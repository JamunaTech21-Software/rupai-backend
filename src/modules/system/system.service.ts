import { createHash } from 'node:crypto';

import type { z } from 'zod';

import { auditCreate, auditDelete, auditUpdate, type AuditedRecord } from '../../core/audit/audit.js';
import { toOrderBy, toPaging, toWhere, type ListFieldMap } from '../../core/db/list.js';
import type { Database } from '../../core/db/prisma.js';
import { withTransaction, type Tx } from '../../core/db/transaction.js';
import { AppError, Errors, type ErrorDetail } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  DOCUMENT_TYPE_BY_KEY,
  DOCUMENT_TYPES,
  type NumberComponent,
} from '../../core/numbering/document-types.js';
import {
  numberParts,
  renderNumber,
  type NumberContext,
  type ResetFrequency,
} from '../../core/numbering/numbering.js';
import {
  encryptionUnavailable,
  settingFromText,
  settingToText,
  type SettingsCipher,
  type SettingType,
  type SettingValue,
} from '../../core/settings/settings.js';
import type { Seeder } from '../../core/db/seed.js';
import { todayIn, type BusinessDate } from '../../core/time/dates.js';
import type { NumberFormat, Prisma, SystemSetting } from '../../generated/prisma/client.js';
import { BOOTSTRAP_ADMIN_ID } from '../identity/identity.seed.js';
import { iso } from '../organisation/common.js';
import type {
  CreateSettingBody,
  NumberFormatOut,
  PatchNumberFormatBody,
  PatchSettingBody,
  PreviewQuery,
  SettingOut,
} from './system.schema.js';

/**
 * Number formats and system settings (Spec P3 §28.6, P2 §6.5, P4 §14: /number-formats, /settings).
 *
 * NUMBER FORMATS. There is exactly one per document type the system has (core/numbering/document-types),
 * created by the seed. The client edits how numbers look: prefix, which components appear, separator,
 * width, reset. It cannot add or remove a document type, switch on a component the document does not
 * have, or change is_gapless: gapless numbering is a property of financial documents, allocated at
 * posting (BACKLOG D-1.11-2). A change applies to numbers allocated from then on.
 *
 * SETTINGS. Typed values by dotted key. An encrypted setting is stored as ciphertext and is WRITE-ONLY:
 * the API returns value null with has_value, and the audit records that it changed, never what to.
 */

type NumberFormatOutT = z.infer<typeof NumberFormatOut>;
type SettingOutT = z.infer<typeof SettingOut>;

export const NUMBER_FORMAT_AUDIT: AuditedRecord = {
  type: 'number_format',
  class: 'master',
  fields: [
    'prefix',
    'include_fiscal_year',
    'include_season',
    'include_estate_code',
    'separator',
    'sequence_width',
    'reset_frequency',
  ],
};
export const SETTING_AUDIT: AuditedRecord = {
  type: 'system_setting',
  class: 'master',
  fields: ['key', 'group', 'value_type', 'is_encrypted', 'value', 'description'],
};

export const NUMBER_FORMAT_LIST_FIELDS: ListFieldMap = {
  document_type: { field: 'documentType' },
  is_gapless: { field: 'isGapless', convert: (v) => v === true || v === 'true' },
};
export const SETTING_LIST_FIELDS: ListFieldMap = {
  key: { field: 'settingKey' },
  group: { field: 'settingGroup' },
  is_encrypted: { field: 'isEncrypted', convert: (v) => v === true || v === 'true' },
};

/** Sample codes, so an example number can be shown without real documents. */
const SAMPLE = { estateCode: 'EST', fiscalYearCode: 'FY2026-27', seasonCode: '2026-27' } as const;

const invalid = (field: string, message: string): ErrorDetail => ({
  field,
  code: 'VALIDATION_FAILED',
  message,
});

export function toNumberFormatOut(f: NumberFormat, today: BusinessDate): NumberFormatOutT {
  const doc = DOCUMENT_TYPE_BY_KEY.get(f.documentType);
  return {
    id: f.id.toString(),
    document_type: f.documentType,
    label: doc?.label ?? f.documentType,
    lifecycle: doc?.lifecycle ?? (f.isGapless ? 'financial' : 'operational'),
    available_components: [...(doc?.components ?? [])],
    prefix: f.prefix,
    include_fiscal_year: f.includeFiscalYear,
    include_season: f.includeSeason,
    include_estate_code: f.includeEstateCode,
    separator: f.separator,
    sequence_width: f.sequenceWidth,
    reset_frequency: f.resetFrequency as ResetFrequency,
    is_gapless: f.isGapless,
    example: renderNumber(f, { date: today, ...SAMPLE }, 1),
    version: f.version,
    updated_at: iso(f.updatedAt),
  };
}

export function numberFormatsService(db: Database, timezone: string) {
  const today = () => todayIn(timezone);
  async function orNotFound(tx: Database | Tx, id: bigint): Promise<NumberFormat> {
    const f = await tx.numberFormat.findUnique({ where: { id } });
    if (!f) throw Errors.notFound('Number format not found.');
    return f;
  }

  return {
    async list(q: ListQuery) {
      const where = toWhere(q, NUMBER_FORMAT_LIST_FIELDS) as Prisma.NumberFormatWhereInput;
      const [rows, total] = await Promise.all([
        db.numberFormat.findMany({
          where,
          orderBy: [...toOrderBy(q.sort, NUMBER_FORMAT_LIST_FIELDS), { id: 'asc' }],
          ...toPaging(q),
        }),
        db.numberFormat.count({ where }),
      ]);
      return { items: rows.map((r) => toNumberFormatOut(r, today())), total };
    },

    async get(id: bigint) {
      return toNumberFormatOut(await orNotFound(db, id), today());
    },

    async update(
      id: bigint,
      expectedVersion: number,
      b: z.infer<typeof PatchNumberFormatBody>,
      actorId: bigint,
    ) {
      return withTransaction(db, async (tx) => {
        const before = await orNotFound(tx, id);
        const supported = new Set<NumberComponent>(
          DOCUMENT_TYPE_BY_KEY.get(before.documentType)?.components ?? [],
        );
        const wants: [NumberComponent, boolean, string][] = [
          ['estate', b.include_estate_code ?? before.includeEstateCode, 'include_estate_code'],
          ['fiscal_year', b.include_fiscal_year ?? before.includeFiscalYear, 'include_fiscal_year'],
          ['season', b.include_season ?? before.includeSeason, 'include_season'],
        ];
        const problems = wants
          .filter(([component, on]) => on && !supported.has(component))
          .map(([component, , field]) =>
            invalid(field, `this document has no ${component.replace('_', ' ')}`),
          );
        if (problems.length > 0) throw Errors.validation(problems);
        const { count } = await tx.numberFormat.updateMany({
          where: { id, version: expectedVersion },
          data: {
            ...(b.prefix !== undefined ? { prefix: b.prefix } : {}),
            ...(b.include_fiscal_year !== undefined ? { includeFiscalYear: b.include_fiscal_year } : {}),
            ...(b.include_season !== undefined ? { includeSeason: b.include_season } : {}),
            ...(b.include_estate_code !== undefined ? { includeEstateCode: b.include_estate_code } : {}),
            ...(b.separator !== undefined ? { separator: b.separator } : {}),
            ...(b.sequence_width !== undefined ? { sequenceWidth: b.sequence_width } : {}),
            ...(b.reset_frequency !== undefined ? { resetFrequency: b.reset_frequency } : {}),
            version: { increment: 1 },
            updatedAt: new Date(),
            updatedBy: actorId,
          },
        });
        if (count !== 1)
          throw Errors.versionConflict({
            version: before.version,
            resource: toNumberFormatOut(before, today()),
          });
        const after = toNumberFormatOut(await orNotFound(tx, id), today());
        await auditUpdate(tx, NUMBER_FORMAT_AUDIT, id, toNumberFormatOut(before, today()), after, {
          actorId,
        });
        return after;
      });
    },

    /** The next number in a scope, WITHOUT allocating it. */
    async preview(id: bigint, query: z.infer<typeof PreviewQuery>) {
      const f = await orNotFound(db, id);
      const ctx: NumberContext = {
        date: query.date ?? today(),
        estateCode: query.estate_code ?? (f.includeEstateCode ? SAMPLE.estateCode : null),
        fiscalYearCode: query.fiscal_year_code ?? (f.includeFiscalYear ? SAMPLE.fiscalYearCode : null),
        seasonCode: query.season_code ?? (f.includeSeason ? SAMPLE.seasonCode : null),
      };
      const { scopeKey } = numberParts(f, ctx);
      const seq = await db.numberSequence.findUnique({
        where: { documentType_scopeKey: { documentType: f.documentType, scopeKey } },
      });
      const last = seq?.lastNumber ?? 0n;
      return {
        next_number: renderNumber(f, ctx, last + 1n),
        scope_key: scopeKey,
        last_number: last.toString(),
      };
    },

    async sequences(id: bigint) {
      const f = await orNotFound(db, id);
      const rows = await db.numberSequence.findMany({
        where: { documentType: f.documentType },
        orderBy: { scopeKey: 'asc' },
      });
      return rows.map((r) => ({
        scope_key: r.scopeKey,
        last_number: r.lastNumber.toString(),
        updated_at: r.updatedAt.toISOString(),
      }));
    },
  };
}

/**
 * One number format per document type (P3 Table 31.2: "one row per document type with sensible
 * prefixes"). Insert-only: the client's edits are never overwritten. Financial documents count within the
 * fiscal year and are gapless; operational ones restart each year.
 */
export const numberFormatSeeder: Seeder = {
  name: 'numbering: one number format per document type',
  async run(tx) {
    let inserted = 0;
    for (const doc of DOCUMENT_TYPES) {
      if (await tx.numberFormat.findUnique({ where: { documentType: doc.key }, select: { id: true } }))
        continue;
      const financial = doc.lifecycle === 'financial';
      await tx.numberFormat.create({
        data: {
          documentType: doc.key,
          prefix: doc.prefix,
          includeEstateCode: doc.components.includes('estate'),
          includeFiscalYear: financial && doc.components.includes('fiscal_year'),
          includeSeason: false,
          separator: '-',
          sequenceWidth: 5,
          resetFrequency: financial ? 'never' : 'yearly',
          isGapless: financial,
          createdBy: BOOTSTRAP_ADMIN_ID,
        },
      });
      inserted += 1;
    }
    return { inserted, updated: 0 };
  },
};

// ---- settings ---------------------------------------------------------------------------------------

/**
 * Settings a module writes itself and the generic /settings API never may: they record a controlled act
 * (P3.01: the accountant's sign-off that activates the chart, D-3.01-9). Readable like any other.
 */
export const RESERVED_SETTINGS: ReadonlySet<string> = new Set(['accounting.chart_sign_off']);
function assertNotReserved(key: string): void {
  if (RESERVED_SETTINGS.has(key)) {
    throw new AppError('SYSTEM_RECORD', `Setting ${key} is written only by the system.`, [
      { field: 'key', code: 'SYSTEM_RECORD', message: 'is written only by the system' },
    ]);
  }
}

export function settingsService(db: Database, cipher: SettingsCipher | null) {
  /** What the API shows. An encrypted value never leaves the server. */
  function toOut(s: SystemSetting): SettingOutT {
    return {
      id: s.id.toString(),
      key: s.settingKey,
      group: s.settingGroup,
      value_type: s.valueType as SettingType,
      is_encrypted: s.isEncrypted,
      value: s.isEncrypted ? null : settingFromText(s.valueType as SettingType, s.settingValue),
      has_value: s.settingValue !== null,
      description: s.description,
      version: s.version,
      updated_at: iso(s.updatedAt),
      updated_by: s.updatedBy?.toString() ?? null,
    };
  }
  /** What the audit records: an encrypted value as a fingerprint of its ciphertext (changed, not what to). */
  function auditValues(s: SystemSetting) {
    const out = toOut(s);
    const value =
      s.settingValue === null
        ? null
        : s.isEncrypted
          ? `[encrypted ${createHash('sha256').update(s.settingValue).digest('hex').slice(0, 8)}]`
          : s.settingValue;
    return { ...out, value };
  }
  function store(type: SettingType, encrypted: boolean, value: unknown): string | null {
    const result = settingToText(type, value as SettingValue);
    if ('error' in result) throw Errors.validation([invalid('value', result.error)]);
    if (result.text === null || !encrypted) return result.text;
    if (!cipher) throw encryptionUnavailable();
    return cipher.encrypt(result.text);
  }
  async function orNotFound(tx: Database | Tx, id: bigint): Promise<SystemSetting> {
    const s = await tx.systemSetting.findUnique({ where: { id } });
    if (!s) throw Errors.notFound('Setting not found.');
    return s;
  }

  return {
    async list(q: ListQuery) {
      const where = toWhere(q, SETTING_LIST_FIELDS) as Prisma.SystemSettingWhereInput;
      const [rows, total] = await Promise.all([
        db.systemSetting.findMany({
          where,
          orderBy: [...toOrderBy(q.sort, SETTING_LIST_FIELDS), { id: 'asc' }],
          ...toPaging(q),
        }),
        db.systemSetting.count({ where }),
      ]);
      return { items: rows.map(toOut), total };
    },

    async get(id: bigint) {
      return toOut(await orNotFound(db, id));
    },

    async create(b: z.infer<typeof CreateSettingBody>, actorId: bigint) {
      assertNotReserved(b.key);
      return withTransaction(db, async (tx) => {
        if (await tx.systemSetting.findUnique({ where: { settingKey: b.key }, select: { id: true } })) {
          throw new AppError('DUPLICATE_KEY', `Setting ${b.key} already exists.`, [
            { field: 'key', code: 'DUPLICATE_KEY', message: 'is already in use' },
          ]);
        }
        const encrypted = b.is_encrypted ?? false;
        const row = await tx.systemSetting.create({
          data: {
            settingKey: b.key,
            valueType: b.value_type,
            settingGroup: b.group ?? b.key.slice(0, b.key.indexOf('.')),
            isEncrypted: encrypted,
            settingValue: store(b.value_type, encrypted, b.value ?? null),
            description: b.description ?? null,
            createdBy: actorId,
          },
        });
        await auditCreate(tx, SETTING_AUDIT, row.id, auditValues(row), { actorId });
        return toOut(row);
      });
    },

    async update(id: bigint, expectedVersion: number, b: z.infer<typeof PatchSettingBody>, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const before = await orNotFound(tx, id);
        assertNotReserved(before.settingKey);
        const { count } = await tx.systemSetting.updateMany({
          where: { id, version: expectedVersion },
          data: {
            ...(b.group !== undefined ? { settingGroup: b.group } : {}),
            ...(b.description !== undefined ? { description: b.description } : {}),
            ...(b.value !== undefined
              ? { settingValue: store(before.valueType as SettingType, before.isEncrypted, b.value) }
              : {}),
            version: { increment: 1 },
            updatedAt: new Date(),
            updatedBy: actorId,
          },
        });
        if (count !== 1) throw Errors.versionConflict({ version: before.version, resource: toOut(before) });
        const after = await orNotFound(tx, id);
        await auditUpdate(tx, SETTING_AUDIT, id, auditValues(before), auditValues(after), { actorId });
        return toOut(after);
      });
    },

    async remove(id: bigint, actorId: bigint) {
      await withTransaction(db, async (tx) => {
        const s = await orNotFound(tx, id);
        assertNotReserved(s.settingKey);
        await tx.systemSetting.delete({ where: { id } });
        await auditDelete(tx, SETTING_AUDIT, id, auditValues(s), { actorId });
      });
    },
  };
}
