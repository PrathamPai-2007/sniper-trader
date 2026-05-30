import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const SALT_LENGTH = 64;
const KEY_LENGTH = 32;
const ITERATIONS = 100_000;

export interface KeystoreData {
  iv: string;
  salt: string;
  ciphertext: string;
  tag: string;
}

/**
 * Derives a cryptographic key from a password and salt using PBKDF2.
 */
function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, ITERATIONS, KEY_LENGTH, 'sha512', (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/**
 * Encrypts a plaintext string using a password.
 * Returns a JSON-serializable object containing the encrypted data and parameters.
 */
export async function encrypt(plaintext: string, password: string): Promise<KeystoreData> {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = await deriveKey(password, salt);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
  ciphertext += cipher.final('hex');

  return {
    iv: iv.toString('hex'),
    salt: salt.toString('hex'),
    ciphertext,
    tag: cipher.getAuthTag().toString('hex'),
  };
}

/**
 * Decrypts a ciphertext using a password and the stored keystore parameters.
 * Returns the original plaintext string.
 */
export async function decrypt(data: KeystoreData, password: string): Promise<string> {
  const salt = Buffer.from(data.salt, 'hex');
  const iv = Buffer.from(data.iv, 'hex');
  const tag = Buffer.from(data.tag, 'hex');
  const key = await deriveKey(password, salt);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let plaintext = decipher.update(data.ciphertext, 'hex', 'utf8');
  plaintext += decipher.final('utf8');

  return plaintext;
}
