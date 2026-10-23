import { z } from 'zod';

/**
 * End-to-end messages carried inside signaling `relay.data`.
 * Binary values are base64url (no padding). Signatures are ECDSA P-256 / SHA-256 in
 * IEEE P1363 form (r || s, 64 bytes). Public keys are SPKI DER. See docs/protocol.md.
 */

const B64u = z.string().regex(/^[A-Za-z0-9_-]*$/);
const Name = z.string().min(1).max(64);

// ---------- Pairing (room derived from the pairing code) ----------

export const PairRequest = z.object({ k: z.literal('pair.req'), nonceA: B64u });
export const PairOffer = z.object({
  k: z.literal('pair.offer'),
  nonceD: B64u,
  desktopPub: B64u,
  desktopName: Name,
  mac: B64u,
});
export const PairAccept = z.object({
  k: z.literal('pair.accept'),
  androidPub: B64u,
  androidName: Name,
  channelId: z.string().regex(/^[a-f0-9]{32}$/),
  mac: B64u,
  sig: B64u,
});
export const PairDone = z.object({ k: z.literal('pair.done'), sig: B64u });
export const PairReject = z.object({ k: z.literal('pair.reject'), reason: z.string().max(200) });

// ---------- Session (room = channelId fixed at pairing) ----------

export const SessionRequest = z.object({
  k: z.literal('sess.req'),
  nonceD: B64u,
  ts: z.number(),
  sig: B64u,
});
export const SessionToken = z.object({
  sid: z.string(),
  desktopFp: z.string(),
  androidFp: z.string(),
  iat: z.number(),
  exp: z.number(),
});
export type SessionToken = z.infer<typeof SessionToken>;
export const SessionAccept = z.object({
  k: z.literal('sess.accept'),
  token: SessionToken,
  nonceA: B64u,
  sig: B64u,
});
export const SessionResume = z.object({
  k: z.literal('sess.resume'),
  sid: z.string(),
  nonceD: B64u,
  ts: z.number(),
  sig: B64u,
});
export const SessionDeny = z.object({ k: z.literal('sess.deny'), reason: z.string().max(200) });
export const SessionEnd = z.object({
  k: z.literal('sess.end'),
  sid: z.string(),
  reason: z.enum(['user', 'revoked', 'expired', 'error', 'lost']),
});

export const SignedSdp = z.object({
  k: z.literal('sdp'),
  sid: z.string(),
  type: z.enum(['offer', 'answer']),
  sdp: z.string(),
  sig: B64u,
});
export const IceCandidateMsg = z.object({
  k: z.literal('ice'),
  sid: z.string(),
  candidate: z.string(),
  sdpMid: z.string().nullable(),
  sdpMLineIndex: z.number().nullable(),
});

export const E2EMessage = z.discriminatedUnion('k', [
  PairRequest,
  PairOffer,
  PairAccept,
  PairDone,
  PairReject,
  SessionRequest,
  SessionAccept,
  SessionResume,
  SessionDeny,
  SessionEnd,
  SignedSdp,
  IceCandidateMsg,
]);
export type E2EMessage = z.infer<typeof E2EMessage>;
