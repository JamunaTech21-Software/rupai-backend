import type { z } from 'zod';

import type { AccessLog } from '../../core/audit/access-log.js';
import {
  auditCreate,
  auditDelete,
  auditUpdate,
  recordStatusChange,
  type AuditedRecord,
} from '../../core/audit/audit.js';
import { toOrderBy, toPaging, toWhere, type ListFieldMap } from '../../core/db/list.js';
import type { Database } from '../../core/db/prisma.js';
import { lockRowsForUpdate, withTransaction, type Tx } from '../../core/db/transaction.js';
import { AppError, Errors, type ErrorDetail } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import type { MasterStatus } from '../../core/http/master.js';
import {
  addDays,
  businessDateFromDb,
  businessDateToDb,
  todayIn,
  type BusinessDate,
} from '../../core/time/dates.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  denyWrite,
  duplicate,
  idIn,
  idOut,
  iso,
  referenced,
  versionConflict,
  writable,
} from '../organisation/common.js';
import type { AddMembersBody, CreateTeamBody, MemberOut, PatchTeamBody, TeamOut } from './team.schema.js';

/**
 * Worker teams and their membership (P2.04; Spec P3 §8.4–§8.5).
 *
 *   - A team belongs to an estate: code unique within it, a type, an optional sardar / supervisor (a
 *     profile of the estate), division and section.
 *   - Membership is effective-dated and never rewritten: a worker joins from a date and leaves on one
 *     (effective_to, the last day). A team distribution dated in March resolves March's members.
 *   - A worker is in one team at a time: overlapping memberships of the same profile are refused (checked
 *     under a lock on the profile; MySQL has no exclusion constraint). `move_from_other_team` ends the
 *     current one the day before instead. One leader per team at a time.
 *   - Members are WORKER profiles of the team's estate, between joining and separation. Separating a
 *     profile ends its memberships (profile.service).
 *   - A team is deactivated only without current or future members, and deleted only if it never had any.
 *   - Scope: the team's estate, division or section; a member row also by its own profile (self). Writes
 *     need the estate.
 */

type TeamOutT = z.infer<typeof TeamOut>;
type MemberOutT = z.infer<typeof MemberOut>;

export const TEAM_AUDIT: AuditedRecord = {
  type: 'worker_team',
  class: 'master',
  fields: [
    'estate_id',
    'code',
    'name',
    'team_type',
    'supervisor_profile_id',
    'division_id',
    'section_id',
    'description',
    'status',
  ],
};
export const MEMBER_AUDIT: AuditedRecord = {
  type: 'team_member',
  class: 'master',
  fields: ['worker_team_id', 'employment_profile_id', 'effective_from', 'effective_to', 'role_in_team'],
};

export const TEAM_LIST_FIELDS: ListFieldMap = {
  estate_id: { field: 'estateId', convert: (v) => BigInt(String(v)) },
  division_id: { field: 'divisionId', convert: (v) => BigInt(String(v)) },
  section_id: { field: 'sectionId', convert: (v) => BigInt(String(v)) },
  supervisor_profile_id: { field: 'supervisorProfileId', convert: (v) => BigInt(String(v)) },
  team_type: { field: 'teamType' },
  status: { field: 'status' },
  code: { field: 'code' },
  name: { field: 'name' },
};

const ref = { select: { id: true, code: true, name: true } } as const;
const teamInclude = {
  estate: ref,
  division: ref,
  section: ref,
  supervisor: { select: { id: true, profileNumber: true, person: { select: { fullName: true } } } },
} as const satisfies Prisma.WorkerTeamInclude;
type TeamRow = Prisma.WorkerTeamGetPayload<{ include: typeof teamInclude }>;

const memberInclude = {
  team: ref,
  profile: {
    select: { id: true, profileNumber: true, status: true, person: { select: { fullName: true } } },
  },
} as const satisfies Prisma.TeamMemberInclude;
type MemberRow = Prisma.TeamMemberGetPayload<{ include: typeof memberInclude }>;

/** Members on the date: started on or before it, not ended before it. */
export function memberOn(date: BusinessDate): Prisma.TeamMemberWhereInput {
  const d = businessDateToDb(date);
  return { effectiveFrom: { lte: d }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: d } }] };
}

/** undefined keeps the current value; null is a value (it clears). */
function pick<T>(v: T | undefined, kept: T): T {
  if (v === undefined) return kept;
  return v;
}

const invalid = (field: string, message: string): ErrorDetail => ({
  field,
  code: 'VALIDATION_FAILED',
  message,
});
const refOut = (r: { id: bigint; code: string; name: string } | null) =>
  r ? { id: r.id.toString(), code: r.code, name: r.name } : null;
const day = (v: Date | null) => (v ? businessDateFromDb(v) : null);
/** Two date ranges overlap (null end: open). */
const overlaps = (
  aFrom: BusinessDate,
  aTo: BusinessDate | null,
  bFrom: BusinessDate,
  bTo: BusinessDate | null,
) => (aTo === null || aTo >= bFrom) && (bTo === null || bTo >= aFrom);

export interface TeamServiceDeps {
  readonly db: Database;
  readonly accessLog: AccessLog;
  readonly timezone: string;
}

export function teamService({ db, accessLog, timezone }: TeamServiceDeps) {
  const today = () => todayIn(timezone);

  async function today_(tx: Database | Tx, teamIds: readonly bigint[]) {
    const rows =
      teamIds.length === 0
        ? []
        : await tx.teamMember.findMany({
            where: { workerTeamId: { in: [...teamIds] }, ...memberOn(today()) },
            include: memberInclude,
          });
    const count = new Map<bigint, number>();
    const leader = new Map<bigint, MemberRow>();
    for (const r of rows) {
      count.set(r.workerTeamId, (count.get(r.workerTeamId) ?? 0) + 1);
      if (r.roleInTeam === 'leader') leader.set(r.workerTeamId, r);
    }
    return { count, leader };
  }

  function toTeamOut(t: TeamRow, count: number, leader: MemberRow | undefined): TeamOutT {
    return {
      id: t.id.toString(),
      estate_id: t.estateId.toString(),
      estate: { id: t.estate.id.toString(), code: t.estate.code, name: t.estate.name },
      code: t.code,
      name: t.name,
      team_type: t.teamType as TeamOutT['team_type'],
      supervisor_profile_id: idOut(t.supervisorProfileId),
      supervisor: t.supervisor
        ? {
            id: t.supervisor.id.toString(),
            profile_number: t.supervisor.profileNumber,
            full_name: t.supervisor.person.fullName,
          }
        : null,
      division_id: idOut(t.divisionId),
      division: refOut(t.division),
      section_id: idOut(t.sectionId),
      section: refOut(t.section),
      description: t.description,
      member_count: count,
      leader: leader
        ? {
            profile_id: leader.employmentProfileId.toString(),
            profile_number: leader.profile.profileNumber,
            full_name: leader.profile.person.fullName,
          }
        : null,
      status: t.status as TeamOutT['status'],
      version: t.version,
      created_at: t.createdAt.toISOString(),
      updated_at: iso(t.updatedAt),
    };
  }
  async function teamOut(tx: Database | Tx, t: TeamRow) {
    const { count, leader } = await today_(tx, [t.id]);
    return toTeamOut(t, count.get(t.id) ?? 0, leader.get(t.id));
  }

  function toMemberOut(m: MemberRow, on: BusinessDate): MemberOutT {
    const from = businessDateFromDb(m.effectiveFrom);
    const to = day(m.effectiveTo);
    return {
      id: m.id.toString(),
      worker_team_id: m.workerTeamId.toString(),
      team: { id: m.team.id.toString(), code: m.team.code, name: m.team.name },
      employment_profile_id: m.employmentProfileId.toString(),
      profile: {
        id: m.profile.id.toString(),
        profile_number: m.profile.profileNumber,
        full_name: m.profile.person.fullName,
        status: m.profile.status,
      },
      effective_from: from,
      effective_to: to,
      role_in_team: m.roleInTeam as MemberOutT['role_in_team'],
      is_current: from <= on && (to === null || to >= on),
      version: m.version,
      created_at: m.createdAt.toISOString(),
    };
  }

  async function teamOrNotFound(tx: Database | Tx, id: bigint): Promise<TeamRow> {
    const t = await tx.workerTeam.findUnique({ where: { id }, include: teamInclude });
    if (!t) throw Errors.notFound('Team not found.');
    return t;
  }
  async function memberOrNotFound(tx: Database | Tx, teamId: bigint, memberId: bigint): Promise<MemberRow> {
    const m = await tx.teamMember.findUnique({ where: { id: memberId }, include: memberInclude });
    if (m?.workerTeamId !== teamId) throw Errors.notFound('Membership not found.');
    return m;
  }
  const canWrite = (estateId: bigint, id: bigint | null, operation: string) =>
    writable({ estate: estateId }).then((ok) =>
      ok ? undefined : denyWrite(accessLog, 'team', id, operation),
    );
  const stamp = (actorId: bigint) => ({
    version: { increment: 1 },
    updatedAt: new Date(),
    updatedBy: actorId,
  });

  /** Supervisor, division and section: of the team's estate, the section within the division. */
  async function checkPlace(
    tx: Database | Tx,
    estateId: bigint,
    v: { supervisor: bigint | null; division: bigint | null; section: bigint | null },
  ): Promise<bigint | null> {
    const problems: ErrorDetail[] = [];
    let division = v.division;
    if (v.supervisor !== null) {
      const s = await tx.employmentProfile.findUnique({
        where: { id: v.supervisor },
        select: { estateId: true, status: true },
      });
      if (s?.estateId !== estateId)
        problems.push(invalid('supervisor_profile_id', 'No such profile in this estate.'));
      else if (s.status === 'separated')
        problems.push(invalid('supervisor_profile_id', 'That profile is separated.'));
    }
    if (v.division !== null) {
      const d = await tx.division.findUnique({
        where: { id: v.division },
        select: { estateId: true, status: true },
      });
      if (d?.estateId !== estateId || d.status !== 'active')
        problems.push(invalid('division_id', 'No such active division in this estate.'));
    }
    if (v.section !== null) {
      const s = await tx.section.findUnique({
        where: { id: v.section },
        select: { divisionId: true, status: true, division: { select: { estateId: true } } },
      });
      if (s?.division.estateId !== estateId || s.status !== 'active') {
        problems.push(invalid('section_id', 'No such active section in this estate.'));
      } else if (v.division !== null && s.divisionId !== v.division) {
        problems.push(invalid('section_id', 'The section is not in that division.'));
      } else {
        division = s.divisionId;
      }
    }
    if (problems.length > 0) throw Errors.validation(problems);
    return division;
  }

  const onDuplicate = (code: string | undefined) =>
    duplicate('code', `Team code ${code ?? ''} in this estate`);

  /**
   * Adds one membership, under a lock on the profile: a worker of the estate, within employment, not in
   * another team at the same time (unless moving), the team's only leader.
   */
  async function addOne(
    tx: Tx,
    team: TeamRow,
    m: z.infer<typeof AddMembersBody>['members'][number],
    move: boolean,
    actorId: bigint,
    index: number,
  ): Promise<bigint> {
    const field = (f: string) => `members[${String(index)}].${f}`;
    await lockRowsForUpdate(tx, 'employment_profile', { id: m.employment_profile_id });
    const p = await tx.employmentProfile.findUnique({
      where: { id: m.employment_profile_id },
      select: { estateId: true, employmentType: true, status: true, joiningDate: true, separationDate: true },
    });
    if (p?.estateId !== team.estateId) {
      throw Errors.validation([
        invalid(field('employment_profile_id'), 'No such profile in the team’s estate.'),
      ]);
    }
    if (p.employmentType !== 'worker') {
      throw Errors.validation([
        invalid(field('employment_profile_id'), 'A team is of workers: this is an employee profile.'),
      ]);
    }
    if (p.status === 'separated') {
      throw Errors.validation([invalid(field('employment_profile_id'), 'That profile is separated.')]);
    }
    if (m.effective_from < businessDateFromDb(p.joiningDate)) {
      throw Errors.validation([invalid(field('effective_from'), 'Cannot be before the worker joined.')]);
    }
    // Every membership of the worker, in any team (all of the profile's estate, which the caller can change).
    const theirs = await tx.teamMember.findMany({
      where: { employmentProfileId: m.employment_profile_id },
      select: { id: true, workerTeamId: true, effectiveFrom: true, effectiveTo: true },
    });
    for (const o of theirs) {
      const from = businessDateFromDb(o.effectiveFrom);
      const to = day(o.effectiveTo);
      if (!overlaps(from, to, m.effective_from, null)) continue;
      const movable = move && o.workerTeamId !== team.id && to === null && from < m.effective_from;
      if (!movable) {
        throw new AppError('DUPLICATE_KEY', 'The worker is in a team over those dates.', [
          {
            field: field('employment_profile_id'),
            code: 'DUPLICATE_KEY',
            message:
              o.workerTeamId === team.id
                ? `Already a member of this team from ${from}.`
                : `In another team from ${from}${to ? ` to ${to}` : ''}: end that membership first, or send move_from_other_team.`,
            context: { worker_team_id: o.workerTeamId.toString(), member_id: o.id.toString() },
          },
        ]);
      }
      const last = addDays(m.effective_from, -1);
      await tx.teamMember.update({
        where: { id: o.id },
        data: { effectiveTo: businessDateToDb(last), ...stamp(actorId) },
      });
      await auditUpdate(tx, MEMBER_AUDIT, o.id, { effective_to: null }, { effective_to: last }, { actorId });
    }
    if (m.role_in_team === 'leader')
      await assertOneLeader(tx, team.id, m.effective_from, null, null, field('role_in_team'));
    const { id } = await tx.teamMember.create({
      data: {
        workerTeamId: team.id,
        employmentProfileId: m.employment_profile_id,
        effectiveFrom: businessDateToDb(m.effective_from),
        roleInTeam: m.role_in_team,
        createdBy: actorId,
      },
      select: { id: true },
    });
    return id;
  }

  async function assertOneLeader(
    tx: Database | Tx,
    teamId: bigint,
    from: BusinessDate,
    to: BusinessDate | null,
    except: bigint | null,
    field: string,
  ) {
    const leaders = await tx.teamMember.findMany({
      where: {
        workerTeamId: teamId,
        roleInTeam: 'leader',
        ...(except !== null ? { id: { not: except } } : {}),
      },
      select: { effectiveFrom: true, effectiveTo: true },
    });
    if (leaders.some((l) => overlaps(businessDateFromDb(l.effectiveFrom), day(l.effectiveTo), from, to))) {
      throw Errors.validation([invalid(field, 'The team already has a leader over those dates.')]);
    }
  }

  return {
    async list(q: ListQuery) {
      const where = toWhere(q, TEAM_LIST_FIELDS) as Prisma.WorkerTeamWhereInput;
      const [rows, total] = await Promise.all([
        db.workerTeam.findMany({
          where,
          include: teamInclude,
          orderBy: [...toOrderBy(q.sort, TEAM_LIST_FIELDS), { id: 'asc' }],
          ...toPaging(q),
        }),
        db.workerTeam.count({ where }),
      ]);
      const { count, leader } = await today_(
        db,
        rows.map((r) => r.id),
      );
      return { items: rows.map((r) => toTeamOut(r, count.get(r.id) ?? 0, leader.get(r.id))), total };
    },

    async get(id: bigint) {
      return teamOut(db, await teamOrNotFound(db, id));
    },

    async create(b: z.infer<typeof CreateTeamBody>, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const estate = await tx.estate.findUnique({
          where: { id: b.estate_id },
          select: { id: true, status: true },
        });
        if (estate?.status !== 'active')
          throw Errors.validation([invalid('estate_id', 'No such active estate.')]);
        await canWrite(estate.id, null, 'create');
        const division = await checkPlace(tx, estate.id, {
          supervisor: idIn(b.supervisor_profile_id ?? null),
          division: idIn(b.division_id ?? null),
          section: idIn(b.section_id ?? null),
        });
        const { id } = await tx.workerTeam
          .create({
            data: {
              estateId: estate.id,
              code: b.code,
              name: b.name,
              teamType: b.team_type,
              supervisorProfileId: idIn(b.supervisor_profile_id ?? null),
              divisionId: division,
              sectionId: idIn(b.section_id ?? null),
              description: b.description ?? null,
              createdBy: actorId,
            },
            select: { id: true },
          })
          .catch(onDuplicate(b.code));
        const out = await teamOut(tx, await teamOrNotFound(tx, id));
        await auditCreate(tx, TEAM_AUDIT, id, out, { actorId });
        await recordStatusChange(tx, TEAM_AUDIT.type, id, null, 'active', { actorId });
        return out;
      });
    },

    async update(
      id: bigint,
      expectedVersion: number,
      changes: z.infer<typeof PatchTeamBody>,
      actorId: bigint,
    ) {
      return withTransaction(db, async (tx) => {
        const before = await teamOrNotFound(tx, id);
        await canWrite(before.estateId, id, 'update');
        const section = changes.section_id === undefined ? before.sectionId : idIn(changes.section_id);
        // A new section without a division moves the division with it.
        const divisionIn =
          changes.division_id !== undefined
            ? idIn(changes.division_id)
            : changes.section_id !== undefined
              ? null
              : before.divisionId;
        const division = await checkPlace(tx, before.estateId, {
          supervisor:
            changes.supervisor_profile_id === undefined
              ? before.supervisorProfileId
              : idIn(changes.supervisor_profile_id),
          division: divisionIn,
          section,
        });
        const { count } = await tx.workerTeam
          .updateMany({
            where: { id, version: expectedVersion },
            data: {
              code: pick(changes.code, before.code),
              name: pick(changes.name, before.name),
              teamType: pick(changes.team_type, before.teamType),
              supervisorProfileId:
                changes.supervisor_profile_id === undefined
                  ? before.supervisorProfileId
                  : idIn(changes.supervisor_profile_id),
              divisionId: division,
              sectionId: section,
              description: pick(changes.description, before.description),
              ...stamp(actorId),
            },
          })
          .catch(onDuplicate(changes.code));
        const old = await teamOut(tx, before);
        if (count !== 1) versionConflict(before, old);
        const after = await teamOut(tx, await teamOrNotFound(tx, id));
        await auditUpdate(tx, TEAM_AUDIT, id, old, after, { actorId });
        return after;
      });
    },

    async setStatus(id: bigint, expectedVersion: number, status: MasterStatus, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const before = await teamOrNotFound(tx, id);
        await canWrite(before.estateId, id, status === 'active' ? 'reactivate' : 'deactivate');
        const old = await teamOut(tx, before);
        if (before.version !== expectedVersion) versionConflict(before, old);
        if (before.status === status) return old;
        if (status === 'inactive') {
          const t = businessDateToDb(today());
          const open = await tx.teamMember.count({
            where: { workerTeamId: id, OR: [{ effectiveTo: null }, { effectiveTo: { gte: t } }] },
          });
          if (open > 0) {
            throw new AppError('INVALID_TRANSITION', 'The team still has members.', [
              {
                code: 'INVALID_TRANSITION',
                message: 'End their memberships first.',
                context: { members: open },
              },
            ]);
          }
        }
        await tx.workerTeam.update({ where: { id }, data: { status, ...stamp(actorId) } });
        const after = await teamOut(tx, await teamOrNotFound(tx, id));
        await auditUpdate(tx, TEAM_AUDIT, id, old, after, { actorId });
        await recordStatusChange(tx, TEAM_AUDIT.type, id, before.status, status, { actorId });
        return after;
      });
    },

    /** Only a team created in error: one that never had a member. */
    async remove(id: bigint, actorId: bigint) {
      await withTransaction(db, async (tx) => {
        const t = await teamOrNotFound(tx, id);
        await canWrite(t.estateId, id, 'delete');
        const out = await teamOut(tx, t);
        await tx.workerTeam.delete({ where: { id } }).catch(referenced('team'));
        await auditDelete(tx, TEAM_AUDIT, id, out, { actorId });
      });
    },

    /** GET /worker-teams/{id}/members: on a date (default today), or the whole history. */
    async members(teamId: bigint, asOf: BusinessDate | undefined, history: boolean) {
      await teamOrNotFound(db, teamId);
      const on = asOf ?? today();
      const rows = await db.teamMember.findMany({
        where: { workerTeamId: teamId, ...(history ? {} : memberOn(on)) },
        include: memberInclude,
        orderBy: history
          ? [{ effectiveFrom: 'desc' }, { id: 'desc' }]
          : [{ roleInTeam: 'asc' }, { id: 'asc' }],
      });
      return rows.map((r) => toMemberOut(r, on));
    },

    async addMembers(teamId: bigint, b: z.infer<typeof AddMembersBody>, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const team = await teamOrNotFound(tx, teamId);
        await canWrite(team.estateId, teamId, 'add-members');
        if (team.status !== 'active') {
          throw new AppError('INVALID_TRANSITION', 'An inactive team takes no members.', [
            { code: 'INVALID_TRANSITION', message: 'Reactivate it first.', context: { state: team.status } },
          ]);
        }
        const ids: bigint[] = [];
        for (const [i, m] of b.members.entries())
          ids.push(await addOne(tx, team, m, b.move_from_other_team, actorId, i));
        const rows = await tx.teamMember.findMany({
          where: { id: { in: ids } },
          include: memberInclude,
          orderBy: { id: 'asc' },
        });
        const out = rows.map((r) => toMemberOut(r, today()));
        for (const o of out) await auditCreate(tx, MEMBER_AUDIT, BigInt(o.id), o, { actorId });
        return out;
      });
    },

    /** Ends a membership: effective_to is the last day in the team. */
    async endMember(
      teamId: bigint,
      memberId: bigint,
      expectedVersion: number,
      to: BusinessDate,
      actorId: bigint,
    ) {
      return withTransaction(db, async (tx) => {
        const team = await teamOrNotFound(tx, teamId);
        await canWrite(team.estateId, memberId, 'end-member');
        const m = await memberOrNotFound(tx, teamId, memberId);
        const before = toMemberOut(m, today());
        if (m.version !== expectedVersion) versionConflict(m, before);
        if (m.effectiveTo !== null) {
          throw new AppError('INVALID_TRANSITION', 'This membership has already ended.', [
            { code: 'INVALID_TRANSITION', message: `It ended on ${before.effective_to ?? ''}.` },
          ]);
        }
        if (to < before.effective_from) {
          throw Errors.validation([
            invalid('effective_to', `Cannot be before ${before.effective_from}, when it started.`),
          ]);
        }
        await tx.teamMember.update({
          where: { id: memberId },
          data: { effectiveTo: businessDateToDb(to), ...stamp(actorId) },
        });
        const after = toMemberOut(await memberOrNotFound(tx, teamId, memberId), today());
        await auditUpdate(tx, MEMBER_AUDIT, memberId, before, after, { actorId });
        return after;
      });
    },

    /** Changes the role in the team (leader, assistant, member) over the membership's whole span. */
    async setRole(teamId: bigint, memberId: bigint, expectedVersion: number, role: string, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const team = await teamOrNotFound(tx, teamId);
        await canWrite(team.estateId, memberId, 'update-member');
        const m = await memberOrNotFound(tx, teamId, memberId);
        const before = toMemberOut(m, today());
        if (m.version !== expectedVersion) versionConflict(m, before);
        if (role === 'leader') {
          await assertOneLeader(
            tx,
            teamId,
            businessDateFromDb(m.effectiveFrom),
            day(m.effectiveTo),
            memberId,
            'role_in_team',
          );
        }
        await tx.teamMember.update({
          where: { id: memberId },
          data: { roleInTeam: role, ...stamp(actorId) },
        });
        const after = toMemberOut(await memberOrNotFound(tx, teamId, memberId), today());
        await auditUpdate(tx, MEMBER_AUDIT, memberId, before, after, { actorId });
        return after;
      });
    },

    /** A membership entered in error. */
    async removeMember(teamId: bigint, memberId: bigint, actorId: bigint) {
      await withTransaction(db, async (tx) => {
        const team = await teamOrNotFound(tx, teamId);
        await canWrite(team.estateId, memberId, 'remove-member');
        const m = await memberOrNotFound(tx, teamId, memberId);
        await tx.teamMember.delete({ where: { id: memberId } });
        await auditDelete(tx, MEMBER_AUDIT, memberId, toMemberOut(m, today()), { actorId });
      });
    },

    /** GET /employment-profiles/{id}/teams: the worker's memberships, latest first. */
    async ofProfile(profileId: bigint) {
      const p = await db.employmentProfile.findUnique({ where: { id: profileId }, select: { id: true } });
      if (!p) throw Errors.notFound('Employment profile not found.');
      const rows = await db.teamMember.findMany({
        where: { employmentProfileId: profileId },
        include: memberInclude,
        orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
      });
      return rows.map((r) => toMemberOut(r, today()));
    },
  };
}

/**
 * Separation ends the worker's memberships (profile.service, in its transaction): open ones end on the
 * separation date; ones that would only start after it are removed.
 */
export async function endMembershipsOnSeparation(
  tx: Tx,
  profileId: bigint,
  on: BusinessDate,
  actorId: bigint,
) {
  const d = businessDateToDb(on);
  const rows = await tx.teamMember.findMany({
    where: { employmentProfileId: profileId, OR: [{ effectiveTo: null }, { effectiveTo: { gt: d } }] },
    select: { id: true, effectiveFrom: true, effectiveTo: true },
  });
  for (const r of rows) {
    if (r.effectiveFrom > d) {
      await tx.teamMember.delete({ where: { id: r.id } });
      await auditDelete(
        tx,
        MEMBER_AUDIT,
        r.id,
        { effective_from: businessDateFromDb(r.effectiveFrom) },
        { actorId, reason: 'Separation' },
      );
    } else {
      await tx.teamMember.update({
        where: { id: r.id },
        data: { effectiveTo: d, version: { increment: 1 }, updatedAt: new Date(), updatedBy: actorId },
      });
      await auditUpdate(
        tx,
        MEMBER_AUDIT,
        r.id,
        { effective_to: day(r.effectiveTo) },
        { effective_to: on },
        { actorId, reason: 'Separation' },
      );
    }
  }
}

export type TeamService = ReturnType<typeof teamService>;
