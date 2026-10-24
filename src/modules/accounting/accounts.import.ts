import type { Database } from '../../core/db/prisma.js';
import type { Tx } from '../../core/db/transaction.js';
import { Errors } from '../../core/errors/app-error.js';
import { registerImportType, type ImportColumn, type RowError } from '../../core/imports/registry.js';
import { CreateAccountBody } from './accounts.schema.js';
import { accountsService } from './accounts.service.js';
import { ACCOUNT_SUBTYPES, ACCOUNT_TYPES, CONTROL_SUBLEDGERS, NORMAL_BALANCES } from './chart.js';

/**
 * accounting.account (D-3.01-11): the estate's own chart, when it has one (O-39, P8 §1.2). Each row is an
 * account, written exactly as one typed in (the service checks, audits and keeps the tree).
 *
 *   - Parents are named by code and must come before their children in the file: rows commit in order.
 *   - A row with system_key re-codes, renames and re-parents that system account instead of creating one,
 *     so the application's control and closing accounts take the estate's codes (before the sign-off).
 *   - New accounts only: a code already in the chart is refused (an import never overwrites, D-1.17-6).
 */

const MAX_ROWS = 2000;
const TRUE = new Set(['yes', 'y', 'true', '1']);
const FALSE = new Set(['no', 'n', 'false', '0']);

type Row =
  | { readonly mode: 'create'; readonly parent: string | null; readonly body: Record<string, unknown> }
  | {
      readonly mode: 'recode';
      readonly systemKey: string;
      readonly parent: string | null;
      readonly code: string;
      readonly name: string;
    };

const BOOL_COLUMNS = [
  'is_postable',
  'is_control_account',
  'is_bank_or_cash',
  'requires_cost_centre',
  'requires_estate',
  'is_clearing',
] as const;

const COLUMNS: ImportColumn[] = [
  {
    name: 'code',
    required: true,
    description: 'Unique in the chart; letters, digits, . _ - /',
    example: '1210',
  },
  { name: 'name', required: true, description: 'Text, up to 150 characters', example: 'Trade Debtors' },
  {
    name: 'parent',
    required: false,
    description:
      'The parent account’s code, listed earlier in the file or already in the chart. Empty for a top-level account',
    example: '1200',
  },
  {
    name: 'account_type',
    required: false,
    description: `One of: ${ACCOUNT_TYPES.join(', ')}. Required for a top-level account; otherwise the parent’s`,
    example: 'asset',
  },
  {
    name: 'account_subtype',
    required: false,
    description: `One of: ${ACCOUNT_SUBTYPES.join(', ')}. Default the parent’s`,
    example: 'current_asset',
  },
  {
    name: 'is_postable',
    required: false,
    description: 'yes or no. Default yes; a group is no',
    example: 'yes',
  },
  { name: 'is_control_account', required: false, description: 'yes or no. Default no', example: 'yes' },
  {
    name: 'control_subledger',
    required: false,
    description: `For a control account, one of: ${CONTROL_SUBLEDGERS.join(', ')}`,
    example: 'receivable',
  },
  { name: 'is_bank_or_cash', required: false, description: 'yes or no. Default no', example: 'no' },
  {
    name: 'currency',
    required: false,
    description:
      'For a foreign-currency bank account: the currency code, e.g. USD. Empty means base currency',
    example: '',
  },
  {
    name: 'requires_cost_centre',
    required: false,
    description: 'yes or no. Default yes for a postable expense account, otherwise no',
    example: 'no',
  },
  { name: 'requires_estate', required: false, description: 'yes or no. Default no', example: 'no' },
  {
    name: 'is_clearing',
    required: false,
    description: 'yes or no: must be nil at period close. Default no',
    example: 'no',
  },
  {
    name: 'normal_balance',
    required: false,
    description: `Only for a contra account: ${NORMAL_BALANCES.join(' or ')}. Default from the type`,
    example: '',
  },
  {
    name: 'system_key',
    required: false,
    description:
      'Give the key of a system account (GET /accounts?filter[is_system]=true) to re-code it to this row instead of creating an account',
    example: 'ar_tea_sales',
  },
];

async function accountIdByCode(tx: Tx, code: string): Promise<bigint | null> {
  return (await tx.account.findUnique({ where: { code }, select: { id: true } }))?.id ?? null;
}

export function registerAccountingImports(db: Database): void {
  const svc = accountsService(db);

  registerImportType<Row>({
    key: 'accounting.account',
    label: 'Chart of accounts',
    permission: 'accounting',
    columns: COLUMNS,
    maxRows: MAX_ROWS,

    async check(row, tx) {
      const errors: RowError[] = [];
      const code = row.code ?? '';
      const parent = (row.parent ?? '') === '' ? null : (row.parent ?? null);
      const systemKey = row.system_key ?? '';

      if (systemKey !== '') {
        const target = await tx.account.findUnique({
          where: { systemKey },
          select: { id: true, code: true },
        });
        if (!target)
          errors.push({
            column: 'system_key',
            code: 'VALIDATION_FAILED',
            message: `No system account ${systemKey}.`,
          });
        else if (code !== target.code && (await accountIdByCode(tx, code)) !== null)
          errors.push({ column: 'code', code: 'DUPLICATE_KEY', message: `${code} is already in the chart.` });
        const name = row.name ?? '';
        if (code === '') errors.push({ column: 'code', code: 'VALIDATION_FAILED', message: 'Required.' });
        if (name === '') errors.push({ column: 'name', code: 'VALIDATION_FAILED', message: 'Required.' });
        if (errors.length > 0) return { ok: false, errors };
        return { ok: true, value: { mode: 'recode', systemKey, parent, code, name }, key: code };
      }

      const body: Record<string, unknown> = { code, name: row.name ?? '' };
      for (const column of [
        'account_type',
        'account_subtype',
        'control_subledger',
        'normal_balance',
      ] as const) {
        const v = (row[column] ?? '').toLowerCase();
        if (v !== '') body[column] = v;
      }
      for (const column of BOOL_COLUMNS) {
        const v = (row[column] ?? '').toLowerCase();
        if (v === '') continue;
        if (TRUE.has(v)) body[column] = true;
        else if (FALSE.has(v)) body[column] = false;
        else errors.push({ column, code: 'VALIDATION_FAILED', message: 'Must be yes or no.' });
      }
      const currency = row.currency ?? '';
      if (currency !== '') {
        const c = await tx.currency.findUnique({
          where: { code: currency.toUpperCase() },
          select: { id: true },
        });
        if (!c)
          errors.push({ column: 'currency', code: 'VALIDATION_FAILED', message: `No currency ${currency}.` });
        else body.currency_id = c.id.toString();
      }
      const parsed = CreateAccountBody.safeParse(body);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const column = String(issue.path[0] ?? '');
          if (errors.some((e) => e.column === column)) continue;
          errors.push({
            column,
            code: 'VALIDATION_FAILED',
            message: (row[column] ?? '') === '' ? 'Required.' : issue.message,
          });
        }
      }
      if (errors.length === 0 && (await accountIdByCode(tx, code)) !== null) {
        errors.push({
          column: 'code',
          code: 'DUPLICATE_KEY',
          message: `${code} is already in the chart. An import adds new accounts only.`,
        });
      }
      if (parent === null && body.account_type === undefined) {
        errors.push({
          column: 'account_type',
          code: 'VALIDATION_FAILED',
          message: 'A top-level account gives its type.',
        });
      }
      if (errors.length > 0) return { ok: false, errors };
      return { ok: true, value: { mode: 'create', parent, body }, key: code };
    },

    async commit(value, tx, actorId) {
      let parentId: string | null = null;
      if (value.parent !== null) {
        const id = await accountIdByCode(tx, value.parent);
        if (id === null) {
          throw Errors.validation([
            {
              field: 'parent',
              code: 'VALIDATION_FAILED',
              message: `No account ${value.parent}: list a parent before its children.`,
            },
          ]);
        }
        parentId = id.toString();
      }
      if (value.mode === 'recode') {
        const target = await tx.account.findUnique({
          where: { systemKey: value.systemKey },
          select: { id: true },
        });
        if (!target) throw Errors.notFound(`No system account ${value.systemKey}.`);
        const out = await svc.updateIn(
          tx,
          target.id,
          null,
          { code: value.code, name: value.name, parent_id: parentId === null ? null : BigInt(parentId) },
          actorId,
        );
        return out.id;
      }
      const out = await svc.createIn(
        tx,
        CreateAccountBody.parse({ ...value.body, parent_id: parentId }),
        actorId,
      );
      return out.id;
    },
  });
}
