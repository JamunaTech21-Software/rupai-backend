import { SCOPED_MODELS } from '../../core/scope/scoped-models.js';

/**
 * Data scope of the workforce (P2.01–P2.02, BACKLOG D-2.01-2, D-2.02-3).
 *
 *   employment_profile  an estate grant sees the profiles of that estate; everyone sees their own (self).
 *                       Division and section grants see the profiles assigned to them from P2.03.
 *   person              a person is seen where they are registered OR hold a profile, and by themselves.
 *
 * Creates are checked by the services: a person's estate is not one column, and a profile is created
 * under an estate the caller must be able to change.
 */
const inIds = (ids: readonly bigint[]) => ({ in: [...ids] });

SCOPED_MODELS.register('EmploymentProfile', {
  estate: (ids) => ({ estateId: inIds(ids) }),
  self: (ids) => ({ id: inIds(ids) }),
  createsCheckedBy: 'service',
}).register('Person', {
  estate: (ids) => ({
    OR: [{ registeredEstateId: inIds(ids) }, { profiles: { some: { estateId: inIds(ids) } } }],
  }),
  self: (ids) => ({ profiles: { some: { id: inIds(ids) } } }),
  createsCheckedBy: 'service',
});
