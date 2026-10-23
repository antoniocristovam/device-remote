import { app, safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fingerprint, fromB64u, signerFromKeyPair, toB64u, type Signer } from '@rc/crypto-proto';

export interface Identity {
  signer: Signer;
  fingerprint: string;
  name: string;
}

const file = () => join(app.getPath('userData'), 'identity.bin');

/**
 * Device identity key (ECDSA P-256). The private key is only ever written to disk encrypted by
 * the OS credential store (DPAPI on Windows, Keychain on macOS) through Electron safeStorage.
 * At runtime it is a non-extractable WebCrypto key that never leaves the main process.
 */
export async function loadIdentity(): Promise<Identity> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error('OS credential storage unavailable; refusing to store identity key in plain text');
  }
  const subtle = globalThis.crypto.subtle;
  let pkcs8: Uint8Array;
  let spki: Uint8Array;

  if (existsSync(file())) {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(readFileSync(file()));
    const stored = JSON.parse(result) as { pkcs8: string; spki: string };
    pkcs8 = fromB64u(stored.pkcs8);
    spki = fromB64u(stored.spki);
    // OS key rotated: rewrap the identity with the current key.
    if (shouldReEncrypt) writeFileSync(file(), await safeStorage.encryptStringAsync(result), { mode: 0o600 });
  } else {
    const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
    spki = new Uint8Array(await subtle.exportKey('spki', pair.publicKey));
    const blob = await safeStorage.encryptStringAsync(JSON.stringify({ pkcs8: toB64u(pkcs8), spki: toB64u(spki) }));
    writeFileSync(file(), blob, { mode: 0o600 });
  }

  const privateKey = await subtle.importKey('pkcs8', pkcs8 as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  pkcs8.fill(0);
  const publicKey = await subtle.importKey('spki', spki as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  const signer = await signerFromKeyPair({ privateKey, publicKey });
  return { signer, fingerprint: await fingerprint(spki), name: hostname() };
}
