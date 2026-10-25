import { spawnSync } from 'node:child_process';
import { Server } from 'node:http';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { GEMINI_RELAY_PATH } from '@clio/protocol';
import { createAdaptorServer } from '@hono/node-server';
import pkg from '../package.json' with { type: 'json' };
import { createApp } from './app';
import { type Config, loadConfig } from './config';
import { consoleLogger, describeError, type Logger } from './log';
import { attachGeminiRelay, type GeminiRelay } from './relay/gemini-relay';
import { createBenchModels } from './services/bench';
import { ProcessEpisodeCompiler } from './services/episode-compiler';
import { createGeminiClient, isGeminiConfigured } from './services/gemini';
import { createGeminiPlanner } from './services/gemini-planner';
import { createGeminiSceneAsker } from './services/gemini-scene';
import { createGeminiStepChecker } from './services/gemini-step-check';
import { createGeminiLocator } from './services/gemini-vision';
import { createHttpLocator } from './services/http-vision';
import { createGeminiPrimaryPicker, createPrimaryObjectFinder } from './services/primary-object';
import { createGeminiTokenMinter } from './services/token-minter';
import { BenchCheckStore } from './storage/bench-check-store';
import { BenchStore } from './storage/bench-store';
import { ClipStore } from './storage/clip-store';
import { DerivedStore } from './storage/derived-store';
import { EpisodeStore } from './storage/episode-store';
import { ProcedureStore } from './storage/procedure-store';
import { SceneStore } from './storage/scene-store';

// Boot: config → stores and services → HTTP app → server, with the Gemini Live relay on the
// server's `upgrade` event (the Vite dev server proxies /api and /gemini here). Once listening, the
// compiler catches up on episodes that finished while the server was down.

function main(): void {
  const logger = consoleLogger;
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    logger.error(describeError(error));
    process.exit(1);
  }

  const gemini = isGeminiConfigured(config.geminiApiKey)
    ? createGeminiClient(config.geminiApiKey)
    : null;
  const benchDir = join(config.dataDir, 'bench');
  const compiler = createCompiler(config, logger);
  const app = createApp({
    version: pkg.version,
    liveModel: config.liveModel,
    episodes: new EpisodeStore(join(config.dataDir, 'episodes'), { logger }),
    derived: new DerivedStore(join(config.dataDir, 'derived'), { logger }),
    scenes: new SceneStore(join(config.dataDir, 'scenes'), { logger }),
    procedures: new ProcedureStore({
      curatedDir: config.proceduresDir,
      plansDir: join(config.dataDir, 'plans'),
      logger,
    }),
    clips: new ClipStore(join(config.dataDir, 'clips')),
    tokenMinter: gemini && createGeminiTokenMinter(gemini),
    planner: gemini && createGeminiPlanner(gemini, config.plannerModel),
    checker: gemini && createGeminiStepChecker(gemini, config.plannerModel),
    locator: config.visionUrl
      ? createHttpLocator({ url: config.visionUrl, token: config.visionToken })
      : gemini && createGeminiLocator(gemini, config.visionModel),
    scene: gemini && createGeminiSceneAsker(gemini, config.sceneModel),
    bench: {
      store: new BenchStore(benchDir, { logger }),
      checks: new BenchCheckStore(benchDir, { logger }),
      plans: new ProcedureStore({
        curatedDir: config.proceduresDir,
        plansDir: join(benchDir, 'plans'),
        logger,
      }),
      models: gemini && createBenchModels(gemini, config),
    },
    primary:
      gemini &&
      createPrimaryObjectFinder({
        picker: createGeminiPrimaryPicker(gemini, config.visionModel),
        finder: createHttpLocator({ url: config.primaryFinderUrl }),
        fallback: createGeminiLocator(gemini, config.visionModel),
        logger,
      }),
    compiler,
    logger,
  });

  const server = createAdaptorServer({ fetch: app.fetch, hostname: config.host });
  if (!(server instanceof Server)) throw new Error('Expected an HTTP/1.1 server');
  const relay = attachGeminiRelay(server, {
    apiKey: config.geminiApiKey,
    logger,
    logMessages: config.relayLog,
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    logger.error(
      error.code === 'EADDRINUSE'
        ? `Port ${config.port} is already in use. Stop the other server or set CLIO_SERVER_PORT.`
        : `Server error: ${describeError(error)}`,
    );
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    logStartup(config, logger, gemini !== null, compiler !== null);
    // Never awaited: startup does not wait for compiles, and lessons finished from now on go first.
    void compiler?.sweep();
  });
  stopOnSignals(server, relay, compiler, logger);
}

/** `clio compile` through uv, or null when compiling is off or uv is not installed. */
function createCompiler(config: Config, logger: Logger): ProcessEpisodeCompiler | null {
  if (config.compile === 'off' || !canRun('uv', ['--version'])) return null;
  return new ProcessEpisodeCompiler({
    command: ['uv', 'run', '--frozen', '--project', config.pipelineDir, 'clio'],
    episodesDir: join(config.dataDir, 'episodes'),
    derivedDir: join(config.dataDir, 'derived'),
    retargetProfiles: config.retargetProfiles,
    logger,
  });
}

function canRun(command: string, args: string[]): boolean {
  return spawnSync(command, args, { stdio: 'ignore', timeout: 5000 }).status === 0;
}

function logStartup(
  config: Config,
  logger: Logger,
  geminiReady: boolean,
  compileReady: boolean,
): void {
  const hosts =
    config.host === '0.0.0.0' || config.host === '::'
      ? ['localhost', ...lanAddresses()]
      : [config.host];
  const lines = [
    `Clio server ${pkg.version}`,
    ...hosts.map((host) => `  http://${host}:${config.port}/api/health`),
    `  Gemini Live relay: ws://${hosts[0]}:${config.port}${GEMINI_RELAY_PATH}`,
    geminiReady
      ? `  Gemini: on (voice ${config.liveModel}, planner ${config.plannerModel}, closer looks ${config.sceneModel})`
      : '  Gemini: off. Set GEMINI_API_KEY in .env; until then use the scripted coach.',
    `  Object finder: ${
      config.visionUrl ?? (geminiReady ? `Gemini ${config.visionModel}` : 'off')
    }`,
    `  Primary object: ${
      geminiReady ? `Gemini ${config.visionModel}, then ${config.primaryFinderUrl}` : 'off'
    }`,
    `  Compile: ${
      compileReady
        ? `on (${config.pipelineDir})`
        : config.compile === 'off'
          ? 'off (CLIO_COMPILE=off)'
          : 'off. Install uv to compile finished episodes.'
    }`,
    `  Data: ${config.dataDir}`,
    `  Procedures: ${config.proceduresDir}`,
  ];
  if (config.relayLog) lines.push('  Relay message logging: on (types and sizes only)');
  logger.info(lines.join('\n'));
}

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a !== undefined && a.family === 'IPv4' && !a.internal)
    .map((a) => a?.address ?? '');
}

function stopOnSignals(
  server: Server,
  relay: GeminiRelay,
  compiler: ProcessEpisodeCompiler | null,
  logger: Logger,
): void {
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) process.exit(1);
    stopping = true;
    logger.info(`${signal}: shutting down`);
    relay.close();
    compiler?.close();
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    // Keep-alive requests or slow peers must not hold up a restart.
    setTimeout(() => {
      server.closeAllConnections();
      process.exit(0);
    }, 2000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main();
