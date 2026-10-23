import { describe, expect, it } from 'vitest';
import { pickLanAddress } from '../src/main/pairing';

const v4 = (address: string) => [{ address, family: 'IPv4', internal: false }];

describe('pickLanAddress', () => {
  it('skips a link-local Tailscale adapter listed before Wi-Fi', () => {
    expect(pickLanAddress({ Tailscale: v4('169.254.83.107'), 'Wi-Fi': v4('192.168.1.224') })).toBe('192.168.1.224');
  });

  it('prefers a physical adapter over VM/VPN ones', () => {
    expect(pickLanAddress({ 'vEthernet (WSL)': v4('172.20.16.1'), Ethernet: v4('10.0.0.5') })).toBe('10.0.0.5');
  });

  it('falls back to a virtual adapter when nothing else exists, never to link-local', () => {
    expect(pickLanAddress({ 'vEthernet (WSL)': v4('172.20.16.1') })).toBe('172.20.16.1');
    expect(pickLanAddress({ Tailscale: v4('169.254.1.1') })).toBeUndefined();
  });
});
