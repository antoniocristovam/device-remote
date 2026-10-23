import { z } from 'zod';

/** WebRTC DataChannel labels and their delivery settings. */
export const Channels = {
  /** Pointer/keyboard. Unordered + no retransmits: a stale move is worse than a lost one. */
  control: { label: 'control', ordered: false, maxRetransmits: 0 },
  /** Discrete control events that must arrive (taps, keys, text). */
  controlReliable: { label: 'control-r', ordered: true },
  session: { label: 'session', ordered: true },
  chat: { label: 'chat', ordered: true },
  file: { label: 'file', ordered: true },
} as const;

/** Normalised coordinate in [0, 1] relative to the shared screen. */
const N = z.number().min(0).max(1);

export const GlobalAction = z.enum(['back', 'home', 'recents', 'notifications', 'quickSettings', 'lockScreen']);
export type GlobalAction = z.infer<typeof GlobalAction>;

export const EditKey = z.enum(['Backspace', 'Enter', 'Delete', 'SelectAll', 'Copy', 'Paste', 'Cut']);
export type EditKey = z.infer<typeof EditKey>;

export const ControlMessage = z.discriminatedUnion('t', [
  /** Pointer down / move / up. One stroke per pointer id. */
  z.object({ t: z.literal('pd'), id: z.number().int(), x: N, y: N, ts: z.number() }),
  z.object({ t: z.literal('pm'), id: z.number().int(), x: N, y: N, ts: z.number() }),
  z.object({ t: z.literal('pu'), id: z.number().int(), x: N, y: N, ts: z.number() }),
  /** Wheel scroll, translated into a short swipe on the device. dx/dy in screen fractions. */
  z.object({ t: z.literal('scroll'), x: N, y: N, dx: z.number(), dy: z.number() }),
  z.object({ t: z.literal('global'), action: GlobalAction }),
  z.object({ t: z.literal('text'), text: z.string().max(4096) }),
  z.object({ t: z.literal('edit'), key: EditKey }),
]);
export type ControlMessage = z.infer<typeof ControlMessage>;

export const QualityPreset = z.enum(['high', 'medium', 'low']);
export type QualityPreset = z.infer<typeof QualityPreset>;

/** Selected by the user on the desktop: a fixed preset or adaptive. */
export const QualityMode = z.enum(['auto', 'high', 'medium', 'low']);
export type QualityMode = z.infer<typeof QualityMode>;

/** Ordered from best to most conservative. Mirrored in WebRtcSession.PRESETS (Kotlin). */
export const QUALITY_LADDER: QualityPreset[] = ['high', 'medium', 'low'];

/** maxLongSide: the capture's longest side in px (the phone may be portrait or landscape). */
export const QualityProfiles: Record<QualityPreset, { maxLongSide: number; fps: number; maxBitrate: number }> = {
  high: { maxLongSide: 1920, fps: 60, maxBitrate: 8_000_000 },
  medium: { maxLongSide: 1280, fps: 30, maxBitrate: 2_500_000 },
  low: { maxLongSide: 960, fps: 24, maxBitrate: 800_000 },
};

export const SessionChannelMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('screen'), w: z.number().int(), h: z.number().int(), rotation: z.number().int() }),
  z.object({ t: z.literal('quality'), preset: QualityPreset }),
  z.object({
    t: z.literal('quality-applied'),
    preset: QualityPreset,
    w: z.number().int(),
    h: z.number().int(),
    fps: z.number(),
    maxBitrate: z.number(),
  }),
  z.object({ t: z.literal('hb'), ts: z.number() }),
  /** Phone -> desktop, every second: the sender's view of the link (WebRTC bandwidth estimate). */
  z.object({
    t: z.literal('sender-stats'),
    availableBitrate: z.number().nullable(),
    rttMs: z.number().nullable(),
    encodeFps: z.number().nullable(),
    qualityLimitation: z.string().nullable(),
  }),
  z.object({ t: z.literal('a11y'), enabled: z.boolean() }),
  z.object({ t: z.literal('end'), reason: z.enum(['user', 'revoked', 'expired', 'error', 'lost']) }),
]);
export type SessionChannelMessage = z.infer<typeof SessionChannelMessage>;

/** Chat (label "chat"): a message and its delivery receipt. */
export const ChatFrame = z.discriminatedUnion('t', [
  z.object({ t: z.literal('msg'), id: z.string().max(64), text: z.string().min(1).max(8000), ts: z.number() }),
  z.object({ t: z.literal('ack'), id: z.string().max(64) }),
]);
export type ChatFrame = z.infer<typeof ChatFrame>;

/**
 * File transfer (label "file"). JSON frames control the transfer; data travels as binary frames
 * of at most FILE_FRAME_BYTES: the 16 raw bytes of the transfer id followed by the payload.
 *
 *   sender: offer ->            receiver: accept | reject
 *   sender: binary chunks..., done{sha256} -> receiver: ack{ok}   (either side may cancel)
 */
export const FILE_FRAME_BYTES = 16 * 1024;
export const FILE_ID_BYTES = 16;
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

const TransferId = z.string().regex(/^[a-f0-9]{32}$/);

export const FileFrame = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('offer'),
    id: TransferId,
    name: z.string().min(1).max(255),
    size: z.number().int().min(0).max(MAX_FILE_BYTES),
    mime: z.string().max(255),
  }),
  z.object({ t: z.literal('accept'), id: TransferId }),
  z.object({ t: z.literal('reject'), id: TransferId, reason: z.string().max(200) }),
  z.object({ t: z.literal('done'), id: TransferId, sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ t: z.literal('ack'), id: TransferId, ok: z.boolean() }),
  z.object({ t: z.literal('cancel'), id: TransferId, reason: z.string().max(200) }),
]);
export type FileFrame = z.infer<typeof FileFrame>;

/**
 * Reduces a file name received from the peer to a safe base name: no directories, no control or
 * reserved characters, no Windows device names, no leading dots.
 */
export function safeFileName(name: string): string {
  let n = name.split(/[/\\]/).pop() ?? '';
  n = n.replace(/[\u0000-\u001f<>:"|?*\u007f]/g, '_').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = '_' + n;
  return n.slice(0, 200) || 'arquivo';
}
