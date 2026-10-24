import { describe, expect, it } from 'vitest';
import {
  chooseAccessKey,
  choosePort,
  generateAccessKey,
  headsetLink,
  isNetworkBlocked,
  isTunnelConnected,
  tunnelUrlIn,
  webLaunchLink,
} from '../live-lib';

describe('chooseAccessKey', () => {
  const generate = () => 'generated-key';

  it('reuses CLIO_ACCESS_KEY from the environment first, then from .env', () => {
    expect(
      chooseAccessKey({ CLIO_ACCESS_KEY: ' env-key ' }, { CLIO_ACCESS_KEY: 'file' }, generate),
    ).toEqual({ key: 'env-key', from: 'environment' });
    expect(chooseAccessKey({}, { CLIO_ACCESS_KEY: 'file-key' }, generate)).toEqual({
      key: 'file-key',
      from: '.env',
    });
  });

  it('generates one when neither has a non-blank key (a public URL always gets one)', () => {
    expect(chooseAccessKey({ CLIO_ACCESS_KEY: '' }, { CLIO_ACCESS_KEY: '  ' }, generate)).toEqual({
      key: 'generated-key',
      from: 'generated',
    });
  });
});

describe('generateAccessKey', () => {
  it('makes 16 URL-safe characters (96 random bits), different every time', () => {
    const key = generateAccessKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(generateAccessKey()).not.toBe(key);
  });
});

describe('choosePort', () => {
  it('takes --port, then CLIO_SERVER_PORT from the environment, then .env, then 8787', () => {
    expect(choosePort('8790', { CLIO_SERVER_PORT: '9000' }, {})).toBe(8790);
    expect(choosePort(undefined, { CLIO_SERVER_PORT: '9000' }, { CLIO_SERVER_PORT: '9100' })).toBe(
      9000,
    );
    expect(choosePort(undefined, {}, { CLIO_SERVER_PORT: '9100' })).toBe(9100);
    expect(choosePort(undefined, { CLIO_SERVER_PORT: '' }, {})).toBe(8787);
  });

  it('refuses a port that is not one, saying where it came from', () => {
    expect(() => choosePort('http', {}, {})).toThrow(/--port/);
    expect(() => choosePort(undefined, { CLIO_SERVER_PORT: '70000' }, {})).toThrow(
      /CLIO_SERVER_PORT/,
    );
  });
});

describe('tunnelUrlIn', () => {
  it('finds the quick tunnel URL in cloudflared output', () => {
    expect(
      tunnelUrlIn(
        '2026-10-24T07:00:00Z INF |  https://brave-otter-sails-quietly.trycloudflare.com      |',
      ),
    ).toBe('https://brave-otter-sails-quietly.trycloudflare.com');
  });

  it('ignores the trycloudflare API and lines without a URL', () => {
    expect(
      tunnelUrlIn(
        'ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF',
      ),
    ).toBeNull();
    expect(tunnelUrlIn('INF Requesting new quick Tunnel on trycloudflare.com...')).toBeNull();
  });
});

describe('isNetworkBlocked', () => {
  it("spots cloudflared's verdict that this network blocks its edge (port 7844)", () => {
    expect(
      isNetworkBlocked(
        '2026-10-24T07:17:42Z INF precheck complete hard_fail=true run_id=404749c6-0a2a-4579-bbeb-7cadbba0373b',
      ),
    ).toBe(true);
    expect(isNetworkBlocked('INF precheck complete hard_fail=false run_id=1')).toBe(false);
    expect(
      isNetworkBlocked(
        'INF precheck component="UDP Connectivity" details="QUIC connection failed" status=fail',
      ),
    ).toBe(false);
  });
});

describe('isTunnelConnected', () => {
  it('spots the line cloudflared logs once the edge accepts the tunnel', () => {
    expect(
      isTunnelConnected(
        '2026-10-24T07:00:02Z INF Registered tunnel connection connIndex=0 connection=abc event=0 ip=198.41.200.13 location=sjc01 protocol=quic',
      ),
    ).toBe(true);
    expect(isTunnelConnected('INF Starting metrics server on 127.0.0.1:20241/metrics')).toBe(false);
  });
});

describe('links', () => {
  it('puts the access key in the headset link, encoded', () => {
    expect(headsetLink('https://a-b.trycloudflare.com', 'k+y/=')).toBe(
      'https://a-b.trycloudflare.com/?key=k%2By%2F%3D',
    );
  });

  it("wraps it in Meta's Web Launch link, which opens it in Quest Browser from a phone", () => {
    expect(webLaunchLink('https://a-b.trycloudflare.com/?key=abc')).toBe(
      'https://www.oculus.com/open_url/?url=https%3A%2F%2Fa-b.trycloudflare.com%2F%3Fkey%3Dabc',
    );
  });
});
