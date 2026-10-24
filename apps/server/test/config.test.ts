import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, REPO_ROOT } from '../src/config';

describe('loadConfig', () => {
  it('uses defaults rooted at the repo, not the working directory', () => {
    expect(loadConfig({}, '/repo')).toEqual({
      port: 8787,
      // Only the local Vite proxy talks to the server, so it never needs the LAN (which would
      // expose the Gemini relay, and the key's quota, to anyone on the venue Wi-Fi).
      host: '127.0.0.1',
      dataDir: '/repo/data',
      proceduresDir: '/repo/procedures',
      geminiApiKey: null,
      liveModel: 'gemini-3.8-live',
      plannerModel: 'gemini-robotics-er-2-preview',
      visionModel: 'gemini-robotics-er-2-preview',
      judgeModel: 'gemini-pro-latest',
      visionUrl: null,
      visionToken: null,
      relayLog: false,
    });
  });

  it('treats empty values (as in .env.example) as unset', () => {
    const config = loadConfig(
      {
        CLIO_SERVER_PORT: '',
        GEMINI_API_KEY: '   ',
        GEMINI_LIVE_MODEL: '',
        GEMINI_PLANNER_MODEL: '',
        GEMINI_VISION_MODEL: '',
        GEMINI_JUDGE_MODEL: '',
        CLIO_DATA_DIR: '',
      },
      '/repo',
    );
    expect(config.port).toBe(8787);
    expect(config.geminiApiKey).toBeNull();
    expect(config.liveModel).toBe('gemini-3.8-live');
    expect(config.plannerModel).toBe('gemini-robotics-er-2-preview');
    expect(config.visionModel).toBe('gemini-robotics-er-2-preview');
    expect(config.judgeModel).toBe('gemini-pro-latest');
    expect(config.dataDir).toBe('/repo/data');
  });

  it('resolves relative directories against the repo root and keeps absolute ones', () => {
    const config = loadConfig(
      { CLIO_DATA_DIR: './data', CLIO_PROCEDURES_DIR: '/srv/procedures' },
      '/repo',
    );
    expect(config.dataDir).toBe('/repo/data');
    expect(config.proceduresDir).toBe('/srv/procedures');
    expect(loadConfig({ CLIO_DATA_DIR: 'tmp/clio' }, '/repo').dataDir).toBe('/repo/tmp/clio');
  });

  it('reads every override', () => {
    const config = loadConfig(
      {
        CLIO_SERVER_PORT: '9000',
        CLIO_HOST: '0.0.0.0',
        GEMINI_API_KEY: ' secret-key ',
        GEMINI_LIVE_MODEL: 'live-x',
        GEMINI_PLANNER_MODEL: 'planner-x',
        GEMINI_VISION_MODEL: 'vision-x',
        GEMINI_JUDGE_MODEL: 'judge-x',
        CLIO_RELAY_LOG: '1',
      },
      '/repo',
    );
    expect(config).toMatchObject({
      port: 9000,
      host: '0.0.0.0',
      geminiApiKey: 'secret-key',
      liveModel: 'live-x',
      plannerModel: 'planner-x',
      visionModel: 'vision-x',
      judgeModel: 'judge-x',
      relayLog: true,
    });
  });

  it('only enables relay logging for 1 or true', () => {
    expect(loadConfig({ CLIO_RELAY_LOG: 'true' }, '/repo').relayLog).toBe(true);
    expect(loadConfig({ CLIO_RELAY_LOG: '0' }, '/repo').relayLog).toBe(false);
    expect(loadConfig({ CLIO_RELAY_LOG: 'no' }, '/repo').relayLog).toBe(false);
  });

  it('reads an external object finder, which must be an http(s) URL', () => {
    const config = loadConfig(
      { CLIO_VISION_URL: ' http://127.0.0.1:8001/locate ', CLIO_VISION_TOKEN: 'tok' },
      '/repo',
    );
    expect(config.visionUrl).toBe('http://127.0.0.1:8001/locate');
    expect(config.visionToken).toBe('tok');
    expect(loadConfig({ CLIO_VISION_URL: '', CLIO_VISION_TOKEN: '' }, '/repo')).toMatchObject({
      visionUrl: null,
      visionToken: null,
    });
    expect(() => loadConfig({ CLIO_VISION_URL: 'ftp://host/locate' }, '/repo')).toThrow(
      /CLIO_VISION_URL/,
    );
    expect(() => loadConfig({ CLIO_VISION_URL: 'localhost:8001' }, '/repo')).toThrow(
      /CLIO_VISION_URL/,
    );
  });

  it('rejects an invalid port with a message naming the variable', () => {
    expect(() => loadConfig({ CLIO_SERVER_PORT: 'eighty' }, '/repo')).toThrow(/CLIO_SERVER_PORT/);
    expect(() => loadConfig({ CLIO_SERVER_PORT: '70000' }, '/repo')).toThrow(/CLIO_SERVER_PORT/);
  });
});

describe('REPO_ROOT', () => {
  it('is the workspace root', () => {
    expect(existsSync(join(REPO_ROOT, 'pnpm-workspace.yaml'))).toBe(true);
  });
});
