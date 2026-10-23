import { startSignalingServer } from './server.js';

const env = (k: string, d?: string) => process.env[k] ?? d;
const list = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

const server = await startSignalingServer({
  port: Number(env('PORT', '8787')),
  turn: {
    secret: env('TURN_SECRET'),
    urls: list(env('TURN_URLS')),
    stunUrls: list(env('STUN_URLS', 'stun:stun.l.google.com:19302')),
    ttlSeconds: Number(env('TURN_TTL', '600')),
  },
  log: (m) => console.log(new Date().toISOString(), m),
});
console.log(`signaling listening on :${server.port()}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => void server.close().then(() => process.exit(0)));
}
