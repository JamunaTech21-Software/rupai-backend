import { hash, verify } from '@node-rs/argon2';
import { z } from 'zod';

/**
 * Password hashing (Spec P1 §12.4, decision T-7): argon2id.
 *
 * The stored value is a PHC string (`$argon2id$v=19$m=…,t=…,p=…$salt$hash`) that records its own
 * algorithm and cost, so the parameters can be strengthened later without a migration: old hashes still
 * verify, and `needsRehash` tells the login path (P1.02) to upgrade them.
 *
 * Parameters follow the OWASP argon2id baseline (m = 19 MiB, t = 2, p = 1).
 */
export const PASSWORD_HASH_PARAMS = {
  // Algorithm.Argon2id. The library exports it as an ambient const enum, which isolated modules cannot read.
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Length bounds. Composition rules are deliberately absent (NIST SP 800-63B); length is what matters. */
export const PASSWORD_POLICY = { minLength: 12, maxLength: 128 } as const;

export const zPassword = z
  .string()
  .min(PASSWORD_POLICY.minLength, `Must be at least ${String(PASSWORD_POLICY.minLength)} characters.`)
  .max(PASSWORD_POLICY.maxLength, `Must be at most ${String(PASSWORD_POLICY.maxLength)} characters.`)
  .meta({ format: 'password', description: 'Never returned by the API.' });

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, PASSWORD_HASH_PARAMS);
}

/** Constant-time verification. A malformed stored hash verifies as false rather than throwing. */
export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(storedHash, plain);
  } catch {
    return false;
  }
}

/** True when the stored hash was made with weaker parameters than the current ones. */
export function needsRehash(storedHash: string): boolean {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
  if (!m) return true;
  const [, mem, time, par] = m.map(Number);
  return (
    mem !== PASSWORD_HASH_PARAMS.memoryCost ||
    time !== PASSWORD_HASH_PARAMS.timeCost ||
    par !== PASSWORD_HASH_PARAMS.parallelism
  );
}
