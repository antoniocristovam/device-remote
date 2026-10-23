import { z } from 'zod';

/**
 * Signaling wire protocol (client <-> signaling server, JSON over WebSocket).
 *
 * The server only routes opaque `relay` payloads between the (at most two) peers of a room.
 * It never sees keys, SDP signatures or session tokens in a form it could forge: every
 * security-relevant message inside `relay.data` is authenticated end to end (see e2e.ts).
 */

export const PeerRole = z.enum(['desktop', 'android']);
export type PeerRole = z.infer<typeof PeerRole>;

/** Rooms are unguessable ids (hex, 32 chars) derived from the pairing code or chosen at pairing. */
export const RoomId = z.string().regex(/^[a-f0-9]{32}$/);

export const ClientMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('join'), room: RoomId, role: PeerRole }),
  z.object({ t: z.literal('leave'), room: RoomId }),
  z.object({ t: z.literal('relay'), room: RoomId, data: z.unknown() }),
  z.object({ t: z.literal('turn') }),
  z.object({ t: z.literal('ping'), ts: z.number() }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const IceServer = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServer = z.infer<typeof IceServer>;

export const ServerMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('joined'), room: RoomId, peers: z.array(PeerRole) }),
  z.object({ t: z.literal('peer-joined'), room: RoomId, role: PeerRole }),
  z.object({ t: z.literal('peer-left'), room: RoomId, role: PeerRole }),
  z.object({ t: z.literal('relay'), room: RoomId, from: PeerRole, data: z.unknown() }),
  z.object({ t: z.literal('turn-credentials'), iceServers: z.array(IceServer), ttl: z.number() }),
  z.object({ t: z.literal('pong'), ts: z.number() }),
  z.object({ t: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export const SignalingErrorCode = {
  BadMessage: 'bad_message',
  RoomFull: 'room_full',
  NotInRoom: 'not_in_room',
  RateLimited: 'rate_limited',
} as const;
