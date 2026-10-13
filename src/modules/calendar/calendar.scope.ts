import { byColumn, SCOPED_MODELS } from '../../core/scope/scoped-models.js';

/**
 * Data scope of the calendars (Spec P1 §12.3). Registered on import from the routes file.
 *
 *   season             estate tier: an estate grant reaches its seasons. Division and section grants may
 *                      READ their estate's seasons (they record work inside them); changing a season
 *                      needs the estate grant, checked in seasons.service.ts
 *   fiscal_year,       organisation tier (decision O-17): never filtered, and there is no estate
 *   accounting_period  parameter anywhere
 */
const inIds = (ids: readonly bigint[]) => ({ in: [...ids] });

SCOPED_MODELS.register('Season', {
  estate: byColumn('estateId'),
  division: (ids) => ({ estate: { divisions: { some: { id: inIds(ids) } } } }),
  section: (ids) => ({ estate: { divisions: { some: { sections: { some: { id: inIds(ids) } } } } } }),
  createsCheckedBy: 'service',
});
