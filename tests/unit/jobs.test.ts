import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { loadConfig } from '../../src/config/env.js';
import { createDatabase } from '../../src/core/db/prisma.js';
import { backoffSeconds, checkCron, nextRun } from '../../src/core/jobs/cron.js';
import { defineJob } from '../../src/core/jobs/registry.js';
import { checkSchedules, schedulerLockName } from '../../src/core/jobs/scheduler.js';
import { memoryMailer } from '../../src/core/mail/mailer.js';
import { JOB_CATALOGUE_SCHEDULES, registerJobs } from '../../src/modules/index.js';
import { TEST_ENV } from '../helpers/test-app.js';
import { localFileStorage } from '../../src/core/storage/storage.js';
import { dbAccessLog } from '../../src/core/audit/access-log.js';
import { tmpdir } from 'node:os';
import pino from 'pino';

const silent = pino({ level: 'silent' });

/** P1.15 — the pure parts of the job system: timetables, backoff, definitions. */

describe('schedules', () => {
  it('reads cron in the organisation’s timezone and answers in UTC', () => {
    const after = new Date('2026-10-14T05:00:00Z'); // 11:00 in Dhaka
    expect(nextRun('0 3 * * *', after, 'Asia/Dhaka').toISOString()).toBe('2026-10-14T21:00:00.000Z');
    expect(nextRun('5 * * * *', after, 'Asia/Dhaka').toISOString()).toBe('2026-10-14T05:05:00.000Z');
    // Sunday 07:00 in Dhaka.
    expect(nextRun('0 7 * * 0', after, 'Asia/Dhaka').toISOString()).toBe('2026-10-18T01:00:00.000Z');
    // Strictly after: a run exactly on the slot is not the next one.
    expect(nextRun('5 * * * *', new Date('2026-10-14T05:05:00Z'), 'Asia/Dhaka').toISOString()).toBe(
      '2026-10-14T06:05:00.000Z',
    );
  });

  it('accepts five-field cron only', () => {
    expect(checkCron('0 3 * * *', 'Asia/Dhaka')).toBeNull();
    expect(checkCron('0 0 3 * * *', 'Asia/Dhaka')).toMatch(/five fields/);
    expect(checkCron('61 3 * * *', 'Asia/Dhaka')).not.toBeNull();
  });

  it('every schedule of the catalogue is valid and names a registered job', () => {
    const config = loadConfig({ ...TEST_ENV });
    const db = createDatabase(config);
    registerJobs({
      db,
      config,
      mailer: memoryMailer(),
      storage: localFileStorage(tmpdir()),
      accessLog: dbAccessLog(db, silent),
    });
    expect(checkSchedules(JOB_CATALOGUE_SCHEDULES, 'Asia/Dhaka')).toEqual([]);
    expect(
      checkSchedules(
        [
          { name: 'a.b', description: '', cron: '* * * * *', jobType: 'no.such' },
          { name: 'a.b', description: '', cron: 'nope', jobType: 'system.purge_jobs' },
        ],
        'Asia/Dhaka',
      ),
    ).toEqual([
      'schedule a.b: no job is registered as no.such',
      'schedule a.b is defined twice',
      expect.stringContaining('schedule a.b: cron "nope"'),
    ]);
  });

  it('keeps two installations on one MySQL server apart', () => {
    expect(schedulerLockName('mysql://u:p@db:3306/rupai')).toBe('rupai.scheduler.rupai');
    expect(schedulerLockName('mysql://u:p@db:3306/rupai_staging')).toBe('rupai.scheduler.rupai_staging');
  });
});

describe('jobs', () => {
  it('backs off exponentially, to a ceiling of fifteen minutes', () => {
    expect([1, 2, 3, 4, 5].map(backoffSeconds)).toEqual([5, 10, 20, 40, 80]);
    expect(backoffSeconds(20)).toBe(900);
  });

  it('refuses a malformed definition', () => {
    const base = { label: 'x', payload: z.object({}), run: () => Promise.resolve(undefined) };
    expect(() => defineJob({ ...base, type: 'nodot' })).toThrow(/module.purpose/);
    expect(() => defineJob({ ...base, type: 'Bad.Type' })).toThrow(/module.purpose/);
    expect(() => defineJob({ ...base, type: 'a.b', maxAttempts: 0 })).toThrow(/maxAttempts/);
    expect(defineJob({ ...base, type: 'payroll.calculate' }).type).toBe('payroll.calculate');
  });
});
