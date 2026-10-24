import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, REPO_ROOT } from '../src/config';
import { tempDir } from './harness';

describe('loadConfig', () => {
  it('uses defaults rooted at the repo, not the working directory', () => {
    expect(loadConfig({}, '/repo')).toEqual({
      port: 8787,
      // Only the local Vite proxy talks to the server, so it never needs the LAN (which would
      // expose the Gemini relay, and the key's quota, to anyone on the venue Wi-Fi).
      host: '127.0.0.1',
      dataDir: '/repo/data',
      proceduresDir: '/repo/procedures',
      // /repo/apps/headset/dist does not exist: nothing is built, so nothing is served.
      staticDir: null,
      accessKey: null,
      geminiApiKey: null,
      liveModel: 'gemini-3.8-live',
      plannerModel: 'gemini-3.5-flash-lite',
      visionModel: 'gemini-3.5-flash-lite',
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
        CLIO_DATA_DIR: '',
      },
      '/repo',
    );
    expect(config.port).toBe(8787);
    expect(config.geminiApiKey).toBeNull();
    expect(config.liveModel).toBe('gemini-3.8-live');
    expect(config.plannerModel).toBe('gemini-3.5-flash-lite');
    expect(config.visionModel).toBe('gemini-3.5-flash-lite');
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

  it('reads an access key; blank means no gate', () => {
    expect(loadConfig({ CLIO_ACCESS_KEY: ' s3cret ' }, '/repo').accessKey).toBe('s3cret');
    expect(loadConfig({ CLIO_ACCESS_KEY: '  ' }, '/repo').accessKey).toBeNull();
  });
});

describe('loadConfig: the built headset app', () => {
  it('serves apps/headset/dist by default once it has been built', async () => {
    const repo = await tempDir();
    expect(loadConfig({}, repo).staticDir).toBeNull();
    await mkdir(join(repo, 'apps', 'headset', 'dist'), { recursive: true });
    expect(loadConfig({}, repo).staticDir).toBe(join(repo, 'apps', 'headset', 'dist'));
  });

  it('reads CLIO_STATIC_DIR against the repo root', async () => {
    const repo = await tempDir();
    await mkdir(join(repo, 'web'));
    expect(loadConfig({ CLIO_STATIC_DIR: 'web' }, repo).staticDir).toBe(join(repo, 'web'));
    expect(loadConfig({ CLIO_STATIC_DIR: join(repo, 'web') }, '/repo').staticDir).toBe(
      join(repo, 'web'),
    );
  });

  it('refuses a CLIO_STATIC_DIR that is not a directory, naming the variable', async () => {
    const repo = await tempDir();
    await writeFile(join(repo, 'file.txt'), 'not a directory');
    expect(() => loadConfig({ CLIO_STATIC_DIR: 'missing' }, repo)).toThrow(/CLIO_STATIC_DIR/);
    expect(() => loadConfig({ CLIO_STATIC_DIR: 'file.txt' }, repo)).toThrow(/CLIO_STATIC_DIR/);
  });
});

describe('REPO_ROOT', () => {
  it('is the workspace root', () => {
    expect(existsSync(join(REPO_ROOT, 'pnpm-workspace.yaml'))).toBe(true);
  });
});
