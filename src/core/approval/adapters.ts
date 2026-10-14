import type { Tx } from '../db/transaction.js';
import type { DocumentValues } from './conditions.js';

/**
 * How a document type plugs into the approval engine (Spec P7 §2.2): the document owns its meaning, its
 * guards and its effects; the engine owns the approval process. A module that makes a document approvable
 * registers one adapter, in the epic that builds the document, and calls `submitForApproval` from its own
 * submit endpoint.
 *
 * The engine never posts, never moves stock, never creates a receivable. On final approval it signals
 * the document (`onApproved`), and the document acts.
 */

/** What the engine needs to know about a document when it is submitted. */
export interface SubmittedDocument {
  readonly id: bigint;
  /** Its document number, once it has one. */
  readonly number: string | null;
  /** How the approval queue names it, e.g. "PO-EST-2026-00012 · Lalbagh Traders". */
  readonly label: string;
  /** Neither the creator nor the submitter may approve it (P7 §12.2). */
  readonly createdBy: bigint;
  /** Where it sits: decides whose scope reaches it (P7 §4.4). */
  readonly estateId?: bigint | null;
  readonly factoryId?: bigint | null;
  readonly warehouseId?: bigint | null;
  readonly departmentId?: bigint | null;
  /**
   * The values its workflow conditions test, by the field names of its APPROVABLE_DOCUMENTS entry.
   * Amounts in BASE currency (P7 §5.1), as decimal strings.
   */
  readonly values: DocumentValues;
  /** Shown in the queue (P7 §13.1). Decimal strings. */
  readonly amount?: string | null;
  readonly quantity?: string | null;
  /** Outside the normal range: never approved in bulk (P7 §13.2). */
  readonly isExceptional?: boolean;
}

export interface ApprovalContext {
  readonly requestId: bigint | null;
  /** Who took the final decision, and for whom under a delegation. */
  readonly actorId: bigint;
  readonly actingForUserId: bigint | null;
}

export interface ApprovalAdapter {
  readonly documentType: string;
  /** Reads the document for the engine, inside the caller's transaction. */
  describe(tx: Tx, documentId: bigint): Promise<SubmittedDocument>;
  /**
   * Final approval: the document runs its guards and executes its effects (P1 §11.3). Throw an AppError
   * to refuse: the approval action stays recorded and the document stays Submitted (P7 §2.2).
   */
  onApproved(tx: Tx, documentId: bigint, ctx: ApprovalContext): Promise<void>;
  /** The workflow said no. The document becomes Rejected (P7 §10.1). */
  onRejected(tx: Tx, documentId: bigint, ctx: ApprovalContext & { readonly reason: string }): Promise<void>;
  /** Sent back for correction: the document becomes a Draft again (P7 §10.2). */
  onReturned(tx: Tx, documentId: bigint, ctx: ApprovalContext & { readonly comment: string }): Promise<void>;
}

const ADAPTERS = new Map<string, ApprovalAdapter>();

/** Registered once, at start-up, by the module that owns the document. A second registration replaces it. */
export function registerApprovalAdapter(adapter: ApprovalAdapter): void {
  ADAPTERS.set(adapter.documentType, adapter);
}

export function approvalAdapter(documentType: string): ApprovalAdapter {
  const adapter = ADAPTERS.get(documentType);
  if (!adapter) throw new Error(`no approval adapter is registered for ${documentType}`);
  return adapter;
}

/** For tests: forget a registration. */
export function unregisterApprovalAdapter(documentType: string): void {
  ADAPTERS.delete(documentType);
}
