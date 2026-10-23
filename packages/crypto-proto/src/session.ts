import { fromB64u, randomBytes, toB64u, toHex, transcript } from './encoding.js';
import { verifySignature, type Signer } from './primitives.js';

export const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface SessionToken {
  sid: string;
  desktopFp: string;
  androidFp: string;
  iat: number;
  exp: number;
}

const tokenFields = (t: SessionToken) => [t.sid, t.desktopFp, t.androidFp, t.iat, t.exp] as const;

export const sessReqData = (channelId: string, nonceD: string, ts: number) =>
  transcript('rc/sess-req/v1', channelId, nonceD, ts);

export const sessAcceptData = (channelId: string, nonceD: string, nonceA: string, t: SessionToken) =>
  transcript('rc/sess-accept/v1', channelId, nonceD, nonceA, ...tokenFields(t));

export const sessResumeData = (channelId: string, sid: string, nonceD: string, ts: number) =>
  transcript('rc/sess-resume/v1', channelId, sid, nonceD, ts);

export const sdpSigData = (sid: string, role: 'desktop' | 'android', type: string, fingerprints: string) =>
  transcript('rc/sdp/v1', sid, role, type, fingerprints);

/**
 * Extracts the DTLS certificate fingerprints from an SDP, normalised (lowercase, sorted, unique,
 * newline-joined). Signing these with the identity key binds the encrypted transport to the
 * paired device, so a malicious signaling/TURN server cannot sit in the middle.
 */
export function dtlsFingerprints(sdp: string): string {
  const set = new Set<string>();
  for (const line of sdp.split(/\r?\n/)) {
    const m = /^a=fingerprint:(\S+)\s+(\S+)/i.exec(line.trim());
    if (m) set.add(`${m[1]!.toLowerCase()} ${m[2]!.toLowerCase()}`);
  }
  return [...set].sort().join('\n');
}

export function withinSkew(ts: number, now = Date.now()): boolean {
  return Math.abs(now - ts) <= MAX_CLOCK_SKEW_MS;
}

// ---------- Desktop role ----------

export async function buildSessionRequest(channelId: string, signer: Signer, now = Date.now()) {
  const nonceD = toB64u(randomBytes(16));
  const sig = toB64u(await signer.sign(sessReqData(channelId, nonceD, now)));
  return { k: 'sess.req' as const, nonceD, ts: now, sig };
}

export async function verifySessionAccept(
  channelId: string,
  nonceD: string,
  androidPub: string,
  expected: { desktopFp: string; androidFp: string },
  msg: { token: SessionToken; nonceA: string; sig: string },
  now = Date.now(),
): Promise<boolean> {
  const t = msg.token;
  if (t.desktopFp !== expected.desktopFp || t.androidFp !== expected.androidFp) return false;
  if (t.exp <= now || t.iat > now + MAX_CLOCK_SKEW_MS) return false;
  return verifySignature(fromB64u(androidPub), sessAcceptData(channelId, nonceD, msg.nonceA, t), fromB64u(msg.sig));
}

export async function buildSessionResume(channelId: string, sid: string, signer: Signer, now = Date.now()) {
  const nonceD = toB64u(randomBytes(16));
  const sig = toB64u(await signer.sign(sessResumeData(channelId, sid, nonceD, now)));
  return { k: 'sess.resume' as const, sid, nonceD, ts: now, sig };
}

// ---------- Both roles ----------

export async function signSdp(sid: string, role: 'desktop' | 'android', type: 'offer' | 'answer', sdp: string, signer: Signer) {
  const fps = dtlsFingerprints(sdp);
  if (!fps) throw new Error('SDP has no DTLS fingerprint');
  const sig = toB64u(await signer.sign(sdpSigData(sid, role, type, fps)));
  return { k: 'sdp' as const, sid, type, sdp, sig };
}

export async function verifySdp(
  peerPub: string,
  peerRole: 'desktop' | 'android',
  msg: { sid: string; type: string; sdp: string; sig: string },
): Promise<boolean> {
  const fps = dtlsFingerprints(msg.sdp);
  if (!fps) return false;
  return verifySignature(fromB64u(peerPub), sdpSigData(msg.sid, peerRole, msg.type, fps), fromB64u(msg.sig));
}

// ---------- Android role (reference; mirrored in Kotlin) ----------

export async function verifySessionRequest(
  channelId: string,
  desktopPub: string,
  msg: { nonceD: string; ts: number; sig: string },
  now = Date.now(),
): Promise<boolean> {
  if (!withinSkew(msg.ts, now)) return false;
  return verifySignature(fromB64u(desktopPub), sessReqData(channelId, msg.nonceD, msg.ts), fromB64u(msg.sig));
}

export async function buildSessionAccept(
  channelId: string,
  nonceD: string,
  ids: { desktopFp: string; androidFp: string },
  signer: Signer,
  now = Date.now(),
) {
  const token: SessionToken = { sid: toHex(randomBytes(16)), ...ids, iat: now, exp: now + SESSION_TTL_MS };
  const nonceA = toB64u(randomBytes(16));
  const sig = toB64u(await signer.sign(sessAcceptData(channelId, nonceD, nonceA, token)));
  return { k: 'sess.accept' as const, token, nonceA, sig };
}

export async function verifySessionResume(
  channelId: string,
  desktopPub: string,
  activeSid: string,
  msg: { sid: string; nonceD: string; ts: number; sig: string },
  now = Date.now(),
): Promise<boolean> {
  if (msg.sid !== activeSid || !withinSkew(msg.ts, now)) return false;
  return verifySignature(fromB64u(desktopPub), sessResumeData(channelId, msg.sid, msg.nonceD, msg.ts), fromB64u(msg.sig));
}
