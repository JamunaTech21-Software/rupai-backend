import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived signed download links (Spec P4 §6.6: "Streams via a short-lived signed URL, never a direct
 * path"). The link names a document id and an expiry and carries an HMAC over both, so:
 *
 *   - a browser can open it without an Authorization header (a plain link or <a download>)
 *   - it stops working by itself, and it cannot be altered to name another document or a later expiry
 *   - nothing in it reveals where the file is stored
 *
 * The signing key is derived from the token secret, so a download link can never be replayed as, or
 * forged from, an access token.
 */

export interface DownloadSigner {
  /** `expires` is Unix seconds. */
  sign(documentId: bigint): { expires: number; signature: string };
  verify(documentId: bigint, expires: number, signature: string): 'ok' | 'expired' | 'invalid';
  readonly ttlSeconds: number;
}

export function downloadSigner(
  opts: { secret: string; ttlSeconds: number },
  now: () => number = Date.now,
): DownloadSigner {
  const key = createHmac('sha256', opts.secret).update('rupai:document-download:v1').digest();
  const mac = (documentId: bigint, expires: number) =>
    createHmac('sha256', key)
      .update(`${documentId.toString()}.${String(expires)}`)
      .digest();

  return {
    ttlSeconds: opts.ttlSeconds,
    sign(documentId) {
      const expires = Math.floor(now() / 1000) + opts.ttlSeconds;
      return { expires, signature: mac(documentId, expires).toString('base64url') };
    },
    verify(documentId, expires, signature) {
      const given = Buffer.from(signature, 'base64url');
      const expected = mac(documentId, expires);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'invalid';
      return expires < Math.floor(now() / 1000) ? 'expired' : 'ok';
    },
  };
}
