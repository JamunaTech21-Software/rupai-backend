import { byColumn, SCOPED_MODELS } from '../../core/scope/scoped-models.js';
import { SCOPE_TARGETS } from '../../core/scope/targets.js';

/**
 * Data scope of the estate hierarchy (Spec P1 §12.2–§12.3, P6 §4.2). Registered on import, from
 * src/modules/index.ts, before any request runs.
 *
 *   estate grant    the estate and everything under it
 *   division grant  that division, its sections and fields; and READ access to its estate, because a
 *                   supervisor must be able to name the estate they work in
 *   section grant   that section and its fields; and read access to its division and estate
 *
 * Writes are checked by level in hierarchy.service.ts: changing an estate needs an estate grant; a
 * division needs its estate or itself; a section or field may also be changed under its own grant. A
 * parent visible only through a child grant is therefore read-only (SCOPE_DENIED).
 *
 * The organisation itself is organisation-tier: never filtered.
 *
 * Section has no estate_id (P3 §4.4), so the extension cannot judge a section create from the row:
 * the sections service checks the parent division instead (createsCheckedBy: 'service'). Field also
 * names a service check, so that a division grant can create fields in that division.
 */

const inIds = (ids: readonly bigint[]) => ({ in: [...ids] });

SCOPED_MODELS.register('Estate', {
  estate: byColumn('id'),
  division: (ids) => ({ divisions: { some: { id: inIds(ids) } } }),
  section: (ids) => ({ divisions: { some: { sections: { some: { id: inIds(ids) } } } } }),
})
  .register('Division', {
    estate: byColumn('estateId'),
    division: byColumn('id'),
    section: (ids) => ({ sections: { some: { id: inIds(ids) } } }),
  })
  .register('Section', {
    estate: (ids) => ({ division: { estateId: inIds(ids) } }),
    division: byColumn('divisionId'),
    section: byColumn('id'),
    createsCheckedBy: 'service',
  })
  .register('Field', {
    estate: byColumn('estateId'),
    division: (ids) => ({ section: { divisionId: inIds(ids) } }),
    section: byColumn('sectionId'),
    createsCheckedBy: 'service',
  });

// A scope grant must name a record that exists (P1.03 D-1.03-4). Facilities arrive with P1.08.
SCOPE_TARGETS.set('estate', async (tx, id) => (await tx.estate.count({ where: { id } })) === 1);
SCOPE_TARGETS.set('division', async (tx, id) => (await tx.division.count({ where: { id } })) === 1);
SCOPE_TARGETS.set('section', async (tx, id) => (await tx.section.count({ where: { id } })) === 1);
