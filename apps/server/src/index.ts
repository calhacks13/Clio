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
import { createGeminiClient, isGeminiConfigured } from './services/gemini';
import { createGeminiPlanner } from './services/gemini-planner';
import { createGeminiLocator } from './services/gemini-vision';
import { createHttpLocator } from './services/http-vision';
import { createGeminiTokenMinter } from './services/token-minter';
import { ClipStore } from './storage/clip-store';
import { EpisodeStore } from './storage/episode-store';
import { ProcedureStore } from './storage/procedure-store';

// Boot: config → stores and services → HTTP app → server, with the Gemini Live relay on the
// server's `upgrade` event (the Vite dev server proxies /api and /gemini here).

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
  const app = createApp({
    version: pkg.version,
    liveModel: config.liveModel,
    episodes: new EpisodeStore(join(config.dataDir, 'episodes'), { logger }),
    procedures: new ProcedureStore({
      curatedDir: config.proceduresDir,
      plansDir: join(config.dataDir, 'plans'),
      logger,
    }),
    clips: new ClipStore(join(config.dataDir, 'clips')),
    tokenMinter: gemini && createGeminiTokenMinter(gemini),
    planner: gemini && createGeminiPlanner(gemini, config.plannerModel),
    locator: config.visionUrl
      ? createHttpLocator({ url: config.visionUrl, token: config.visionToken })
      : gemini && createGeminiLocator(gemini, config.visionModel),
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
  server.listen(config.port, config.host, () => logStartup(config, logger, gemini !== null));
  stopOnSignals(server, relay, logger);
}

function logStartup(config: Config, logger: Logger, geminiReady: boolean): void {
  const hosts =
    config.host === '0.0.0.0' || config.host === '::'
      ? ['localhost', ...lanAddresses()]
      : [config.host];
  const lines = [
    `Clio server ${pkg.version}`,
    ...hosts.map((host) => `  http://${host}:${config.port}/api/health`),
    `  Gemini Live relay: ws://${hosts[0]}:${config.port}${GEMINI_RELAY_PATH}`,
    geminiReady
      ? `  Gemini: on (live ${config.liveModel}, planner ${config.plannerModel})`
      : '  Gemini: off. Set GEMINI_API_KEY in .env; until then use the scripted coach.',
    `  Object finder: ${
      config.visionUrl ?? (geminiReady ? `Gemini ${config.visionModel}` : 'off')
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

function stopOnSignals(server: Server, relay: GeminiRelay, logger: Logger): void {
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) process.exit(1);
    stopping = true;
    logger.info(`${signal}: shutting down`);
    relay.close();
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
