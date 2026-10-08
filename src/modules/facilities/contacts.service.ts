import type { z } from 'zod';

import { auditCreate, auditDelete, auditUpdate, type AuditedRecord } from '../../core/audit/audit.js';
import type { Database } from '../../core/db/prisma.js';
import { withTransaction, type Tx } from '../../core/db/transaction.js';
import { Errors } from '../../core/errors/app-error.js';
import type { PartyContact } from '../../generated/prisma/client.js';
import { iso, versionConflict } from '../organisation/common.js';
import type {
  ContactOut,
  ContactOwnerType,
  CreateContactBody,
  PatchContactBody,
  Status,
} from './facilities.schema.js';

/**
 * Contacts of any owner (Spec P3 §6.2): one implementation behind every "contacts panel".
 *
 *   - The OWNER decides who may see and change its contacts: every call first reads the owner through
 *     its own (scoped) model, so a contact of an out-of-scope warehouse is 404 like the warehouse itself.
 *   - At most one primary contact per owner: the generated primary_key under a unique index guarantees
 *     it in the database. The first contact of an owner becomes primary; /make-primary moves the flag in
 *     one transaction (old one cleared first, so the key is never held twice).
 *   - Owners with an inline cache of the primary contact (warehouse.phone, later buyer, broker, supplier,
 *     leaf_supplier) refresh it on every primary change (P3 §8: "party_contact is authoritative").
 *   - Contacts are deleted outright (audited): nothing refers to a contact.
 */

type ContactOutT = z.infer<typeof ContactOut>;

export interface ContactOwner {
  readonly type: ContactOwnerType;
  /** The permission module guarding the owner (warehouse, land …): view to read, edit to change. */
  readonly module: string;
  /** Whether the owner exists AND is in the caller's scope (a scoped read). */
  exists(tx: Database | Tx, id: bigint): Promise<boolean>;
  /** Refreshes the owner's inline copy of its primary contact, if it keeps one. */
  syncPrimary?(tx: Tx, ownerId: bigint, primary: PartyContact | null): Promise<void>;
}

export const CONTACT_AUDIT: AuditedRecord = {
  type: 'party_contact',
  class: 'master',
  fields: [
    'owner_type',
    'owner_id',
    'contact_name',
    'designation',
    'contact_type',
    'phone',
    'phone_alt',
    'email',
    'is_primary',
    'status',
  ],
};

export function toContactOut(c: PartyContact): ContactOutT {
  return {
    id: c.id.toString(),
    owner_type: c.ownerType as ContactOwnerType,
    owner_id: c.ownerId.toString(),
    contact_name: c.contactName,
    designation: c.designation,
    contact_type: c.contactType as ContactOutT['contact_type'],
    phone: c.phone,
    phone_alt: c.phoneAlt,
    email: c.email,
    is_primary: c.isPrimary,
    status: c.status as Status,
    version: c.version,
    created_at: c.createdAt.toISOString(),
    updated_at: iso(c.updatedAt),
  };
}

export function contactsService(db: Database, owner: ContactOwner) {
  const of = (ownerId: bigint) => ({ ownerType: owner.type, ownerId });

  async function ownerOrNotFound(tx: Database | Tx, ownerId: bigint) {
    if (!(await owner.exists(tx, ownerId))) throw Errors.notFound(`No such ${owner.type.replace('_', ' ')}.`);
  }
  async function contactOrNotFound(tx: Database | Tx, ownerId: bigint, id: bigint): Promise<PartyContact> {
    await ownerOrNotFound(tx, ownerId);
    const c = await tx.partyContact.findFirst({ where: { id, ...of(ownerId) } });
    if (!c) throw Errors.notFound('No such contact.');
    return c;
  }
  async function sync(tx: Tx, ownerId: bigint) {
    if (!owner.syncPrimary) return;
    const primary = await tx.partyContact.findFirst({
      where: { ...of(ownerId), isPrimary: true, status: 'active' },
    });
    await owner.syncPrimary(tx, ownerId, primary);
  }

  return {
    owner,

    async list(ownerId: bigint): Promise<ContactOutT[]> {
      await ownerOrNotFound(db, ownerId);
      const rows = await db.partyContact.findMany({
        where: of(ownerId),
        orderBy: [{ isPrimary: 'desc' }, { contactName: 'asc' }, { id: 'asc' }],
      });
      return rows.map(toContactOut);
    },

    async get(ownerId: bigint, id: bigint): Promise<ContactOutT> {
      return toContactOut(await contactOrNotFound(db, ownerId, id));
    },

    async create(
      ownerId: bigint,
      body: z.infer<typeof CreateContactBody>,
      actorId: bigint,
    ): Promise<ContactOutT> {
      return withTransaction(db, async (tx) => {
        await ownerOrNotFound(tx, ownerId);
        const hasPrimary =
          (await tx.partyContact.count({ where: { ...of(ownerId), isPrimary: true, status: 'active' } })) > 0;
        const primary = body.is_primary === true || !hasPrimary;
        if (primary && hasPrimary) {
          // Clear first: the unique primary_key may never be held by two rows.
          for (const p of await tx.partyContact.findMany({ where: { ...of(ownerId), isPrimary: true } })) {
            await tx.partyContact.update({
              where: { id: p.id },
              data: {
                isPrimary: false,
                version: { increment: 1 },
                updatedAt: new Date(),
                updatedBy: actorId,
              },
            });
            await auditUpdate(
              tx,
              CONTACT_AUDIT,
              p.id,
              toContactOut(p),
              { ...toContactOut(p), is_primary: false },
              { actorId },
            );
          }
        }
        const c = await tx.partyContact.create({
          data: {
            ...of(ownerId),
            contactName: body.contact_name,
            designation: body.designation ?? null,
            contactType: body.contact_type,
            phone: body.phone ?? null,
            phoneAlt: body.phone_alt ?? null,
            email: body.email ?? null,
            isPrimary: primary,
            status: 'active',
            createdBy: actorId,
          },
        });
        const out = toContactOut(c);
        await auditCreate(tx, CONTACT_AUDIT, c.id, out, { actorId });
        if (primary) await sync(tx, ownerId);
        return out;
      });
    },

    async update(
      ownerId: bigint,
      id: bigint,
      expectedVersion: number,
      changes: z.infer<typeof PatchContactBody>,
      actorId: bigint,
    ) {
      return withTransaction(db, async (tx) => {
        const before = await contactOrNotFound(tx, ownerId, id);
        const { count } = await tx.partyContact.updateMany({
          where: { id, version: expectedVersion },
          data: {
            ...(changes.contact_name !== undefined ? { contactName: changes.contact_name } : {}),
            ...(changes.designation !== undefined ? { designation: changes.designation } : {}),
            ...(changes.contact_type !== undefined ? { contactType: changes.contact_type } : {}),
            ...(changes.phone !== undefined ? { phone: changes.phone } : {}),
            ...(changes.phone_alt !== undefined ? { phoneAlt: changes.phone_alt } : {}),
            ...(changes.email !== undefined ? { email: changes.email } : {}),
            version: { increment: 1 },
            updatedAt: new Date(),
            updatedBy: actorId,
          },
        });
        if (count !== 1) versionConflict(before, toContactOut(before));
        const after = await contactOrNotFound(tx, ownerId, id);
        await auditUpdate(tx, CONTACT_AUDIT, id, toContactOut(before), toContactOut(after), { actorId });
        if (after.isPrimary) await sync(tx, ownerId);
        return toContactOut(after);
      });
    },

    /** Makes this the owner's only primary contact. Idempotent. */
    async makePrimary(ownerId: bigint, id: bigint, expectedVersion: number, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const before = await contactOrNotFound(tx, ownerId, id);
        if (before.version !== expectedVersion) versionConflict(before, toContactOut(before));
        if (before.isPrimary) return toContactOut(before);
        if (before.status !== 'active') {
          throw Errors.validation([
            { field: 'id', code: 'VALIDATION_FAILED', message: 'An inactive contact cannot be primary.' },
          ]);
        }
        const stamp = { version: { increment: 1 }, updatedAt: new Date(), updatedBy: actorId };
        const previous = await tx.partyContact.findMany({ where: { ...of(ownerId), isPrimary: true } });
        // Clear first: the unique primary_key may never be held by two rows, even inside the transaction.
        for (const p of previous) {
          await tx.partyContact.update({ where: { id: p.id }, data: { isPrimary: false, ...stamp } });
          await auditUpdate(
            tx,
            CONTACT_AUDIT,
            p.id,
            toContactOut(p),
            { ...toContactOut(p), is_primary: false },
            { actorId },
          );
        }
        await tx.partyContact.update({ where: { id }, data: { isPrimary: true, ...stamp } });
        const after = await contactOrNotFound(tx, ownerId, id);
        await auditUpdate(tx, CONTACT_AUDIT, id, toContactOut(before), toContactOut(after), { actorId });
        await sync(tx, ownerId);
        return toContactOut(after);
      });
    },

    /** Removes a contact. Removing the primary leaves the owner without one until another is chosen. */
    async remove(ownerId: bigint, id: bigint, actorId: bigint): Promise<void> {
      await withTransaction(db, async (tx) => {
        const c = await contactOrNotFound(tx, ownerId, id);
        await tx.partyContact.delete({ where: { id } });
        await auditDelete(tx, CONTACT_AUDIT, id, toContactOut(c), { actorId });
        if (c.isPrimary) await sync(tx, ownerId);
      });
    },
  };
}

/** Inside an owner's own deletion: its contacts go with it (audited). */
export async function removeContactsOf(
  tx: Tx,
  type: ContactOwnerType,
  ownerId: bigint,
  actorId: bigint,
): Promise<void> {
  const contacts = await tx.partyContact.findMany({ where: { ownerType: type, ownerId } });
  for (const c of contacts) {
    await tx.partyContact.delete({ where: { id: c.id } });
    await auditDelete(tx, CONTACT_AUDIT, c.id, toContactOut(c), { actorId });
  }
}

export type ContactsService = ReturnType<typeof contactsService>;
