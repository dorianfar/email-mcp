/**
 * Encrypts and decrypts email account credentials (passwords) using AES-256-GCM.
 * The encryption key comes from an environment variable (ENCRYPTION_KEY),
 * never stored in the database or in code.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

function getKey(): Buffer {
  const hexKey = process.env.ENCRYPTION_KEY;
  if (!hexKey || hexKey.length !== 64) {
    throw new Error(
      'ENCRYPTION_KEY environment variable is missing or invalid (must be a 64-character hex string).',
    );
  }
  return Buffer.from(hexKey, 'hex');
}

/**
 * Encrypts a plaintext string (e.g. an email password).
 * Returns a single string combining iv + authTag + ciphertext, safe to store in the database.
 */
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

/**
 * Decrypts a string previously produced by encryptSecret.
 */
export function decryptSecret(stored: string): string {
  const key = getKey();
  const [ivHex, authTagHex, encryptedHex] = stored.split(':');
  if (!ivHex || !authTagHex || !encryptedHex) {
    throw new Error('Invalid encrypted secret format.');
  }

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  return decrypted.toString('utf8');
}