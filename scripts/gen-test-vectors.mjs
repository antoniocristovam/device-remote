// Generates cross-language test vectors from the TypeScript reference implementation.
// Output is consumed by the Kotlin unit tests (apps/android-app/android/app/src/test/resources).
// Usage: node scripts/gen-test-vectors.mjs   (after `npm run build:packages`)
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cp from '../packages/crypto-proto/dist/index.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'apps/android-app/android/app/src/test/resources/vectors.json');

const code = '0123456789ABCDEF';
const desktop = await cp.createEphemeralSigner();
const nonceA = 'AAAAAAAAAAAAAAAAAAAAAA';
const offer = await cp.buildPairOffer(code, nonceA, desktop, 'Desk PC');
const channelId = 'c'.repeat(32);
const sessReq = await cp.buildSessionRequest(channelId, desktop, 1_700_000_000_000);
const sdp = 'v=0\r\na=fingerprint:sha-256 AB:CD:EF\r\n';
const sdpMsg = await cp.signSdp('sid-1', 'desktop', 'answer', sdp, desktop);
const resume = await cp.buildSessionResume(channelId, 'sid-1', desktop, 1_700_000_000_000);

const vectors = {
  transcriptHex: cp.toHex(cp.transcript('ab', 'c', 42)),
  code,
  room: await cp.pairingRoom(code),
  keyHex: cp.toHex(await cp.pairingKey(code)),
  qr: cp.encodeQr({ s: 'ws://192.168.0.10:8787', c: code, f: await cp.fingerprint(desktop.publicKey), n: 'Desk PC' }),
  desktopPub: cp.toB64u(desktop.publicKey),
  desktopFp: await cp.fingerprint(desktop.publicKey),
  nonceA,
  offer: offer.msg,
  sas: await cp.pairingSas(offer.fields),
  channelId,
  sessReq,
  sessReqNow: 1_700_000_000_000,
  sdpMsg,
  resume,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(vectors, null, 2));
console.log('wrote', out);
