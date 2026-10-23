import { fromB64u, randomBytes, timingSafeEqual, toB64u, toHex, transcript, utf8 } from './encoding.js';
import { fingerprint, hkdfSha256, hmacSha256, sha256, verifySignature, type Signer } from './primitives.js';

// Crockford base32 without I, L, O, U: unambiguous when read aloud or typed.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIRING_CODE_LENGTH = 16; // 80 bits
export const PAIRING_TTL_MS = 2 * 60 * 1000;

export function generatePairingCode(): string {
  const bytes = randomBytes(PAIRING_CODE_LENGTH);
  return Array.from(bytes, (b) => ALPHABET[b & 31]).join('');
}

/** Accepts user input ("abcd-efgh ijkl mnop", lowercase, O/I/L confusables). Returns null if invalid. */
export function normalizePairingCode(input: string): string | null {
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (s.length !== PAIRING_CODE_LENGTH) return null;
  for (const c of s) if (!ALPHABET.includes(c)) return null;
  return s;
}

export function formatPairingCode(code: string): string {
  return code.match(/.{4}/g)!.join('-');
}

export async function pairingRoom(code: string): Promise<string> {
  return toHex(await sha256(transcript('rc/pair-room/v1', code))).slice(0, 32);
}

export async function pairingKey(code: string): Promise<Uint8Array> {
  return hkdfSha256(utf8(code), 'rc/pair/v1', 'mac-key');
}

// ---------- QR payload ----------

export interface QrPayload {
  /** Signaling server URL (wss://...). */
  s: string;
  /** Pairing code. */
  c: string;
  /** Desktop identity fingerprint (hex SHA-256 of SPKI) — lets the phone detect a swapped offer. */
  f: string;
  /** Desktop display name. */
  n: string;
}

export function encodeQr(p: QrPayload): string {
  return 'rc1:' + toB64u(utf8(JSON.stringify(p)));
}

export function decodeQr(text: string): QrPayload | null {
  if (!text.startsWith('rc1:')) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromB64u(text.slice(4)))) as Partial<QrPayload>;
    if (typeof p.s !== 'string' || typeof p.f !== 'string' || typeof p.n !== 'string') return null;
    const c = normalizePairingCode(p.c ?? '');
    if (!c) return null;
    return { s: p.s, c, f: p.f, n: p.n };
  } catch {
    return null;
  }
}

// ---------- Transcripts ----------

interface OfferFields {
  nonceA: string;
  nonceD: string;
  desktopPub: string;
  desktopName: string;
}
interface AcceptFields extends OfferFields {
  androidPub: string;
  androidName: string;
  channelId: string;
}

const offerData = (f: OfferFields) =>
  transcript('rc/pair-offer/v1', f.nonceA, f.nonceD, f.desktopPub, f.desktopName);

const acceptData = (f: AcceptFields) =>
  transcript('rc/pair-accept/v1', f.nonceA, f.nonceD, f.desktopPub, f.desktopName, f.androidPub, f.androidName, f.channelId);

/** What each side signs to bind its identity key to the completed pairing. */
export const pairSigData = (role: 'desktop' | 'android', f: AcceptFields) =>
  transcript('rc/pair-sig/v1', role, f.nonceA, f.nonceD, f.desktopPub, f.desktopName, f.androidPub, f.androidName, f.channelId);

/** 6-digit short authentication string shown on both screens for visual confirmation. */
export async function pairingSas(f: OfferFields): Promise<string> {
  const h = await sha256(transcript('rc/sas/v1', f.nonceA, f.nonceD, f.desktopPub));
  const n = new DataView(h.buffer).getUint32(0, false) % 1_000_000;
  return String(n).padStart(6, '0');
}

// ---------- Desktop role ----------

export async function buildPairOffer(code: string, nonceA: string, signer: Signer, desktopName: string) {
  const key = await pairingKey(code);
  const f: OfferFields = { nonceA, nonceD: toB64u(randomBytes(16)), desktopPub: toB64u(signer.publicKey), desktopName };
  const mac = toB64u(await hmacSha256(key, offerData(f)));
  return { msg: { k: 'pair.offer' as const, nonceD: f.nonceD, desktopPub: f.desktopPub, desktopName, mac }, fields: f };
}

export interface PairedPeer {
  publicKey: string; // SPKI b64u
  fingerprint: string;
  name: string;
  channelId: string;
}

/** Verifies the phone's acceptance; returns the peer to pin and the desktop's closing signature. */
export async function verifyPairAccept(
  code: string,
  offer: OfferFields,
  accept: { androidPub: string; androidName: string; channelId: string; mac: string; sig: string },
  signer: Signer,
): Promise<{ peer: PairedPeer; done: { k: 'pair.done'; sig: string } } | null> {
  const key = await pairingKey(code);
  const f: AcceptFields = { ...offer, androidPub: accept.androidPub, androidName: accept.androidName, channelId: accept.channelId };
  const mac = await hmacSha256(key, acceptData(f));
  if (!timingSafeEqual(mac, fromB64u(accept.mac))) return null;
  const androidPub = fromB64u(accept.androidPub);
  if (!(await verifySignature(androidPub, pairSigData('android', f), fromB64u(accept.sig)))) return null;
  const sig = toB64u(await signer.sign(pairSigData('desktop', f)));
  return {
    peer: { publicKey: accept.androidPub, fingerprint: await fingerprint(androidPub), name: accept.androidName, channelId: accept.channelId },
    done: { k: 'pair.done', sig },
  };
}

// ---------- Android role (reference implementation, mirrored in Kotlin) ----------

export function buildPairRequest() {
  return { k: 'pair.req' as const, nonceA: toB64u(randomBytes(16)) };
}

/** Checks the desktop's offer MAC and (when scanned from QR) the expected fingerprint. */
export async function verifyPairOffer(
  code: string,
  nonceA: string,
  offer: { nonceD: string; desktopPub: string; desktopName: string; mac: string },
  expectedFingerprint?: string,
): Promise<OfferFields | null> {
  const key = await pairingKey(code);
  const f: OfferFields = { nonceA, nonceD: offer.nonceD, desktopPub: offer.desktopPub, desktopName: offer.desktopName };
  const mac = await hmacSha256(key, offerData(f));
  if (!timingSafeEqual(mac, fromB64u(offer.mac))) return null;
  if (expectedFingerprint && (await fingerprint(fromB64u(offer.desktopPub))) !== expectedFingerprint) return null;
  return f;
}

export async function buildPairAccept(code: string, offer: OfferFields, signer: Signer, androidName: string) {
  const key = await pairingKey(code);
  const f: AcceptFields = {
    ...offer,
    androidPub: toB64u(signer.publicKey),
    androidName,
    channelId: toHex(randomBytes(16)),
  };
  return {
    msg: {
      k: 'pair.accept' as const,
      androidPub: f.androidPub,
      androidName,
      channelId: f.channelId,
      mac: toB64u(await hmacSha256(key, acceptData(f))),
      sig: toB64u(await signer.sign(pairSigData('android', f))),
    },
    fields: f,
  };
}

export async function verifyPairDone(f: AcceptFields, sig: string): Promise<boolean> {
  return verifySignature(fromB64u(f.desktopPub), pairSigData('desktop', f), fromB64u(sig));
}
