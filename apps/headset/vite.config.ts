import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
      '/api': { target: server, changeOrigin: true },
      '/gemini': { target: server, changeOrigin: true, ws: true },
      // Live tracking stream for lessons and primary.html (tracker/TRACK.md).
      '/track': {
        target: process.env.CLIO_TRACKER_URL ?? 'http://127.0.0.1:8790',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // hello.html: bare WebXR smoke test. tracking.html: what the headset tracks (hands, surfaces,
    // room mesh). viewer.html: laptop page that replays or follows a recorded episode live.
    // gallery.html: every UI in its states, rendered from the real code, to iterate on locally.
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        hello: fileURLToPath(new URL('./hello.html', import.meta.url)),
        tracking: fileURLToPath(new URL('./tracking.html', import.meta.url)),
        viewer: fileURLToPath(new URL('./viewer.html', import.meta.url)),
        primary: fileURLToPath(new URL('./primary.html', import.meta.url)),
        depth: fileURLToPath(new URL('./depth.html', import.meta.url)),
        calibrate: fileURLToPath(new URL('./calibrate.html', import.meta.url)),
        glowPreview: fileURLToPath(new URL('./glow-preview.html', import.meta.url)),
        gallery: fileURLToPath(new URL('./gallery.html', import.meta.url)),
        widgetsPreview: fileURLToPath(new URL('./widgets-preview.html', import.meta.url)),
      },
    },
  },
});
