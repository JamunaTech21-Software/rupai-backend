import type { z } from 'zod';

import { resolveApprovers, stepRule } from '../../core/approval/approvers.js';
import {
  CLASS_OPERATORS,
  fieldOf,
  type Condition,
  type DocumentValues,
} from '../../core/approval/conditions.js';
import {
  checkDefinition,
  pathFor,
  workflowApplies,
  type ApproverRule,
  type StepDefinition,
  type WorkflowDefinition,
} from '../../core/approval/definition.js';
import {
  APPROVABLE_DOCUMENTS,
  approvableDocument,
  approvePermissionOf,
  NEVER_SELF_APPROVE,
  type ApprovableDocument,
} from '../../core/approval/document-types.js';
import { readConditions } from '../../core/approval/select.js';
import { WORKFLOW_METHOD, WORKFLOW_TABLE } from '../../core/approval/workflow-table.js';
import type { AccessLog } from '../../core/audit/access-log.js';
import { auditUpdate, recordStatusChange, type AuditedRecord } from '../../core/audit/audit.js';
import { currentActorId } from '../../core/auth/authorize.js';
import type { Database } from '../../core/db/prisma.js';
import type { Seeder } from '../../core/db/seed.js';
import { withTransaction, type Tx } from '../../core/db/transaction.js';
import { Errors, type ErrorDetail } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import type { RuleState } from '../../core/rules/rule-table.js';
import { ruleVersions, type RuleVersion } from '../../core/rules/versions.js';
import { businessDateToDb, parseBusinessDate, todayIn } from '../../core/time/dates.js';
import { Prisma } from '../../generated/prisma/client.js';
import { BOOTSTRAP_ADMIN_ID } from '../identity/identity.seed.js';
import { PERMISSION_KEYS } from '../identity/permission-catalogue.js';
import type {
  CreateWorkflowBody,
  DocumentTypeOut,
  PatchWorkflowBody,
  PreviewOut,
  StepBody,
  SupersedeWorkflowBody,
  WorkflowOut,
} from './workflows.schema.js';

/**
 * Approval workflow definitions (Spec P7 §3, §5, §15; P3 §28.3).
 *
 *   - A workflow is an effective-dated policy record: versions are drafted, approved and superseded by the
 *     rule core (core/rules/versions.ts), which also keeps the timeline free of overlaps and refuses a
 *     creator approving their own version. This service adds what is specific to workflows: the steps,
 *     the condition grammar, and the definition-time checks of P7 §15.2.
 *   - Steps change only while the workflow is a draft, and are replaced as a set. An active workflow's
 *     steps are therefore fixed, which is what lets a submitted document keep its path (P7 §3.3).
 *   - A workflow that fails a check is refused when it is SAVED, not when a document gets stuck on it.
 *     Things that are suspicious but legitimate (a role nobody holds yet, an approver who can also
 *     create) come back as warnings.
 *
 * Running a workflow for a document (submit, approve, the queue) is the runtime: P1.14.
 */

type WorkflowOutT = z.infer<typeof WorkflowOut>;
type StepIn = z.infer<typeof StepBody>;
type Warning = NonNullable<WorkflowOutT['warnings']>[number];

const stepInclude = {
  role: { select: { id: true, code: true, name: true } },
  user: { select: { id: true, username: true } },
} satisfies Prisma.WorkflowStepInclude;
type StepRow = Prisma.WorkflowStepGetPayload<{ include: typeof stepInclude }>;

/** Steps are audited as one value on their workflow: a change of approver shows as one before/after. */
const STEPS_AUDIT: AuditedRecord = { type: WORKFLOW_TABLE.table, class: 'policy', fields: ['steps'] };

const LIST_LIMIT = 5000;
/** Seeded workflows apply from here, so a back-dated document still finds one. */
const SEED_EFFECTIVE_FROM = parseBusinessDate('2020-01-01');

const str = (v: bigint | string | null | undefined): string | null =>
  v === null || v === undefined ? null : v.toString();
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function conditionIn(c: {
  field: string;
  operator: Condition['operator'];
  value?: Condition['value'] | undefined;
}): Condition {
  return { field: c.field, operator: c.operator, value: c.value ?? null };
}

function stepIn(s: StepIn): StepDefinition {
  return {
    name: s.name ?? null,
    approverRule: s.approver_rule,
    roleId: str(s.role_id),
    userId: str(s.user_id),
    reportingLevel: s.reporting_level ?? null,
    condition: s.condition ? conditionIn(s.condition) : null,
    allowSelfApproval: s.allow_self_approval ?? false,
  };
}

function stepOfRow(r: StepRow): StepDefinition {
  return {
    name: r.name,
    approverRule: r.approverRule as ApproverRule,
    roleId: str(r.roleId),
    userId: str(r.userId),
    reportingLevel: r.reportingLevel,
    condition:
      r.conditionField !== null && r.conditionOperator !== null
        ? {
            field: r.conditionField,
            operator: r.conditionOperator as Condition['operator'],
            value: (r.conditionValue ?? null) as Condition['value'],
          }
        : null,
    allowSelfApproval: r.allowSelfApproval,
  };
}

const stepAudit = (steps: readonly StepDefinition[]) =>
  steps.map((s, i) => ({
    step_number: i + 1,
    name: s.name,
    approver_rule: s.approverRule,
    role_id: s.roleId,
    user_id: s.userId,
    reporting_level: s.reportingLevel,
    condition: s.condition,
    allow_self_approval: s.allowSelfApproval,
  }));

export interface WorkflowsDeps {
  readonly db: Database;
  readonly accessLog: AccessLog;
  readonly timezone: string;
}

export function workflowsService({ db, accessLog, timezone }: WorkflowsDeps) {
  const versions = ruleVersions(WORKFLOW_TABLE, { timezone, accessLog });
  const documentOf = (v: RuleVersion): ApprovableDocument | undefined =>
    approvableDocument(v.partitions.document_type ?? '');

  async function stepsOf(tx: Database | Tx, ids: readonly bigint[]): Promise<Map<string, StepRow[]>> {
    const rows =
      ids.length === 0
        ? []
        : await tx.workflowStep.findMany({
            where: { workflowId: { in: [...ids] } },
            include: stepInclude,
            orderBy: [{ workflowId: 'asc' }, { stepNumber: 'asc' }],
          });
    const out = new Map<string, StepRow[]>();
    for (const r of rows) out.set(r.workflowId.toString(), [...(out.get(r.workflowId.toString()) ?? []), r]);
    return out;
  }

  function toOut(v: RuleVersion, steps: readonly StepRow[], warnings?: Warning[]): WorkflowOutT {
    const documentType = v.partitions.document_type ?? '';
    return {
      id: v.id.toString(),
      code: v.ruleCode,
      name: v.name,
      document_type: documentType,
      document_type_label: approvableDocument(documentType)?.label ?? documentType,
      estate_id: v.scope.estate ?? null,
      department_id: v.scope.department ?? null,
      specificity: v.specificity,
      effective_from: v.effectiveFrom,
      effective_to: v.effectiveTo,
      is_retrospective: v.isRetrospective,
      supersedes_id: str(v.supersedesId),
      notes: v.notes,
      conditions: readConditions(v.extras.condition_json),
      state: v.state,
      is_active: v.state === 'active',
      submitted_at: iso(v.submittedAt),
      submitted_by: str(v.submittedBy),
      approved_at: iso(v.approvedAt),
      approved_by: str(v.approvedBy),
      rejected_at: iso(v.rejectedAt),
      rejected_by: str(v.rejectedBy),
      rejection_reason: v.rejectionReason,
      version: v.version,
      created_at: v.createdAt.toISOString(),
      created_by: v.createdBy.toString(),
      updated_at: iso(v.updatedAt),
      steps: steps.map((r) => {
        const s = stepOfRow(r);
        return {
          id: r.id.toString(),
          step_number: r.stepNumber,
          name: s.name,
          approver_rule: s.approverRule,
          role_id: s.roleId,
          role: r.role ? { id: r.role.id.toString(), code: r.role.code, name: r.role.name } : null,
          user_id: s.userId,
          user: r.user ? { id: r.user.id.toString(), username: r.user.username } : null,
          reporting_level: s.reportingLevel,
          condition: s.condition,
          allow_self_approval: s.allowSelfApproval,
        };
      }),
      ...(warnings ? { warnings } : {}),
    };
  }

  const roleIdsOf = (def: WorkflowDefinition) => [
    ...new Set(def.steps.flatMap((s) => (s.roleId ? [BigInt(s.roleId)] : []))),
  ];

  /**
   * P7 §15.2 check 4, and the references a definition makes: every estate, department, role and user it
   * names exists and is usable. Returned as errors, since each would leave a step that can never resolve.
   */
  async function referenceErrors(
    tx: Tx,
    def: WorkflowDefinition,
    scope: { estate: string | null; department: string | null },
  ): Promise<ErrorDetail[]> {
    const out: ErrorDetail[] = [];
    const bad = (field: string, message: string) =>
      out.push({ field, code: 'WORKFLOW_REFERENCE_INVALID', message });

    if (scope.estate && (await tx.estate.count({ where: { id: BigInt(scope.estate) } })) === 0) {
      bad('estate_id', 'No such estate.');
    }
    if (scope.department) {
      const d = await tx.department.findUnique({
        where: { id: BigInt(scope.department) },
        select: { status: true },
      });
      if (!d) bad('department_id', 'No such department.');
      else if (d.status !== 'active') bad('department_id', 'The department is inactive.');
    }
    const roleIds = roleIdsOf(def);
    const roles = new Map(
      (await tx.role.findMany({ where: { id: { in: roleIds } }, select: { id: true, status: true } })).map(
        (r) => [r.id.toString(), r.status],
      ),
    );
    const userIds = [...new Set(def.steps.flatMap((s) => (s.userId ? [BigInt(s.userId)] : [])))];
    const users = new Map(
      (await tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, status: true } })).map(
        (u) => [u.id.toString(), u.status],
      ),
    );
    def.steps.forEach((s, i) => {
      if (s.roleId) {
        const status = roles.get(s.roleId);
        if (status === undefined) bad(`steps.${String(i)}.role_id`, 'No such role.');
        else if (status !== 'active') bad(`steps.${String(i)}.role_id`, 'The role is inactive.');
      }
      if (s.userId) {
        const status = users.get(s.userId);
        if (status === undefined) bad(`steps.${String(i)}.user_id`, 'No such user.');
        else if (status !== 'active') bad(`steps.${String(i)}.user_id`, 'The user is not active.');
      }
    });
    return out;
  }

  /** Every definition-time check that refuses a save. */
  async function assertValid(
    tx: Tx,
    def: WorkflowDefinition,
    scope: { estate: string | null; department: string | null },
  ): Promise<void> {
    const problems = checkDefinition(def);
    // Reference checks read ids the shape check has just vouched for.
    if (problems.length === 0) problems.push(...(await referenceErrors(tx, def, scope)));
    if (problems.length > 0) throw Errors.validation(problems, 'The workflow is not valid.');
  }

  /**
   * What is worth a second look but does not stop a save (P7 §15.2 checks 4 and 5):
   *   ROLE_HAS_NO_HOLDER          no active user holds the role: the step would be unresolved today
   *   APPROVER_CAN_CREATE         the approver role may also create this document (separation of duties)
   *   APPROVER_LACKS_PERMISSION   the role may not approve this document type at all
   */
  async function warningsFor(tx: Database | Tx, def: WorkflowDefinition): Promise<Warning[]> {
    const document = approvableDocument(def.documentType);
    const roleIds = roleIdsOf(def);
    if (!document || roleIds.length === 0) return [];
    const holders = await tx.$queryRaw<{ role_id: bigint }[]>(Prisma.sql`
      SELECT DISTINCT ur.role_id FROM user_role ur JOIN user u ON u.id = ur.user_id
      WHERE ur.role_id IN (${Prisma.join(roleIds)}) AND u.status = 'active'
        AND (ur.expires_at IS NULL OR ur.expires_at > UTC_TIMESTAMP())`);
    const held = new Set(holders.map((h) => h.role_id.toString()));
    const approve = approvePermissionOf(document);
    const create = `${document.module}.create`;
    const permissions = await tx.$queryRaw<{ role_id: bigint; module: string; action: string }[]>(Prisma.sql`
      SELECT rp.role_id, p.module, p.action FROM role_permission rp
      JOIN permission p ON p.id = rp.permission_id
      WHERE rp.role_id IN (${Prisma.join(roleIds)}) AND p.module IN (${Prisma.join([
        ...new Set([approve.split('.')[0] ?? '', document.module]),
      ])})`);
    const has = (roleId: string, key: string) =>
      permissions.some((p) => p.role_id.toString() === roleId && `${p.module}.${p.action}` === key);

    const out: Warning[] = [];
    def.steps.forEach((s, i) => {
      if (!s.roleId) return;
      const step_number = i + 1;
      if (!held.has(s.roleId)) {
        out.push({
          code: 'ROLE_HAS_NO_HOLDER',
          message: 'No active user holds this role, so nobody could approve at this step today.',
          step_number,
        });
      }
      if (has(s.roleId, create)) {
        out.push({
          code: 'APPROVER_CAN_CREATE',
          message: `This role can also create a ${document.label.toLowerCase()} (${create}). Nobody approves their own document, but one role doing both weakens the separation of duties.`,
          step_number,
        });
      }
      // Some document types have no approve permission in the catalogue yet (P6 Table 3.2 gives a
      // master none); the runtime (P1.14) decides what acting on those needs.
      if (PERMISSION_KEYS.has(approve) && !has(s.roleId, approve)) {
        out.push({
          code: 'APPROVER_LACKS_PERMISSION',
          message: `This role does not hold ${approve}, so its users could not act on this step.`,
          step_number,
        });
      }
    });
    return out;
  }

  async function writeSteps(
    tx: Tx,
    workflowId: bigint,
    steps: readonly StepDefinition[],
    before: readonly StepDefinition[] | null,
  ): Promise<void> {
    const actorId = currentActorId();
    await tx.workflowStep.deleteMany({ where: { workflowId } });
    await tx.workflowStep.createMany({
      data: steps.map((s, i) => ({
        workflowId,
        stepNumber: i + 1,
        sequence: i + 1,
        name: s.name,
        approverRule: s.approverRule,
        roleId: s.roleId ? BigInt(s.roleId) : null,
        userId: s.userId ? BigInt(s.userId) : null,
        reportingLevel: s.reportingLevel,
        conditionField: s.condition?.field ?? null,
        conditionOperator: s.condition?.operator ?? null,
        conditionValue:
          s.condition && s.condition.value !== null
            ? (s.condition.value as Prisma.InputJsonValue)
            : Prisma.DbNull,
        allowSelfApproval: s.allowSelfApproval,
        createdBy: actorId,
      })),
    });
    await auditUpdate(
      tx,
      STEPS_AUDIT,
      workflowId,
      { steps: before ? stepAudit(before) : null },
      { steps: stepAudit(steps) },
    );
  }

  const conditionColumn = (conditions: readonly Condition[]) =>
    conditions.length > 0 ? JSON.stringify(conditions) : null;

  async function view(tx: Database | Tx, v: RuleVersion): Promise<WorkflowOutT> {
    const steps = (await stepsOf(tx, [v.id])).get(v.id.toString()) ?? [];
    const def: WorkflowDefinition = {
      documentType: v.partitions.document_type ?? '',
      conditions: readConditions(v.extras.condition_json),
      steps: steps.map(stepOfRow),
    };
    return toOut(v, steps, await warningsFor(tx, def));
  }

  /** The stored definition of a version, re-checked before it moves towards taking effect. */
  async function recheck(tx: Tx, v: RuleVersion): Promise<void> {
    const steps = (await stepsOf(tx, [v.id])).get(v.id.toString()) ?? [];
    await assertValid(
      tx,
      {
        documentType: v.partitions.document_type ?? '',
        conditions: readConditions(v.extras.condition_json),
        steps: steps.map(stepOfRow),
      },
      { estate: v.scope.estate ?? null, department: v.scope.department ?? null },
    );
  }

  return {
    async list(q: ListQuery): Promise<{ items: WorkflowOutT[]; total: number }> {
      const one = (field: string) => q.filters.filter((f) => f.field === field);
      const values = (field: string): string[] | null => {
        const fs = one(field);
        return fs.length === 0
          ? null
          : fs.flatMap((f) => (Array.isArray(f.value) ? f.value.map(String) : [String(f.value)]));
      };
      const asOf = values('as_of')?.[0];
      const states = values('state') as RuleState[] | null;
      const code = values('code')?.[0];
      const all = await withTransaction(db, (tx) =>
        versions.list(tx, {
          ...(code !== undefined ? { ruleCode: code } : {}),
          ...(asOf !== undefined ? { asOf: parseBusinessDate(asOf) } : {}),
          ...(states ? { states } : {}),
          limit: LIST_LIMIT,
        }),
      );
      const types = values('document_type');
      const estates = values('estate_id');
      const filtered = all
        .filter((v) => !types || types.includes(v.partitions.document_type ?? ''))
        .filter((v) => !estates || (v.scope.estate !== null && estates.includes(v.scope.estate ?? '')))
        .sort(
          (a, b) =>
            (a.partitions.document_type ?? '').localeCompare(b.partitions.document_type ?? '') ||
            a.ruleCode.localeCompare(b.ruleCode) ||
            a.effectiveFrom.localeCompare(b.effectiveFrom) ||
            Number(a.id - b.id),
        );
      const { page, perPage } = q.page ?? { page: 1, perPage: 25 };
      const slice = filtered.slice((page - 1) * perPage, page * perPage);
      const steps = await stepsOf(
        db,
        slice.map((v) => v.id),
      );
      return {
        items: slice.map((v) => toOut(v, steps.get(v.id.toString()) ?? [])),
        total: filtered.length,
      };
    },

    get(id: bigint): Promise<WorkflowOutT> {
      return withTransaction(db, async (tx) => view(tx, await versions.get(tx, id)));
    },

    /** A new workflow, as a draft. */
    create(body: z.infer<typeof CreateWorkflowBody>): Promise<WorkflowOutT> {
      return withTransaction(db, async (tx) => {
        const def: WorkflowDefinition = {
          documentType: body.document_type,
          conditions: (body.conditions ?? []).map(conditionIn),
          steps: body.steps.map(stepIn),
        };
        const scope = { estate: str(body.estate_id), department: str(body.department_id) };
        await assertValid(tx, def, scope);
        const v = await versions.create(tx, {
          ruleCode: body.code,
          name: body.name,
          method: WORKFLOW_METHOD,
          parameters: {},
          effectiveFrom: body.effective_from,
          effectiveTo: body.effective_to ?? null,
          notes: body.notes ?? null,
          scope,
          partitions: { document_type: body.document_type },
          extras: { condition_json: conditionColumn(def.conditions) },
        });
        await writeSteps(tx, v.id, def.steps, null);
        return view(tx, v);
      });
    },

    /** The next version of an ACTIVE workflow, as a draft. Its steps are copied unless new ones are sent. */
    supersede(id: bigint, body: z.infer<typeof SupersedeWorkflowBody>): Promise<WorkflowOutT> {
      return withTransaction(db, async (tx) => {
        const current = await versions.get(tx, id);
        const currentSteps = ((await stepsOf(tx, [current.id])).get(current.id.toString()) ?? []).map(
          stepOfRow,
        );
        const def: WorkflowDefinition = {
          documentType: current.partitions.document_type ?? '',
          conditions: body.conditions
            ? body.conditions.map(conditionIn)
            : readConditions(current.extras.condition_json),
          steps: body.steps ? body.steps.map(stepIn) : currentSteps,
        };
        // An active version is checked by the rule core first, so a non-active one answers 409, not 422.
        if (current.state === 'active') {
          await assertValid(tx, def, {
            estate: current.scope.estate ?? null,
            department: current.scope.department ?? null,
          });
        }
        const v = await versions.supersede(tx, id, {
          name: body.name ?? current.name,
          method: WORKFLOW_METHOD,
          parameters: {},
          effectiveFrom: body.effective_from,
          effectiveTo: body.effective_to ?? null,
          notes: body.notes ?? null,
          extras: { condition_json: conditionColumn(def.conditions) },
        });
        await writeSteps(tx, v.id, def.steps, null);
        return view(tx, v);
      });
    },

    /** Edits a DRAFT. Steps, when sent, replace the whole list. */
    update(
      id: bigint,
      expectedVersion: number,
      patch: z.infer<typeof PatchWorkflowBody>,
    ): Promise<WorkflowOutT> {
      return withTransaction(db, async (tx) => {
        const current = await versions.get(tx, id);
        const beforeSteps = ((await stepsOf(tx, [current.id])).get(current.id.toString()) ?? []).map(
          stepOfRow,
        );
        const scope = {
          estate: patch.estate_id !== undefined ? str(patch.estate_id) : (current.scope.estate ?? null),
          department:
            patch.department_id !== undefined ? str(patch.department_id) : (current.scope.department ?? null),
        };
        const def: WorkflowDefinition = {
          documentType: patch.document_type ?? current.partitions.document_type ?? '',
          conditions: patch.conditions
            ? patch.conditions.map(conditionIn)
            : readConditions(current.extras.condition_json),
          steps: patch.steps ? patch.steps.map(stepIn) : beforeSteps,
        };
        // A version that is not a draft is refused by the rule core (409) before anything is validated.
        if (current.state === 'draft') await assertValid(tx, def, scope);
        const v = await versions.updateDraft(tx, id, expectedVersion, {
          ...(patch.code !== undefined ? { ruleCode: patch.code } : {}),
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.effective_from !== undefined ? { effectiveFrom: patch.effective_from } : {}),
          ...(patch.effective_to !== undefined ? { effectiveTo: patch.effective_to } : {}),
          ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
          ...(patch.estate_id !== undefined || patch.department_id !== undefined ? { scope } : {}),
          ...(patch.document_type !== undefined
            ? { partitions: { document_type: patch.document_type } }
            : {}),
          ...(patch.conditions !== undefined
            ? { extras: { condition_json: conditionColumn(def.conditions) } }
            : {}),
        });
        if (patch.steps) await writeSteps(tx, v.id, def.steps, beforeSteps);
        return view(tx, v);
      });
    },

    /** draft → submitted. The definition is checked again: a role may have gone since it was drafted. */
    submit(id: bigint): Promise<WorkflowOutT> {
      return withTransaction(db, async (tx) => {
        const current = await versions.get(tx, id);
        if (current.state === 'draft') await recheck(tx, current);
        return view(tx, await versions.submit(tx, id));
      });
    },

    returnToDraft(id: bigint, comment: string): Promise<WorkflowOutT> {
      return withTransaction(db, async (tx) => view(tx, await versions.returnToDraft(tx, id, comment)));
    },

    reject(id: bigint, reason: string): Promise<WorkflowOutT> {
      return withTransaction(db, async (tx) => view(tx, await versions.reject(tx, id, reason)));
    },

    /**
     * submitted → active: the workflow governs documents submitted from its effective date. The version
     * it supersedes is closed the day before (the rule core), so documents already in flight keep the
     * steps they were submitted under.
     */
    approve(id: bigint, reason: string | null): Promise<WorkflowOutT> {
      return withTransaction(db, async (tx) => {
        const current = await versions.get(tx, id);
        if (current.state === 'submitted') await recheck(tx, current);
        // workflow.approve is the one level of approval a workflow has: its holder may also approve a
        // version that takes effect in the past, with a reason.
        const { version } = await versions.approve(tx, id, { elevated: true, reason });
        return view(tx, version);
      });
    },

    /** The approvable document types, the fields their conditions may test, and whether one is covered. */
    async documentTypes(): Promise<z.infer<typeof DocumentTypeOut>[]> {
      const today = businessDateToDb(todayIn(timezone));
      const counts = await db.workflow.groupBy({
        by: ['documentType'],
        where: {
          state: 'active',
          effectiveFrom: { lte: today },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }],
        },
        _count: { _all: true },
      });
      const active = new Map(counts.map((c) => [c.documentType, c._count._all]));
      return APPROVABLE_DOCUMENTS.map((d) => ({
        key: d.key,
        label: d.label,
        approval_class: d.approvalClass,
        tier: d.tier,
        self_approval_configurable: !NEVER_SELF_APPROVE.has(d.approvalClass),
        fields: d.fields.map((f) => ({
          name: f.name,
          label: f.label,
          class: f.class,
          operators: [...CLASS_OPERATORS[f.class]],
        })),
        active_workflows: active.get(d.key) ?? 0,
      }));
    },

    /**
     * Which steps a sample document would go through, and who could act on each (P7 §15.1). Nothing is
     * stored. Reporting-line and cost-centre steps follow a real submitter and document, so they are
     * shown as deferred.
     */
    async preview(id: bigint, sample: Readonly<Record<string, string>>): Promise<z.infer<typeof PreviewOut>> {
      const v = await withTransaction(db, (tx) => versions.get(tx, id));
      const document = documentOf(v);
      if (!document) throw Errors.notFound('No such workflow.');
      const problems: ErrorDetail[] = [];
      const values: Record<string, string | boolean> = {};
      for (const [name, raw] of Object.entries(sample)) {
        const field = fieldOf(document, name);
        const invalid = (message: string) =>
          problems.push({ field: `sample.${name}`, code: 'VALIDATION_FAILED', message });
        if (!field) invalid(`A ${document.label.toLowerCase()} has no field "${name}".`);
        else if (field.class === 'flag') {
          if (raw === 'true' || raw === 'false') values[name] = raw === 'true';
          else invalid('Must be true or false.');
        } else if (field.class === 'amount' || field.class === 'quantity') {
          if (/^\d{1,15}(?:\.\d{1,4})?$/.test(raw)) values[name] = raw;
          else invalid('Must be a number such as 50000.00.');
        } else if (field.class === 'attribute') values[name] = raw;
        else if (/^[1-9]\d{0,19}$/.test(raw)) values[name] = raw;
        else invalid('Must be an id.');
      }
      if (problems.length > 0) throw Errors.validation(problems);

      const steps = (await stepsOf(db, [v.id])).get(v.id.toString()) ?? [];
      const definitions = steps.map(stepOfRow);
      const documentValues: DocumentValues = values;
      const path = pathFor(definitions, documentValues);
      const id_ = (name: string) => (typeof values[name] === 'string' ? BigInt(values[name]) : null);
      const place = {
        estateId: id_('estate_id'),
        factoryId: id_('factory_id'),
        warehouseId: id_('warehouse_id'),
      };
      const out: z.infer<typeof PreviewOut>['steps'] = [];
      for (const [i, row] of steps.entries()) {
        const fires = path.includes(i);
        const resolved = await resolveApprovers(db, document, stepRule(row), place);
        out.push({
          step_number: row.stepNumber,
          name: row.name,
          approver_rule: row.approverRule as ApproverRule,
          fires,
          path_position: fires ? path.indexOf(i) + 1 : null,
          approvers: [...resolved.users],
          approvers_deferred: resolved.deferred,
          unresolved: fires && !resolved.deferred && resolved.users.length === 0,
        });
      }
      return {
        workflow_id: v.id.toString(),
        applies: workflowApplies({ conditions: readConditions(v.extras.condition_json) }, documentValues),
        sample,
        steps: out,
      };
    },
  };
}

/**
 * P3 §31.2: "a single-step submit-and-approve workflow per approvable document type — a usable starting
 * point the client refines". Only the Administrator role is seeded and it approves nothing (P6 §5.5), so
 * the one step cannot name a role: it goes to the submitter's supervisor (by_reporting_line, level 1),
 * which needs no role and never lets anyone approve their own document. The client replaces these with
 * the workflows of P7 §7–§9 once roles and thresholds are confirmed (O-26, O-32).
 *
 * Insert-only: a document type that already has any workflow, in any state, is left alone.
 */
export const workflowSeeder: Seeder = {
  name: 'approval: a single-step workflow per approvable document type',
  async run(tx) {
    let inserted = 0;
    const now = new Date();
    for (const d of APPROVABLE_DOCUMENTS) {
      if ((await tx.workflow.count({ where: { documentType: d.key } })) > 0) continue;
      const w = await tx.workflow.create({
        data: {
          ruleCode: `WF_${d.key.toUpperCase()}`,
          name: `${d.label}: supervisor approval`,
          documentType: d.key,
          method: WORKFLOW_METHOD,
          parameters: {},
          effectiveFrom: businessDateToDb(SEED_EFFECTIVE_FROM),
          notes: 'Seeded starting point. Replace it with the workflow agreed for this document type.',
          state: 'active',
          stateChangedAt: now,
          approvedAt: now,
          approvedBy: BOOTSTRAP_ADMIN_ID,
          createdBy: BOOTSTRAP_ADMIN_ID,
          steps: {
            create: [
              {
                stepNumber: 1,
                sequence: 1,
                name: 'Supervisor approval',
                approverRule: 'by_reporting_line',
                reportingLevel: 1,
                createdBy: BOOTSTRAP_ADMIN_ID,
              },
            ],
          },
        },
        select: { id: true },
      });
      await recordStatusChange(tx, WORKFLOW_TABLE.table, w.id, null, 'active', {
        actorId: BOOTSTRAP_ADMIN_ID,
        comment: 'Seeded',
      });
      inserted += 1;
    }
    return { inserted, updated: 0 };
  },
};

export type WorkflowsService = ReturnType<typeof workflowsService>;
