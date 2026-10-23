import { describe, expect, it } from 'vitest';
import {
  buildPairAccept,
  buildPairOffer,
  buildPairRequest,
  buildSessionAccept,
  buildSessionRequest,
  buildSessionResume,
  createEphemeralSigner,
  decodeQr,
  dtlsFingerprints,
  encodeQr,
  fingerprint,
  fromB64u,
  generatePairingCode,
  normalizePairingCode,
  pairingRoom,
  pairingSas,
  signSdp,
  transcript,
  toHex,
  verifyPairAccept,
  verifyPairDone,
  verifyPairOffer,
  verifySdp,
  verifySessionAccept,
  verifySessionRequest,
  verifySessionResume,
  formatPairingCode,
} from '../src/index.js';

const SDP = (fp: string) => `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 ${fp}\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n`;

describe('encoding', () => {
  it('transcript is length-prefixed and unambiguous', () => {
    expect(toHex(transcript('ab', 'c'))).toBe('00000002616200000001' + '63');
    expect(toHex(transcript('a', 'bc'))).not.toBe(toHex(transcript('ab', 'c')));
    expect(toHex(transcript(42))).toBe('000000023432');
  });
});

describe('pairing code', () => {
  it('generates 16 valid chars and normalises user input', () => {
    const c = generatePairingCode();
    expect(c).toHaveLength(16);
    expect(normalizePairingCode(formatPairingCode(c).toLowerCase())).toBe(c);
    expect(normalizePairingCode('oooo-iiii-llll-0000')).toBe('0000111111110000');
    expect(normalizePairingCode('too-short')).toBeNull();
    expect(normalizePairingCode('UUUU-UUUU-UUUU-UUUU')).toBeNull();
  });

  it('round-trips the QR payload', () => {
    const p = { s: 'wss://example.test', c: generatePairingCode(), f: 'ab'.repeat(32), n: 'Meu PC' };
    expect(decodeQr(encodeQr(p))).toEqual(p);
    expect(decodeQr('http://evil')).toBeNull();
  });

  it('derives a stable 32-hex room', async () => {
    const r = await pairingRoom('0123456789ABCDEF');
    expect(r).toMatch(/^[a-f0-9]{32}$/);
    expect(await pairingRoom('0123456789ABCDEF')).toBe(r);
  });
});

describe('pairing handshake', () => {
  async function setup() {
    const desktop = await createEphemeralSigner();
    const android = await createEphemeralSigner();
    const code = generatePairingCode();
    return { desktop, android, code, desktopFp: await fingerprint(desktop.publicKey) };
  }

  it('completes and both sides pin the other key', async () => {
    const { desktop, android, code, desktopFp } = await setup();
    const req = buildPairRequest();
    const offer = await buildPairOffer(code, req.nonceA, desktop, 'PC');
    const offerFields = await verifyPairOffer(code, req.nonceA, offer.msg, desktopFp);
    expect(offerFields).not.toBeNull();
    expect(await pairingSas(offerFields!)).toBe(await pairingSas(offer.fields));

    const accept = await buildPairAccept(code, offerFields!, android, 'Pixel');
    const result = await verifyPairAccept(code, offer.fields, accept.msg, desktop);
    expect(result?.peer.fingerprint).toBe(await fingerprint(android.publicKey));
    expect(result?.peer.channelId).toMatch(/^[a-f0-9]{32}$/);
    expect(await verifyPairDone(accept.fields, result!.done.sig)).toBe(true);
  });

  it('rejects an offer made without the code', async () => {
    const { desktop, code } = await setup();
    const req = buildPairRequest();
    const offer = await buildPairOffer(generatePairingCode(), req.nonceA, desktop, 'Attacker');
    expect(await verifyPairOffer(code, req.nonceA, offer.msg)).toBeNull();
  });

  it('rejects an offer whose key does not match the QR fingerprint', async () => {
    const { code, desktopFp } = await setup();
    const impostor = await createEphemeralSigner();
    const req = buildPairRequest();
    const offer = await buildPairOffer(code, req.nonceA, impostor, 'PC');
    expect(await verifyPairOffer(code, req.nonceA, offer.msg, desktopFp)).toBeNull();
  });

  it('rejects a tampered acceptance', async () => {
    const { desktop, android, code } = await setup();
    const req = buildPairRequest();
    const offer = await buildPairOffer(code, req.nonceA, desktop, 'PC');
    const accept = await buildPairAccept(code, offer.fields, android, 'Pixel');
    const evil = await createEphemeralSigner();
    const swapped = { ...accept.msg, androidPub: Buffer.from(evil.publicKey).toString('base64url') };
    expect(await verifyPairAccept(code, offer.fields, swapped, desktop)).toBeNull();
    expect(await verifyPairAccept(code, offer.fields, { ...accept.msg, androidName: 'Other' }, desktop)).toBeNull();
  });
});

describe('session handshake', () => {
  async function paired() {
    const desktop = await createEphemeralSigner();
    const android = await createEphemeralSigner();
    const ids = { desktopFp: await fingerprint(desktop.publicKey), androidFp: await fingerprint(android.publicKey) };
    const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64url');
    return { desktop, android, ids, desktopPub: b64(desktop.publicKey), androidPub: b64(android.publicKey), channelId: 'c'.repeat(32) };
  }

  it('request -> accept -> signed SDP -> resume', async () => {
    const p = await paired();
    const req = await buildSessionRequest(p.channelId, p.desktop);
    expect(await verifySessionRequest(p.channelId, p.desktopPub, req)).toBe(true);

    const acc = await buildSessionAccept(p.channelId, req.nonceD, p.ids, p.android);
    expect(await verifySessionAccept(p.channelId, req.nonceD, p.androidPub, p.ids, acc)).toBe(true);

    const offer = await signSdp(acc.token.sid, 'android', 'offer', SDP('AA:BB'), p.android);
    expect(await verifySdp(p.androidPub, 'android', offer)).toBe(true);

    const resume = await buildSessionResume(p.channelId, acc.token.sid, p.desktop);
    expect(await verifySessionResume(p.channelId, p.desktopPub, acc.token.sid, resume)).toBe(true);
    expect(await verifySessionResume(p.channelId, p.desktopPub, 'other-sid', resume)).toBe(false);
  });

  it('rejects requests from unpinned keys or replayed outside the skew window', async () => {
    const p = await paired();
    const stranger = await createEphemeralSigner();
    const req = await buildSessionRequest(p.channelId, stranger);
    expect(await verifySessionRequest(p.channelId, p.desktopPub, req)).toBe(false);

    const old = await buildSessionRequest(p.channelId, p.desktop, Date.now() - 10 * 60 * 1000);
    expect(await verifySessionRequest(p.channelId, p.desktopPub, old)).toBe(false);
  });

  it('rejects expired tokens', async () => {
    const p = await paired();
    const req = await buildSessionRequest(p.channelId, p.desktop);
    const acc = await buildSessionAccept(p.channelId, req.nonceD, p.ids, p.android, Date.now() - 13 * 3600_000);
    expect(await verifySessionAccept(p.channelId, req.nonceD, p.androidPub, p.ids, acc)).toBe(false);
  });

  it('rejects an SDP whose DTLS fingerprint was swapped (MITM)', async () => {
    const p = await paired();
    const offer = await signSdp('sid', 'android', 'offer', SDP('AA:BB'), p.android);
    expect(await verifySdp(p.androidPub, 'android', { ...offer, sdp: SDP('CC:DD') })).toBe(false);
    // Role is bound too: a desktop-signed SDP cannot be replayed as the android's.
    expect(await verifySdp(p.androidPub, 'desktop', offer)).toBe(false);
  });

  it('normalises fingerprints', () => {
    expect(dtlsFingerprints('a=fingerprint:SHA-256 AB:CD\r\na=fingerprint:sha-256 ab:cd\n')).toBe('sha-256 ab:cd');
    expect(fromB64u('AQID')).toEqual(new Uint8Array([1, 2, 3]));
  });
});
