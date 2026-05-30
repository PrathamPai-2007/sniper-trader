import test from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt } from '../src/core/keystore.js';

test('keystore encrypt and decrypt', async () => {
  const password = 'secure-password';
  const plaintext = '5U3D1bg3jFL2n3zPXSkwQnQKvU4uEPrKzJ6aXvQf6tTq'; // dummy pk

  const encrypted = await encrypt(plaintext, password);
  assert.ok(encrypted.iv);
  assert.ok(encrypted.salt);
  assert.ok(encrypted.ciphertext);
  assert.ok(encrypted.tag);

  const decrypted = await decrypt(encrypted, password);
  assert.strictEqual(decrypted, plaintext);
});

test('keystore decryption fails with wrong password', async () => {
  const password = 'secure-password';
  const plaintext = 'dummy-key';

  const encrypted = await encrypt(plaintext, password);

  await assert.rejects(
    () => decrypt(encrypted, 'wrong-password'),
    /Unsupported state or unable to authenticate data/i
  );
});
