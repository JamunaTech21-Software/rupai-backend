import type { Database } from '../db/prisma.js';
import type { Tx } from '../db/transaction.js';
import type { SettlementPartyType } from './sides.js';

/**
 * Who a receivable or payable is with (D-3.05-4). Each party type registers how to find its rows: the
 * settlement core checks a party exists before raising an item, and the read API shows its code and name.
 * `party`, `employment_profile` and `contractor` exist now and are registered here; buyer (P8.02),
 * supplier (P4.01) and leaf_supplier (P6) are registered by the phases that build them.
 */

export interface PartyLabel {
  readonly code: string;
  readonly name: string;
  readonly estateId: bigint | null;
}
export type PartyResolver = (tx: Database | Tx, ids: readonly bigint[]) => Promise<Map<bigint, PartyLabel>>;

const resolvers = new Map<SettlementPartyType, PartyResolver>();

export function registerPartyResolver(type: SettlementPartyType, resolver: PartyResolver): void {
  resolvers.set(type, resolver);
}

export function partyResolver(type: SettlementPartyType): PartyResolver | undefined {
  return resolvers.get(type);
}

/** Labels of a mixed set of parties; unknown or unregistered ones are absent. */
export async function partyLabels(
  tx: Database | Tx,
  parties: readonly { type: string; id: bigint }[],
): Promise<Map<string, PartyLabel>> {
  const byType = new Map<string, bigint[]>();
  for (const p of parties) byType.set(p.type, [...(byType.get(p.type) ?? []), p.id]);
  const out = new Map<string, PartyLabel>();
  for (const [type, ids] of byType) {
    const resolve = resolvers.get(type as SettlementPartyType);
    if (!resolve) continue;
    for (const [id, label] of await resolve(tx, [...new Set(ids)])) out.set(`${type}:${String(id)}`, label);
  }
  return out;
}

registerPartyResolver('party', async (tx, ids) => {
  const rows = await tx.party.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, code: true, name: true },
  });
  return new Map(rows.map((r) => [r.id, { code: r.code, name: r.name, estateId: null }]));
});

registerPartyResolver('contractor', async (tx, ids) => {
  const rows = await tx.contractor.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, code: true, name: true },
  });
  return new Map(rows.map((r) => [r.id, { code: r.code, name: r.name, estateId: null }]));
});

registerPartyResolver('employment_profile', async (tx, ids) => {
  const rows = await tx.employmentProfile.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, profileNumber: true, estateId: true, person: { select: { fullName: true } } },
  });
  return new Map(
    rows.map((r) => [r.id, { code: r.profileNumber, name: r.person.fullName, estateId: r.estateId }]),
  );
});
