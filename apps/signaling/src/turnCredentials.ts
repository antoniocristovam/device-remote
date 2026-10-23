import { createHmac } from 'node:crypto';
import type { IceServer } from '@rc/protocol';

export interface TurnConfig {
  /** Shared secret configured in coturn as `static-auth-secret` (use-auth-secret mode). */
  secret?: string;
  /** e.g. ["turn:turn.example.com:3478?transport=udp", "turns:turn.example.com:5349?transport=tcp"] */
  urls: string[];
  stunUrls: string[];
  ttlSeconds: number;
}

/**
 * Ephemeral TURN credentials per the "TURN REST API" draft that coturn implements:
 * username = "<expiry-unix>:<label>", credential = base64(HMAC-SHA1(secret, username)).
 * Nothing long-lived ever reaches clients.
 */
export function issueIceServers(cfg: TurnConfig, label: string, now = Date.now()): { iceServers: IceServer[]; ttl: number } {
  const iceServers: IceServer[] = [];
  if (cfg.stunUrls.length) iceServers.push({ urls: cfg.stunUrls });
  if (cfg.secret && cfg.urls.length) {
    const username = `${Math.floor(now / 1000) + cfg.ttlSeconds}:${label}`;
    const credential = createHmac('sha1', cfg.secret).update(username).digest('base64');
    iceServers.push({ urls: cfg.urls, username, credential });
  }
  return { iceServers, ttl: cfg.ttlSeconds };
}
