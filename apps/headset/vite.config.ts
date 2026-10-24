import { readFileSync } from 'node:fs';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

// The headset only talks to this origin: /api and the /gemini WebSocket relay are proxied to the
// laptop server, so the page works over `adb reverse` (http://localhost is a secure context) and
// over Wi-Fi with CLIO_HTTPS=1 (self-signed certificate; accept it once on the headset).

const server = process.env.CLIO_SERVER_URL ?? 'http://localhost:8787';
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
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: server, changeOrigin: true },
      '/gemini': { target: server, changeOrigin: true, ws: true },
    },
  },
  build: { target: 'es2022', sourcemap: true },
});
