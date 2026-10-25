import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CORS_ORIGINS, describeSceneBuilds, loadConfig, REPO_ROOT } from '../src/config';

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
      sceneModel: 'gemini-robotics-er-2-preview',
      judgeModel: 'gemini-pro-latest',
      visionUrl: null,
      visionToken: null,
      primaryFinderUrl: 'http://127.0.0.1:8790/locate',
      relayLog: false,
      // Only the visualizer viewer on this laptop may call /api cross-origin.
      corsOrigins: ['http://127.0.0.1:3001', 'http://localhost:3001'],
      // Finished episodes compile with the repo's pipeline, retargeted onto the example arm.
      compile: 'auto',
      pipelineDir: '/repo/pipeline',
      retargetProfiles: ['/repo/pipeline/src/clio_pipeline/retarget/profiles/clio-arm-6dof.json'],
      // Each compile is followed by a scene build with offline primitive models.
      scene: 'auto',
      sceneModels: 'primitive',
      sceneTimeoutMs: null,
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
        GEMINI_SCENE_MODEL: '',
        GEMINI_JUDGE_MODEL: '',
        CLIO_DATA_DIR: '',
        CLIO_CORS_ORIGINS: ' ',
      },
      '/repo',
    );
    expect(config.port).toBe(8787);
    expect(config.geminiApiKey).toBeNull();
    expect(config.liveModel).toBe('gemini-3.8-live');
    expect(config.plannerModel).toBe('gemini-robotics-er-2-preview');
    expect(config.visionModel).toBe('gemini-robotics-er-2-preview');
    expect(config.sceneModel).toBe('gemini-robotics-er-2-preview');
    expect(config.judgeModel).toBe('gemini-pro-latest');
    expect(config.dataDir).toBe('/repo/data');
    expect(config.corsOrigins).toEqual(DEFAULT_CORS_ORIGINS);
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
        GEMINI_SCENE_MODEL: 'scene-x',
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
      sceneModel: 'scene-x',
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

  it('reads CORS origins as a comma-separated list of exact origins', () => {
    expect(
      loadConfig({ CLIO_CORS_ORIGINS: ' http://127.0.0.1:3002 , https://viewer.test,' }, '/repo')
        .corsOrigins,
    ).toEqual(['http://127.0.0.1:3002', 'https://viewer.test']);
    // A browser's Origin header never has a path, a trailing slash or a default port.
    for (const value of [
      'localhost:3001',
      'http://localhost:3001/',
      'http://localhost:3001/clio',
      'http://localhost:80',
      'ws://localhost:3001',
      'http://localhost:3001,not a url',
      ',',
    ]) {
      expect(() => loadConfig({ CLIO_CORS_ORIGINS: value }, '/repo')).toThrow(/CLIO_CORS_ORIGINS/);
    }
  });

  it('turns compiling off only with CLIO_COMPILE=off', () => {
    expect(loadConfig({ CLIO_COMPILE: 'off' }, '/repo').compile).toBe('off');
    expect(loadConfig({ CLIO_COMPILE: ' auto ' }, '/repo').compile).toBe('auto');
    expect(loadConfig({ CLIO_COMPILE: '' }, '/repo').compile).toBe('auto');
    expect(() => loadConfig({ CLIO_COMPILE: 'sometimes' }, '/repo')).toThrow(/CLIO_COMPILE/);
  });

  it('resolves the pipeline directory and retarget profiles against the repo root', () => {
    const config = loadConfig(
      {
        CLIO_PIPELINE_DIR: 'tools/pipeline',
        CLIO_RETARGET_PROFILES: ' robots/arm-a.json , /srv/robots/arm-b.json,',
      },
      '/repo',
    );
    expect(config.pipelineDir).toBe('/repo/tools/pipeline');
    expect(config.retargetProfiles).toEqual(['/repo/robots/arm-a.json', '/srv/robots/arm-b.json']);
  });

  it('retargets onto no robot when CLIO_RETARGET_PROFILES is none', () => {
    expect(loadConfig({ CLIO_RETARGET_PROFILES: 'none' }, '/repo').retargetProfiles).toEqual([]);
    expect(loadConfig({ CLIO_RETARGET_PROFILES: ' ' }, '/repo').retargetProfiles).toEqual([
      '/repo/pipeline/src/clio_pipeline/retarget/profiles/clio-arm-6dof.json',
    ]);
    expect(() => loadConfig({ CLIO_RETARGET_PROFILES: ',' }, '/repo')).toThrow(
      /CLIO_RETARGET_PROFILES/,
    );
  });

  it('turns scene builds off only with CLIO_SCENE=off', () => {
    expect(loadConfig({ CLIO_SCENE: 'off' }, '/repo').scene).toBe('off');
    expect(loadConfig({ CLIO_SCENE: ' auto ' }, '/repo').scene).toBe('auto');
    expect(loadConfig({ CLIO_SCENE: '' }, '/repo').scene).toBe('auto');
    expect(() => loadConfig({ CLIO_SCENE: 'on' }, '/repo')).toThrow(/CLIO_SCENE/);
  });

  it('reads the object model backend, primitive unless set', () => {
    for (const models of ['primitive', 'gemini-cad', 'command'] as const) {
      expect(loadConfig({ CLIO_SCENE_MODELS: ` ${models} ` }, '/repo').sceneModels).toBe(models);
    }
    expect(loadConfig({ CLIO_SCENE_MODELS: '' }, '/repo').sceneModels).toBe('primitive');
    for (const value of ['gemini', 'trellis', 'Primitive']) {
      expect(() => loadConfig({ CLIO_SCENE_MODELS: value }, '/repo')).toThrow(/CLIO_SCENE_MODELS/);
    }
  });

  it('reads a scene build timeout in whole milliseconds, up to a day', () => {
    expect(loadConfig({ CLIO_SCENE_TIMEOUT_MS: ' 120000 ' }, '/repo').sceneTimeoutMs).toBe(120_000);
    expect(loadConfig({ CLIO_SCENE_TIMEOUT_MS: '' }, '/repo').sceneTimeoutMs).toBeNull();
    expect(loadConfig({ CLIO_SCENE_TIMEOUT_MS: '86400000' }, '/repo').sceneTimeoutMs).toBe(
      86_400_000,
    );
    for (const value of ['0', '-5', '1.5', 'ten', '86400001']) {
      expect(() => loadConfig({ CLIO_SCENE_TIMEOUT_MS: value }, '/repo'), value).toThrow(
        /CLIO_SCENE_TIMEOUT_MS/,
      );
    }
  });

  it('rejects an invalid port with a message naming the variable', () => {
    expect(() => loadConfig({ CLIO_SERVER_PORT: 'eighty' }, '/repo')).toThrow(/CLIO_SERVER_PORT/);
    expect(() => loadConfig({ CLIO_SERVER_PORT: '70000' }, '/repo')).toThrow(/CLIO_SERVER_PORT/);
  });
});

describe('describeSceneBuilds', () => {
  const on = { gemini: true, scene: true };

  it('says which models scene builds make, and that gemini-cad sends crops to Google', () => {
    const models = (sceneModels: string) => loadConfig({ CLIO_SCENE_MODELS: sceneModels }, '/r');
    expect(describeSceneBuilds(models('primitive'), on)).toBe(
      'on (object models: primitive, offline)',
    );
    expect(describeSceneBuilds(models('gemini-cad'), on)).toBe(
      'on (object models: gemini-cad, which sends crops of each object to Google)',
    );
    expect(describeSceneBuilds(models('gemini-cad'), { ...on, gemini: false })).toBe(
      'on (object models: gemini-cad, but GEMINI_API_KEY is not set, so primitives)',
    );
    expect(describeSceneBuilds(models('command'), on)).toBe(
      'on (object models: command, which runs CLIO_MODEL_COMMAND)',
    );
  });

  it('says why scene builds are off', () => {
    const off = { ...on, scene: false };
    expect(describeSceneBuilds(loadConfig({ CLIO_SCENE: 'off' }, '/r'), off)).toBe(
      'off (CLIO_SCENE=off)',
    );
    expect(describeSceneBuilds(loadConfig({ CLIO_COMPILE: 'off' }, '/r'), off)).toBe(
      'off, since compiling is off',
    );
  });
});

describe('REPO_ROOT', () => {
  it('is the workspace root', () => {
    expect(existsSync(join(REPO_ROOT, 'pnpm-workspace.yaml'))).toBe(true);
  });
});
