import type { Seeder } from '../../core/db/seed.js';
import type { Tx } from '../../core/db/transaction.js';
import { Prisma } from '../../generated/prisma/client.js';
import { BOOTSTRAP_ADMIN_ID } from '../identity/identity.seed.js';
import { COUNTRIES } from './countries.js';

/**
 * Seed data of the reference masters (Spec P3 Table 31.1). Mechanism ships active; department,
 * designation, worker_category and shift ship EMPTY, because they are the client's own.
 *
 * INSERT-ONLY: a row is added when its code is missing and is never updated afterwards. These rows are
 * "client-editable" (P3 §31.1): a re-seed must not undo a rename, a re-ordering or a deactivation.
 * is_system rows (kg, pc, the unit categories, the opening-balance reason) are the ones application logic
 * refers to by code.
 */

type Row = Readonly<Record<string, string | number | boolean | bigint | null>>;
const q = (name: string) => Prisma.raw(`\`${name}\``);

/** Inserts the row unless one with its key exists. Returns 1 when inserted. */
async function ensure(tx: Tx, table: string, key: string, row: Row): Promise<number> {
  const data: Record<string, unknown> = { ...row, created_by: BOOTSTRAP_ADMIN_ID };
  const cols = Object.keys(data);
  return tx.$executeRaw(Prisma.sql`
    INSERT INTO ${q(table)} (${Prisma.join(cols.map(q))})
    SELECT ${Prisma.join(cols.map((c) => data[c]))} FROM DUAL
    WHERE NOT EXISTS (SELECT 1 FROM ${q(table)} WHERE ${q(key)} = ${row[key]})`);
}

async function idOf(tx: Tx, table: string, code: string): Promise<bigint> {
  const rows = await tx.$queryRaw<{ id: bigint }[]>(
    Prisma.sql`SELECT id FROM ${q(table)} WHERE code = ${code}`,
  );
  if (!rows[0]) throw new Error(`seed: ${table} ${code} is missing`);
  return rows[0].id;
}

/** code, name → rows in display order. */
const plain = (rows: readonly (readonly [string, string, boolean?])[]): Row[] =>
  rows.map(([code, name, system], i) => ({
    code,
    name,
    sort_order: (i + 1) * 10,
    is_system: system ?? false,
  }));

const COMMON_SEEDS: Readonly<Record<string, Row[]>> = {
  // P3 Table 31.2 lists leave types with the platform seeds: active, client-editable.
  leave_type: plain([
    ['CASUAL', 'Casual leave'],
    ['SICK', 'Sick leave'],
    ['EARNED', 'Earned leave'],
    ['MATERNITY', 'Maternity leave'],
    ['UNPAID', 'Unpaid leave'],
  ]),
  // R.2: the estate profile's facility checkboxes (the manager's design). Factories are not here: an
  // estate has one when the factory register says so.
  amenity: plain([
    ['WAREHOUSE', 'Warehouse'],
    ['STAFF_QUARTER', 'Staff quarter'],
    ['HOSPITAL', 'Hospital / dispensary'],
    ['SCHOOL', 'School'],
    ['PLAYGROUND', 'Playground'],
    ['RELIGIOUS', 'Mosque / temple'],
    ['ELECTRICITY', 'Electricity'],
    ['WATER_SUPPLY', 'Water supply'],
    ['TRANSPORT', 'Transport'],
    ['CANTEEN', 'Canteen'],
    ['CLUB_LIBRARY', 'Club & library'],
  ]),
  land_type: plain([
    ['TEA', 'Tea'],
    ['SHADE', 'Shade'],
    ['HOUSING', 'Housing'],
    ['ROAD', 'Road'],
    ['WATER_BODY', 'Water body'],
    ['WASTE', 'Waste'],
    ['OTHER', 'Other'],
  ]),
  buyer_type: plain([
    ['LOCAL', 'Local'],
    ['PACKER', 'Packer'],
  ]),
  trading_type: plain([
    ['INTERNAL', 'Internal'],
    ['EXPORT', 'Export'],
    ['BOTH', 'Both'],
  ]),
  charge_type: plain([
    ['BROKER_COMMISSION', 'Broker commission'],
    ['CESS', 'Cess'],
    ['WAREHOUSE_CHARGE', 'Warehouse charge'],
    ['CATALOGUE_FEE', 'Catalogue fee'],
    ['TRANSPORT', 'Transport'],
  ]),
  adjustment_reason: plain([
    ['COUNT_VARIANCE', 'Physical count variance'],
    ['DAMAGE', 'Damage'],
    ['SPOILAGE', 'Spoilage'],
    ['WRITE_OFF', 'Write-off'],
    ['REVALUATION', 'Revaluation'],
    ['OPENING_BALANCE', 'Opening balance', true],
  ]),
  payment_method: plain([
    ['CASH', 'Cash'],
    ['BANK_TRANSFER', 'Bank transfer'],
    ['CHEQUE', 'Cheque'],
    ['MOBILE_BANKING', 'Mobile banking'],
  ]),
  document_type: plain([
    ['NID', 'National ID'],
    ['LICENCE', 'Licence'],
    ['AGREEMENT', 'Agreement'],
    ['OWNERSHIP_DEED', 'Ownership deed'],
    ['TAX_DOCUMENT', 'Tax document'],
    ['PHOTOGRAPH', 'Photograph'],
    ['OTHER', 'Other'],
  ]),
  packaging_type: plain([
    ['PAPER_SACK', 'Paper sack'],
    ['TEA_CHEST', 'Tea chest'],
    ['JUTE_BAG', 'Jute bag'],
    ['CARTON', 'Carton'],
  ]),
};

/** category → [code, name, precision, factor to the base, is_base, is_system] */
const UOMS: Readonly<
  Record<string, readonly (readonly [string, string, number, string | null, boolean, boolean])[]>
> = {
  WEIGHT: [
    ['kg', 'Kilogram', 3, '1', true, true],
    ['g', 'Gram', 3, '0.001', false, false],
    ['ton', 'Tonne', 3, '1000', false, false],
  ],
  VOLUME: [['ltr', 'Litre', 3, '1', true, false]],
  LENGTH: [['m', 'Metre', 3, '1', true, false]],
  COUNT: [
    ['pc', 'Piece', 0, '1', true, true],
    ['bag', 'Bag', 0, null, false, false],
    ['box', 'Box', 0, null, false, false],
    ['carton', 'Carton', 0, null, false, false],
    ['roll', 'Roll', 0, null, false, false],
  ],
};

const TEA_TYPES = [
  ['CTC', 'CTC', 'ctc'],
  ['ORTHODOX', 'Orthodox', 'orthodox'],
  ['GREEN', 'Green', 'green'],
  ['OOLONG', 'Oolong', 'oolong'],
  ['WHITE', 'White', 'white'],
] as const;

/** code, name, grade category, the tea type it belongs to (null: valid for every type). */
const TEA_GRADES = [
  ['BOP', 'Broken Orange Pekoe', 'broken', null],
  ['BOPF', 'Broken Orange Pekoe Fannings', 'fannings', null],
  ['BP', 'Broken Pekoe', 'broken', 'CTC'],
  ['PF', 'Pekoe Fannings', 'fannings', 'CTC'],
  ['OF', 'Orange Fannings', 'fannings', 'CTC'],
  ['PD', 'Pekoe Dust', 'dust', 'CTC'],
  ['DUST', 'Dust', 'dust', 'CTC'],
  ['OP', 'Orange Pekoe', 'leaf', 'ORTHODOX'],
  ['FOP', 'Flowery Orange Pekoe', 'leaf', 'ORTHODOX'],
  ['GFOP', 'Golden Flowery Orange Pekoe', 'leaf', 'ORTHODOX'],
  ['TGFOP', 'Tippy Golden Flowery Orange Pekoe', 'leaf', 'ORTHODOX'],
  ['FBOP', 'Flowery Broken Orange Pekoe', 'broken', 'ORTHODOX'],
] as const;

/** code, name, cost pool (P1 §9.1), needs material. */
const ACTIVITY_TYPES = [
  ['PRUNING', 'Pruning', 'cultivation', false],
  ['FERTILISATION', 'Fertilisation', 'cultivation', true],
  ['IRRIGATION', 'Irrigation', 'cultivation', false],
  ['WEEDING', 'Weeding', 'maintenance', false],
  ['PEST_CONTROL', 'Pest control', 'protection', true],
  ['DRAINAGE', 'Drainage', 'maintenance', false],
  ['SHADE_MANAGEMENT', 'Shade management', 'maintenance', false],
  ['SOIL_MANAGEMENT', 'Soil management', 'cultivation', false],
  ['MAINTENANCE', 'Maintenance', 'maintenance', false],
] as const;

const CURRENCIES = [
  ['BDT', 'Bangladeshi taka', '৳', true],
  ['USD', 'US dollar', '$', false],
  ['EUR', 'Euro', '€', false],
  ['GBP', 'Pound sterling', '£', false],
] as const;

export const lookupSeeder: Seeder = {
  name: 'lookups: units, currencies, countries, tea types and grades, reference lists (P3 Table 31.1)',
  async run(tx) {
    let inserted = 0;

    for (const [table, rows] of Object.entries(COMMON_SEEDS)) {
      for (const row of rows) inserted += await ensure(tx, table, 'code', row);
    }

    // Units: categories first, then their units, then each category's base unit (a circular reference).
    const categories = [
      ['WEIGHT', 'Weight'],
      ['VOLUME', 'Volume'],
      ['LENGTH', 'Length'],
      ['COUNT', 'Count'],
    ] as const;
    for (const [i, [code, name]] of categories.entries()) {
      inserted += await ensure(tx, 'uom_category', 'code', {
        code,
        name,
        sort_order: (i + 1) * 10,
        is_system: true,
      });
      const categoryId = await idOf(tx, 'uom_category', code);
      for (const [uom, uomName, precision, factor, isBase, isSystem] of UOMS[code] ?? []) {
        // A category that already has a base keeps it: a second base would break ux_uom_base.
        const hasBase =
          (
            await tx.$queryRaw<
              unknown[]
            >`SELECT 1 FROM uom WHERE uom_category_id = ${categoryId} AND is_base = 1 LIMIT 1`
          ).length > 0;
        inserted += await ensure(tx, 'uom', 'code', {
          uom_category_id: categoryId,
          code: uom,
          name: uomName,
          decimal_precision: precision,
          conversion_factor: factor,
          is_base: isBase && !hasBase,
          is_system: isSystem,
        });
      }
      await tx.$executeRaw`
        UPDATE uom_category SET base_uom_id = (SELECT id FROM uom WHERE uom_category_id = ${categoryId} AND is_base = 1)
        WHERE id = ${categoryId} AND base_uom_id IS NULL`;
    }

    const hasBaseCurrency =
      (await tx.$queryRaw<unknown[]>`SELECT 1 FROM currency WHERE is_base = 1 LIMIT 1`).length > 0;
    for (const [code, name, symbol, isBase] of CURRENCIES) {
      inserted += await ensure(tx, 'currency', 'code', {
        code,
        name,
        symbol,
        decimal_places: 2,
        is_base: isBase && !hasBaseCurrency,
      });
    }
    for (const [iso2, iso3, dialling, name] of COUNTRIES) {
      inserted += await ensure(tx, 'country', 'iso2', { iso2, iso3, name, dialling_code: dialling });
    }

    for (const [i, [code, name, process]] of TEA_TYPES.entries()) {
      inserted += await ensure(tx, 'tea_type', 'code', {
        code,
        name,
        manufacture_process: process,
        sort_order: (i + 1) * 10,
      });
    }
    for (const [i, [code, name, category, type]] of TEA_GRADES.entries()) {
      inserted += await ensure(tx, 'tea_grade', 'code', {
        code,
        name,
        grade_category: category,
        tea_type_id: type === null ? null : await idOf(tx, 'tea_type', type),
        sort_order: (i + 1) * 10,
      });
    }
    for (const [i, [code, name, cost, material]] of ACTIVITY_TYPES.entries()) {
      inserted += await ensure(tx, 'activity_type', 'code', {
        code,
        name,
        cost_category: cost,
        requires_material: material,
        sort_order: (i + 1) * 10,
      });
    }
    return { inserted, updated: 0 };
  },
};
