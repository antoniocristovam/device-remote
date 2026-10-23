// Headless desktop for testing the Android app without Electron.
// Implements the desktop role of pairing + session handshake with the TypeScript reference.
//
//   node scripts/fake-desktop.mjs pair    [ws://localhost:8787]   -> prints a pairing code, waits for the phone
//   node scripts/fake-desktop.mjs session [ws://localhost:8787]   -> requests a session from the paired phone
//
// The paired phone and the desktop identity are kept in .fake-desktop.json (test keys only).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';
import * as cp from '../packages/crypto-proto/dist/index.js';

const [mode = 'pair', url = 'ws://localhost:8787'] = process.argv.slice(2);
const STATE = '.fake-desktop.json';
const subtle = globalThis.crypto.subtle;
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

async function identity() {
  const s = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
  if (!s.pkcs8) {
    const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    s.pkcs8 = cp.toB64u(new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey)));
    s.spki = cp.toB64u(new Uint8Array(await subtle.exportKey('spki', pair.publicKey)));
    writeFileSync(STATE, JSON.stringify(s, null, 2));
  }
  const privateKey = await subtle.importKey('pkcs8', cp.fromB64u(s.pkcs8), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const publicKey = await subtle.importKey('spki', cp.fromB64u(s.spki), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  return { state: s, signer: await cp.signerFromKeyPair({ privateKey, publicKey }) };
}

const { state, signer } = await identity();
const fp = await cp.fingerprint(signer.publicKey);
const ws = new WebSocket(url);
const send = (m) => ws.send(JSON.stringify(m));
const exit = (code) => setTimeout(() => process.exit(code), 300);
await new Promise((r) => ws.once('open', r));
log('connected to', url, 'as', cp.shortFingerprint(fp));

if (mode === 'pair') {
  const code = cp.generatePairingCode();
  const room = await cp.pairingRoom(code);
  let offer;
  send({ t: 'join', room, role: 'desktop' });
  log('PAIRING CODE', cp.formatPairingCode(code));
  log('QR', cp.encodeQr({ s: url, c: code, f: fp, n: 'Fake Desktop' }));
  ws.on('message', async (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t !== 'relay') return log('<-', m.t, m.role ?? m.code ?? '');
    const d = m.data;
    log('<- relay', d.k);
    if (d.k === 'pair.req') {
      offer = await cp.buildPairOffer(code, d.nonceA, signer, 'Fake Desktop');
      send({ t: 'relay', room, data: offer.msg });
      log('SAS', await cp.pairingSas(offer.fields));
    } else if (d.k === 'pair.accept') {
      const r = await cp.verifyPairAccept(code, offer.fields, d, signer);
      if (!r) {
        log('ACCEPT VERIFICATION FAILED');
        return exit(1);
      }
      send({ t: 'relay', room, data: r.done });
      writeFileSync(STATE, JSON.stringify({ ...state, peer: r.peer }, null, 2));
      log('PAIRED with', r.peer.name, cp.shortFingerprint(r.peer.fingerprint));
      exit(0);
    } else if (d.k === 'pair.reject') {
      log('REJECTED by phone');
      exit(2);
    }
  });
} else {
  const peer = state.peer;
  if (!peer) throw new Error('pair first');
  let nonceD;
  let sid;
  send({ t: 'join', room: peer.channelId, role: 'desktop' });
  const request = async () => {
    const req = await cp.buildSessionRequest(peer.channelId, signer);
    nonceD = req.nonceD;
    send({ t: 'relay', room: peer.channelId, data: req });
    log('-> sess.req (waiting for consent on the phone)');
  };
  ws.on('message', async (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === 'joined') return m.peers.includes('android') ? request() : log('phone not available yet');
    if (m.t === 'peer-joined' && m.role === 'android') return request();
    if (m.t !== 'relay') return log('<-', m.t, m.role ?? m.code ?? '');
    const d = m.data;
    if (d.k === 'sess.accept') {
      const ok = await cp.verifySessionAccept(peer.channelId, nonceD, peer.publicKey, { desktopFp: fp, androidFp: peer.fingerprint }, d);
      sid = d.token.sid;
      log('<- sess.accept verified:', ok, 'sid', sid.slice(0, 8));
    } else if (d.k === 'sdp') {
      const ok = await cp.verifySdp(peer.publicKey, 'android', d);
      const video = /m=video/.test(d.sdp);
      const channels = /m=application/.test(d.sdp);
      log('<- sdp', d.type, 'signature ok:', ok, 'video:', video, 'datachannels:', channels);
      log('ending session in 25s');
      setTimeout(() => {
        send({ t: 'relay', room: peer.channelId, data: { k: 'sess.end', sid, reason: 'user' } });
        log('-> sess.end');
        exit(ok && video ? 0 : 1);
      }, 25000);
    } else if (d.k === 'ice') {
      // not answering: no WebRTC stack in this script
    } else {
      log('<- relay', d.k, d.reason ?? '');
      if (d.k === 'sess.deny' || d.k === 'sess.end') exit(2);
    }
  });
}
