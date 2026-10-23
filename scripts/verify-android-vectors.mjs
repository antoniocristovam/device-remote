// Verifies messages signed by the Kotlin implementation (written by InteropTest.writesAndroidVectors)
// with the TypeScript reference. Usage: node scripts/verify-android-vectors.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cp from '../packages/crypto-proto/dist/index.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const v = JSON.parse(readFileSync(join(root, 'apps/android-app/android/app/src/test/resources/vectors.json'), 'utf8'));
const a = JSON.parse(readFileSync(join(root, 'apps/android-app/android/app/build/interop/android-vectors.json'), 'utf8'));

const offerFields = { nonceA: v.nonceA, nonceD: v.offer.nonceD, desktopPub: v.offer.desktopPub, desktopName: v.offer.desktopName };
const fields = { ...offerFields, androidPub: a.accept.androidPub, androidName: a.accept.androidName, channelId: a.accept.channelId };

// verifyPairAccept needs the desktop signer only to produce pair.done; verify MAC + signature by hand here.
const key = await cp.pairingKey(v.code);
const { hmacSha256, transcript, fromB64u, timingSafeEqual, verifySignature, pairSigData } = cp;
const mac = await hmacSha256(key, transcript('rc/pair-accept/v1', fields.nonceA, fields.nonceD, fields.desktopPub, fields.desktopName, fields.androidPub, fields.androidName, fields.channelId));
const checks = {
  acceptMac: timingSafeEqual(mac, fromB64u(a.accept.mac)),
  acceptSig: await verifySignature(fromB64u(a.androidPub), pairSigData('android', fields), fromB64u(a.accept.sig)),
  fingerprint: (await cp.fingerprint(fromB64u(a.androidPub))) === a.androidFp,
  sessAccept: await cp.verifySessionAccept(v.channelId, a.nonceD, a.androidPub, { desktopFp: v.desktopFp, androidFp: a.androidFp }, a.sessAccept),
  sdp: await cp.verifySdp(a.androidPub, 'android', a.sdp),
};
console.log(checks);
if (Object.values(checks).some((ok) => !ok)) process.exit(1);
console.log('Kotlin -> TypeScript interop OK');
