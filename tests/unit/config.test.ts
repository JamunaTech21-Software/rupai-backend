import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../../src/config/env.js';
import { TEST_ENV } from '../helpers/test-app.js';

function problemsOf(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return [...err.problems];
    throw err;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('parses a valid environment and applies defaults', () => {
    const c = loadConfig({ ...TEST_ENV });
    expect(c.appEnv).toBe('test');
    expect(c.port).toBe(4000);
    expect(c.timezone).toBe('Asia/Dhaka');
    expect(c.isProduction).toBe(false);
    expect(c.database.url).toBe(TEST_ENV.DATABASE_URL);
  });

  it('returns a frozen object', () => {
    const c = loadConfig({ ...TEST_ENV });
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.database)).toBe(true);
  });

  it('refuses to start when the database URL is missing', () => {
    expect(problemsOf({ ...TEST_ENV, DATABASE_URL: undefined })).toContain('DATABASE_URL is required');
  });

  it('treats an empty value as missing, with a single message', () => {
    expect(problemsOf({ ...TEST_ENV, DATABASE_URL: '' })).toEqual(['DATABASE_URL is required']);
  });

  it('reports every problem at once, not just the first', () => {
    const problems = problemsOf({ ...TEST_ENV, APP_ENV: undefined, DATABASE_URL: undefined, PORT: 'abc' });
    expect(problems).toEqual(
      expect.arrayContaining(['APP_ENV is required', 'DATABASE_URL is required', 'PORT must be a number']),
    );
  });

  it('never echoes the offending value (it may be a secret)', () => {
    const secret = 'postgres://admin:S3cr3tPassw0rd@db/x';
    const problems = problemsOf({ ...TEST_ENV, DATABASE_URL: secret });
    expect(problems).toContain('DATABASE_URL must be a mysql:// connection URL');
    expect(problems.join(' ')).not.toContain('S3cr3tPassw0rd');
  });

  it.each([
    ['0', 'PORT must be between 1 and 65535'],
    ['70000', 'PORT must be between 1 and 65535'],
    ['40.5', 'PORT must be an integer'],
  ])('rejects PORT=%s', (port, message) => {
    expect(problemsOf({ ...TEST_ENV, PORT: port })).toContain(message);
  });

  it('rejects an unknown APP_ENV', () => {
    expect(problemsOf({ ...TEST_ENV, APP_ENV: 'prod' })[0]).toMatch(/^APP_ENV must be one of/);
  });

  it('rejects an invalid timezone', () => {
    expect(problemsOf({ ...TEST_ENV, APP_TIMEZONE: 'Mars/Olympus' })[0]).toMatch(
      /APP_TIMEZONE must be a valid/,
    );
  });

  it('enforces production consistency', () => {
    const problems = problemsOf({
      ...TEST_ENV,
      APP_ENV: 'production',
      NODE_ENV: 'development',
      LOG_FORMAT: 'pretty',
    });
    expect(problems).toEqual([
      'NODE_ENV must be production when APP_ENV is production',
      'LOG_FORMAT must be json in production',
    ]);
  });

  it('accepts a correct production configuration', () => {
    const c = loadConfig({ ...TEST_ENV, APP_ENV: 'production', NODE_ENV: 'production' });
    expect(c.isProduction).toBe(true);
  });
});
