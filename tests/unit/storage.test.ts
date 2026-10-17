import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../../src/config/env.js';
import { AppError } from '../../src/core/errors/app-error.js';
import { checkFileName, identifyFile } from '../../src/core/storage/file-types.js';
import { downloadSigner } from '../../src/core/storage/signed-url.js';
import { localFileStorage } from '../../src/core/storage/storage.js';
import { TEST_ENV } from '../helpers/test-app.js';

/** P1.12: file-type checks, signed download links and the local storage (Spec P4 §6.6, P13 §10). */

const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(24, 1)]);
const JPEG = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(24, 2)]);
const ZIP = Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.alloc(24, 3)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(8)]);

const detailCode = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (err) {
    if (err instanceof AppError) return err.details[0]?.code;
    throw err;
  }
  return undefined;
};

describe('file types', () => {
  it('accepts a file whose extension, declared type and content agree', () => {
    expect(identifyFile('licence.pdf', 'application/pdf', PDF).mime).toBe('application/pdf');
    expect(identifyFile('photo.JPG', 'image/jpeg', JPEG).key).toBe('jpeg');
    expect(identifyFile('scan.png', 'image/png', PNG).key).toBe('png');
    expect(identifyFile('scan.webp', 'image/webp', WEBP).key).toBe('webp');
    expect(identifyFile('deed.docx', 'application/octet-stream', ZIP).key).toBe('docx');
    expect(identifyFile('list.xlsx', '', ZIP).key).toBe('xlsx');
  });

  it('refuses a mismatched extension: the content decides, not the name', () => {
    expect(detailCode(() => identifyFile('licence.pdf', 'application/pdf', PNG))).toBe('FILE_TYPE_MISMATCH');
    expect(detailCode(() => identifyFile('photo.png', 'image/png', PDF))).toBe('FILE_TYPE_MISMATCH');
    expect(detailCode(() => identifyFile('licence.pdf', 'application/pdf', Buffer.alloc(0)))).toBe(
      'FILE_TYPE_MISMATCH',
    );
  });

  it('refuses a declared type that contradicts the file', () => {
    expect(detailCode(() => identifyFile('licence.pdf', 'image/png', PDF))).toBe('FILE_TYPE_MISMATCH');
    expect(detailCode(() => identifyFile('licence.pdf', 'text/html; charset=utf-8', PDF))).toBe(
      'FILE_TYPE_MISMATCH',
    );
  });

  it('refuses types that are not on the list, whatever they contain', () => {
    for (const name of ['run.exe', 'page.html', 'script.sh', 'archive.zip', 'noextension', '.pdf']) {
      expect(
        detailCode(() => identifyFile(name, 'application/pdf', PDF)),
        name,
      ).toBe('FILE_TYPE_NOT_ALLOWED');
    }
    // A double extension is judged by the last one.
    expect(detailCode(() => identifyFile('licence.pdf.exe', 'application/pdf', PDF))).toBe(
      'FILE_TYPE_NOT_ALLOWED',
    );
  });

  it('refuses a file name that carries a path (P13 §10)', () => {
    for (const name of [
      '../../etc/passwd.pdf',
      'dir/licence.pdf',
      'C:\\docs\\licence.pdf',
      '..',
      '',
      'a\u0000.pdf',
    ]) {
      expect(
        detailCode(() => checkFileName(name)),
        JSON.stringify(name),
      ).toBe('FILE_NAME_INVALID');
    }
    expect(detailCode(() => checkFileName(`${'x'.repeat(200)}.pdf`))).toBe('FILE_NAME_INVALID');
    expect(checkFileName('  লাইসেন্স ২০২৬.pdf ')).toBe('লাইসেন্স ২০২৬.pdf');
  });
});

describe('signed download links', () => {
  let clock = 1_800_000_000_000;
  const signer = downloadSigner(
    { secret: 'a-secret-of-at-least-thirty-two-chars', ttlSeconds: 300 },
    () => clock,
  );

  it('verifies its own link until it expires', () => {
    const { expires, signature } = signer.sign(42n);
    expect(expires).toBe(1_800_000_300);
    expect(signer.verify(42n, expires, signature)).toBe('ok');
    clock += 300_000;
    expect(signer.verify(42n, expires, signature)).toBe('ok');
    clock += 1_000;
    expect(signer.verify(42n, expires, signature)).toBe('expired');
  });

  it('cannot be moved to another document, a later expiry or another key', () => {
    const { expires, signature } = signer.sign(42n);
    expect(signer.verify(43n, expires, signature)).toBe('invalid');
    expect(signer.verify(42n, expires + 3600, signature)).toBe('invalid');
    expect(signer.verify(42n, expires, `${signature.slice(0, -1)}A`)).not.toBe('ok');
    expect(signer.verify(42n, expires, 'short')).toBe('invalid');
    const other = downloadSigner(
      { secret: 'another-secret-of-thirty-two-characters', ttlSeconds: 300 },
      () => clock,
    );
    expect(other.verify(42n, expires, signature)).toBe('invalid');
  });
});

describe('local file storage', () => {
  const root = mkdtempSync(join(tmpdir(), 'rupai-storage-unit-'));
  const storage = localFileStorage(root);
  const read = async (key: string) => {
    const { stream } = await storage.open(key);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  };

  it('stores a stream under a generated key, with its size, checksum and leading bytes', async () => {
    const temp = await storage.writeTemp(Readable.from([PDF.subarray(0, 5), PDF.subarray(5)]), 1024);
    expect(temp.key).toMatch(/^tmp\/[0-9A-Z]{26}$/);
    expect(temp.size).toBe(PDF.length);
    expect(temp.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(temp.head.equals(PDF.subarray(0, 16))).toBe(true);

    const key = await storage.promote(temp.key, 'documents');
    expect(key).toMatch(/^documents\/\d{4}\/\d{2}\/[0-9A-Z]{26}$/);
    expect((await read(key)).equals(PDF)).toBe(true);
    await expect(storage.open(temp.key)).rejects.toThrow();
    // No extension and no execute bit: an upload can never be run or served by type (P13 §10).
    expect(readFileSync(join(root, key)).length).toBe(PDF.length);

    await storage.remove(key);
    await expect(storage.open(key)).rejects.toThrow();
    await storage.remove(key); // a missing file is not an error
  });

  it('keeps nothing of a file past the size limit', async () => {
    const before = readdirSync(join(root, 'tmp')).length;
    await expect(
      storage.writeTemp(Readable.from([Buffer.alloc(600), Buffer.alloc(600)]), 1000),
    ).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
    });
    expect(readdirSync(join(root, 'tmp')).length).toBe(before);
  });

  it('never resolves a key outside its root', async () => {
    for (const key of ['../outside', '/etc/passwd', 'documents/../../x', 'documents', 'tmp/a.b']) {
      await expect(storage.open(key), key).rejects.toThrow(/storage key/);
      await expect(storage.remove(key), key).rejects.toThrow(/storage key/);
    }
    await expect(storage.promote('documents/2026/10/X', 'documents')).rejects.toThrow(/temporary/);
    await expect(storage.check()).resolves.toBeUndefined();
  });
});

describe('storage configuration', () => {
  it('has safe defaults and reads its limits', () => {
    expect(loadConfig(TEST_ENV).storage).toEqual({
      dir: './storage',
      maxUploadBytes: 10 * 1024 * 1024,
      downloadUrlSeconds: 300,
      backupDir: null,
    });
    const c = loadConfig({
      ...TEST_ENV,
      STORAGE_DIR: '/srv/uploads',
      UPLOAD_MAX_MB: '25',
      DOWNLOAD_URL_SECONDS: '60',
      BACKUP_DIR: '/srv/backups',
    });
    expect(c.storage).toEqual({
      dir: '/srv/uploads',
      maxUploadBytes: 25 * 1024 * 1024,
      downloadUrlSeconds: 60,
      backupDir: '/srv/backups',
    });
  });

  it('refuses limits out of range, and a relative directory in production', () => {
    const problems = (env: Record<string, string>) => {
      try {
        loadConfig({ ...TEST_ENV, ...env });
      } catch (err) {
        if (err instanceof ConfigError) return err.message;
        throw err;
      }
      return '';
    };
    expect(problems({ UPLOAD_MAX_MB: '0' })).toContain('UPLOAD_MAX_MB');
    expect(problems({ UPLOAD_MAX_MB: '500' })).toContain('UPLOAD_MAX_MB');
    expect(problems({ DOWNLOAD_URL_SECONDS: '5' })).toContain('DOWNLOAD_URL_SECONDS');
    expect(problems({ APP_ENV: 'production', NODE_ENV: 'production' })).toContain(
      'STORAGE_DIR must be an absolute path in production',
    );
  });
});
