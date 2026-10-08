import { byColumn, SCOPED_MODELS } from '../../core/scope/scoped-models.js';
import { SCOPE_TARGETS } from '../../core/scope/targets.js';

/**
 * Data scope of the facility tier (Spec P1 §4.4, P6 §4.2), registered on import from the routes file.
 *
 *   factory grant    that factory (P6 R-08 Factory Manager: "facility — one or more factories")
 *   warehouse grant  that warehouse (P6 R-10 Warehouse Keeper: "facility — one or more warehouses")
 *
 * An estate grant is NOT a way in to the facility masters: a factory belongs to the organisation and may
 * serve several estates, and primary_estate_id is informational only (P3 §4.6). Estate users will see the
 * part of a factory's ACTIVITY that came from their estates through leaf origin, which the production
 * tables map when they arrive. Creating a facility needs all_estates (no grant can name it yet).
 *
 * party is organisation-tier (no estate), and party_contact is polymorphic: its owner decides who may see
 * it, so contacts are always read through their owner (contacts.service.ts).
 */
SCOPED_MODELS.register('Factory', { factory: byColumn('id') }).register('Warehouse', {
  warehouse: byColumn('id'),
});

SCOPE_TARGETS.set('factory', async (tx, id) => (await tx.factory.count({ where: { id } })) === 1);
SCOPE_TARGETS.set('warehouse', async (tx, id) => (await tx.warehouse.count({ where: { id } })) === 1);
