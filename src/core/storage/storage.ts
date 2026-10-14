import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, constants, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ulid } from 'ulid';

import { AppError } from '../errors/app-error.js';

/**
 * File storage behind an abstraction (Spec P1 §5.23, P2 §6.2). Business code names a file by a RELATIVE
 * key and never by a path, so the directory on the organisation's server can become network-attached or
 * object storage later without a data migration.
 *
 *   - keys are generated here, never taken from the client: the uploaded file name is metadata only
 *   - stored files have no extension and are written without execute permission (P13 §10: "uploads not
 *     executable and outside the web root")
 *   - an upload lands under tmp/ first and is promoted to its final key once the request is accepted, so
 *     a rejected upload never appears among the stored documents
 */

export interface StoredTemp {
  /** Key under tmp/. Promote it or remove it. */
  readonly key: string;
  readonly size: number;
  /** SHA-256 of the content, lower-case hex. */
  readonly sha256: string;
  /** The first bytes of the content, for file-type detection. */
  readonly head: Buffer;
}

export interface FileStorage {
  /** Writes a stream to a temporary key. 413 PAYLOAD_TOO_LARGE past `maxBytes` (nothing is kept). */
  writeTemp(stream: Readable, maxBytes: number): Promise<StoredTemp>;
  /** Moves a temporary file to a new permanent key under `area` and returns that key. */
  promote(tempKey: string, area: string): Promise<string>;
  /** Opens a stored file for reading. Throws when it is missing. */
  open(key: string): Promise<{ stream: Readable; size: number }>;
  /** Removes a file. A missing file is not an error. */
  remove(key: string): Promise<void>;
  /** Resolves when the storage is usable (readiness check). */
  check(): Promise<void>;
}

const KEY = /^[a-z0-9]+(?:\/[A-Za-z0-9]+)+$/;
const AREA = /^[a-z0-9]+$/;
export const HEAD_BYTES = 16;

export function tooLarge(maxBytes: number): AppError {
  return new AppError('PAYLOAD_TOO_LARGE', 'The file is too large.', [
    {
      field: 'file',
      code: 'PAYLOAD_TOO_LARGE',
      message: `The largest file accepted is ${String(Math.floor(maxBytes / 1024 / 1024))} MB.`,
      context: { max_bytes: maxBytes },
    },
  ]);
}

/** Files in a directory of the server, outside the web root (P14 §4.2: shared/uploads). */
export function localFileStorage(rootDir: string): FileStorage {
  const root = resolve(rootDir);

  function pathOf(key: string): string {
    if (!KEY.test(key)) throw new Error(`invalid storage key: ${key}`);
    const p = resolve(root, key);
    if (!p.startsWith(root + sep)) throw new Error(`storage key escapes the storage root: ${key}`);
    return p;
  }

  return {
    async writeTemp(stream, maxBytes) {
      const key = `tmp/${ulid()}`;
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      const hash = createHash('sha256');
      const head: Buffer[] = [];
      let headSize = 0;
      let size = 0;
      try {
        await pipeline(
          stream,
          async function* (source: AsyncIterable<Buffer>) {
            for await (const chunk of source) {
              size += chunk.length;
              if (size > maxBytes) throw tooLarge(maxBytes);
              hash.update(chunk);
              if (headSize < HEAD_BYTES) {
                head.push(chunk.subarray(0, HEAD_BYTES - headSize));
                headSize += chunk.length;
              }
              yield chunk;
            }
          },
          createWriteStream(path, { mode: 0o640, flags: 'wx' }),
        );
      } catch (err) {
        await rm(path, { force: true });
        throw err;
      }
      return { key, size, sha256: hash.digest('hex'), head: Buffer.concat(head).subarray(0, HEAD_BYTES) };
    },

    async promote(tempKey, area) {
      if (!tempKey.startsWith('tmp/')) throw new Error(`not a temporary key: ${tempKey}`);
      if (!AREA.test(area)) throw new Error(`invalid storage area: ${area}`);
      const now = new Date();
      const month = String(now.getUTCMonth() + 1).padStart(2, '0');
      const key = `${area}/${String(now.getUTCFullYear())}/${month}/${ulid()}`;
      const to = pathOf(key);
      await mkdir(dirname(to), { recursive: true });
      await rename(pathOf(tempKey), to);
      return key;
    },

    async open(key) {
      const path = pathOf(key);
      const info = await stat(path);
      return { stream: createReadStream(path), size: info.size };
    },

    async remove(key) {
      await rm(pathOf(key), { force: true });
    },

    async check() {
      await mkdir(root, { recursive: true });
      await access(root, constants.R_OK | constants.W_OK);
    },
  };
}
