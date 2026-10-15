import { z } from 'zod';

import { zId } from '../../core/ids/ids.js';
import { CHANNELS, RECIPIENT_RULES, SEVERITIES, TRIGGER_TYPES } from '../../core/notify/triggers.js';

/** Request and response schemas of notifications and notification rules (Spec P3 §28.5, P4 §14). */

export const IdParams = z.object({ id: zId });
export const DELIVERY_STATES = ['not_required', 'pending', 'sending', 'sent', 'failed', 'skipped'] as const;

const Ref = z.object({ id: z.string(), username: z.string() });

export const NotificationOut = z.object({
  id: z.string(),
  subject: z.string(),
  body: z.string(),
  severity: z.enum(SEVERITIES),
  /** What it is about, and where the web app shows it. */
  link: z.object({
    type: z.string(),
    id: z.string(),
    /** A web-app route, e.g. /approvals/12. Open it on click. */
    route: z.string(),
  }),
  rule: z.object({ code: z.string(), name: z.string(), trigger_type: z.enum(TRIGGER_TYPES) }),
  /** The day of what it reports (the expiry date, the day the step started). */
  occurred_on: z.string(),
  created_at: z.string(),
  is_read: z.boolean(),
  read_at: z.string().nullable(),
  dismissed_at: z.string().nullable(),
  /** Email delivery. not_required: in-app only. skipped: the user has no email address. */
  email: z.object({
    state: z.enum(DELIVERY_STATES),
    delivered_at: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const SummaryOut = z.object({
  /** Not read and not dismissed: the number on the bell. */
  unread: z.number().int(),
  unread_critical: z.number().int(),
  /** The newest notification's time, or null. Poll this; refetch the list when it changes. */
  latest_at: z.string().nullable(),
});

export const ReadAllBody = z.strictObject({
  /** Marks read only notifications up to this one, so one arriving meanwhile stays unread. */
  up_to_id: zId.optional(),
});
export const ReadAllOut = z.object({ marked_read: z.number().int() });

// ---- rules ------------------------------------------------------------------------------------------

export const TriggerOut = z.object({
  key: z.enum(TRIGGER_TYPES),
  label: z.string(),
  description: z.string(),
  recipient_rules: z.array(z.enum(RECIPIENT_RULES)),
  uses_lead_days: z.boolean(),
  /** false: its module does not exist yet, so nothing evaluates it (arrives_with says what will). */
  evaluated: z.boolean(),
  arrives_with: z.string().nullable(),
});

export const RuleOut = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  trigger_type: z.enum(TRIGGER_TYPES),
  trigger: TriggerOut,
  condition: z.record(z.string(), z.unknown()).nullable(),
  lead_days: z.number().int().nullable(),
  recipient_rule: z.enum(RECIPIENT_RULES),
  role: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  user: Ref.nullable(),
  channel: z.enum(CHANNELS),
  severity: z.enum(SEVERITIES),
  is_active: z.boolean(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});

/**
 * condition, by trigger:
 *   document_expiry       { document_type_codes?: string[] }   only these document types
 *   approval_unresolved   { notify_next_step_approvers?: boolean }   default true (P7 §4.3)
 *   others                none
 */
export const Condition = z
  .strictObject({
    document_type_codes: z.array(z.string().trim().min(1).max(20)).min(1).max(50).optional(),
    notify_next_step_approvers: z.boolean().optional(),
  })
  .nullable();

const ruleFields = {
  name: z.string().trim().min(1).max(150),
  description: z.string().trim().max(500).nullable(),
  condition: Condition,
  lead_days: z.number().int().min(0).max(365).nullable(),
  recipient_rule: z.enum(RECIPIENT_RULES),
  role_id: zId.nullable(),
  user_id: zId.nullable(),
  channel: z.enum(CHANNELS),
  severity: z.enum(SEVERITIES),
  is_active: z.boolean(),
};

export const CreateRuleBody = z.strictObject({
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, 'Use letters, digits and _ (up to 40), starting with a letter.')
    .transform((v) => v.toUpperCase()),
  trigger_type: z.enum(TRIGGER_TYPES),
  ...ruleFields,
  description: ruleFields.description.default(null),
  condition: ruleFields.condition.default(null),
  lead_days: ruleFields.lead_days.default(null),
  role_id: ruleFields.role_id.default(null),
  user_id: ruleFields.user_id.default(null),
  channel: ruleFields.channel.default('in_app'),
  severity: ruleFields.severity.default('info'),
  is_active: ruleFields.is_active.default(true),
});
/** code and trigger_type are fixed once created. */
export const PatchRuleBody = z.strictObject(ruleFields).partial();
