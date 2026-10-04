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
      CORS_ORIGINS: 'https://erp.example.com',
      REDIS_URL: 'redis://:secret@127.0.0.1:6379',
      SMTP_HOST: 'smtp.example.com',
      APP_PUBLIC_URL: 'https://erp.example.com',
      LOG_FORMAT: 'pretty',
    });
    expect(problems).toEqual([
      'NODE_ENV must be production when APP_ENV is production',
      'LOG_FORMAT must be json in production',
    ]);
  });

  it('accepts a correct production configuration', () => {
    const c = loadConfig({
      ...TEST_ENV,
      APP_ENV: 'production',
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://erp.example.com',
      REDIS_URL: 'redis://:secret@127.0.0.1:6379',
      SMTP_HOST: 'smtp.example.com',
      APP_PUBLIC_URL: 'https://erp.example.com/',
    });
    expect(c.isProduction).toBe(true);
    expect(c.docs.enabled).toBe(false);
    expect(c.auth.cookieSecure).toBe(true);
    expect(c.app.publicUrl).toBe('https://erp.example.com');
  });
});

describe('authentication configuration (P1.02)', () => {
  it('requires a token secret of at least 32 characters', () => {
    expect(problemsOf({ ...TEST_ENV, AUTH_TOKEN_SECRET: undefined })).toContain(
      'AUTH_TOKEN_SECRET is required',
    );
    expect(problemsOf({ ...TEST_ENV, AUTH_TOKEN_SECRET: 'short' })).toContain(
      'AUTH_TOKEN_SECRET must be at least 32 characters',
    );
  });

  it('applies the P4 §2.2.1 defaults', () => {
    const { auth, mail } = loadConfig({ ...TEST_ENV });
    expect(auth.accessTokenSeconds).toBe(15 * 60);
    expect(auth.refreshTokenSeconds).toBe(24 * 3600);
    expect(auth.sessionMaxSeconds).toBe(7 * 86400);
    expect(auth.lockoutThreshold).toBe(5);
    expect(auth.cookieSecure).toBe(false);
    expect(auth.previousTokenSecret).toBeNull();
    expect(mail.smtp).toBeNull();
  });

  it('refuses a previous secret equal to the current one', () => {
    expect(problemsOf({ ...TEST_ENV, AUTH_TOKEN_PREVIOUS_SECRET: TEST_ENV.AUTH_TOKEN_SECRET })).toContain(
      'AUTH_TOKEN_PREVIOUS_SECRET must differ from AUTH_TOKEN_SECRET',
    );
  });

  it('requires mail, a public URL, a secure cookie and a real secret in production', () => {
    const problems = problemsOf({
      ...TEST_ENV,
      APP_ENV: 'production',
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://erp.example.com',
      REDIS_URL: 'redis://:secret@127.0.0.1:6379',
      AUTH_COOKIE_SECURE: 'false',
      AUTH_TOKEN_SECRET: 'change-me-to-a-long-random-string-of-48-chars',
    });
    expect(problems).toEqual([
      'SMTP_HOST is required in production (password reset emails)',
      'APP_PUBLIC_URL is required in production (password reset links)',
      'AUTH_COOKIE_SECURE must be true in production',
      'AUTH_TOKEN_SECRET is still the example value',
    ]);
  });
});

describe('HTTP configuration (P0.04)', () => {
  const prod = { ...TEST_ENV, APP_ENV: 'production', NODE_ENV: 'production' };

  it('defaults CORS to the local web app outside production', () => {
    expect(loadConfig({ ...TEST_ENV }).http.corsOrigins).toEqual([
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ]);
  });

  it('requires an explicit CORS origin list in production', () => {
    expect(problemsOf(prod)).toContain('CORS_ORIGINS is required in production');
  });

  it.each([
    ['*', 'CORS_ORIGINS must not contain a wildcard'],
    ['https://erp.example.com/', 'CORS_ORIGINS entries must be exact origins'],
    ['not a url', 'CORS_ORIGINS contains an invalid origin'],
  ])('rejects CORS_ORIGINS=%s', (origins, message) => {
    expect(problemsOf({ ...TEST_ENV, CORS_ORIGINS: origins }).join('\n')).toContain(message);
  });

  it('parses several exact origins', () => {
    const c = loadConfig({ ...TEST_ENV, CORS_ORIGINS: 'https://erp.example.com, http://10.0.0.5:8080' });
    expect(c.http.corsOrigins).toEqual(['https://erp.example.com', 'http://10.0.0.5:8080']);
  });

  it('refuses to disable rate limiting in production', () => {
    expect(
      problemsOf({ ...prod, CORS_ORIGINS: 'https://erp.example.com', RATE_LIMIT_ENABLED: 'false' }),
    ).toContain('RATE_LIMIT_ENABLED must be true in production');
  });

  it('validates the body limit format', () => {
    expect(problemsOf({ ...TEST_ENV, BODY_LIMIT: 'lots' })[0]).toMatch(/^BODY_LIMIT must be a size/);
  });
});
