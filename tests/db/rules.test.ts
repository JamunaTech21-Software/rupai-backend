import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Prisma } from '../../src/generated/prisma/client.js';
import { dbAccessLog } from '../../src/core/audit/access-log.js';
import { runWithRequestContext } from '../../src/core/context/request-context.js';
import { withTransaction, type Tx } from '../../src/core/db/transaction.js';
import { AppError } from '../../src/core/errors/app-error.js';
import {
  explainRule,
  pickRule,
  resolveRule,
  toCandidate,
  type RuleContext,
} from '../../src/core/rules/resolve.js';
import { checkRuleTable, ruleTableSql } from '../../src/core/rules/rule-sql.js';
import { defineRuleTable, specificityOf } from '../../src/core/rules/rule-table.js';
import { ruleVersions, type NewRuleInput } from '../../src/core/rules/versions.js';
import { ALL_ESTATES_SCOPE, EMPTY_SCOPE, type ResolvedScope } from '../../src/core/scope/scope.js';
import { addDays, todayIn, type BusinessDate } from '../../src/core/time/dates.js';
import { RULE_TABLES } from '../../src/modules/rule-tables.js';
import { createMigratedDatabase, silentLogger, withRollback, type MigratedDatabase } from './helpers.js';

/**
 * P1.06 — the effective-dated rule engine core against real MySQL 8.4.
 *
 * No business rule table exists yet (they arrive with their modules), so the suite creates fixture rule
 * tables FROM THE MIGRATION HELPER and runs the resolver and the version service on them. That also
 * proves the helper's DDL is valid MySQL with the block's generated columns, CHECKs and grant.
 */

const fixture = defineRuleTable({
  table: 'test_rule',
  methods: ['daily', 'monthly'],
  extraColumns: ['base_rate'],
});
const partitioned = defineRuleTable({
  table: 'test_part_rule',
  methods: ['percentage'],
  partitions: [{ column: 'statutory_type', key: 'statutory_type', sqlType: 'VARCHAR(30)' }],
});

const TZ = 'Asia/Dhaka';
const d = (s: string) => s as BusinessDate;
const ADMIN = 1n;
let mdb: MigratedDatabase;
let CREATOR: bigint;
let APPROVER: bigint;
let svc: ReturnType<typeof ruleVersions>;
let estateSeq = 1000n;
/** A fresh estate id per test, so tests sharing the committed database never meet at one scope. */
const freshEstate = () => (estateSeq += 1n);
let codeSeq = 0;
const code = (p = 'R') => `${p}-${String((codeSeq += 1))}`;

async function applySql(sql: string): Promise<void> {
  for (const stmt of sql.split(/;\s*\n/)) {
    if (stmt.split('\n').every((l) => l.trim() === '' || l.trim().startsWith('--'))) continue;
    await mdb.migrator.$executeRawUnsafe(stmt);
  }
}

beforeAll(async () => {
  mdb = await createMigratedDatabase();
  await applySql(ruleTableSql(fixture, ['`base_rate` DECIMAL(18,4) NOT NULL']));
  await applySql(ruleTableSql(partitioned));
  const user = (username: string) =>
    mdb.migrator.user.create({ data: { username, passwordHash: 'x', createdBy: ADMIN } }).then((u) => u.id);
  CREATOR = await user('rule_creator');
  APPROVER = await user('rule_approver');
  svc = ruleVersions(fixture, { timezone: TZ, accessLog: dbAccessLog(mdb.db, silentLogger()) });
});
afterAll(async () => {
  await mdb.drop();
});

/** Runs `work` as `actor` with the given data scope (default: all estates). */
function as<T>(
  actor: bigint,
  work: () => Promise<T>,
  scope: Partial<ResolvedScope> | 'all' = 'all',
): Promise<T> {
  const resolved = scope === 'all' ? ALL_ESTATES_SCOPE : { ...EMPTY_SCOPE, ...scope };
  return runWithRequestContext(
    { requestId: 'rules-test', actorId: actor.toString(), loadScope: () => Promise.resolve(resolved) },
    work,
  );
}

const draft = (over: Partial<NewRuleInput> = {}): NewRuleInput => ({
  ruleCode: code(),
  name: 'Plucking — General Worker',
  method: 'daily',
  parameters: { week_days: 6, holiday_treatment: 'paid' },
  effectiveFrom: d('2030-01-01'),
  extras: { base_rate: '152.0000' },
  ...over,
});

/** create → submit → approve by someone else. Returns the active version. */
async function activate(tx: Tx, input: NewRuleInput) {
  const v = await as(CREATOR, () => svc.create(tx, input));
  await as(CREATOR, () => svc.submit(tx, v.id));
  return (await as(APPROVER, () => svc.approve(tx, v.id))).version;
}

/** The AppError a call fails with (any other outcome fails the test). */
async function failure(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error('expected it to fail');
}

const codeOf = (p: Promise<unknown>) => failure(p).then((e) => e.code);

describe('the migration helper (P3 §17.1 rule block)', () => {
  it('produces tables that pass the shape check', async () => {
    expect(await checkRuleTable(mdb.db, fixture)).toEqual([]);
    expect(await checkRuleTable(mdb.db, partitioned)).toEqual([]);
  });

  it('every registered rule table in the real migrations carries the block', async () => {
    for (const t of RULE_TABLES) expect(await checkRuleTable(mdb.db, t), t.table).toEqual([]);
  });

  it('the shape check finds a table that lost part of the block', async () => {
    await mdb.migrator.$executeRawUnsafe(
      'CREATE TABLE `test_broken_rule` (`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, `rule_code` VARCHAR(30) NULL, `specificity` SMALLINT NOT NULL)',
    );
    const t = defineRuleTable({ table: 'test_broken_rule', methods: ['daily'] });
    const problems = await checkRuleTable(mdb.db, t);
    expect(problems).toEqual(
      expect.arrayContaining([
        'test_broken_rule.rule_code: must be NOT NULL',
        'test_broken_rule.specificity: must be a STORED generated column',
        'test_broken_rule.active_key: missing',
        'test_broken_rule: needs UNIQUE ux_test_broken_rule_scope_from(active_key)',
        'test_broken_rule: missing CHECK ck_test_broken_rule_range',
      ]),
    );
    expect(
      await checkRuleTable(mdb.db, defineRuleTable({ table: 'test_no_such_rule', methods: ['x'] })),
    ).toEqual(['test_no_such_rule: table does not exist']);
  });

  it('MySQL computes specificity from the scope columns, exactly as the resolver ranks it', async () => {
    await withRollback(mdb.db, async (tx) => {
      const scopes = [
        {},
        { category: '7' },
        { estate: '3', category: '7' },
        { estate: '3', category: '7', activity_type: '2', season: '9' },
      ];
      for (const scope of scopes) {
        const v = await as(CREATOR, () => svc.create(tx, draft({ scope })));
        expect(v.specificity).toBe(specificityOf(fixture, scope));
      }
    });
  });

  it('the database refuses a backwards range, an unknown state or method, and a rejection without a reason', async () => {
    await expect(
      mdb.db.$executeRawUnsafe(
        `INSERT INTO test_rule (rule_code, name, method, parameters, effective_from, effective_to, base_rate, created_by) VALUES ('CK', 'x', 'daily', '{}', '2030-02-01', '2030-01-01', 1, 1)`,
      ),
    ).rejects.toThrow(/ck_test_rule_range/);
    await expect(
      mdb.db.$executeRawUnsafe(
        `INSERT INTO test_rule (rule_code, name, method, parameters, effective_from, base_rate, state, created_by) VALUES ('CK', 'x', 'daily', '{}', '2030-01-01', 1, 'bogus', 1)`,
      ),
    ).rejects.toThrow(/ck_test_rule_state/);
    await expect(
      mdb.db.$executeRawUnsafe(
        `INSERT INTO test_rule (rule_code, name, method, parameters, effective_from, base_rate, created_by) VALUES ('CK', 'x', 'weekly', '{}', '2030-01-01', 1, 1)`,
      ),
    ).rejects.toThrow(/ck_test_rule_method/);
    await expect(
      mdb.db.$executeRawUnsafe(
        `INSERT INTO test_rule (rule_code, name, method, parameters, effective_from, base_rate, state, rejected_at, created_by) VALUES ('CK', 'x', 'daily', '{}', '2030-01-01', 1, 'rejected', NOW(), 1)`,
      ),
    ).rejects.toThrow(/ck_test_rule_rejection/);
    await expect(
      mdb.db.$executeRawUnsafe(
        `INSERT INTO test_rule (rule_code, name, method, parameters, effective_from, base_rate, state, created_by) VALUES ('CK', 'x', 'daily', '{}', '2030-01-01', 1, 'active', 1)`,
      ),
    ).rejects.toThrow(/ck_test_rule_approved/);
  });

  it('two ACTIVE versions cannot start on the same date at the same scope, organisation-wide ones included', async () => {
    const insertActive = (estate: string) =>
      mdb.db.$executeRawUnsafe(
        `INSERT INTO test_rule (rule_code, name, method, parameters, effective_from, base_rate, state, approved_at, created_by, scope_estate_id)
         VALUES ('UQ', 'x', 'daily', '{}', '2040-01-01', 1, 'active', NOW(), 1, ${estate})`,
      );
    await withRollback(mdb.db, async () => {
      // Two NULL-scope rows would pass a plain unique key: MySQL lets NULLs repeat. active_key does not.
      await insertActive('NULL');
      await expect(insertActive('NULL')).rejects.toThrow(/ux_test_rule_scope_from/);
    });
    // Drafts at the same scope and date are allowed (only ACTIVE versions are keyed).
    await withRollback(mdb.db, async (tx) => {
      const scope = { estate: freshEstate().toString() };
      await as(CREATOR, () => svc.create(tx, draft({ scope })));
      await as(CREATOR, () => svc.create(tx, draft({ scope })));
    });
  });

  it('the app account may update a rule version but never delete one', async () => {
    await expect(mdb.db.$executeRawUnsafe('DELETE FROM test_rule WHERE id = 0')).rejects.toThrow(
      /DELETE command denied/,
    );
    await expect(mdb.db.$executeRawUnsafe('UPDATE test_rule SET notes = NULL WHERE id = 0')).resolves.toBe(0);
  });
});

describe('resolution in SQL (P9 §3.1)', () => {
  /** Active versions inserted directly, so the set may also contain configurations the service refuses. */
  async function insertActive(tx: Tx, scope: Record<string, string>, from: string, to: string | null = null) {
    const columns: Record<string, unknown> = {
      rule_code: code('S'),
      name: 'x',
      method: 'daily',
      parameters: '{}',
      effective_from: from,
      effective_to: to,
      base_rate: '1',
      state: 'active',
      approved_at: new Date(),
      created_by: ADMIN,
      ...Object.fromEntries(fixture.dimensions.map((dim) => [dim.column, scope[dim.key] ?? null])),
    };
    const cols = Object.keys(columns);
    await tx.$executeRaw(
      Prisma.sql`INSERT INTO test_rule (${Prisma.join(cols.map((c) => Prisma.raw(c)))}) VALUES (${Prisma.join(cols.map((c) => columns[c]))})`,
    );
  }

  it('agrees with pickRule on every context and date of a mixed rule set', async () => {
    await withRollback(mdb.db, async (tx) => {
      const e = freshEstate().toString();
      const cat = '501';
      await insertActive(tx, {}, '2020-01-01');
      await insertActive(tx, { category: cat }, '2021-01-01', '2026-12-31');
      await insertActive(tx, { category: cat }, '2027-01-01');
      await insertActive(tx, { category: cat, activity_type: '3' }, '2022-01-01');
      await insertActive(tx, { estate: e, category: cat }, '2023-06-01');
      await insertActive(
        tx,
        { estate: e, category: cat, activity_type: '3', season: '9' },
        '2024-01-01',
        '2024-12-31',
      );
      // Another estate's rule, and a draft-like row in another state, never compete.
      await insertActive(tx, { estate: freshEstate().toString(), category: cat }, '2020-01-01');
      const all = (
        await tx.$queryRaw<Record<string, unknown>[]>`SELECT * FROM test_rule WHERE state = 'active'`
      ).map((r) => toCandidate(fixture, r));
      const contexts: RuleContext[] = [
        {},
        { category: cat },
        { estate: e, category: cat },
        { estate: e, category: cat, activity_type: 3n },
        { estate: e, category: cat, activity_type: 3n, season: 9n },
        { estate: '999999', category: cat, activity_type: 3n },
      ];
      const dates = [
        '2020-06-01',
        '2022-02-01',
        '2023-05-31',
        '2023-06-01',
        '2024-07-01',
        '2026-12-31',
        '2027-01-01',
      ];
      for (const ctx of contexts) {
        for (const on of dates) {
          const expected = pickRule(fixture, all, ctx, d(on)).rule.id;
          const actual = (await resolveRule(tx, fixture, ctx, d(on))).rule.id;
          expect(
            actual,
            `${JSON.stringify(ctx, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))} on ${on}`,
          ).toBe(expected);
        }
      }
    });
  });

  it('halts with RULE_AMBIGUOUS on an overlap that bypassed the service, naming both versions', async () => {
    await withRollback(mdb.db, async (tx) => {
      const e = freshEstate().toString();
      await insertActive(tx, { estate: e }, '2026-01-01');
      await insertActive(tx, { estate: e }, '2026-02-01');
      const err = await resolveRule(tx, fixture, { estate: e }, d('2026-03-01')).catch((x: unknown) => x);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('RULE_AMBIGUOUS');
      expect((err as AppError).details).toHaveLength(2);
    });
  });

  it('RULE_NOT_FOUND where nothing applies; partitions never mix', async () => {
    await withRollback(mdb.db, async (tx) => {
      expect(
        await codeOf(resolveRule(tx, partitioned, { statutory_type: 'gratuity' }, d('2026-01-01'))),
      ).toBe('RULE_NOT_FOUND');
      await tx.$executeRawUnsafe(
        `INSERT INTO test_part_rule (rule_code, name, statutory_type, method, parameters, effective_from, state, approved_at, created_by)
         VALUES ('PF', 'Provident fund', 'provident_fund', 'percentage', '{}', '2020-01-01', 'active', NOW(), 1)`,
      );
      expect(
        (await resolveRule(tx, partitioned, { statutory_type: 'provident_fund' }, d('2026-01-01'))).rule
          .ruleCode,
      ).toBe('PF');
      expect(
        await codeOf(resolveRule(tx, partitioned, { statutory_type: 'gratuity' }, d('2026-01-01'))),
      ).toBe('RULE_NOT_FOUND');
    });
  });

  it('uses the resolution index (one indexed query, P2 §2.10)', async () => {
    const plan = await mdb.db.$queryRawUnsafe<{ key: string | null; possible_keys: string | null }[]>(
      `EXPLAIN SELECT id FROM test_rule r WHERE state = 'active' AND effective_from <= '2026-01-01'
       AND (effective_to IS NULL OR effective_to >= '2026-01-01') AND scope_estate_id IS NULL
       ORDER BY specificity DESC, effective_from DESC, id LIMIT 100`,
    );
    expect(plan[0]?.possible_keys ?? '').toMatch(/ix_test_rule_resolution|ix_test_rule_state/);
  });
});

describe('versions: draft → submitted → active (P1 §3.2, P4 §6.5)', () => {
  it('a version takes effect only once approved, and is audited all the way', async () => {
    await withRollback(mdb.db, async (tx) => {
      const scope = { estate: freshEstate().toString(), category: '7' };
      const v = await as(CREATOR, () => svc.create(tx, draft({ scope })));
      expect(v).toMatchObject({ state: 'draft', isRetrospective: false, createdBy: CREATOR, version: 1 });
      expect(v.extras.base_rate).toEqual(new Prisma.Decimal('152'));
      expect(await codeOf(resolveRule(tx, fixture, scope, d('2030-06-01')))).toBe('RULE_NOT_FOUND');

      const submitted = await as(CREATOR, () => svc.submit(tx, v.id));
      expect(submitted).toMatchObject({ state: 'submitted', submittedBy: CREATOR });
      const {
        version: active,
        closed,
        superseded,
        retrospective,
      } = await as(APPROVER, () => svc.approve(tx, v.id));
      expect(active).toMatchObject({ state: 'active', approvedBy: APPROVER });
      expect(active.approvedAt).toBeInstanceOf(Date);
      expect({ closed, superseded, retrospective }).toEqual({
        closed: [],
        superseded: [],
        retrospective: null,
      });
      expect((await resolveRule(tx, fixture, scope, d('2030-06-01'))).rule.id).toBe(v.id);

      const history = await tx.statusHistory.findMany({
        where: { recordType: 'test_rule', recordId: v.id.toString() },
        orderBy: { id: 'asc' },
      });
      expect(history.map((h) => [h.fromState, h.toState])).toEqual([
        [null, 'draft'],
        ['draft', 'submitted'],
        ['submitted', 'active'],
      ]);
      const audit = await tx.auditChange.findMany({
        where: { recordType: 'test_rule', recordId: v.id.toString() },
        orderBy: { id: 'asc' },
      });
      expect(audit.map((a) => a.action)).toEqual(['create', 'approve']);
      expect(JSON.parse(audit[0]?.newValue ?? '{}')).toMatchObject({
        base_rate: '152',
        effective_from: '2030-01-01',
        scope_estate_id: scope.estate,
      });
      expect(audit[1]?.changedBy).toBe(APPROVER);
    });
  });

  it('nobody approves a version they created', async () => {
    await withRollback(mdb.db, async (tx) => {
      const v = await as(CREATOR, () =>
        svc.create(tx, draft({ scope: { estate: freshEstate().toString() } })),
      );
      await as(CREATOR, () => svc.submit(tx, v.id));
      expect(await codeOf(as(CREATOR, () => svc.approve(tx, v.id)))).toBe('SELF_APPROVAL_FORBIDDEN');
    });
  });

  it('only a draft is edited, with If-Match, and every changed field is audited', async () => {
    await withRollback(mdb.db, async (tx) => {
      const v = await as(CREATOR, () =>
        svc.create(tx, draft({ scope: { estate: freshEstate().toString() } })),
      );
      expect(await codeOf(as(CREATOR, () => svc.updateDraft(tx, v.id, 99, { name: 'x' })))).toBe(
        'VERSION_CONFLICT',
      );
      const edited = await as(CREATOR, () =>
        svc.updateDraft(tx, v.id, 1, {
          name: 'Plucking — revised',
          effectiveFrom: d('2030-02-01'),
          extras: { base_rate: '160.5' },
        }),
      );
      expect(edited).toMatchObject({ name: 'Plucking — revised', effectiveFrom: '2030-02-01', version: 2 });
      const changes = await tx.auditChange.findMany({
        where: { recordType: 'test_rule', recordId: v.id.toString(), action: 'update' },
      });
      expect(changes.map((c) => [c.field, c.oldValue, c.newValue]).sort()).toEqual([
        ['base_rate', '152', '160.5'],
        ['effective_from', '2030-01-01', '2030-02-01'],
        ['name', 'Plucking — General Worker', 'Plucking — revised'],
      ]);
      await as(CREATOR, () => svc.submit(tx, v.id));
      expect(await codeOf(as(CREATOR, () => svc.updateDraft(tx, v.id, 3, { name: 'y' })))).toBe(
        'INVALID_TRANSITION',
      );
    });
  });

  it('refuses a domain mistake with every problem listed', async () => {
    await withRollback(mdb.db, async (tx) => {
      const err = await failure(
        as(CREATOR, () =>
          svc.create(
            tx,
            draft({
              ruleCode: 'bad code!',
              method: 'weekly',
              effectiveTo: d('2029-12-31'),
              scope: { estat: '1' },
              roundingPrecision: 12,
            }),
          ),
        ),
      );
      expect(err.code).toBe('VALIDATION_FAILED');
      expect(err.details.map((x) => x.field).sort()).toEqual([
        'effective_to',
        'method',
        'rounding_precision',
        'rule_code',
        'scope.estat',
      ]);
    });
  });

  it('a rule code names one rule: a second first version is refused, a supersede is the way', async () => {
    await withRollback(mdb.db, async (tx) => {
      const ruleCode = code();
      await as(CREATOR, () =>
        svc.create(tx, draft({ ruleCode, scope: { estate: freshEstate().toString() } })),
      );
      expect(await codeOf(as(CREATOR, () => svc.create(tx, draft({ ruleCode }))))).toBe('DUPLICATE_KEY');
    });
  });

  it('state guards: approve a draft, approve twice, supersede a draft, reject without a reason', async () => {
    await withRollback(mdb.db, async (tx) => {
      const v = await as(CREATOR, () =>
        svc.create(tx, draft({ scope: { estate: freshEstate().toString() } })),
      );
      expect(await codeOf(as(APPROVER, () => svc.approve(tx, v.id)))).toBe('NOT_SUBMITTED');
      expect(await codeOf(as(CREATOR, () => svc.supersede(tx, v.id, draft())))).toBe('INVALID_TRANSITION');
      await as(CREATOR, () => svc.submit(tx, v.id));
      expect(await codeOf(as(CREATOR, () => svc.submit(tx, v.id)))).toBe('INVALID_TRANSITION');
      expect(await codeOf(as(APPROVER, () => svc.reject(tx, v.id, '  ')))).toBe('VALIDATION_FAILED');
      await as(APPROVER, () => svc.approve(tx, v.id));
      expect(await codeOf(as(APPROVER, () => svc.approve(tx, v.id)))).toBe('ALREADY_APPROVED');
    });
  });

  it('return for correction, and rejection (terminal, audited with its reason)', async () => {
    await withRollback(mdb.db, async (tx) => {
      const v = await as(CREATOR, () =>
        svc.create(tx, draft({ scope: { estate: freshEstate().toString() } })),
      );
      await as(CREATOR, () => svc.submit(tx, v.id));
      const back = await as(APPROVER, () => svc.returnToDraft(tx, v.id, 'Rate is per kg, not per day'));
      expect(back).toMatchObject({ state: 'draft', submittedAt: null, submittedBy: null });
      await as(CREATOR, () => svc.submit(tx, v.id));
      const rejected = await as(APPROVER, () => svc.reject(tx, v.id, 'Superseded by the wage settlement'));
      expect(rejected).toMatchObject({
        state: 'rejected',
        rejectedBy: APPROVER,
        rejectionReason: 'Superseded by the wage settlement',
      });
      expect(await codeOf(as(CREATOR, () => svc.submit(tx, v.id)))).toBe('INVALID_TRANSITION');
      const audit = await tx.auditChange.findFirst({
        where: { recordType: 'test_rule', recordId: v.id.toString(), action: 'reject' },
      });
      expect(audit?.reason).toBe('Superseded by the wage settlement');
      const returned = await tx.statusHistory.findFirst({
        where: {
          recordType: 'test_rule',
          recordId: v.id.toString(),
          toState: 'draft',
          fromState: 'submitted',
        },
      });
      expect(returned?.comment).toBe('Rate is per kg, not per day');
    });
  });
});

describe('superseding: versions are added, never overwritten (P1 Figure 3.1)', () => {
  it('the old version keeps resolving until the new one is approved, then closes the day before it', async () => {
    await withRollback(mdb.db, async (tx) => {
      const scope = { estate: freshEstate().toString(), category: '7' };
      const v2 = await activate(
        tx,
        draft({ scope, effectiveFrom: d('2030-04-01'), extras: { base_rate: '138' } }),
      );
      const v3 = await as(CREATOR, () =>
        svc.supersede(tx, v2.id, {
          ...draft(),
          effectiveFrom: d('2031-03-01'),
          extras: { base_rate: '152' },
        }),
      );
      expect(v3).toMatchObject({
        state: 'draft',
        ruleCode: v2.ruleCode,
        supersedesId: v2.id,
        scope: v2.scope,
      });
      // Awaiting approval: no gap, the old rate still applies.
      expect((await resolveRule(tx, fixture, scope, d('2031-06-01'))).rule.id).toBe(v2.id);

      await as(CREATOR, () => svc.submit(tx, v3.id));
      const result = await as(APPROVER, () => svc.approve(tx, v3.id));
      expect(result.closed).toEqual([{ id: v2.id, effectiveTo: '2031-02-28' }]);
      const closed = await as(ADMIN, () => svc.get(tx, v2.id));
      expect(closed).toMatchObject({ state: 'active', effectiveTo: '2031-02-28' });
      // February resolves February's rate whenever it is run; March onwards the new one.
      expect((await resolveRule(tx, fixture, scope, d('2031-02-28'))).rule.id).toBe(v2.id);
      expect((await resolveRule(tx, fixture, scope, d('2031-03-01'))).rule.id).toBe(v3.id);
      const closeAudit = await tx.auditChange.findFirst({
        where: { recordType: 'test_rule', recordId: v2.id.toString(), field: 'effective_to' },
      });
      expect(closeAudit).toMatchObject({
        oldValue: null,
        newValue: '2031-02-28',
        reason: `Closed by version ${v3.id.toString()}`,
      });
    });
  });

  it('a correction from the same date supersedes the old version entirely', async () => {
    await withRollback(mdb.db, async (tx) => {
      const scope = { estate: freshEstate().toString() };
      const wrong = await activate(
        tx,
        draft({ scope, effectiveFrom: d('2030-04-01'), extras: { base_rate: '183' } }),
      );
      const fix = await as(CREATOR, () =>
        svc.supersede(tx, wrong.id, {
          ...draft(),
          effectiveFrom: d('2030-04-01'),
          extras: { base_rate: '138' },
        }),
      );
      await as(CREATOR, () => svc.submit(tx, fix.id));
      const result = await as(APPROVER, () => svc.approve(tx, fix.id));
      expect(result.superseded).toEqual([wrong.id]);
      expect((await as(ADMIN, () => svc.get(tx, wrong.id))).state).toBe('superseded');
      expect((await resolveRule(tx, fixture, scope, d('2030-04-01'))).rule.id).toBe(fix.id);
    });
  });

  it('a later version keeps the rule code and scope of the one it supersedes', async () => {
    await withRollback(mdb.db, async (tx) => {
      const v = await activate(tx, draft({ scope: { estate: freshEstate().toString() } }));
      const next = await as(CREATOR, () =>
        svc.supersede(tx, v.id, { ...draft(), effectiveFrom: d('2031-01-01') }),
      );
      expect(
        await codeOf(as(CREATOR, () => svc.updateDraft(tx, next.id, 1, { scope: { estate: '1' } }))),
      ).toBe('VALIDATION_FAILED');
    });
  });

  it('refuses an overlap at the same scope, at submission and at approval (RULE_OVERLAP)', async () => {
    await withRollback(mdb.db, async (tx) => {
      const scope = { estate: freshEstate().toString() };
      const v = await activate(tx, draft({ scope, effectiveFrom: d('2030-01-01') }));
      const rival = await as(CREATOR, () => svc.create(tx, draft({ scope, effectiveFrom: d('2030-06-01') })));
      const err = await failure(as(CREATOR, () => svc.submit(tx, rival.id)));
      expect(err.code).toBe('RULE_OVERLAP');
      expect(err.status).toBe(422);
      expect(err.details[0]?.context).toMatchObject({
        reason: 'overlaps',
        rule_id: v.id.toString(),
        rule_code: v.ruleCode,
      });
      // The same dates at a different scope are fine.
      const elsewhere = await as(CREATOR, () =>
        svc.create(
          tx,
          draft({ scope: { estate: freshEstate().toString() }, effectiveFrom: d('2030-06-01') }),
        ),
      );
      await expect(as(CREATOR, () => svc.submit(tx, elsewhere.id))).resolves.toMatchObject({
        state: 'submitted',
      });
    });
  });

  it('two approvals racing at one scope are serialised: one wins, the other sees the overlap', async () => {
    const scope = { estate: freshEstate().toString() };
    const [a, b] = await withTransaction(mdb.db, async (tx) => {
      const x = await as(CREATOR, () => svc.create(tx, draft({ scope, effectiveFrom: d('2030-01-01') })));
      const y = await as(CREATOR, () => svc.create(tx, draft({ scope, effectiveFrom: d('2030-07-01') })));
      await as(CREATOR, () => svc.submit(tx, x.id));
      await as(CREATOR, () => svc.submit(tx, y.id)); // nothing active yet, so both may be submitted
      return [x, y];
    });
    const results = await Promise.allSettled(
      [a, b].map((v) => withTransaction(mdb.db, (tx) => as(APPROVER, () => svc.approve(tx, v.id)))),
    );
    const outcomes = results.map((r) =>
      r.status === 'fulfilled' ? 'approved' : r.reason instanceof AppError ? r.reason.code : String(r.reason),
    );
    expect(outcomes.sort()).toEqual(['RULE_OVERLAP', 'approved']);
  });
});

describe('retrospective versions (P1 §10.7)', () => {
  it('are flagged, need elevated approval and a reason, and name the past range for arrears', async () => {
    await withRollback(mdb.db, async (tx) => {
      const v = await as(CREATOR, () =>
        svc.create(
          tx,
          draft({ scope: { estate: freshEstate().toString() }, effectiveFrom: d('2026-01-01') }),
        ),
      );
      expect(v.isRetrospective).toBe(true);
      await as(CREATOR, () => svc.submit(tx, v.id));
      expect(await codeOf(as(APPROVER, () => svc.approve(tx, v.id)))).toBe('RETROSPECTIVE_APPROVAL_REQUIRED');
      expect(await codeOf(as(APPROVER, () => svc.approve(tx, v.id, { elevated: true })))).toBe(
        'VALIDATION_FAILED',
      );
      const result = await as(APPROVER, () =>
        svc.approve(tx, v.id, { elevated: true, reason: 'Wage settlement backdated to January' }),
      );
      expect(result.version).toMatchObject({ state: 'active', isRetrospective: true });
      expect(result.retrospective).toEqual({ from: '2026-01-01', to: addDays(todayIn(TZ), -1) });
      const approval = await tx.auditChange.findFirst({
        where: { recordType: 'test_rule', recordId: v.id.toString(), action: 'approve' },
      });
      expect(approval?.reason).toBe('Wage settlement backdated to January');
    });
  });

  it('a version that was future when drafted but is approved after it began is retrospective too', async () => {
    await withRollback(mdb.db, async (tx) => {
      const v = await as(CREATOR, () =>
        svc.create(
          tx,
          draft({ scope: { estate: freshEstate().toString() }, effectiveFrom: d('2030-01-01') }),
        ),
      );
      await as(CREATOR, () => svc.submit(tx, v.id));
      const late = ruleVersions(fixture, { timezone: TZ, now: () => new Date('2030-01-10T06:00:00Z') });
      expect(await codeOf(as(APPROVER, () => late.approve(tx, v.id)))).toBe(
        'RETROSPECTIVE_APPROVAL_REQUIRED',
      );
      const done = await as(APPROVER, () =>
        late.approve(tx, v.id, { elevated: true, reason: 'Approved late' }),
      );
      expect(done.version.isRetrospective).toBe(true);
      expect(done.retrospective).toEqual({ from: '2030-01-01', to: '2030-01-09' });
    });
  });
});

describe('data scope on rule tables (P1 §12.3, P4 §4.3)', () => {
  it('an estate user sees organisation-wide rules and their estate, never another estate (404, logged)', async () => {
    const mine = freshEstate();
    const theirs = freshEstate();
    const ids = await withTransaction(mdb.db, async (tx) => ({
      org: (await as(CREATOR, () => svc.create(tx, draft({ scope: {} })))).id,
      mine: (await as(CREATOR, () => svc.create(tx, draft({ scope: { estate: mine.toString() } })))).id,
      theirs: (await as(CREATOR, () => svc.create(tx, draft({ scope: { estate: theirs.toString() } })))).id,
    }));
    const scoped = { estates: [mine] };
    await withRollback(mdb.db, async (tx) => {
      await expect(as(CREATOR, () => svc.get(tx, ids.org), scoped)).resolves.toMatchObject({ id: ids.org });
      await expect(as(CREATOR, () => svc.get(tx, ids.mine), scoped)).resolves.toMatchObject({ id: ids.mine });
      expect(await codeOf(as(CREATOR, () => svc.get(tx, ids.theirs), scoped))).toBe('NOT_FOUND');
      const listed = (await as(CREATOR, () => svc.list(tx, {}), scoped)).map((v) => v.id);
      expect(listed).toEqual(expect.arrayContaining([ids.org, ids.mine]));
      expect(listed).not.toContain(ids.theirs);
    });
    const denial = await mdb.db.accessLog.findFirst({
      where: { eventType: 'scope_denied', module: 'test_rule' },
      orderBy: { id: 'desc' },
    });
    expect(denial).toMatchObject({
      userId: CREATOR,
      recordReference: JSON.stringify({ id: ids.theirs.toString() }),
    });
  });

  it('writing needs the estate in scope, and an organisation-wide rule needs all estates (SCOPE_DENIED)', async () => {
    const mine = freshEstate();
    const scoped = { estates: [mine] };
    await withRollback(mdb.db, async (tx) => {
      await expect(
        as(CREATOR, () => svc.create(tx, draft({ scope: { estate: mine.toString() } })), scoped),
      ).resolves.toMatchObject({ state: 'draft' });
      expect(
        await codeOf(
          as(CREATOR, () => svc.create(tx, draft({ scope: { estate: freshEstate().toString() } })), scoped),
        ),
      ).toBe('SCOPE_DENIED');
      expect(await codeOf(as(CREATOR, () => svc.create(tx, draft({ scope: {} })), scoped))).toBe(
        'SCOPE_DENIED',
      );
      // An organisation-wide rule is visible to the estate user, but not theirs to change.
      const org = await as(CREATOR, () => svc.create(tx, draft({ scope: {} })));
      expect(await codeOf(as(CREATOR, () => svc.submit(tx, org.id), scoped))).toBe('SCOPE_DENIED');
    });
  });

  it('a scoped service refuses to run where no scope was set up', async () => {
    await expect(
      runWithRequestContext({ requestId: 'x', actorId: '1' }, () =>
        withRollback(mdb.db, (tx) => svc.list(tx)),
      ),
    ).rejects.toThrow(/no data scope/i);
  });
});

describe('the /resolve diagnostic (P4 §6.5)', () => {
  it('explains which rule applies and why, and reports ambiguity instead of failing', async () => {
    await withRollback(mdb.db, async (tx) => {
      const e = freshEstate();
      const general = await activate(
        tx,
        draft({ scope: { category: '42' }, effectiveFrom: d('2030-01-01') }),
      );
      const specific = await activate(
        tx,
        draft({ scope: { estate: e.toString(), category: '42' }, effectiveFrom: d('2030-01-01') }),
      );
      const why = await as(ADMIN, () =>
        explainRule(tx, fixture, { estate: e, category: 42n }, d('2030-05-01')),
      );
      expect(why.resolved?.id).toBe(specific.id);
      expect(why.error).toBeNull();
      expect(why.candidates.map((c) => [c.id, c.outcome])).toEqual([
        [specific.id, 'selected'],
        [general.id, 'less_specific'],
      ]);
      expect(why.candidates[0]?.matched).toEqual([
        { key: 'estate', weight: 16 },
        { key: 'category', weight: 8 },
      ]);
      const none = await as(ADMIN, () =>
        explainRule(tx, fixture, { estate: e, category: 43n }, d('2030-05-01')),
      );
      expect(none).toMatchObject({ resolved: null, error: { code: 'RULE_NOT_FOUND' }, candidates: [] });
    });
  });

  it('a user may only ask about an estate in their scope', async () => {
    await withRollback(mdb.db, async (tx) => {
      expect(
        await codeOf(
          as(CREATOR, () => explainRule(tx, fixture, { estate: freshEstate() }, d('2030-01-01')), {
            estates: [1n],
          }),
        ),
      ).toBe('SCOPE_DENIED');
    });
  });

  it('list ?as_of= shows what was in force on a date', async () => {
    await withRollback(mdb.db, async (tx) => {
      const scope = { estate: freshEstate().toString() };
      const v1 = await activate(tx, draft({ scope, effectiveFrom: d('2030-01-01') }));
      const v2 = await as(CREATOR, () =>
        svc.supersede(tx, v1.id, { ...draft(), effectiveFrom: d('2031-01-01') }),
      );
      await as(CREATOR, () => svc.submit(tx, v2.id));
      await as(APPROVER, () => svc.approve(tx, v2.id));
      const at = (on: string) =>
        as(ADMIN, () => svc.list(tx, { ruleCode: v1.ruleCode, asOf: d(on) })).then((l) => l.map((v) => v.id));
      expect(await at('2030-06-01')).toEqual([v1.id]);
      expect(await at('2031-06-01')).toEqual([v2.id]);
      expect(await at('2029-06-01')).toEqual([]);
      expect((await as(ADMIN, () => svc.list(tx, { ruleCode: v1.ruleCode }))).map((v) => v.id)).toEqual([
        v1.id,
        v2.id,
      ]);
    });
  });
});
