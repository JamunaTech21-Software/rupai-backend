import type { Database } from '../db/prisma.js';

/**
 * The integration log (Spec P3 §29.2): one row per call to or from an external system: face recognition
 * (P2), broker catalogue import (P6). Append-only. The first caller arrives with those integrations.
 *
 * NEVER pass a biometric payload, an image, a token or a full request body: only references, the
 * endpoint, the status and timing (P3 §9.4).
 */
export interface IntegrationEntry {
  readonly integrationKey: 'face_recognition' | 'broker_import' | 'other';
  readonly direction: 'inbound' | 'outbound';
  readonly outcome: 'success' | 'failure';
  readonly requestReference?: string | null;
  readonly endpoint?: string | null;
  readonly statusCode?: number | null;
  readonly durationMs?: number | null;
  readonly errorMessage?: string | null;
  readonly related?: { readonly type: string; readonly id: bigint | string } | null;
}

export async function logIntegration(db: Database, e: IntegrationEntry): Promise<void> {
  await db.integrationLog.create({
    data: {
      integrationKey: e.integrationKey,
      direction: e.direction,
      outcome: e.outcome,
      requestReference: e.requestReference?.slice(0, 100) ?? null,
      endpoint: e.endpoint?.slice(0, 255) ?? null,
      statusCode: e.statusCode ?? null,
      durationMs: e.durationMs ?? null,
      errorMessage: e.errorMessage?.slice(0, 1000) ?? null,
      relatedType: e.related?.type ?? null,
      relatedId: e.related ? e.related.id.toString() : null,
    },
  });
}
