import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import type { Database } from '../db/prisma.js';
import type { Tx } from '../db/transaction.js';
import { AppError } from '../errors/app-error.js';

/**
 * System settings as code reads them (Spec P3 §28.6): typed values by key, and the cipher for the ones
 * marked is_encrypted.
 *
 *   - A value is stored as text and typed by value_type: string, integer, decimal (a decimal STRING, never
 *     a float), boolean, json.
 *   - An encrypted value is AES-256-GCM ciphertext ("enc:v1:iv:tag:data", base64). The key derives from
 *     SETTINGS_ENCRYPTION_KEY and never touches the database. The API never returns such a value; only
 *     server code that needs it (an SMTP password, an integration secret) decrypts it, through readSetting.
 */

export const SETTING_TYPES = ['string', 'integer', 'decimal', 'boolean', 'json'] as const;
export type SettingType = (typeof SETTING_TYPES)[number];
export type SettingValue =
  string | number | boolean | null | readonly unknown[] | Readonly<Record<string, unknown>>;

export interface SettingsCipher {
  encrypt(plain: string): string;
  decrypt(stored: string): string;
}

const PREFIX = 'enc:v1:';

/** The cipher, or null when no key is configured (encrypted settings are then unavailable). */
export function settingsCipher(encryptionKey: string | null): SettingsCipher | null {
  if (encryptionKey === null) return null;
  const key = createHash('sha256').update(encryptionKey, 'utf8').digest();
  return {
    encrypt(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return `${PREFIX}${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
    },
    decrypt(stored) {
      const [iv, tag, data] = stored.slice(PREFIX.length).split(':');
      if (!stored.startsWith(PREFIX) || !iv || !tag || data === undefined)
        throw new Error('not an encrypted setting value');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    },
  };
}

export function encryptionUnavailable(): AppError {
  return new AppError('INVARIANT_VIOLATED', 'Encrypted settings are not available on this server.', [
    { code: 'INVARIANT_VIOLATED', message: 'SETTINGS_ENCRYPTION_KEY is not configured.' },
  ]);
}

const DECIMAL = /^-?\d{1,30}(\.\d{1,10})?$/;

/** The stored text of a value, or the reason it does not fit its type. */
export function settingToText(
  type: SettingType,
  value: SettingValue,
): { text: string | null } | { error: string } {
  if (value === null) return { text: null };
  switch (type) {
    case 'string':
      return typeof value === 'string' && value.length <= 10_000
        ? { text: value }
        : { error: 'must be a string of at most 10000 characters' };
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value)
        ? { text: String(value) }
        : { error: 'must be a whole number' };
    case 'decimal':
      return typeof value === 'string' && DECIMAL.test(value)
        ? { text: value }
        : { error: 'must be a decimal string such as "12.50", not a number' };
    case 'boolean':
      return typeof value === 'boolean' ? { text: String(value) } : { error: 'must be true or false' };
    case 'json': {
      const text = JSON.stringify(value);
      return text.length <= 20_000 ? { text } : { error: 'is too large (20000 characters of JSON at most)' };
    }
  }
}

export function settingFromText(type: SettingType, text: string | null): SettingValue {
  if (text === null) return null;
  switch (type) {
    case 'integer':
      return Number.parseInt(text, 10);
    case 'boolean':
      return text === 'true';
    case 'json':
      return JSON.parse(text) as SettingValue;
    default:
      return text;
  }
}

/**
 * A setting's typed value, decrypted where needed, or undefined when the key does not exist. For server
 * code only: never send the result of an encrypted setting to a client.
 */
export async function readSetting(
  db: Database | Tx,
  cipher: SettingsCipher | null,
  key: string,
): Promise<SettingValue | undefined> {
  const row = await db.systemSetting.findUnique({ where: { settingKey: key } });
  if (!row) return undefined;
  if (row.settingValue === null) return null;
  if (!row.isEncrypted) return settingFromText(row.valueType as SettingType, row.settingValue);
  if (!cipher) throw encryptionUnavailable();
  return settingFromText(row.valueType as SettingType, cipher.decrypt(row.settingValue));
}
