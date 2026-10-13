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
import { businessDateFromDb, businessDateToDb, type BusinessDate } from '../../core/time/dates.js';
import type { Prisma, Season } from '../../generated/prisma/client.js';
import {
  denyWrite,
  duplicate,
  idOut,
  iso,
  referenced,
  versionConflict,
  writable,
} from '../organisation/common.js';
import type { CreateSeasonBody, PatchSeasonBody, SeasonOut, SeasonState } from './calendar.schema.js';

/**
 * Seasons (Spec P3 §4.8, P1 §5.2, §14.3, P4 §7.2): the agricultural calendar of one estate.
 *
 *   planned ──activate──► active ──close──► closed
 *
 *   - Seasons of one estate NEVER overlap, in any state: an operational record dated 12 June must belong
 *     to exactly one season. MySQL has no exclusion constraint, so the estate row is locked while the
 *     dates are checked (two concurrent creates cannot both pass).
 *   - planned: everything editable, may be deleted. active: name and end_date only (records already carry
 *     the season). closed: nothing; it rejects new operational transactions dated within it.
 *   - Closing has no effect on accounting, and nothing here reads the fiscal calendar (P1 §5.2 rule).
 *   - Scope: reads follow the extension; changing a season needs the estate grant.
 */

type SeasonOutT = z.infer<typeof SeasonOut>;

export const SEASON_AUDIT: AuditedRecord = {
  type: 'season',
  class: 'master',
  fields: ['estate_id', 'code', 'name', 'start_date', 'end_date', 'state'],
};

export const SEASON_LIST_FIELDS: ListFieldMap = {
  estate_id: { field: 'estateId', convert: (v) => BigInt(String(v)) },
  state: { field: 'state' },
  code: { field: 'code' },
  start_date: { field: 'startDate', convert: (v) => businessDateToDb(String(v) as BusinessDate) },
  end_date: { field: 'endDate', convert: (v) => businessDateToDb(String(v) as BusinessDate) },
};

export function toSeasonOut(s: Season): SeasonOutT {
  return {
    id: s.id.toString(),
    estate_id: s.estateId.toString(),
    code: s.code,
    name: s.name,
    start_date: businessDateFromDb(s.startDate),
    end_date: businessDateFromDb(s.endDate),
    state: s.state as SeasonState,
    closed_at: iso(s.closedAt),
    closed_by: idOut(s.closedBy),
    version: s.version,
    created_at: s.createdAt.toISOString(),
    updated_at: iso(s.updatedAt),
  };
}

const invalid = (field: string, message: string, context?: Record<string, unknown>): ErrorDetail => ({
  field,
  code: 'VALIDATION_FAILED',
  message,
  ...(context ? { context } : {}),
});

const wrongState = (s: Season, message: string) =>
  new AppError('INVALID_TRANSITION', message, [
    { code: 'INVALID_TRANSITION', message: `the season is ${s.state}`, context: { state: s.state } },
  ]);

/** The season of an estate that contains a date, or null. For operational modules (P1 §5.2). */
export async function seasonOn(
  tx: Database | Tx,
  estateId: bigint,
  date: BusinessDate,
): Promise<Season | null> {
  const d = businessDateToDb(date);
  return tx.season.findFirst({ where: { estateId, startDate: { lte: d }, endDate: { gte: d } } });
}

/**
 * Refuses an operational transaction dated inside a CLOSED season (P1 §14.3): 423 SEASON_CLOSED. Returns
 * the season, or null where no season covers the date (the caller decides whether one is required).
 */
export async function assertSeasonOpenOn(
  tx: Database | Tx,
  estateId: bigint,
  date: BusinessDate,
): Promise<Season | null> {
  const season = await seasonOn(tx, estateId, date);
  if (season?.state === 'closed') {
    throw new AppError(
      'SEASON_CLOSED',
      `Season ${season.code} is closed; nothing dated ${date} can be recorded.`,
      [
        {
          code: 'SEASON_CLOSED',
          message: `closed season ${season.code}`,
          context: { season_id: season.id.toString(), code: season.code, date },
        },
      ],
    );
  }
  return season;
}

export function seasonsService(db: Database, accessLog: AccessLog) {
  async function seasonOrNotFound(tx: Database | Tx, id: bigint): Promise<Season> {
    const s = await tx.season.findUnique({ where: { id } });
    if (!s) throw Errors.notFound('Season not found.');
    return s;
  }

  /** Call with the estate row locked. */
  async function assertNoOverlap(
    tx: Tx,
    estateId: bigint,
    start: BusinessDate,
    end: BusinessDate,
    exceptId?: bigint,
  ) {
    if (end <= start) throw Errors.validation([invalid('end_date', 'must be after start_date')]);
    const other = await tx.season.findFirst({
      where: {
        estateId,
        ...(exceptId === undefined ? {} : { id: { not: exceptId } }),
        startDate: { lte: businessDateToDb(end) },
        endDate: { gte: businessDateToDb(start) },
      },
      orderBy: { startDate: 'asc' },
    });
    if (other) {
      const o = toSeasonOut(other);
      throw Errors.validation([
        invalid('start_date', `overlaps season ${o.code} (${o.start_date} to ${o.end_date})`, {
          season_id: o.id,
          code: o.code,
          start_date: o.start_date,
          end_date: o.end_date,
        }),
      ]);
    }
  }

  const stamp = (actorId: bigint) => ({
    version: { increment: 1 },
    updatedAt: new Date(),
    updatedBy: actorId,
  });

  async function mayChange(s: Season, operation: string): Promise<void> {
    if (!(await writable({ estate: s.estateId }))) await denyWrite(accessLog, 'season', s.id, operation);
  }

  return {
    async list(q: ListQuery) {
      const where = toWhere(q, SEASON_LIST_FIELDS) as Prisma.SeasonWhereInput;
      const [rows, total] = await Promise.all([
        db.season.findMany({
          where,
          orderBy: [...toOrderBy(q.sort, SEASON_LIST_FIELDS), { id: 'asc' }],
          ...toPaging(q),
        }),
        db.season.count({ where }),
      ]);
      return { items: rows.map(toSeasonOut), total };
    },

    async get(id: bigint) {
      return toSeasonOut(await seasonOrNotFound(db, id));
    },

    async create(body: z.infer<typeof CreateSeasonBody>, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const estate = await tx.estate.findUnique({
          where: { id: body.estate_id },
          select: { id: true, status: true },
        });
        if (!estate) throw Errors.validation([invalid('estate_id', 'No such estate.')]);
        if (!(await writable({ estate: estate.id }))) await denyWrite(accessLog, 'season', null, 'create');
        if (estate.status !== 'active')
          throw Errors.validation([invalid('estate_id', 'The estate is inactive.')]);
        await lockRowsForUpdate(tx, 'estate', { id: estate.id });
        await assertNoOverlap(tx, estate.id, body.start_date, body.end_date);
        const { id } = await tx.season
          .create({
            data: {
              estateId: estate.id,
              code: body.code,
              name: body.name,
              startDate: businessDateToDb(body.start_date),
              endDate: businessDateToDb(body.end_date),
              state: 'planned',
              createdBy: actorId,
            },
            select: { id: true },
          })
          .catch(duplicate('code', `Season code ${body.code} in this estate`));
        const out = toSeasonOut(await seasonOrNotFound(tx, id));
        await auditCreate(tx, SEASON_AUDIT, id, out, { actorId });
        await recordStatusChange(tx, SEASON_AUDIT.type, id, null, out.state, { actorId });
        return out;
      });
    },

    async update(
      id: bigint,
      expectedVersion: number,
      changes: z.infer<typeof PatchSeasonBody>,
      actorId: bigint,
    ) {
      return withTransaction(db, async (tx) => {
        const before = await seasonOrNotFound(tx, id);
        await mayChange(before, 'update');
        if (before.state === 'closed') throw wrongState(before, 'A closed season cannot be changed.');
        const current = toSeasonOut(before);
        if (before.state === 'active') {
          const fixed = (['code', 'start_date'] as const).filter(
            (f) => changes[f] !== undefined && changes[f] !== current[f],
          );
          if (fixed.length > 0) {
            throw Errors.validation(
              fixed.map((f) => invalid(f, 'cannot be changed once the season is active')),
            );
          }
        }
        const start = changes.start_date ?? (current.start_date as BusinessDate);
        const end = changes.end_date ?? (current.end_date as BusinessDate);
        await lockRowsForUpdate(tx, 'estate', { id: before.estateId });
        await assertNoOverlap(tx, before.estateId, start, end, id);
        const { count } = await tx.season
          .updateMany({
            where: { id, version: expectedVersion },
            data: {
              ...(changes.code !== undefined ? { code: changes.code } : {}),
              ...(changes.name !== undefined ? { name: changes.name } : {}),
              startDate: businessDateToDb(start),
              endDate: businessDateToDb(end),
              ...stamp(actorId),
            },
          })
          .catch(duplicate('code', `Season code ${changes.code ?? ''} in this estate`));
        if (count !== 1) versionConflict(before, current);
        const after = toSeasonOut(await seasonOrNotFound(tx, id));
        await auditUpdate(tx, SEASON_AUDIT, id, current, after, { actorId });
        return after;
      });
    },

    /** planned → active. */
    async activate(id: bigint, expectedVersion: number, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const before = await seasonOrNotFound(tx, id);
        await mayChange(before, 'activate');
        if (before.version !== expectedVersion) versionConflict(before, toSeasonOut(before));
        if (before.state === 'active') return toSeasonOut(before);
        if (before.state !== 'planned') throw wrongState(before, 'Only a planned season can be activated.');
        await tx.season.update({ where: { id }, data: { state: 'active', ...stamp(actorId) } });
        await recordStatusChange(tx, SEASON_AUDIT.type, id, 'planned', 'active', { actorId });
        const after = toSeasonOut(await seasonOrNotFound(tx, id));
        await auditUpdate(tx, SEASON_AUDIT, id, toSeasonOut(before), after, { actorId });
        return after;
      });
    },

    /** active → closed: no further operational transactions dated within it (P1 §14.3). */
    async close(id: bigint, expectedVersion: number, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const before = await seasonOrNotFound(tx, id);
        await mayChange(before, 'close');
        if (before.version !== expectedVersion) versionConflict(before, toSeasonOut(before));
        if (before.state === 'closed') return toSeasonOut(before);
        if (before.state !== 'active') throw wrongState(before, 'Only an active season can be closed.');
        await tx.season.update({
          where: { id },
          data: { state: 'closed', closedAt: new Date(), closedBy: actorId, ...stamp(actorId) },
        });
        await recordStatusChange(tx, SEASON_AUDIT.type, id, 'active', 'closed', { actorId });
        const after = toSeasonOut(await seasonOrNotFound(tx, id));
        await auditUpdate(tx, SEASON_AUDIT, id, toSeasonOut(before), after, { actorId });
        return after;
      });
    },

    /** Only a planned season: once active, records may carry it. */
    async remove(id: bigint, actorId: bigint) {
      await withTransaction(db, async (tx) => {
        const s = await seasonOrNotFound(tx, id);
        await mayChange(s, 'delete');
        if (s.state !== 'planned') throw wrongState(s, 'Only a planned season can be deleted.');
        await tx.season.delete({ where: { id } }).catch(referenced('season'));
        await auditDelete(tx, SEASON_AUDIT, id, toSeasonOut(s), { actorId });
      });
    },
  };
}
