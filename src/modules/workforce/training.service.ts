import type { z } from 'zod';

import type { AccessLog } from '../../core/audit/access-log.js';
import {
  auditAction,
  auditCreate,
  auditDelete,
  auditUpdate,
  recordStatusChange,
  type AuditedRecord,
} from '../../core/audit/audit.js';
import type { ApprovalAdapter } from '../../core/approval/adapters.js';
import { submitForApproval } from '../../core/approval/engine.js';
import { constraintViolation } from '../../core/db/errors.js';
import { toOrderBy, toPaging, toWhere, type ListFieldMap } from '../../core/db/list.js';
import type { Database } from '../../core/db/prisma.js';
import { lockRowsForUpdate, withTransaction, type Tx } from '../../core/db/transaction.js';
import { AppError, Errors, type ErrorDetail } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { toDecimalString } from '../../core/money/decimal.js';
import { allocateNumber } from '../../core/numbering/numbering.js';
import { scopeToCheck } from '../../core/scope/scope.js';
import { businessDateFromDb, businessDateToDb, todayIn } from '../../core/time/dates.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { denyWrite, duplicate, idOut, iso, versionConflict } from '../organisation/common.js';
import { assertExpenseBudgetHead } from '../accounting/dimensions.js';
import type {
  AddParticipantsBody,
  CreateProgramBody,
  ParticipantOut,
  PatchProgramBody,
  ProgramOut,
  RecordParticipantBody,
} from './training.schema.js';

/**
 * Training programmes and participants (P2.09; Spec P3 §24.1).
 *
 *   programme    per estate: draft → submitted → approved (planned), or rejected / returned; an approved
 *                one is completed once every participant's attendance is recorded, or cancelled with a
 *                reason. Only a draft is changed or deleted.
 *   participant  one row per programme and profile (ux_training_participant, the verification):
 *                profiles of the programme's estate, within its capacity; attendance, score, result,
 *                certificate and feedback are recorded from the start date. Only someone who attended is
 *                assessed or certified.
 */

type ProgramOutT = z.infer<typeof ProgramOut>;
type ParticipantOutT = z.infer<typeof ParticipantOut>;

export const PROGRAM_DOCUMENT = 'training_program';
export const PROGRAM_AUDIT: AuditedRecord = {
  type: PROGRAM_DOCUMENT,
  class: 'operational',
  fields: [
    'program_code',
    'estate_id',
    'title',
    'training_type',
    'trainer_name',
    'trainer_type',
    'venue',
    'start_date',
    'end_date',
    'duration_hours',
    'capacity',
    'cost',
    'budget_head_id',
    'description',
    'state',
    'cancellation_reason',
  ],
};
export const PARTICIPANT_AUDIT: AuditedRecord = {
  type: 'training_participant',
  class: 'master',
  fields: [
    'training_program_id',
    'employment_profile_id',
    'attendance_status',
    'score',
    'result',
    'certificate_number',
    'certificate_issued_on',
    'feedback_rating',
    'remarks',
  ],
};

const idf = (v: unknown) => BigInt(String(v));
export const PROGRAM_LIST_FIELDS: ListFieldMap = {
  estate_id: { field: 'estateId', convert: idf },
  training_type: { field: 'trainingType' },
  trainer_type: { field: 'trainerType' },
  state: { field: 'state' },
  start_date: { field: 'startDate' },
  program_code: { field: 'programCode' },
  title: { field: 'title' },
};

const programInclude = {
  estate: { select: { id: true, code: true, name: true } },
  approver: { select: { id: true, username: true } },
  _count: { select: { participants: { where: { attendanceStatus: { not: 'withdrawn' } } } } },
} as const satisfies Prisma.TrainingProgramInclude;
type ProgramRow = Prisma.TrainingProgramGetPayload<{ include: typeof programInclude }>;
const participantInclude = {
  program: { select: { id: true, programCode: true, title: true, startDate: true, endDate: true } },
  profile: { select: { id: true, profileNumber: true, person: { select: { fullName: true } } } },
} as const satisfies Prisma.TrainingParticipantInclude;
type ParticipantRow = Prisma.TrainingParticipantGetPayload<{ include: typeof participantInclude }>;

const invalid = (field: string, message: string): ErrorDetail => ({
  field,
  code: 'VALIDATION_FAILED',
  message,
});
const transition = (message: string, state: string, help: string) =>
  new AppError('INVALID_TRANSITION', message, [
    { code: 'INVALID_TRANSITION', message: help, context: { state } },
  ]);
const d = (v: Date | null) => (v ? businessDateFromDb(v) : null);

export interface TrainingServiceDeps {
  readonly db: Database;
  readonly accessLog: AccessLog;
  readonly timezone: string;
}

export function trainingService({ db, accessLog, timezone }: TrainingServiceDeps) {
  const today = () => todayIn(timezone);
  const stamp = (actorId: bigint) => ({
    version: { increment: 1 },
    updatedAt: new Date(),
    updatedBy: actorId,
  });
  async function canManage(estateId: bigint, recordId: bigint | null, operation: string) {
    const scope = await scopeToCheck();
    if (scope === null || scope.allEstates || scope.estates.includes(estateId)) return;
    await denyWrite(accessLog, 'training', recordId, operation);
  }
  async function approvalId(tx: Database | Tx, p: { id: bigint; state: string }) {
    if (p.state !== 'submitted') return null;
    return (
      (
        await tx.approvalRequest.findFirst({
          where: { documentType: PROGRAM_DOCUMENT, documentId: p.id, state: 'pending' },
          select: { id: true },
        })
      )?.id ?? null
    );
  }

  function toProgramOut(p: ProgramRow, approval: bigint | null): ProgramOutT {
    const count = p._count.participants;
    return {
      id: p.id.toString(),
      program_code: p.programCode,
      estate_id: p.estateId.toString(),
      estate: { id: p.estate.id.toString(), code: p.estate.code, name: p.estate.name },
      title: p.title,
      training_type: p.trainingType as ProgramOutT['training_type'],
      trainer_name: p.trainerName,
      trainer_type: p.trainerType as ProgramOutT['trainer_type'],
      venue: p.venue,
      start_date: businessDateFromDb(p.startDate),
      end_date: businessDateFromDb(p.endDate),
      duration_hours: p.durationHours === null ? null : toDecimalString(p.durationHours.toString(), 'pct'),
      capacity: p.capacity,
      cost: p.cost === null ? null : toDecimalString(p.cost.toString(), 'money'),
      budget_head_id: p.budgetHeadId?.toString() ?? null,
      description: p.description,
      participant_count: count,
      seats_left: p.capacity === null ? null : Math.max(0, p.capacity - count),
      state: p.state as ProgramOutT['state'],
      approval_id: idOut(approval),
      approved_at: iso(p.approvedAt),
      approved_by: p.approver ? { id: p.approver.id.toString(), username: p.approver.username } : null,
      rejection_reason: p.rejectionReason,
      cancellation_reason: p.cancellationReason,
      version: p.version,
      created_at: p.createdAt.toISOString(),
    };
  }
  async function programOut(tx: Database | Tx, p: ProgramRow) {
    return toProgramOut(p, await approvalId(tx, p));
  }
  async function programOrNotFound(tx: Database | Tx, id: bigint) {
    const p = await tx.trainingProgram.findUnique({ where: { id }, include: programInclude });
    if (!p) throw Errors.notFound('Training programme not found.');
    return p;
  }
  function toParticipantOut(r: ParticipantRow): ParticipantOutT {
    return {
      id: r.id.toString(),
      training_program_id: r.trainingProgramId.toString(),
      program: {
        id: r.program.id.toString(),
        program_code: r.program.programCode,
        title: r.program.title,
        start_date: businessDateFromDb(r.program.startDate),
        end_date: businessDateFromDb(r.program.endDate),
      },
      employment_profile_id: r.employmentProfileId.toString(),
      profile: {
        id: r.profile.id.toString(),
        profile_number: r.profile.profileNumber,
        full_name: r.profile.person.fullName,
      },
      attendance_status: r.attendanceStatus as ParticipantOutT['attendance_status'],
      score: r.score === null ? null : toDecimalString(r.score.toString(), 'pct'),
      result: r.result as ParticipantOutT['result'],
      certificate_number: r.certificateNumber,
      certificate_issued_on: d(r.certificateIssuedOn),
      feedback_rating: r.feedbackRating,
      remarks: r.remarks,
      version: r.version,
    };
  }

  const adapter: ApprovalAdapter = {
    documentType: PROGRAM_DOCUMENT,
    async describe(tx, id) {
      const p = await programOrNotFound(tx, id);
      return {
        id,
        number: p.programCode,
        label: `${p.programCode} · ${p.title}`,
        createdBy: p.createdBy,
        estateId: p.estateId,
        values: {
          estate_id: p.estateId.toString(),
          cost: p.cost === null ? null : toDecimalString(p.cost.toString(), 'money'),
        },
        amount: p.cost === null ? null : p.cost.toFixed(2),
      };
    },
    async onApproved(tx, id, ctx) {
      await lockRowsForUpdate(tx, 'training_program', { id });
      const p = await programOrNotFound(tx, id);
      if (p.state !== 'submitted')
        throw transition(`A ${p.state} programme cannot be approved.`, p.state, 'Reload it.');
      const now = new Date();
      await tx.trainingProgram.update({
        where: { id },
        data: {
          state: 'approved',
          stateChangedAt: now,
          approvedAt: now,
          approvedBy: ctx.actorId,
          ...stamp(ctx.actorId),
        },
      });
      await auditAction(tx, PROGRAM_AUDIT, id, 'approve', {
        actorId: ctx.actorId,
        actingForUserId: ctx.actingForUserId,
      });
      await recordStatusChange(tx, PROGRAM_AUDIT.type, id, 'submitted', 'approved', { actorId: ctx.actorId });
    },
    async onRejected(tx, id, ctx) {
      const now = new Date();
      await tx.trainingProgram.update({
        where: { id },
        data: {
          state: 'rejected',
          stateChangedAt: now,
          rejectedAt: now,
          rejectedBy: ctx.actorId,
          rejectionReason: ctx.reason.slice(0, 500),
          ...stamp(ctx.actorId),
        },
      });
      await auditAction(tx, PROGRAM_AUDIT, id, 'reject', { actorId: ctx.actorId, reason: ctx.reason });
      await recordStatusChange(tx, PROGRAM_AUDIT.type, id, 'submitted', 'rejected', {
        actorId: ctx.actorId,
        comment: ctx.reason,
      });
    },
    async onReturned(tx, id, ctx) {
      await tx.trainingProgram.update({
        where: { id },
        data: {
          state: 'draft',
          stateChangedAt: new Date(),
          submittedAt: null,
          submittedBy: null,
          ...stamp(ctx.actorId),
        },
      });
      await recordStatusChange(tx, PROGRAM_AUDIT.type, id, 'submitted', 'draft', {
        actorId: ctx.actorId,
        comment: ctx.comment,
      });
    },
  };

  /** A programme open to participants: not rejected, completed or cancelled. */
  const open = (p: { state: string }) => {
    if (!['draft', 'submitted', 'approved'].includes(p.state)) {
      throw transition(
        `A ${p.state} programme takes no change to its participants.`,
        p.state,
        'Only an open programme.',
      );
    }
  };

  return {
    adapter,
    programs: {
      async list(q: ListQuery) {
        const where = toWhere(q, PROGRAM_LIST_FIELDS) as Prisma.TrainingProgramWhereInput;
        const [rows, total] = await Promise.all([
          db.trainingProgram.findMany({
            where,
            include: programInclude,
            orderBy: [...toOrderBy(q.sort, PROGRAM_LIST_FIELDS), { id: 'desc' }],
            ...toPaging(q),
          }),
          db.trainingProgram.count({ where }),
        ]);
        const items: ProgramOutT[] = [];
        for (const r of rows) items.push(await programOut(db, r));
        return { items, total };
      },
      async get(id: bigint) {
        return programOut(db, await programOrNotFound(db, id));
      },
      async create(b: z.infer<typeof CreateProgramBody>, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          const estate = await tx.estate.findUnique({
            where: { id: b.estate_id },
            select: { id: true, code: true, status: true },
          });
          if (estate?.status !== 'active')
            throw Errors.validation([invalid('estate_id', 'No such active estate.')]);
          await canManage(estate.id, null, 'create-program');
          if (b.end_date < b.start_date)
            throw Errors.validation([invalid('end_date', 'Cannot be before start_date.')]);
          const code =
            b.program_code ??
            (
              await allocateNumber(
                tx,
                PROGRAM_DOCUMENT,
                { date: b.start_date, estateCode: estate.code },
                'draft',
              )
            ).number;
          await assertExpenseBudgetHead(tx, b.budget_head_id);
          const p = await tx.trainingProgram
            .create({
              data: {
                programCode: code,
                estateId: estate.id,
                title: b.title,
                trainingType: b.training_type,
                trainerName: b.trainer_name ?? null,
                trainerType: b.trainer_type ?? 'internal',
                venue: b.venue ?? null,
                startDate: businessDateToDb(b.start_date),
                endDate: businessDateToDb(b.end_date),
                durationHours: b.duration_hours?.toString() ?? null,
                capacity: b.capacity ?? null,
                cost: b.cost?.toString() ?? null,
                budgetHeadId: b.budget_head_id ?? null,
                description: b.description ?? null,
                state: 'draft',
                stateChangedAt: new Date(),
                createdBy: actorId,
              },
              select: { id: true },
            })
            .catch(duplicate('program_code', `Programme code ${code}`));
          const out = await programOut(tx, await programOrNotFound(tx, p.id));
          await auditCreate(tx, PROGRAM_AUDIT, p.id, out, { actorId });
          await recordStatusChange(tx, PROGRAM_AUDIT.type, p.id, null, 'draft', { actorId });
          return out;
        });
      },
      async update(id: bigint, version: number, b: z.infer<typeof PatchProgramBody>, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          const before = await programOrNotFound(tx, id);
          await canManage(before.estateId, id, 'update-program');
          if (before.state !== 'draft')
            throw transition(
              `A ${before.state} programme cannot be changed.`,
              before.state,
              'Only a draft is changed.',
            );
          const start = b.start_date ?? businessDateFromDb(before.startDate);
          const end = b.end_date ?? businessDateFromDb(before.endDate);
          if (end < start) throw Errors.validation([invalid('end_date', 'Cannot be before start_date.')]);
          if (b.capacity !== undefined && b.capacity !== null && b.capacity < before._count.participants) {
            throw Errors.validation([
              invalid(
                'capacity',
                `${String(before._count.participants)} participants are already registered.`,
              ),
            ]);
          }
          await assertExpenseBudgetHead(tx, b.budget_head_id);
          const data: Record<string, unknown> = {};
          const map: [keyof typeof b, string, (v: unknown) => unknown][] = [
            ['program_code', 'programCode', (v) => v],
            ['title', 'title', (v) => v],
            ['training_type', 'trainingType', (v) => v],
            ['trainer_name', 'trainerName', (v) => v],
            ['trainer_type', 'trainerType', (v) => v],
            ['venue', 'venue', (v) => v],
            ['start_date', 'startDate', (v) => businessDateToDb(v as never)],
            ['end_date', 'endDate', (v) => businessDateToDb(v as never)],
            [
              'duration_hours',
              'durationHours',
              (v) => (v === null ? null : (v as { toString(): string }).toString()),
            ],
            ['capacity', 'capacity', (v) => v],
            ['cost', 'cost', (v) => (v === null ? null : (v as { toString(): string }).toString())],
            ['budget_head_id', 'budgetHeadId', (v) => v],
            ['description', 'description', (v) => v],
          ];
          for (const [k, col, f] of map) if (b[k] !== undefined) data[col] = f(b[k]);
          const { count } = await tx.trainingProgram
            .updateMany({ where: { id, version }, data: { ...data, ...stamp(actorId) } })
            .catch(duplicate('program_code', `Programme code ${b.program_code ?? ''}`));
          const old = await programOut(tx, before);
          if (count !== 1) versionConflict(before, old);
          const after = await programOut(tx, await programOrNotFound(tx, id));
          await auditUpdate(tx, PROGRAM_AUDIT, id, old, after, { actorId });
          return after;
        });
      },
      async remove(id: bigint, actorId: bigint) {
        await withTransaction(db, async (tx) => {
          const p = await programOrNotFound(tx, id);
          await canManage(p.estateId, id, 'delete-program');
          if (p.state !== 'draft')
            throw transition(`A ${p.state} programme cannot be deleted.`, p.state, 'Cancel it instead.');
          const out = await programOut(tx, p);
          await tx.trainingParticipant.deleteMany({ where: { trainingProgramId: id } });
          await tx.trainingProgram.delete({ where: { id } });
          await auditDelete(tx, PROGRAM_AUDIT, id, out, { actorId });
        });
      },
      async submit(id: bigint, version: number, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          await lockRowsForUpdate(tx, 'training_program', { id });
          const p = await programOrNotFound(tx, id);
          await canManage(p.estateId, id, 'submit-program');
          if (p.version !== version) versionConflict(p, await programOut(tx, p));
          if (p.state !== 'draft')
            throw transition(
              `A ${p.state} programme cannot be submitted.`,
              p.state,
              'Only a draft is submitted.',
            );
          const now = new Date();
          await tx.trainingProgram.update({
            where: { id },
            data: {
              state: 'submitted',
              stateChangedAt: now,
              submittedAt: now,
              submittedBy: actorId,
              ...stamp(actorId),
            },
          });
          await recordStatusChange(tx, PROGRAM_AUDIT.type, id, 'draft', 'submitted', { actorId });
          await submitForApproval(tx, { timezone }, PROGRAM_DOCUMENT, id, { actorId, date: today() });
          return programOut(tx, await programOrNotFound(tx, id));
        });
      },
      /** An approved programme whose participants' attendance is all recorded, from its end date. */
      async complete(id: bigint, version: number, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          const p = await programOrNotFound(tx, id);
          await canManage(p.estateId, id, 'complete-program');
          const old = await programOut(tx, p);
          if (p.version !== version) versionConflict(p, old);
          if (p.state !== 'approved')
            throw transition(
              `A ${p.state} programme cannot be completed.`,
              p.state,
              'Only an approved programme.',
            );
          if (businessDateFromDb(p.endDate) > today())
            throw Errors.validation([invalid('end_date', 'The programme has not ended yet.')]);
          const pending = await tx.trainingParticipant.count({
            where: { trainingProgramId: id, attendanceStatus: 'registered' },
          });
          if (pending > 0)
            throw Errors.validation([
              invalid('attendance_status', `${String(pending)} participants have no attendance recorded.`),
            ]);
          await tx.trainingProgram.update({
            where: { id },
            data: { state: 'completed', stateChangedAt: new Date(), ...stamp(actorId) },
          });
          const after = await programOut(tx, await programOrNotFound(tx, id));
          await auditUpdate(tx, PROGRAM_AUDIT, id, old, after, { actorId });
          await recordStatusChange(tx, PROGRAM_AUDIT.type, id, 'approved', 'completed', { actorId });
          return after;
        });
      },
      async cancel(id: bigint, version: number, reason: string, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          const p = await programOrNotFound(tx, id);
          await canManage(p.estateId, id, 'cancel-program');
          const old = await programOut(tx, p);
          if (p.version !== version) versionConflict(p, old);
          if (p.state !== 'approved' && p.state !== 'draft')
            throw transition(
              `A ${p.state} programme cannot be cancelled.`,
              p.state,
              'A draft or an approved programme.',
            );
          await tx.trainingProgram.update({
            where: { id },
            data: {
              state: 'cancelled',
              stateChangedAt: new Date(),
              cancellationReason: reason,
              ...stamp(actorId),
            },
          });
          const after = await programOut(tx, await programOrNotFound(tx, id));
          await auditUpdate(tx, PROGRAM_AUDIT, id, old, after, { actorId, reason });
          await recordStatusChange(tx, PROGRAM_AUDIT.type, id, p.state, 'cancelled', {
            actorId,
            comment: reason,
          });
          return after;
        });
      },
    },

    participants: {
      async list(programId: bigint) {
        await programOrNotFound(db, programId);
        const rows = await db.trainingParticipant.findMany({
          where: { trainingProgramId: programId },
          include: participantInclude,
          orderBy: { id: 'asc' },
        });
        return rows.map(toParticipantOut);
      },
      /** GET /employment-profiles/{id}/trainings: a profile's training history. */
      async ofProfile(profileId: bigint) {
        if (!(await db.employmentProfile.findUnique({ where: { id: profileId }, select: { id: true } })))
          throw Errors.notFound('Employment profile not found.');
        const rows = await db.trainingParticipant.findMany({
          where: { employmentProfileId: profileId },
          include: participantInclude,
          orderBy: [{ program: { startDate: 'desc' } }],
        });
        return rows.map(toParticipantOut);
      },
      async add(programId: bigint, b: z.infer<typeof AddParticipantsBody>, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          await lockRowsForUpdate(tx, 'training_program', { id: programId });
          const p = await programOrNotFound(tx, programId);
          await canManage(p.estateId, programId, 'add-participants');
          open(p);
          if (p.capacity !== null && p._count.participants + b.employment_profile_ids.length > p.capacity) {
            throw Errors.validation([
              invalid(
                'employment_profile_ids',
                `Only ${String(Math.max(0, p.capacity - p._count.participants))} seats are left.`,
              ),
            ]);
          }
          const ids: bigint[] = [];
          for (const [i, pid] of b.employment_profile_ids.entries()) {
            const prof = await tx.employmentProfile.findUnique({
              where: { id: pid },
              select: { estateId: true, status: true },
            });
            if (prof?.estateId !== p.estateId || prof.status === 'separated') {
              throw Errors.validation([
                invalid(
                  `employment_profile_ids[${String(i)}]`,
                  'Not a current profile of the programme’s estate.',
                ),
              ]);
            }
            const r = await tx.trainingParticipant
              .create({
                data: { trainingProgramId: programId, employmentProfileId: pid, createdBy: actorId },
                select: { id: true },
              })
              .catch((err: unknown) => {
                if (constraintViolation(err)?.kind === 'unique') {
                  throw new AppError('DUPLICATE_KEY', 'That profile is already a participant.', [
                    {
                      field: `employment_profile_ids[${String(i)}]`,
                      code: 'DUPLICATE_KEY',
                      message: 'One row per programme and profile.',
                    },
                  ]);
                }
                throw err;
              });
            ids.push(r.id);
          }
          const rows = await tx.trainingParticipant.findMany({
            where: { id: { in: ids } },
            include: participantInclude,
            orderBy: { id: 'asc' },
          });
          const out = rows.map(toParticipantOut);
          for (const o of out) await auditCreate(tx, PARTICIPANT_AUDIT, BigInt(o.id), o, { actorId });
          return out;
        });
      },
      /** Attendance, score, result, certificate, feedback: from the start date; assessed only if attended. */
      async record(
        programId: bigint,
        participantId: bigint,
        version: number,
        b: z.infer<typeof RecordParticipantBody>,
        actorId: bigint,
      ) {
        return withTransaction(db, async (tx) => {
          const p = await programOrNotFound(tx, programId);
          await canManage(p.estateId, participantId, 'record-participant');
          if (p.state !== 'approved')
            throw transition(
              `Results are recorded on an approved programme, not a ${p.state} one.`,
              p.state,
              'Approve the programme first.',
            );
          const before = await tx.trainingParticipant.findUnique({
            where: { id: participantId },
            include: participantInclude,
          });
          if (before?.trainingProgramId !== programId) throw Errors.notFound('Participant not found.');
          const attendance = b.attendance_status ?? before.attendanceStatus;
          const problems: ErrorDetail[] = [];
          if (
            attendance !== 'registered' &&
            attendance !== 'withdrawn' &&
            businessDateFromDb(p.startDate) > today()
          ) {
            problems.push(invalid('attendance_status', 'The programme has not started yet.'));
          }
          const assessed =
            (b.result ?? before.result) !== 'not_assessed' ||
            (b.score !== undefined ? b.score !== null : before.score !== null) ||
            (b.certificate_number !== undefined
              ? b.certificate_number !== null
              : before.certificateNumber !== null);
          if (assessed && attendance !== 'attended')
            problems.push(invalid('result', 'Only someone who attended is assessed or certified.'));
          if (problems.length > 0) throw Errors.validation(problems);
          const data: Record<string, unknown> = {};
          if (b.attendance_status !== undefined) data.attendanceStatus = b.attendance_status;
          if (b.score !== undefined) data.score = b.score === null ? null : b.score.toString();
          if (b.result !== undefined) data.result = b.result;
          if (b.certificate_number !== undefined) data.certificateNumber = b.certificate_number;
          if (b.certificate_issued_on !== undefined)
            data.certificateIssuedOn =
              b.certificate_issued_on === null ? null : businessDateToDb(b.certificate_issued_on);
          if (b.feedback_rating !== undefined) data.feedbackRating = b.feedback_rating;
          if (b.remarks !== undefined) data.remarks = b.remarks;
          const { count } = await tx.trainingParticipant.updateMany({
            where: { id: participantId, version },
            data: { ...data, ...stamp(actorId) },
          });
          const old = toParticipantOut(before);
          if (count !== 1) versionConflict(before, old);
          const after = toParticipantOut(
            await tx.trainingParticipant.findUniqueOrThrow({
              where: { id: participantId },
              include: participantInclude,
            }),
          );
          await auditUpdate(tx, PARTICIPANT_AUDIT, participantId, old, after, { actorId });
          return after;
        });
      },
      async remove(programId: bigint, participantId: bigint, actorId: bigint) {
        await withTransaction(db, async (tx) => {
          const p = await programOrNotFound(tx, programId);
          await canManage(p.estateId, participantId, 'remove-participant');
          open(p);
          const r = await tx.trainingParticipant.findUnique({
            where: { id: participantId },
            include: participantInclude,
          });
          if (r?.trainingProgramId !== programId) throw Errors.notFound('Participant not found.');
          await tx.trainingParticipant.delete({ where: { id: participantId } });
          await auditDelete(tx, PARTICIPANT_AUDIT, participantId, toParticipantOut(r), { actorId });
        });
      },
    },
  };
}

export type TrainingService = ReturnType<typeof trainingService>;
