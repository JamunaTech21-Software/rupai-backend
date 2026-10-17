import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { buildModules } from '../../src/modules/index.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import { createMigratedDatabase, silentLogger, url, type MigratedDatabase } from './helpers.js';

/**
 * P1.18 — GET /system/health on real MySQL: every signal of P14 Table 10.1 present, each turning warning or
 * critical at its threshold, a check that cannot be read reported as unknown, and system.view required.
 */

/** The Administrator holds system.view (P6 R-01). */
const ADMIN = '1';
let NOBODY = '';
let mdb: MigratedDatabase;
let backups = '';
let seq = 0;

interface Check {
  key: string;
  status: string;
  value: string | null;
  detail: string;
  data: Record<string, unknown>;
}
interface Report {
  status: string;
  version: { app: string; environment: string };
  checks: Check[];
}

function appWith(env: Record<string, string>): Express {
  const config = loadConfig({
    ...TEST_ENV,
    DATABASE_URL: url('app', mdb.name),
    RATE_LIMIT_ENABLED: 'false',
    ...env,
  });
  const deps = testModuleDeps({
    config,
    db: mdb.db,
    authz: dbPermissionResolver(mdb.db),
    logger: silentLogger(),
  });
  return createApp({
    config,
    logger: silentLogger(),
    db: mdb.db,
    platform: memoryPlatform(),
    modules: buildModules(deps),
    authenticate: testActor(),
  });
}
let app: Express;

async function report(on = app): Promise<{ report: Report; byKey: Record<string, Check> }> {
  const res = await as(request(on).get('/api/v1/system/health'), ADMIN);
  expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(200);
  const r = (res.body as { data: Report }).data;
  return { report: r, byKey: Object.fromEntries(r.checks.map((c) => [c.key, c])) };
}

const beat = (kind: 'worker' | 'scheduler', secondsAgo = 5) =>
  mdb.migrator.processHeartbeat.create({
    data: {
      processKey: `${kind}:test:${String((seq += 1))}`,
      kind,
      host: 'test',
      pid: 1,
      appVersion: 'test',
      startedAt: new Date(Date.now() - 3_600_000),
      beatAt: new Date(Date.now() - secondsAgo * 1000),
    },
  });

beforeAll(async () => {
  mdb = await createMigratedDatabase();
  backups = mkdtempSync(join(tmpdir(), 'rupai-test-backups-'));
  app = appWith({ BACKUP_DIR: backups });
  NOBODY = (
    await mdb.migrator.user.create({
      data: { username: `nobody${String(Date.now() % 100000)}`, passwordHash: 'x', createdBy: 1n },
    })
  ).id.toString();
}, 180_000);

afterAll(async () => {
  await mdb.drop();
});

describe('GET /system/health (P1.18)', () => {
  it('needs system.view', async () => {
    expect((await as(request(app).get('/api/v1/system/health'), NOBODY)).status).toBe(403);
  });

  it('reports every signal, the ones not built yet as not applicable', async () => {
    const { report: r, byKey } = await report();
    expect(Object.keys(byKey)).toEqual([
      'database',
      'db_connections',
      'slow_queries',
      'queue',
      'failed_jobs',
      'workers',
      'scheduler',
      'disk',
      'backup',
      'failed_logins',
      'failed_postings',
      'consistency_checks',
      'device_fleet',
      'response_time',
      'error_rate',
      'certificate',
    ]);
    expect(byKey.database?.status).toBe('ok');
    expect(byKey.db_connections?.data).toMatchObject({ max_connections: expect.any(Number) as number });
    expect(byKey.disk?.status).toMatch(/ok|warning|critical/);
    expect(byKey.consistency_checks).toMatchObject({ status: 'not_applicable' });
    expect(r.version.environment).toBe('test');
  });

  it('is critical without a worker or a scheduler, and ok once they beat', async () => {
    const { report: r } = await report();
    let { byKey } = await report();
    expect([byKey.workers?.status, byKey.scheduler?.status]).toEqual(['critical', 'critical']);
    expect(r.status).toBe('critical');
    await beat('worker');
    await beat('scheduler');
    await beat('worker', 600); // a dead one is not counted
    ({ byKey } = await report());
    expect(byKey.workers).toMatchObject({ status: 'ok', data: { alive: 1 } });
    expect(byKey.scheduler?.status).toMatch(/ok|warning/);
  });

  it('flags a queue that does not drain and jobs that failed', async () => {
    const old = new Date(Date.now() - 40 * 60_000);
    const queued = await mdb.migrator.job.create({
      data: { type: 'system.self_test', payload: {}, maxAttempts: 1, availableAt: old, queuedAt: old },
    });
    const failed = await mdb.migrator.job.create({
      data: {
        type: 'system.self_test',
        payload: {},
        maxAttempts: 1,
        state: 'failed',
        finishedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    try {
      const { byKey } = await report();
      expect(byKey.queue).toMatchObject({ status: 'critical', data: { waiting: 1 } });
      expect(byKey.failed_jobs).toMatchObject({ status: 'warning', data: { last_24h: 1 } });
    } finally {
      await mdb.migrator.job.deleteMany({ where: { id: { in: [queued.id, failed.id] } } });
    }
    expect((await report()).byKey.queue?.status).toBe('ok');
  });

  it('names a schedule that has not fired', async () => {
    await beat('scheduler');
    const s = await mdb.migrator.jobSchedule.create({
      data: {
        name: 'test.late',
        jobType: 'system.self_test',
        cron: '0 * * * *',
        nextRunAt: new Date(Date.now() - 3_600_000),
      },
    });
    try {
      const { byKey } = await report();
      expect(byKey.scheduler).toMatchObject({ status: 'warning' });
      expect(byKey.scheduler?.detail).toContain('test.late');
    } finally {
      await mdb.migrator.jobSchedule.delete({ where: { id: s.id } });
    }
  });

  it('reports the last backup: missing, shrunk, old', async () => {
    expect((await report()).byKey.backup).toMatchObject({ status: 'critical', value: 'none' });
    writeFileSync(join(backups, 'rupai-20261016T020000Z.sql.gz'), Buffer.alloc(10_000));
    writeFileSync(join(backups, 'rupai-20261017T020000Z.sql.gz'), Buffer.alloc(9_000));
    expect((await report()).byKey.backup?.status).toBe('ok');
    writeFileSync(join(backups, 'rupai-20261018T020000Z.sql.gz'), Buffer.alloc(1_000));
    expect((await report()).byKey.backup?.status).toBe('warning'); // less than half the one before
    const twoDaysAgo = new Date(Date.now() - 48 * 3_600_000);
    utimesSync(join(backups, 'rupai-20261018T020000Z.sql.gz'), twoDaysAgo, twoDaysAgo);
    expect((await report()).byKey.backup?.status).toBe('critical'); // no success in 26 hours
  });

  it('says it cannot see the backups without BACKUP_DIR, and a check that cannot be read is unknown', async () => {
    expect((await report(appWith({}))).byKey.backup?.status).toBe('unknown');
    const missing = await report(appWith({ BACKUP_DIR: join(backups, 'nowhere') }));
    expect(missing.byKey.backup).toMatchObject({ status: 'unknown' });
    expect(missing.byKey.backup?.detail).toMatch(/^Could not be read/);
    // The page still answers with every other check.
    expect(missing.byKey.database?.status).toBe('ok');
  });

  it('warns of an unusual rate of failed logins', async () => {
    await mdb.migrator.accessLog.createMany({
      data: Array.from({ length: 21 }, () => ({ eventType: 'failed_login', ipAddress: '10.0.0.9' })),
    });
    expect((await report()).byKey.failed_logins).toMatchObject({
      status: 'warning',
      data: { last_hour: 21 },
    });
  });
});
