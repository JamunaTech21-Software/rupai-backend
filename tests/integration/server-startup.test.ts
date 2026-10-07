import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TEST_ENV } from '../helpers/test-app.js';

const BACKEND = resolve(import.meta.dirname, '../..');
const TSX = resolve(BACKEND, 'node_modules/.bin/tsx');

/**
 * Verification for P0.02: the real entry point refuses to start on bad configuration, with a clear
 * message and a non-zero exit, instead of starting and failing on the first request.
 */
function startServer(env: Record<string, string>) {
  return spawnSync(TSX, ['src/server.ts'], {
    cwd: BACKEND,
    // Empty values override anything in a developer's local .env (loadEnvFile never overwrites).
    env: { PATH: process.env.PATH ?? '', ...TEST_ENV, ...env },
    encoding: 'utf8',
    timeout: 20_000,
  });
}

// Each test starts a real Node process through tsx; a cold start under a busy CI runner can take several
// seconds, so the test timeout matches the process timeout rather than Vitest's 5 s default.
describe('server start-up', { timeout: 25_000 }, () => {
  it('refuses to start without a database URL', () => {
    const run = startServer({ DATABASE_URL: '' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Invalid configuration — refusing to start');
    expect(run.stderr).toContain('DATABASE_URL is required');
  });

  it('lists every configuration problem in one go', () => {
    const run = startServer({ DATABASE_URL: '', APP_ENV: '', PORT: 'abc' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('APP_ENV is required');
    expect(run.stderr).toContain('PORT must be a number');
  });
});
