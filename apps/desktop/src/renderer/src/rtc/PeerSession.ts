import { ChatFrame, Channels, ControlMessage, FILE_ID_BYTES, FileFrame, SessionChannelMessage, type IceServer } from '@rc/protocol';
import { rc } from '@/rc';
import type { Transport } from '../../../shared/api';

export interface LinkStats {
  rttMs?: number;
  fps?: number;
  bitrateKbps?: number;
  jitterMs?: number;
  packetLossPct?: number;
  /** Average time frames spent in the jitter buffer — the part of latency we control here. */
  jitterBufferMs?: number;
  width?: number;
  height?: number;
  relayed?: boolean;
  /** From the phone (sender-stats): WebRTC bandwidth estimate, bit/s. */
  senderBitrate?: number | null;
  qualityLimitation?: string | null;
}

/** Chat/file listeners, attached by the chat panel after the session exists. */
export interface PeerDataHandlers {
  chat?(f: ChatFrame): void;
  file?(f: FileFrame): void;
  fileChunk?(id: string, data: Uint8Array): void;
  channelState?(label: string, open: boolean): void;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export interface PeerSessionEvents {
  onStream(stream: MediaStream): void;
  onConnection(state: RTCPeerConnectionState): void;
  onStats(s: LinkStats): void;
  onSessionMessage(m: SessionChannelMessage): void;
  /** The "session" channel opened: the phone is ready for quality commands. */
  onSessionOpen?(): void;
}

/**
 * Desktop half of the WebRTC link. The phone is the offerer (it owns the media and creates the
 * data channels); we answer. Signed SDP/ICE travel through the main process.
 */
export class PeerSession {
  private pc: RTCPeerConnection;
  private channels = new Map<string, RTCDataChannel>();
  private pendingIce: RTCIceCandidateInit[] = [];
  private statsTimer: number;
  private lastBytes?: { bytes: number; ts: number };
  private lastPackets?: { lost: number; recv: number; jbDelay: number; jbCount: number };
  private sender?: Extract<SessionChannelMessage, { t: 'sender-stats' }>;
  handlers: PeerDataHandlers = {};

  constructor(
    private readonly fingerprint: string,
    iceServers: IceServer[],
    transport: Transport,
    private readonly ev: PeerSessionEvents,
  ) {
    // Over the USB cable the only path is the desktop's local TURN relay, reached by the phone through adb.
    this.pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle', iceTransportPolicy: transport === 'usb' ? 'relay' : 'all' });
    this.pc.onicecandidate = (e) => {
      if (e.candidate?.candidate) {
        void rc.session.sendIce(fingerprint, { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex });
      }
    };
    this.pc.ontrack = (e) => {
      // Latency over smoothness: ask Chromium to play frames as soon as they are decodable.
      const r = e.receiver as RTCRtpReceiver & { jitterBufferTarget?: number; playoutDelayHint?: number };
      try {
        r.jitterBufferTarget = 0;
      } catch {
        r.playoutDelayHint = 0;
      }
      ev.onStream(e.streams[0] ?? new MediaStream([e.track]));
    };
    this.pc.onconnectionstatechange = () => ev.onConnection(this.pc.connectionState);
    this.pc.ondatachannel = (e) => {
      const ch = e.channel;
      this.channels.set(ch.label, ch);
      ch.binaryType = 'arraybuffer';
      ch.onopen = () => this.handlers.channelState?.(ch.label, true);
      ch.onclose = () => this.handlers.channelState?.(ch.label, false);
      if (ch.label === Channels.chat.label) ch.onmessage = (m) => this.onJson(m, ChatFrame, (f) => this.handlers.chat?.(f));
      if (ch.label === Channels.file.label) {
        ch.bufferedAmountLowThreshold = 1 << 20;
        ch.onmessage = (m) => {
          if (m.data instanceof ArrayBuffer) {
            const bytes = new Uint8Array(m.data);
            if (bytes.length > FILE_ID_BYTES) this.handlers.fileChunk?.(hex(bytes.subarray(0, FILE_ID_BYTES)), bytes.subarray(FILE_ID_BYTES));
          } else {
            this.onJson(m, FileFrame, (f) => this.handlers.file?.(f));
          }
        };
      }
      if (ch.label === Channels.session.label) {
        const open = () => ev.onSessionOpen?.();
        if (ch.readyState === 'open') open();
        else ch.addEventListener('open', open, { once: true });
        ch.onmessage = (m) => {
          try {
            const r = SessionChannelMessage.safeParse(JSON.parse(String(m.data)));
            if (!r.success) return;
            if (r.data.t === 'sender-stats') this.sender = r.data;
            ev.onSessionMessage(r.data);
          } catch {
            /* ignore */
          }
        };
      }
    };
    this.statsTimer = window.setInterval(() => void this.collectStats(), 1000);
  }

  /**
   * Answer with H.264 first: phones encode it in hardware without the forced key frame every 15 s
   * that libwebrtc applies to Qualcomm's VP8 encoder (a frame-rate dip each time). VP8 and the rest
   * stay as fallbacks; the answer only keeps codecs the phone offered.
   */
  private preferH264() {
    const caps = RTCRtpReceiver.getCapabilities('video')?.codecs;
    if (!caps) return;
    const rank = (c: RTCRtpCodec) => {
      if (c.mimeType === 'video/H264') return c.sdpFmtpLine?.includes('packetization-mode=1') ? 0 : 1;
      if (c.mimeType === 'video/VP8') return 2;
      return 3;
    };
    const ordered = [...caps].sort((a, b) => rank(a) - rank(b));
    for (const t of this.pc.getTransceivers()) {
      if (t.receiver.track.kind !== 'video') continue;
      try {
        t.setCodecPreferences(ordered);
      } catch {
        /* keep the default order */
      }
    }
  }

  async handleOffer(sdp: string) {
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    this.preferH264();
    for (const c of this.pendingIce.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await rc.session.sendAnswer(this.fingerprint, this.pc.localDescription!.sdp);
  }

  async addIce(c: RTCIceCandidateInit) {
    if (!this.pc.remoteDescription) this.pendingIce.push(c);
    else await this.pc.addIceCandidate(c).catch(() => {});
  }

  /** Moves go over the lossy channel; everything discrete must arrive, in order. */
  send(m: ControlMessage) {
    const label = m.t === 'pm' ? Channels.control.label : Channels.controlReliable.label;
    const ch = this.channels.get(label) ?? this.channels.get(Channels.controlReliable.label);
    if (ch?.readyState === 'open') ch.send(JSON.stringify(m));
  }

  private onJson<T>(m: MessageEvent, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, cb: (v: T) => void) {
    if (typeof m.data !== 'string') return;
    try {
      const r = schema.safeParse(JSON.parse(m.data));
      if (r.success) cb(r.data);
    } catch {
      /* ignore malformed */
    }
  }

  isOpen(label: string) {
    return this.channels.get(label)?.readyState === 'open';
  }

  sendChat(f: ChatFrame) {
    const ch = this.channels.get(Channels.chat.label);
    if (ch?.readyState !== 'open') return false;
    ch.send(JSON.stringify(f));
    return true;
  }

  sendFileFrame(f: FileFrame) {
    const ch = this.channels.get(Channels.file.label);
    if (ch?.readyState !== 'open') return false;
    ch.send(JSON.stringify(f));
    return true;
  }

  /** Sends one binary frame, waiting first while more than 4 MB is queued (backpressure). */
  async sendFileChunk(frame: Uint8Array) {
    const ch = this.channels.get(Channels.file.label);
    if (ch?.readyState !== 'open') throw new Error('file channel closed');
    if (ch.bufferedAmount > 4 << 20) {
      await new Promise<void>((resolve, reject) => {
        ch.addEventListener('bufferedamountlow', () => resolve(), { once: true });
        ch.addEventListener('close', () => reject(new Error('file channel closed')), { once: true });
      });
    }
    ch.send(frame as Uint8Array<ArrayBuffer>);
  }

  sendSession(m: SessionChannelMessage) {
    const ch = this.channels.get(Channels.session.label);
    if (ch?.readyState === 'open') ch.send(JSON.stringify(m));
  }

  private async collectStats() {
    const report = await this.pc.getStats().catch(() => null);
    if (!report) return;
    const s: LinkStats = {};
    let selectedPair: string | undefined;
    const candidates = new Map<string, { candidateType?: string }>();
    report.forEach((r: any) => {
      if (r.type === 'transport' && r.selectedCandidatePairId) selectedPair = r.selectedCandidatePairId;
      if (r.type === 'local-candidate' || r.type === 'remote-candidate') candidates.set(r.id, r);
    });
    report.forEach((r: any) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') {
        s.fps = r.framesPerSecond;
        s.width = r.frameWidth;
        s.height = r.frameHeight;
        s.jitterMs = r.jitter != null ? r.jitter * 1000 : undefined;
        // Loss and jitter-buffer delay over the last interval: session-wide averages would hide congestion.
        const cur = { lost: r.packetsLost ?? 0, recv: r.packetsReceived ?? 0, jbDelay: r.jitterBufferDelay ?? 0, jbCount: r.jitterBufferEmittedCount ?? 0 };
        const prev = this.lastPackets ?? { lost: 0, recv: 0, jbDelay: 0, jbCount: 0 };
        const dLost = Math.max(0, cur.lost - prev.lost);
        const dRecv = Math.max(0, cur.recv - prev.recv);
        s.packetLossPct = dRecv + dLost > 0 ? (dLost / (dRecv + dLost)) * 100 : 0;
        const dCount = cur.jbCount - prev.jbCount;
        if (dCount > 0) s.jitterBufferMs = ((cur.jbDelay - prev.jbDelay) / dCount) * 1000;
        this.lastPackets = cur;
        if (this.lastBytes) {
          const dt = (r.timestamp - this.lastBytes.ts) / 1000;
          if (dt > 0) s.bitrateKbps = ((r.bytesReceived - this.lastBytes.bytes) * 8) / dt / 1000;
        }
        this.lastBytes = { bytes: r.bytesReceived, ts: r.timestamp };
      }
      if (r.type === 'candidate-pair' && (r.id === selectedPair || (!selectedPair && r.nominated && r.state === 'succeeded'))) {
        if (r.currentRoundTripTime != null) s.rttMs = r.currentRoundTripTime * 1000;
        s.relayed = candidates.get(r.localCandidateId)?.candidateType === 'relay' || candidates.get(r.remoteCandidateId)?.candidateType === 'relay';
      }
    });
    if (this.sender) {
      s.senderBitrate = this.sender.availableBitrate;
      s.qualityLimitation = this.sender.qualityLimitation;
    }
    if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) this.logDiagnostics(report, s);
    this.ev.onStats(s);
  }

  private diagPrev: Record<string, number> = {};
  /** Dev only: one line per second per device in the terminal (electron-vite forwards warnings, not info). */
  private logDiagnostics(report: RTCStatsReport, s: LinkStats) {
    let v: any;
    let codec = '';
    report.forEach((r: any) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') v = r;
    });
    if (!v) return;
    report.forEach((r: any) => {
      if (r.type === 'codec' && r.id === v.codecId) codec = String(r.mimeType).replace('video/', '');
    });
    const keys = ['framesReceived', 'framesDecoded', 'framesDropped', 'freezeCount', 'totalFreezesDuration', 'totalDecodeTime', 'totalInterFrameDelay', 'nackCount', 'pliCount', 'keyFramesDecoded', 'totalProcessingDelay', 'totalAssemblyTime', 'framesAssembledFromMultiplePackets'];
    const d: any = {};
    for (const k of keys) {
      d[k] = (v[k] ?? 0) - (this.diagPrev[k] ?? 0);
      this.diagPrev[k] = v[k] ?? 0;
    }
    const per = (x: number) => (d.framesDecoded > 0 ? ((x / d.framesDecoded) * 1000).toFixed(1) : '-');
    console.warn(
      `[diag ${this.fingerprint.slice(0, 6)}] ${codec} ${v.frameWidth}x${v.frameHeight} recv=${d.framesReceived} dec=${d.framesDecoded} drop=${d.framesDropped} ` +
        `freeze=${d.freezeCount}/${(d.totalFreezesDuration * 1000).toFixed(0)}ms decode=${per(d.totalDecodeTime)}ms proc=${per(d.totalProcessingDelay)}ms ` +
        `asm=${d.framesAssembledFromMultiplePackets > 0 ? ((d.totalAssemblyTime / d.framesAssembledFromMultiplePackets) * 1000).toFixed(1) : '-'}ms ` +
        `jb=${s.jitterBufferMs?.toFixed(0) ?? '-'}ms rtt=${s.rttMs?.toFixed(0) ?? '-'} kbps=${s.bitrateKbps?.toFixed(0) ?? '-'} loss=${s.packetLossPct?.toFixed(1)} ` +
        `nack=${d.nackCount} pli=${d.pliCount} key=${d.keyFramesDecoded} | phone: enc=${this.sender?.encodeFps?.toFixed(0) ?? '-'}fps bwe=${s.senderBitrate != null ? (s.senderBitrate / 1000).toFixed(0) : '-'}k lim=${s.qualityLimitation ?? '-'}`,
    );
  }

  close() {
    window.clearInterval(this.statsTimer);
    for (const ch of this.channels.values()) ch.close();
    this.pc.close();
  }
}
