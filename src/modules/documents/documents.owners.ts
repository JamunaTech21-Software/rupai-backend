import type { Database } from '../../core/db/prisma.js';
import type { Tx } from '../../core/db/transaction.js';
import type { ItemPlace } from '../../core/notify/notify.js';
import { writable } from '../organisation/common.js';
import { personWritable } from '../workforce/person.access.js';

/**
 * What a document can be attached to (Spec P2 §6.2: a polymorphic owner). The OWNER decides who may see
 * and change its documents:
 *
 *   - permission: {module}.view to read and download, {module}.edit to add, replace or correct,
 *     {module}.delete to remove (P4 §6.6)
 *   - scope: every call first reads the owner through its own scoped model, so a document of an estate
 *     outside the caller's scope is 404, like the estate itself
 *
 * Adding an owner: one entry here. Its `/{path}/{id}/documents` endpoints then exist, and its documents
 * appear on the expiring-documents list. person (P2.01); employment profile, land parcel, lease,
 * supplier and buyer join as their modules arrive.
 */
export interface DocumentOwner {
  /** owner_type as stored: the table name. */
  readonly type: string;
  /** The owner's collection path under /api/v1. */
  readonly path: string;
  /** The permission module guarding the owner. */
  readonly module: string;
  readonly label: string;
  /** The owners among `ids` that exist AND are in the caller's scope, with a display label each. */
  find(db: Database | Tx, ids: readonly bigint[]): Promise<Map<bigint, string>>;
  /** Whether the caller's scope may CHANGE this owner (a parent seen through a child grant is read-only). */
  writable(db: Database | Tx, id: bigint): Promise<boolean>;
  /** Where each owner sits, for scope: who may hear of its documents (P1.16 expiry alerts). */
  places(db: Database | Tx, ids: readonly bigint[]): Promise<Map<bigint, ItemPlace>>;
}

const byId = <T extends { id: bigint }>(rows: readonly T[], place: (r: T) => ItemPlace) =>
  new Map(rows.map((r) => [r.id, place(r)]));

const named = (rows: readonly { id: bigint; code: string; name: string }[]) =>
  new Map(rows.map((r) => [r.id, `${r.code} · ${r.name}`]));
const select = { id: true, code: true, name: true } as const;
const always = () => Promise.resolve(true);

export const DOCUMENT_OWNERS: readonly DocumentOwner[] = [
  {
    type: 'estate',
    path: '/estates',
    module: 'estate',
    label: 'estate',
    find: async (db, ids) => named(await db.estate.findMany({ where: { id: { in: [...ids] } }, select })),
    writable: (_db, id) => writable({ estate: id }),
    places: (_db, ids) => Promise.resolve(new Map(ids.map((id) => [id, { estateId: id }]))),
  },
  {
    type: 'field',
    path: '/fields',
    module: 'field',
    label: 'field',
    find: async (db, ids) => {
      const rows = await db.field.findMany({
        where: { id: { in: [...ids] } },
        select: { id: true, fieldNumber: true, name: true, estate: { select: { code: true } } },
      });
      return new Map(
        rows.map((f) => [f.id, `${f.estate.code} / ${f.fieldNumber}${f.name ? ` · ${f.name}` : ''}`]),
      );
    },
    writable: async (db, id) => {
      const f = await db.field.findFirst({
        where: { id },
        select: { estateId: true, sectionId: true, section: { select: { divisionId: true } } },
      });
      return (
        f !== null && writable({ estate: f.estateId, division: f.section.divisionId, section: f.sectionId })
      );
    },
    places: async (db, ids) =>
      byId(
        await db.field.findMany({ where: { id: { in: [...ids] } }, select: { id: true, estateId: true } }),
        (f) => ({ estateId: f.estateId }),
      ),
  },
  {
    type: 'factory',
    path: '/factories',
    module: 'factory',
    label: 'factory',
    find: async (db, ids) => named(await db.factory.findMany({ where: { id: { in: [...ids] } }, select })),
    writable: always,
    places: (_db, ids) => Promise.resolve(new Map(ids.map((id) => [id, { factoryId: id }]))),
  },
  {
    type: 'warehouse',
    path: '/warehouses',
    module: 'warehouse',
    label: 'warehouse',
    find: async (db, ids) => named(await db.warehouse.findMany({ where: { id: { in: [...ids] } }, select })),
    writable: always,
    places: (_db, ids) => Promise.resolve(new Map(ids.map((id) => [id, { warehouseId: id }]))),
  },
  {
    type: 'party',
    path: '/parties',
    module: 'land',
    label: 'party',
    find: async (db, ids) => named(await db.party.findMany({ where: { id: { in: [...ids] } }, select })),
    writable: always,
    // Organisation level: no estate scope applies.
    places: (_db, ids) => Promise.resolve(new Map(ids.map((id) => [id, {}]))),
  },
  {
    // P2.01: a person's identity papers and photo (personal data: person.view to read).
    type: 'person',
    path: '/persons',
    module: 'person',
    label: 'person',
    find: async (db, ids) => {
      const rows = await db.person.findMany({
        where: { id: { in: [...ids] } },
        select: { id: true, personCode: true, fullName: true },
      });
      return new Map(rows.map((p) => [p.id, `${p.personCode} · ${p.fullName}`]));
    },
    writable: async (db, id) => {
      const p = await db.person.findFirst({
        where: { id },
        select: { registeredEstateId: true, profiles: { select: { estateId: true } } },
      });
      return (
        p !== null &&
        (await personWritable(
          p.registeredEstateId,
          p.profiles.map((x) => x.estateId),
        ))
      );
    },
    places: async (db, ids) =>
      byId(
        await db.person.findMany({
          where: { id: { in: [...ids] } },
          select: { id: true, registeredEstateId: true },
        }),
        (p) => ({ estateId: p.registeredEstateId }),
      ),
  },
];

export const DOCUMENT_OWNER_TYPES: readonly string[] = DOCUMENT_OWNERS.map((o) => o.type);

export function documentOwner(type: string): DocumentOwner | undefined {
  return DOCUMENT_OWNERS.find((o) => o.type === type);
}
