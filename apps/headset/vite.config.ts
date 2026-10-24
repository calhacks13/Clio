import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

// The headset only talks to this origin: /api and the /gemini WebSocket relay are proxied to the
// laptop server (which listens on loopback only), so the page works over `adb reverse`
// (http://localhost is a secure context) and over Wi-Fi with CLIO_HTTPS=1 (self-signed certificate;
// accept it once on the headset).

// 127.0.0.1, not localhost: on macOS "localhost" may resolve to ::1 and miss an IPv4-bound server.
const server = process.env.CLIO_SERVER_URL ?? 'http://127.0.0.1:8787';
// USB (adb reverse) only needs loopback. Wi-Fi mode (HTTPS) opens the dev server to the LAN, and
// with it the Gemini relay: only use it on a network you trust.
const lan = Boolean(process.env.CLIO_HTTPS || process.env.CLIO_LAN);
// With CLIO_ACCESS_KEY set, the server wants it on /api and /gemini (docs/deploy.md). Read it as
// the server does (the environment first, then the root .env) and send it, so dev keeps working.
const rootEnv = new URL('../../.env', import.meta.url);
const accessKey = (
  process.env.CLIO_ACCESS_KEY ??
  (existsSync(rootEnv) ? parseEnv(readFileSync(rootEnv, 'utf8')).CLIO_ACCESS_KEY : undefined)
)?.trim();
const headers = accessKey ? { authorization: `Bearer ${accessKey}` } : undefined;
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as {
  version: string;
};

export default defineConfig({
  plugins: process.env.CLIO_HTTPS ? [basicSsl()] : [],
  define: { __CLIO_VERSION__: JSON.stringify(version) },
  // IWER's devui/sem pin an older three; two copies break its synthetic rooms.
  resolve: { dedupe: ['three'] },
  server: {
    host: lan ? true : '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: server, changeOrigin: true, headers },
      '/gemini': { target: server, changeOrigin: true, ws: true, headers },
    },
  },
  build: { target: 'es2022', sourcemap: true },
});
