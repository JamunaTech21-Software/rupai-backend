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
import type { ApprovalAdapter, ApprovalContext } from '../../core/approval/adapters.js';
import { submitForApproval } from '../../core/approval/engine.js';
import { getRequestContext } from '../../core/context/request-context.js';
import { toOrderBy, toPaging, toWhere, type ListFieldMap } from '../../core/db/list.js';
import type { Database } from '../../core/db/prisma.js';
import { lockRowsForUpdate, withTransaction, type Tx } from '../../core/db/transaction.js';
import { AppError, Errors, type ErrorDetail } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { dec, round, sum, toDecimalString, type Dec } from '../../core/money/decimal.js';
import { allocateNumber } from '../../core/numbering/numbering.js';
import { runUnscoped, scopeToCheck } from '../../core/scope/scope.js';
import {
  businessDateFromDb,
  businessDateToDb,
  diffDays,
  todayIn,
  type BusinessDate,
} from '../../core/time/dates.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { denyWrite, idIn, idOut, iso, versionConflict } from '../organisation/common.js';
import type {
  CalendarOut,
  CreateEvaluationBody,
  CreateGoalBody,
  EvaluationOut,
  GoalOut,
  LinesBody,
  OverviewOut,
  PatchEvaluationBody,
  PatchGoalBody,
  ProgressBody,
  ProgressOut,
} from './performance.schema.js';

/**
 * Goals and evaluations (P2.10; Spec P3 §24.2–§24.3, P4 §12.4).
 *
 *   goal        owned by a profile, a department or an estate; draft → submitted → active (approved);
 *               progress updates make it in_progress; it is completed or cancelled. delayed and overdue
 *               are COMPUTED (nightly, and after each progress update), never keyed (D-2.10-2):
 *               overdue past the due date; delayed when progress trails the elapsed time by more than
 *               25 points.
 *   evaluation  a profile's review for a period: lines per criterion (weighted score = score ÷ max ×
 *               weight; overall = Σ weighted ÷ Σ weight × 100, rated); draft → submitted → approved, then
 *               ACKNOWLEDGED by the evaluated employee, which locks it for good (the verification). Never
 *               deleted.
 */

type GoalOutT = z.infer<typeof GoalOut>;
type EvaluationOutT = z.infer<typeof EvaluationOut>;

export const GOAL_DOCUMENT = 'goal';
export const EVALUATION_DOCUMENT = 'evaluation';
const DELAY_TOLERANCE = 25;
const LIVE = ['active', 'in_progress', 'delayed', 'overdue'] as const;

export const GOAL_AUDIT: AuditedRecord = {
  type: GOAL_DOCUMENT,
  class: 'operational',
  fields: [
    'owner_type',
    'owner_id',
    'parent_goal_id',
    'title',
    'description',
    'kpi_name',
    'measure_unit',
    'target_value',
    'current_value',
    'weight',
    'start_date',
    'due_date',
    'review_date',
    'progress_percentage',
    'state',
    'cancellation_reason',
  ],
};
export const EVALUATION_AUDIT: AuditedRecord = {
  type: EVALUATION_DOCUMENT,
  class: 'operational',
  fields: [
    'employment_profile_id',
    'reviewer_profile_id',
    'period_start',
    'period_end',
    'evaluation_type',
    'overall_score',
    'overall_rating',
    'strengths',
    'development_needs',
    'reviewer_comment',
    'employee_comment',
    'lines',
    'state',
  ],
};

const idf = (v: unknown) => BigInt(String(v));
export const GOAL_LIST_FIELDS: ListFieldMap = {
  owner_type: { field: 'ownerType' },
  owner_id: { field: 'ownerId', convert: idf },
  estate_id: { field: 'estateId', convert: idf },
  parent_goal_id: { field: 'parentGoalId', convert: idf },
  state: { field: 'state' },
  start_date: { field: 'startDate' },
  due_date: { field: 'dueDate' },
  goal_code: { field: 'goalCode' },
};
export const EVALUATION_LIST_FIELDS: ListFieldMap = {
  employment_profile_id: { field: 'employmentProfileId', convert: idf },
  reviewer_profile_id: { field: 'reviewerProfileId', convert: idf },
  estate_id: { field: 'estateId', convert: idf },
  evaluation_type: { field: 'evaluationType' },
  state: { field: 'state' },
  period_end: { field: 'periodEnd' },
  evaluation_number: { field: 'evaluationNumber' },
};

type GoalRow = Prisma.GoalGetPayload<object>;
const profileRef = {
  select: { id: true, profileNumber: true, person: { select: { fullName: true } } },
} as const;
const evaluationInclude = {
  profile: profileRef,
  reviewer: profileRef,
  lines: {
    include: { criteria: { select: { id: true, code: true, name: true, criteriaGroup: true } } },
    orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
  },
} as const satisfies Prisma.EvaluationInclude;
type EvaluationRow = Prisma.EvaluationGetPayload<{ include: typeof evaluationInclude }>;

const d = (v: Date | null) => (v ? businessDateFromDb(v) : null);
const pct = (v: Dec) => toDecimalString(v.toString(), 'pct');
const invalid = (field: string, message: string): ErrorDetail => ({
  field,
  code: 'VALIDATION_FAILED',
  message,
});
const transition = (message: string, state: string, help: string) =>
  new AppError('INVALID_TRANSITION', message, [
    { code: 'INVALID_TRANSITION', message: help, context: { state } },
  ]);

/** The state of a live goal on a date (D-2.10-2). */
export function liveState(
  g: { startDate: BusinessDate; dueDate: BusinessDate; progress: Dec; hasProgress: boolean },
  today: BusinessDate,
): (typeof LIVE)[number] {
  if (today > g.dueDate) return 'overdue';
  const span = Math.max(1, diffDays(g.startDate, g.dueDate));
  const elapsed = Math.min(100, Math.max(0, (diffDays(g.startDate, today) / span) * 100));
  if (elapsed - Number(g.progress.toFixed(4)) > DELAY_TOLERANCE) return 'delayed';
  return g.hasProgress ? 'in_progress' : 'active';
}
/** The rating of an overall score (D-2.10-4). */
export function ratingOf(score: Dec): (typeof RATING_BANDS)[number][1] {
  for (const [min, r] of RATING_BANDS) if (score.gte(min)) return r;
  return 'unsatisfactory';
}
const RATING_BANDS = [
  [90, 'outstanding'],
  [75, 'exceeds'],
  [60, 'meets'],
  [40, 'needs_improvement'],
  [0, 'unsatisfactory'],
] as const;

export interface PerformanceServiceDeps {
  readonly db: Database;
  readonly accessLog: AccessLog;
  readonly timezone: string;
}

export function performanceService({ db, accessLog, timezone }: PerformanceServiceDeps) {
  const today = () => todayIn(timezone);
  const stamp = (actorId: bigint) => ({
    version: { increment: 1 },
    updatedAt: new Date(),
    updatedBy: actorId,
  });
  async function canManage(
    estateId: bigint,
    recordId: bigint | null,
    operation: string,
    module: 'goal' | 'evaluation',
  ) {
    const scope = await scopeToCheck();
    if (scope === null || scope.allEstates || scope.estates.includes(estateId)) return;
    await denyWrite(accessLog, module, recordId, operation);
  }
  async function pending(tx: Database | Tx, type: string, id: bigint, state: string) {
    if (state !== 'submitted') return null;
    return (
      (
        await tx.approvalRequest.findFirst({
          where: { documentType: type, documentId: id, state: 'pending' },
          select: { id: true },
        })
      )?.id ?? null
    );
  }

  // ================= goals =================
  async function ownerName(tx: Database | Tx, g: { ownerType: string; ownerId: bigint }) {
    if (g.ownerType === 'employment_profile')
      return (
        (
          await tx.employmentProfile.findUnique({
            where: { id: g.ownerId },
            select: { person: { select: { fullName: true } } },
          })
        )?.person.fullName ?? null
      );
    if (g.ownerType === 'department')
      return (
        (await tx.department.findUnique({ where: { id: g.ownerId }, select: { name: true } }))?.name ?? null
      );
    return (await tx.estate.findUnique({ where: { id: g.ownerId }, select: { name: true } }))?.name ?? null;
  }
  async function goalOut(tx: Database | Tx, g: GoalRow): Promise<GoalOutT> {
    return {
      id: g.id.toString(),
      goal_code: g.goalCode,
      owner_type: g.ownerType as GoalOutT['owner_type'],
      owner_id: g.ownerId.toString(),
      owner_name: await ownerName(tx, g),
      estate_id: g.estateId.toString(),
      parent_goal_id: idOut(g.parentGoalId),
      title: g.title,
      description: g.description,
      kpi_name: g.kpiName,
      measure_unit: g.measureUnit,
      target_value: g.targetValue === null ? null : toDecimalString(g.targetValue.toString(), 'money'),
      current_value: toDecimalString(g.currentValue.toString(), 'money'),
      weight: g.weight === null ? null : pct(g.weight),
      start_date: businessDateFromDb(g.startDate),
      due_date: businessDateFromDb(g.dueDate),
      review_date: d(g.reviewDate),
      progress_percentage: pct(g.progressPercentage),
      state: g.state as GoalOutT['state'],
      approval_id: idOut(await pending(tx, GOAL_DOCUMENT, g.id, g.state)),
      completed_at: iso(g.completedAt),
      cancellation_reason: g.cancellationReason,
      rejection_reason: g.rejectionReason,
      version: g.version,
      created_at: g.createdAt.toISOString(),
    };
  }
  async function goalOrNotFound(tx: Database | Tx, id: bigint) {
    const g = await tx.goal.findUnique({ where: { id } });
    if (!g) throw Errors.notFound('Goal not found.');
    return g;
  }
  /** The estate of a goal's owner (a department goal names its estate). */
  async function ownerEstate(
    tx: Database | Tx,
    type: string,
    id: bigint,
    estateId: bigint | undefined,
  ): Promise<bigint> {
    if (type === 'employment_profile') {
      const p = await tx.employmentProfile.findUnique({
        where: { id },
        select: { estateId: true, status: true },
      });
      if (!p || p.status === 'separated')
        throw Errors.validation([invalid('owner_id', 'No such current profile.')]);
      return p.estateId;
    }
    if (type === 'estate') {
      if (!(await tx.estate.findUnique({ where: { id }, select: { id: true } })))
        throw Errors.validation([invalid('owner_id', 'No such estate.')]);
      return id;
    }
    const dep = await tx.department.findUnique({ where: { id }, select: { status: true } });
    if (dep?.status !== 'active')
      throw Errors.validation([invalid('owner_id', 'No such active department.')]);
    if (estateId === undefined)
      throw Errors.validation([invalid('estate_id', 'A department goal names its estate.')]);
    return estateId;
  }
  /** Recomputes a live goal's state (after progress, and nightly). */
  async function refresh(tx: Tx, g: GoalRow, actorId: bigint) {
    if (!(LIVE as readonly string[]).includes(g.state)) return g.state;
    const hasProgress = (await tx.goalProgress.count({ where: { goalId: g.id } })) > 0;
    const next = liveState(
      {
        startDate: businessDateFromDb(g.startDate),
        dueDate: businessDateFromDb(g.dueDate),
        progress: dec(g.progressPercentage.toString()),
        hasProgress,
      },
      today(),
    );
    if (next !== g.state) {
      await tx.goal.update({ where: { id: g.id }, data: { state: next, stateChangedAt: new Date() } });
      await recordStatusChange(tx, GOAL_AUDIT.type, g.id, g.state, next, {
        actorId,
        comment: 'Computed from the due date and progress',
      });
    }
    return next;
  }

  function adapterFor(
    type: string,
    audit: AuditedRecord,
    table: 'goal' | 'evaluation',
    approvedState: string,
    describe: ApprovalAdapter['describe'],
  ): ApprovalAdapter {
    const model = (tx: Tx) =>
      tx[table] as unknown as {
        update(a: { where: { id: bigint }; data: Record<string, unknown> }): Promise<unknown>;
        findUniqueOrThrow(a: { where: { id: bigint } }): Promise<{ state: string }>;
      };
    return {
      documentType: type,
      describe,
      async onApproved(tx, id, ctx: ApprovalContext) {
        await lockRowsForUpdate(tx, table, { id });
        const row = await model(tx).findUniqueOrThrow({ where: { id } });
        if (row.state !== 'submitted')
          throw transition(`A ${row.state} ${table} cannot be approved.`, row.state, 'Reload it.');
        const now = new Date();
        await model(tx).update({
          where: { id },
          data: {
            state: approvedState,
            stateChangedAt: now,
            approvedAt: now,
            approvedBy: ctx.actorId,
            ...stamp(ctx.actorId),
          },
        });
        await auditAction(tx, audit, id, 'approve', {
          actorId: ctx.actorId,
          actingForUserId: ctx.actingForUserId,
        });
        await recordStatusChange(tx, audit.type, id, 'submitted', approvedState, { actorId: ctx.actorId });
      },
      async onRejected(tx, id, ctx) {
        const now = new Date();
        await model(tx).update({
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
        await auditAction(tx, audit, id, 'reject', { actorId: ctx.actorId, reason: ctx.reason });
        await recordStatusChange(tx, audit.type, id, 'submitted', 'rejected', {
          actorId: ctx.actorId,
          comment: ctx.reason,
        });
      },
      async onReturned(tx, id, ctx) {
        await model(tx).update({
          where: { id },
          data: {
            state: 'draft',
            stateChangedAt: new Date(),
            submittedAt: null,
            submittedBy: null,
            ...stamp(ctx.actorId),
          },
        });
        await recordStatusChange(tx, audit.type, id, 'submitted', 'draft', {
          actorId: ctx.actorId,
          comment: ctx.comment,
        });
      },
    };
  }
  const goalAdapter = adapterFor(GOAL_DOCUMENT, GOAL_AUDIT, 'goal', 'active', async (tx, id) => {
    const g = await goalOrNotFound(tx, id);
    return {
      id,
      number: g.goalCode,
      label: `${g.goalCode} · ${g.title}`,
      createdBy: g.createdBy,
      estateId: g.estateId,
      values: { estate_id: g.estateId.toString() },
    };
  });

  // ================= evaluations =================
  function toEvaluationOut(e: EvaluationRow, approval: bigint | null): EvaluationOutT {
    const ref = (p: { id: bigint; profileNumber: string; person: { fullName: string } }) => ({
      id: p.id.toString(),
      profile_number: p.profileNumber,
      full_name: p.person.fullName,
    });
    return {
      id: e.id.toString(),
      evaluation_number: e.evaluationNumber,
      employment_profile_id: e.employmentProfileId.toString(),
      profile: ref(e.profile),
      estate_id: e.estateId.toString(),
      reviewer_profile_id: idOut(e.reviewerProfileId),
      reviewer: e.reviewer ? ref(e.reviewer) : null,
      period_start: businessDateFromDb(e.periodStart),
      period_end: businessDateFromDb(e.periodEnd),
      evaluation_type: e.evaluationType as EvaluationOutT['evaluation_type'],
      overall_score: e.overallScore === null ? null : pct(e.overallScore),
      overall_rating: e.overallRating as EvaluationOutT['overall_rating'],
      strengths: e.strengths,
      development_needs: e.developmentNeeds,
      reviewer_comment: e.reviewerComment,
      employee_comment: e.employeeComment,
      acknowledged_at: iso(e.acknowledgedAt),
      lines: e.lines.map((l) => ({
        id: l.id.toString(),
        criteria_id: l.criteriaId.toString(),
        criteria: {
          id: l.criteria.id.toString(),
          code: l.criteria.code,
          name: l.criteria.name,
          criteria_group: l.criteria.criteriaGroup,
        },
        goal_id: idOut(l.goalId),
        weight: pct(l.weight),
        score: l.score === null ? null : pct(l.score),
        max_score: pct(l.maxScore),
        weighted_score: l.weightedScore === null ? null : pct(l.weightedScore),
        comment: l.comment,
        sequence: l.sequence,
      })),
      state: e.state as EvaluationOutT['state'],
      is_locked: e.state === 'acknowledged',
      approval_id: idOut(approval),
      approved_at: iso(e.approvedAt),
      rejection_reason: e.rejectionReason,
      version: e.version,
      created_at: e.createdAt.toISOString(),
    };
  }
  async function evaluationOut(tx: Database | Tx, e: EvaluationRow) {
    return toEvaluationOut(e, await pending(tx, EVALUATION_DOCUMENT, e.id, e.state));
  }
  async function evaluationOrNotFound(tx: Database | Tx, id: bigint) {
    const e = await tx.evaluation.findUnique({ where: { id }, include: evaluationInclude });
    if (!e) throw Errors.notFound('Evaluation not found.');
    return e;
  }
  /** Only a draft (a returned one is a draft again) is edited; an acknowledged one is locked for good. */
  const editable = (e: { state: string }) => {
    if (e.state === 'acknowledged')
      throw transition(
        'An acknowledged evaluation is locked.',
        e.state,
        'It is never edited after acknowledgement.',
      );
    if (e.state !== 'draft')
      throw transition(`A ${e.state} evaluation cannot be changed.`, e.state, 'Only a draft is changed.');
  };
  /** Replaces the lines and recomputes the overall score and rating, in the caller's transaction. */
  async function writeLines(
    tx: Tx,
    e: { id: bigint; employmentProfileId: bigint },
    lines: z.infer<typeof LinesBody>['lines'],
    actorId: bigint,
  ) {
    const profile = await tx.employmentProfile.findUniqueOrThrow({
      where: { id: e.employmentProfileId },
      select: { employmentType: true },
    });
    const rows: Prisma.EvaluationLineCreateManyInput[] = [];
    /** Weight and weighted score of each scored line, for the overall score. */
    const scoredLines: { weight: Dec; weighted: Dec }[] = [];
    for (const [i, l] of lines.entries()) {
      const f = (x: string) => `lines[${String(i)}].${x}`;
      const c = await tx.evaluationCriteria.findUnique({ where: { id: l.criteria_id } });
      if (c?.status !== 'active')
        throw Errors.validation([invalid(f('criteria_id'), 'No such active criterion.')]);
      if (c.appliesTo !== 'all' && c.appliesTo !== profile.employmentType)
        throw Errors.validation([invalid(f('criteria_id'), `This criterion is for ${c.appliesTo}s.`)]);
      const max = dec(c.maxScore.toString());
      if (l.score?.gt(max)) throw Errors.validation([invalid(f('score'), `At most ${pct(max)}.`)]);
      if (l.goal_id !== undefined && l.goal_id !== null) {
        const g = await tx.goal.findUnique({
          where: { id: l.goal_id },
          select: { ownerType: true, ownerId: true },
        });
        if (g?.ownerType !== 'employment_profile' || g.ownerId !== e.employmentProfileId)
          throw Errors.validation([invalid(f('goal_id'), 'Not a goal of the evaluated profile.')]);
      }
      const weight = l.weight ?? dec('1');
      const score = l.score ?? null;
      if (score !== null)
        scoredLines.push({ weight, weighted: round(score.dividedBy(max).times(weight), 4) });
      rows.push({
        evaluationId: e.id,
        criteriaId: l.criteria_id,
        goalId: idIn(l.goal_id ?? null),
        weight: weight.toString(),
        score: score?.toString() ?? null,
        maxScore: max.toString(),
        weightedScore: score === null ? null : round(score.dividedBy(max).times(weight), 4).toString(),
        comment: l.comment ?? null,
        sequence: i + 1,
        createdBy: actorId,
      });
    }
    await tx.evaluationLine.deleteMany({ where: { evaluationId: e.id } });
    if (rows.length > 0) await tx.evaluationLine.createMany({ data: rows });
    const totalWeight = sum(scoredLines.map((x) => x.weight));
    const overall =
      scoredLines.length === 0 || totalWeight.isZero()
        ? null
        : round(
            sum(scoredLines.map((x) => x.weighted))
              .dividedBy(totalWeight)
              .times(100),
            4,
          );
    await tx.evaluation.update({
      where: { id: e.id },
      data: {
        overallScore: overall?.toString() ?? null,
        overallRating: overall === null ? null : ratingOf(overall),
      },
    });
  }
  const evaluationAdapter = adapterFor(
    EVALUATION_DOCUMENT,
    EVALUATION_AUDIT,
    'evaluation',
    'approved',
    async (tx, id) => {
      const e = await evaluationOrNotFound(tx, id);
      return {
        id,
        number: e.evaluationNumber,
        label: `${e.evaluationNumber} · ${e.profile.person.fullName} · ${e.evaluationType}`,
        createdBy: e.createdBy,
        estateId: e.estateId,
        values: { estate_id: e.estateId.toString() },
      };
    },
  );

  return {
    adapters: [goalAdapter, evaluationAdapter],

    goals: {
      async list(q: ListQuery) {
        const where = toWhere(q, GOAL_LIST_FIELDS) as Prisma.GoalWhereInput;
        const [rows, total] = await Promise.all([
          db.goal.findMany({
            where,
            orderBy: [...toOrderBy(q.sort, GOAL_LIST_FIELDS), { id: 'desc' }],
            ...toPaging(q),
          }),
          db.goal.count({ where }),
        ]);
        const items: GoalOutT[] = [];
        for (const r of rows) items.push(await goalOut(db, r));
        return { items, total };
      },
      async get(id: bigint) {
        return goalOut(db, await goalOrNotFound(db, id));
      },
      async create(b: z.infer<typeof CreateGoalBody>, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          const estateId = await ownerEstate(tx, b.owner_type, b.owner_id, b.estate_id);
          await canManage(estateId, null, 'create-goal', 'goal');
          const problems: ErrorDetail[] = [];
          if (b.due_date < b.start_date) problems.push(invalid('due_date', 'Cannot be before start_date.'));
          if (b.review_date && b.review_date < b.start_date)
            problems.push(invalid('review_date', 'Cannot be before start_date.'));
          if (b.parent_goal_id) {
            const parent = await tx.goal.findUnique({
              where: { id: b.parent_goal_id },
              select: { estateId: true, state: true },
            });
            if (parent?.estateId !== estateId || ['rejected', 'cancelled'].includes(parent.state))
              problems.push(invalid('parent_goal_id', 'No such current goal in the estate.'));
          }
          if (problems.length > 0) throw Errors.validation(problems);
          const estate = await tx.estate.findUniqueOrThrow({
            where: { id: estateId },
            select: { code: true },
          });
          const { number } = await allocateNumber(
            tx,
            GOAL_DOCUMENT,
            { date: b.start_date, estateCode: estate.code },
            'draft',
          );
          const g = await tx.goal.create({
            data: {
              goalCode: number,
              ownerType: b.owner_type,
              ownerId: b.owner_id,
              estateId,
              parentGoalId: idIn(b.parent_goal_id ?? null),
              title: b.title,
              description: b.description ?? null,
              kpiName: b.kpi_name ?? null,
              measureUnit: b.measure_unit ?? null,
              targetValue: b.target_value?.toString() ?? null,
              weight: b.weight?.toString() ?? null,
              startDate: businessDateToDb(b.start_date),
              dueDate: businessDateToDb(b.due_date),
              reviewDate: b.review_date ? businessDateToDb(b.review_date) : null,
              state: 'draft',
              stateChangedAt: new Date(),
              createdBy: actorId,
            },
          });
          const out = await goalOut(tx, g);
          await auditCreate(tx, GOAL_AUDIT, g.id, out, { actorId });
          await recordStatusChange(tx, GOAL_AUDIT.type, g.id, null, 'draft', { actorId });
          return out;
        });
      },
      async update(id: bigint, version: number, b: z.infer<typeof PatchGoalBody>, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          const before = await goalOrNotFound(tx, id);
          await canManage(before.estateId, id, 'update-goal', 'goal');
          if (before.state !== 'draft')
            throw transition(
              `A ${before.state} goal cannot be changed.`,
              before.state,
              'Only a draft is changed; record progress instead.',
            );
          const start = b.start_date ?? businessDateFromDb(before.startDate);
          const due = b.due_date ?? businessDateFromDb(before.dueDate);
          if (due < start) throw Errors.validation([invalid('due_date', 'Cannot be before start_date.')]);
          if (b.parent_goal_id !== undefined && b.parent_goal_id !== null && b.parent_goal_id === id)
            throw Errors.validation([invalid('parent_goal_id', 'A goal is not its own parent.')]);
          const data: Record<string, unknown> = {};
          const set = (k: string, v: unknown) => {
            if (v !== undefined) data[k] = v;
          };
          set('parentGoalId', b.parent_goal_id === undefined ? undefined : idIn(b.parent_goal_id));
          set('title', b.title);
          set('description', b.description);
          set('kpiName', b.kpi_name);
          set('measureUnit', b.measure_unit);
          set('targetValue', b.target_value === undefined ? undefined : (b.target_value?.toString() ?? null));
          set('weight', b.weight === undefined ? undefined : (b.weight?.toString() ?? null));
          set('startDate', b.start_date ? businessDateToDb(b.start_date) : undefined);
          set('dueDate', b.due_date ? businessDateToDb(b.due_date) : undefined);
          set(
            'reviewDate',
            b.review_date === undefined ? undefined : b.review_date ? businessDateToDb(b.review_date) : null,
          );
          const { count } = await tx.goal.updateMany({
            where: { id, version },
            data: { ...data, ...stamp(actorId) },
          });
          const old = await goalOut(tx, before);
          if (count !== 1) versionConflict(before, old);
          const after = await goalOut(tx, await goalOrNotFound(tx, id));
          await auditUpdate(tx, GOAL_AUDIT, id, old, after, { actorId });
          return after;
        });
      },
      async remove(id: bigint, actorId: bigint) {
        await withTransaction(db, async (tx) => {
          const g = await goalOrNotFound(tx, id);
          await canManage(g.estateId, id, 'delete-goal', 'goal');
          if (g.state !== 'draft')
            throw transition(`A ${g.state} goal cannot be deleted.`, g.state, 'Cancel it instead.');
          const out = await goalOut(tx, g);
          await tx.goal.delete({ where: { id } });
          await auditDelete(tx, GOAL_AUDIT, id, out, { actorId });
        });
      },
      async submit(id: bigint, version: number, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          await lockRowsForUpdate(tx, 'goal', { id });
          const g = await goalOrNotFound(tx, id);
          await canManage(g.estateId, id, 'submit-goal', 'goal');
          if (g.version !== version) versionConflict(g, await goalOut(tx, g));
          if (g.state !== 'draft')
            throw transition(`A ${g.state} goal cannot be submitted.`, g.state, 'Only a draft is submitted.');
          const now = new Date();
          await tx.goal.update({
            where: { id },
            data: {
              state: 'submitted',
              stateChangedAt: now,
              submittedAt: now,
              submittedBy: actorId,
              ...stamp(actorId),
            },
          });
          await recordStatusChange(tx, GOAL_AUDIT.type, id, 'draft', 'submitted', { actorId });
          await submitForApproval(tx, { timezone }, GOAL_DOCUMENT, id, { actorId, date: today() });
          return goalOut(tx, await goalOrNotFound(tx, id));
        });
      },
      /** POST /goals/{id}/progress (P4 §12.4): the value (and percentage of the target) on a date. */
      async progress(id: bigint, b: z.infer<typeof ProgressBody>, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          await lockRowsForUpdate(tx, 'goal', { id });
          const g = await goalOrNotFound(tx, id);
          await canManage(g.estateId, id, 'record-progress', 'goal');
          if (!(LIVE as readonly string[]).includes(g.state))
            throw transition(
              `Progress is recorded on an active goal, not a ${g.state} one.`,
              g.state,
              'Approve the goal first.',
            );
          if (b.progress_date > today())
            throw Errors.validation([invalid('progress_date', 'Cannot be in the future.')]);
          let percentage = b.progress_percentage ?? null;
          if (percentage === null) {
            if (
              b.value === undefined ||
              b.value === null ||
              g.targetValue === null ||
              dec(g.targetValue.toString()).isZero()
            ) {
              throw Errors.validation([
                invalid('progress_percentage', 'Give the percentage (or a value, for a goal with a target).'),
              ]);
            }
            const ratio = b.value.dividedBy(g.targetValue.toString()).times(100);
            percentage = round(ratio.gt(100) ? dec('100') : ratio.lt(0) ? dec('0') : ratio, 4);
          }
          const p = await tx.goalProgress.create({
            data: {
              goalId: id,
              progressDate: businessDateToDb(b.progress_date),
              value: b.value?.toString() ?? null,
              progressPercentage: percentage.toString(),
              note: b.note ?? null,
              createdBy: actorId,
            },
            include: { creator: { select: { id: true, username: true } } },
          });
          const before = await goalOut(tx, g);
          await tx.goal.update({
            where: { id },
            data: {
              progressPercentage: percentage.toString(),
              ...(b.value !== undefined && b.value !== null ? { currentValue: b.value.toString() } : {}),
              ...stamp(actorId),
            },
          });
          await refresh(tx, await goalOrNotFound(tx, id), actorId);
          const after = await goalOut(tx, await goalOrNotFound(tx, id));
          await auditUpdate(tx, GOAL_AUDIT, id, before, after, { actorId });
          return {
            goal: after,
            progress: {
              id: p.id.toString(),
              goal_id: id.toString(),
              progress_date: businessDateFromDb(p.progressDate),
              value: p.value === null ? null : toDecimalString(p.value.toString(), 'money'),
              progress_percentage: pct(p.progressPercentage),
              note: p.note,
              recorded_by: { id: p.creator.id.toString(), username: p.creator.username },
              created_at: p.createdAt.toISOString(),
            } satisfies z.infer<typeof ProgressOut>,
          };
        });
      },
      async progressOf(id: bigint) {
        await goalOrNotFound(db, id);
        const rows = await db.goalProgress.findMany({
          where: { goalId: id },
          include: { creator: { select: { id: true, username: true } } },
          orderBy: [{ progressDate: 'desc' }, { id: 'desc' }],
        });
        return rows.map((p) => ({
          id: p.id.toString(),
          goal_id: id.toString(),
          progress_date: businessDateFromDb(p.progressDate),
          value: p.value === null ? null : toDecimalString(p.value.toString(), 'money'),
          progress_percentage: pct(p.progressPercentage),
          note: p.note,
          recorded_by: { id: p.creator.id.toString(), username: p.creator.username },
          created_at: p.createdAt.toISOString(),
        }));
      },
      async complete(id: bigint, version: number, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          const g = await goalOrNotFound(tx, id);
          await canManage(g.estateId, id, 'complete-goal', 'goal');
          const old = await goalOut(tx, g);
          if (g.version !== version) versionConflict(g, old);
          if (!(LIVE as readonly string[]).includes(g.state))
            throw transition(`A ${g.state} goal cannot be completed.`, g.state, 'Only an active goal.');
          await tx.goal.update({
            where: { id },
            data: {
              state: 'completed',
              stateChangedAt: new Date(),
              completedAt: new Date(),
              ...stamp(actorId),
            },
          });
          const after = await goalOut(tx, await goalOrNotFound(tx, id));
          await auditUpdate(tx, GOAL_AUDIT, id, old, after, { actorId });
          await recordStatusChange(tx, GOAL_AUDIT.type, id, g.state, 'completed', { actorId });
          return after;
        });
      },
      async cancel(id: bigint, version: number, reason: string, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          const g = await goalOrNotFound(tx, id);
          await canManage(g.estateId, id, 'cancel-goal', 'goal');
          const old = await goalOut(tx, g);
          if (g.version !== version) versionConflict(g, old);
          if (!['draft', ...LIVE].includes(g.state))
            throw transition(`A ${g.state} goal cannot be cancelled.`, g.state, 'A draft or an active goal.');
          await tx.goal.update({
            where: { id },
            data: {
              state: 'cancelled',
              stateChangedAt: new Date(),
              cancellationReason: reason,
              ...stamp(actorId),
            },
          });
          const after = await goalOut(tx, await goalOrNotFound(tx, id));
          await auditUpdate(tx, GOAL_AUDIT, id, old, after, { actorId, reason });
          await recordStatusChange(tx, GOAL_AUDIT.type, id, g.state, 'cancelled', {
            actorId,
            comment: reason,
          });
          return after;
        });
      },
      /** GET /goals/calendar: start, review and due dates in a range. */
      async calendar(q: {
        from: BusinessDate;
        to: BusinessDate;
        estate_id?: bigint | undefined;
        owner_type?: string | undefined;
        owner_id?: bigint | undefined;
      }) {
        const from = businessDateToDb(q.from);
        const to = businessDateToDb(q.to);
        const rows = await db.goal.findMany({
          where: {
            ...(q.estate_id !== undefined ? { estateId: q.estate_id } : {}),
            ...(q.owner_type !== undefined ? { ownerType: q.owner_type } : {}),
            ...(q.owner_id !== undefined ? { ownerId: q.owner_id } : {}),
            state: { notIn: ['rejected', 'cancelled'] },
            OR: [
              { startDate: { gte: from, lte: to } },
              { dueDate: { gte: from, lte: to } },
              { reviewDate: { gte: from, lte: to } },
            ],
          },
          orderBy: { id: 'asc' },
        });
        const events: z.infer<typeof CalendarOut>[] = [];
        for (const g of rows) {
          for (const [kind, date] of [
            ['start', g.startDate],
            ['review', g.reviewDate],
            ['due', g.dueDate],
          ] as const) {
            const day = d(date);
            if (day !== null && day >= q.from && day <= q.to)
              events.push({
                goal_id: g.id.toString(),
                goal_code: g.goalCode,
                title: g.title,
                kind,
                date: day,
                state: g.state as GoalOutT['state'],
              });
          }
        }
        return events.sort((a, b) => a.date.localeCompare(b.date));
      },
      /** GET /goals/overview: total, completed, in progress, delayed, overdue (P4 §12.4). */
      async overview(q: {
        estate_id?: bigint | undefined;
        owner_type?: string | undefined;
        owner_id?: bigint | undefined;
      }): Promise<z.infer<typeof OverviewOut>> {
        const rows = await db.goal.groupBy({
          by: ['state'],
          where: {
            ...(q.estate_id !== undefined ? { estateId: q.estate_id } : {}),
            ...(q.owner_type !== undefined ? { ownerType: q.owner_type } : {}),
            ...(q.owner_id !== undefined ? { ownerId: q.owner_id } : {}),
            state: { not: 'rejected' },
          },
          _count: { _all: true },
        });
        const n = (s: string) => rows.find((r) => r.state === s)?._count._all ?? 0;
        return {
          total: rows.reduce((a, r) => a + r._count._all, 0),
          completed: n('completed'),
          in_progress: n('active') + n('in_progress'),
          delayed: n('delayed'),
          overdue: n('overdue'),
          draft: n('draft') + n('submitted'),
          cancelled: n('cancelled'),
        };
      },
      /** The nightly job: every live goal's state from today's date. */
      async refreshAll(actorId: bigint) {
        return runUnscoped('nightly goal states', async () => {
          let changed = 0;
          const rows = await db.goal.findMany({ where: { state: { in: [...LIVE] } } });
          for (const g of rows) {
            const next = await withTransaction(db, (tx) => refresh(tx, g, actorId));
            if (next !== g.state) changed += 1;
          }
          return { checked: rows.length, changed };
        });
      },
    },

    evaluations: {
      async list(q: ListQuery) {
        const where = toWhere(q, EVALUATION_LIST_FIELDS) as Prisma.EvaluationWhereInput;
        const [rows, total] = await Promise.all([
          db.evaluation.findMany({
            where,
            include: evaluationInclude,
            orderBy: [...toOrderBy(q.sort, EVALUATION_LIST_FIELDS), { id: 'desc' }],
            ...toPaging(q),
          }),
          db.evaluation.count({ where }),
        ]);
        const items: EvaluationOutT[] = [];
        for (const r of rows) items.push(await evaluationOut(db, r));
        return { items, total };
      },
      async get(id: bigint) {
        return evaluationOut(db, await evaluationOrNotFound(db, id));
      },
      async create(b: z.infer<typeof CreateEvaluationBody>, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          const p = await tx.employmentProfile.findUnique({
            where: { id: b.employment_profile_id },
            select: { id: true, estateId: true, estate: { select: { code: true } } },
          });
          if (!p) throw Errors.validation([invalid('employment_profile_id', 'No such profile.')]);
          await canManage(p.estateId, null, 'create-evaluation', 'evaluation');
          const problems: ErrorDetail[] = [];
          if (b.period_end < b.period_start)
            problems.push(invalid('period_end', 'Cannot be before period_start.'));
          if (b.reviewer_profile_id) {
            const r = await tx.employmentProfile.findUnique({
              where: { id: b.reviewer_profile_id },
              select: { estateId: true, status: true },
            });
            if (r?.estateId !== p.estateId || r.status === 'separated' || b.reviewer_profile_id === p.id)
              problems.push(invalid('reviewer_profile_id', 'Another current profile of the same estate.'));
          }
          if (problems.length > 0) throw Errors.validation(problems);
          const { number } = await allocateNumber(
            tx,
            EVALUATION_DOCUMENT,
            { date: b.period_end, estateCode: p.estate.code },
            'draft',
          );
          const e = await tx.evaluation.create({
            data: {
              evaluationNumber: number,
              employmentProfileId: p.id,
              estateId: p.estateId,
              reviewerProfileId: idIn(b.reviewer_profile_id ?? null),
              periodStart: businessDateToDb(b.period_start),
              periodEnd: businessDateToDb(b.period_end),
              evaluationType: b.evaluation_type,
              strengths: b.strengths ?? null,
              developmentNeeds: b.development_needs ?? null,
              reviewerComment: b.reviewer_comment ?? null,
              state: 'draft',
              stateChangedAt: new Date(),
              createdBy: actorId,
            },
          });
          if (b.lines) await writeLines(tx, e, b.lines, actorId);
          const out = await evaluationOut(tx, await evaluationOrNotFound(tx, e.id));
          await auditCreate(tx, EVALUATION_AUDIT, e.id, out, { actorId });
          await recordStatusChange(tx, EVALUATION_AUDIT.type, e.id, null, 'draft', { actorId });
          return out;
        });
      },
      async update(id: bigint, version: number, b: z.infer<typeof PatchEvaluationBody>, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          const before = await evaluationOrNotFound(tx, id);
          await canManage(before.estateId, id, 'update-evaluation', 'evaluation');
          editable(before);
          const data: Record<string, unknown> = {};
          if (b.reviewer_profile_id !== undefined) data.reviewerProfileId = idIn(b.reviewer_profile_id);
          if (b.period_start !== undefined) data.periodStart = businessDateToDb(b.period_start);
          if (b.period_end !== undefined) data.periodEnd = businessDateToDb(b.period_end);
          if (b.evaluation_type !== undefined) data.evaluationType = b.evaluation_type;
          if (b.strengths !== undefined) data.strengths = b.strengths;
          if (b.development_needs !== undefined) data.developmentNeeds = b.development_needs;
          if (b.reviewer_comment !== undefined) data.reviewerComment = b.reviewer_comment;
          const { count } = await tx.evaluation.updateMany({
            where: { id, version },
            data: { ...data, ...stamp(actorId) },
          });
          const old = await evaluationOut(tx, before);
          if (count !== 1) versionConflict(before, old);
          const after = await evaluationOut(tx, await evaluationOrNotFound(tx, id));
          await auditUpdate(tx, EVALUATION_AUDIT, id, old, after, { actorId });
          return after;
        });
      },
      /** PUT /evaluations/{id}/lines: the whole set of scored criteria, replaced (drafts only). */
      async setLines(id: bigint, version: number, b: z.infer<typeof LinesBody>, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          await lockRowsForUpdate(tx, 'evaluation', { id });
          const before = await evaluationOrNotFound(tx, id);
          await canManage(before.estateId, id, 'score-evaluation', 'evaluation');
          editable(before);
          const old = await evaluationOut(tx, before);
          if (before.version !== version) versionConflict(before, old);
          await writeLines(tx, before, b.lines, actorId);
          await tx.evaluation.update({ where: { id }, data: stamp(actorId) });
          const after = await evaluationOut(tx, await evaluationOrNotFound(tx, id));
          await auditUpdate(tx, EVALUATION_AUDIT, id, old, after, { actorId });
          return after;
        });
      },
      async submit(id: bigint, version: number, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          await lockRowsForUpdate(tx, 'evaluation', { id });
          const e = await evaluationOrNotFound(tx, id);
          await canManage(e.estateId, id, 'submit-evaluation', 'evaluation');
          if (e.version !== version) versionConflict(e, await evaluationOut(tx, e));
          editable(e);
          if (e.lines.length === 0 || e.lines.some((l) => l.score === null))
            throw Errors.validation([invalid('lines', 'Score every criterion before submitting.')]);
          const now = new Date();
          await tx.evaluation.update({
            where: { id },
            data: {
              state: 'submitted',
              stateChangedAt: now,
              submittedAt: now,
              submittedBy: actorId,
              ...stamp(actorId),
            },
          });
          await recordStatusChange(tx, EVALUATION_AUDIT.type, id, 'draft', 'submitted', { actorId });
          await submitForApproval(tx, { timezone }, EVALUATION_DOCUMENT, id, { actorId, date: today() });
          return evaluationOut(tx, await evaluationOrNotFound(tx, id));
        });
      },
      /** POST /evaluations/{id}/acknowledge: by the evaluated employee; locks the record for good. */
      async acknowledge(id: bigint, version: number, comment: string | null, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          await lockRowsForUpdate(tx, 'evaluation', { id });
          const e = await evaluationOrNotFound(tx, id);
          const actor = getRequestContext()?.actorId;
          const user = actor
            ? await tx.user.findUnique({
                where: { id: BigInt(actor) },
                select: { employmentProfileId: true },
              })
            : null;
          if (user?.employmentProfileId !== e.employmentProfileId) {
            throw new AppError(
              'PERMISSION_DENIED',
              'Only the evaluated employee acknowledges their evaluation.',
              [{ code: 'PERMISSION_DENIED', message: 'Sign in as the employee whose evaluation this is.' }],
            );
          }
          const old = await evaluationOut(tx, e);
          if (e.version !== version) versionConflict(e, old);
          if (e.state !== 'approved')
            throw transition(
              `A ${e.state} evaluation cannot be acknowledged.`,
              e.state,
              'Only an approved evaluation.',
            );
          await tx.evaluation.update({
            where: { id },
            data: {
              state: 'acknowledged',
              stateChangedAt: new Date(),
              acknowledgedAt: new Date(),
              employeeComment: comment,
              ...stamp(actorId),
            },
          });
          const after = await evaluationOut(tx, await evaluationOrNotFound(tx, id));
          await auditUpdate(tx, EVALUATION_AUDIT, id, old, after, { actorId });
          await recordStatusChange(tx, EVALUATION_AUDIT.type, id, 'approved', 'acknowledged', {
            actorId,
            comment,
          });
          return after;
        });
      },
    },
  };
}

export type PerformanceService = ReturnType<typeof performanceService>;
