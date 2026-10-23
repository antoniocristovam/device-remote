import { toHex, utf8 } from './encoding.js';

const subtle = () => globalThis.crypto.subtle;
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

/** Something that can sign with a device identity key (ECDSA P-256, SHA-256, P1363 output). */
export interface Signer {
  /** SPKI DER of the public key. */
  readonly publicKey: Uint8Array;
  sign(data: Uint8Array): Promise<Uint8Array>;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest('SHA-256', bs(data)));
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', bs(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', k, bs(data)));
}

export async function hkdfSha256(ikm: Uint8Array, salt: string, info: string, length = 32): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', bs(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: bs(utf8(salt)), info: bs(utf8(info)) },
    k,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** Lowercase hex SHA-256 of the SPKI DER public key. */
export async function fingerprint(spki: Uint8Array): Promise<string> {
  return toHex(await sha256(spki));
}

/** Human-readable short form: first 16 hex chars grouped by 4 (e.g. "a1b2 c3d4 e5f6 0718"). */
export function shortFingerprint(fp: string): string {
  return fp.slice(0, 16).toUpperCase().match(/.{4}/g)!.join(' ');
}

export async function verifySignature(spki: Uint8Array, data: Uint8Array, sig: Uint8Array): Promise<boolean> {
  try {
    const key = await subtle().importKey('spki', bs(spki), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, key, bs(sig), bs(data));
  } catch {
    return false;
  }
}

/** In-memory WebCrypto signer. Used in tests and as the building block of persisted identities. */
export async function createEphemeralSigner(): Promise<Signer & { privateKey: CryptoKey }> {
  const pair = await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return signerFromKeyPair(pair);
}

export async function signerFromKeyPair(pair: CryptoKeyPair): Promise<Signer & { privateKey: CryptoKey }> {
  const publicKey = new Uint8Array(await subtle().exportKey('spki', pair.publicKey));
  return {
    publicKey,
    privateKey: pair.privateKey,
    async sign(data) {
      return new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, bs(data)));
    },
  };
}
