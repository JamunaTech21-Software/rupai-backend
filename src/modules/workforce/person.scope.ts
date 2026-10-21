import { byColumn, SCOPED_MODELS } from '../../core/scope/scoped-models.js';
import { businessDateToDb, todayIn } from '../../core/time/dates.js';

/**
 * Data scope of the workforce (P2.01–P2.03, BACKLOG D-2.01-2, D-2.02-3, D-2.03-4).
 *
 *   employment_assignment  the profile's estate, and the division, section or department it names; self.
 *   worker_team            its estate, division or section (P2.04).
 *   team_member            as its team; also the member's own profile (self).
 *   contractor             where it was registered OR has a contract (P2.05, D-2.05-3).
 *   contractor_contract    its estate and division; contractor_labour as its contract.
 *   employment_profile     an estate grant sees the profiles of that estate; a division or section grant
 *                          the profiles whose CURRENT assignment is there (approved, in force today, in
 *                          the organisation's timezone); everyone sees their own (self).
 *   person                 seen where registered OR employed (as the profile above), and by themselves.
 *
 * Creates are checked by the services: a person's estate is not one column, and a profile or an
 * assignment is created under an estate the caller must be able to change.
 */
const inIds = (ids: readonly bigint[]) => ({ in: [...ids] });

let timezone = 'UTC';
/** The organisation's timezone, for "today" (set once when the workforce routes are built). */
export function setWorkforceScopeTimezone(tz: string): void {
  timezone = tz;
}
/** Profiles whose assignment in force today matches. */
const assignedTo = (where: Record<string, unknown>) => {
  const today = businessDateToDb(todayIn(timezone));
  return {
    assignments: {
      some: {
        ...where,
        state: 'approved',
        effectiveFrom: { lte: today },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }],
      },
    },
  };
};

SCOPED_MODELS.register('Contractor', {
  estate: (ids) => ({
    OR: [{ registeredEstateId: inIds(ids) }, { contracts: { some: { estateId: inIds(ids) } } }],
  }),
  division: (ids) => ({ contracts: { some: { divisionId: inIds(ids) } } }),
  createsCheckedBy: 'service',
})
  .register('ContractorContract', {
    estate: byColumn('estateId'),
    division: byColumn('divisionId'),
    createsCheckedBy: 'service',
  })
  .register('ContractorLabour', {
    estate: (ids) => ({ contract: { estateId: inIds(ids) } }),
    division: (ids) => ({ contract: { divisionId: inIds(ids) } }),
    createsCheckedBy: 'service',
  })
  .register('WorkerTeam', {
    estate: byColumn('estateId'),
    division: byColumn('divisionId'),
    section: byColumn('sectionId'),
    createsCheckedBy: 'service',
  })
  .register('TeamMember', {
    estate: (ids) => ({ team: { estateId: inIds(ids) } }),
    division: (ids) => ({ team: { divisionId: inIds(ids) } }),
    section: (ids) => ({ team: { sectionId: inIds(ids) } }),
    self: byColumn('employmentProfileId'),
    createsCheckedBy: 'service',
  })
  .register('EmploymentAssignment', {
    estate: byColumn('estateId'),
    division: byColumn('divisionId'),
    section: byColumn('sectionId'),
    department: byColumn('departmentId'),
    self: byColumn('employmentProfileId'),
    createsCheckedBy: 'service',
  })
  .register('EmploymentProfile', {
    estate: (ids) => ({ estateId: inIds(ids) }),
    division: (ids) => assignedTo({ divisionId: inIds(ids) }),
    section: (ids) => assignedTo({ sectionId: inIds(ids) }),
    self: (ids) => ({ id: inIds(ids) }),
    createsCheckedBy: 'service',
  })
  .register('Person', {
    estate: (ids) => ({
      OR: [{ registeredEstateId: inIds(ids) }, { profiles: { some: { estateId: inIds(ids) } } }],
    }),
    division: (ids) => ({ profiles: { some: assignedTo({ divisionId: inIds(ids) }) } }),
    section: (ids) => ({ profiles: { some: assignedTo({ sectionId: inIds(ids) }) } }),
    self: (ids) => ({ profiles: { some: { id: inIds(ids) } } }),
    createsCheckedBy: 'service',
  });
