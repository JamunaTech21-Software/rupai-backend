import { Prisma } from '../../generated/prisma/client.js';

/**
 * Database constraint violations, recognised from the MySQL error the driver adapter reports. The
 * database is the last line of defence for uniqueness, references and CHECKs (P2 §7.3), and services turn
 * these into the API's error codes instead of a 500:
 *
 *   unique      1062 → DUPLICATE_KEY (422), naming the field
 *   referenced  1451 → REFERENCED_RECORD (422): the row is in use and cannot be deleted
 *   missing     1452 → a referenced row does not exist
 *   check       3819 → a CHECK constraint refused the value
 */
export type ConstraintViolation =
  | { readonly kind: 'unique'; readonly index: string }
  | { readonly kind: 'referenced'; readonly message: string }
  | { readonly kind: 'missing'; readonly fields: readonly string[] }
  | { readonly kind: 'check'; readonly constraint: string };

interface AdapterCause {
  originalCode?: string;
  code?: number;
  originalMessage?: string;
  message?: string;
  constraint?: { index?: string; fields?: string[] };
}

export function constraintViolation(err: unknown): ConstraintViolation | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return null;
  const meta = err.meta as { driverAdapterError?: { cause?: AdapterCause } } | undefined;
  const cause = meta?.driverAdapterError?.cause;
  const code = cause?.originalCode ?? (cause?.code !== undefined ? String(cause.code) : undefined);
  const message = cause?.originalMessage ?? cause?.message ?? err.message;
  switch (code) {
    case '1062': {
      const index = cause?.constraint?.index ?? /for key '(?:[^.']+\.)?([^']+)'/.exec(message)?.[1] ?? '';
      return { kind: 'unique', index };
    }
    case '1451':
      return { kind: 'referenced', message };
    case '1452':
      return { kind: 'missing', fields: cause?.constraint?.fields ?? [] };
    case '3819':
      return { kind: 'check', constraint: /constraint '([^']+)'/.exec(message)?.[1] ?? '' };
    default:
      return null;
  }
}
