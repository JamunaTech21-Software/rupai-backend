import { describe, expect, it } from 'vitest';

import { poolConfigFromUrl } from '../../src/core/db/prisma.js';
import { lockRowsForUpdate, type Tx } from '../../src/core/db/transaction.js';

describe('poolConfigFromUrl', () => {
  const opts = { poolSize: 7, allowPublicKeyRetrieval: false };

  it('maps a mysql URL to pool settings, UTC and utf8mb4', () => {
    expect(poolConfigFromUrl('mysql://rupai_app:secret@db.local:3307/rupai', opts)).toEqual({
      host: 'db.local',
      port: 3307,
      user: 'rupai_app',
      password: 'secret',
      database: 'rupai',
      connectionLimit: 7,
      allowPublicKeyRetrieval: false,
      timezone: 'Z',
      charset: 'utf8mb4',
    });
  });

  it('defaults the port to 3306 and decodes URL-encoded credentials', () => {
    const c = poolConfigFromUrl('mysql://us%40er:p%40ss%2Fw%3Ard@localhost/rupai', opts);
    expect(c.port).toBe(3306);
    expect(c.user).toBe('us@er');
    expect(c.password).toBe('p@ss/w:rd');
  });

  it('requires a database name', () => {
    expect(() => poolConfigFromUrl('mysql://u:p@localhost:3306/', opts)).toThrow('must name a database');
  });

  it('rejects other schemes', () => {
    expect(() => poolConfigFromUrl('postgres://u:p@localhost/x', opts)).toThrow('mysql://');
  });
});

describe('lockRowsForUpdate identifier safety', () => {
  const tx = {} as Tx; // never reached: identifiers are validated before any query

  it.each([
    ['table with quote', 'stock`; DROP TABLE x; --', { id: 1 }],
    ['table with dot', 'other_db.stock_balance', { id: 1 }],
    ['uppercase table', 'StockBalance', { id: 1 }],
    ['column with space', 'stock_balance', { 'id OR 1': 1 }],
  ])('rejects an unsafe identifier (%s)', async (_label, table, where) => {
    await expect(lockRowsForUpdate(tx, table, where)).rejects.toThrow(/unsafe/);
  });

  it('requires at least one condition (never locks a whole table)', async () => {
    await expect(lockRowsForUpdate(tx, 'stock_balance', {})).rejects.toThrow(/at least one condition/);
  });
});
