import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './harness';

// A tiny stand-in for `pnpm build` output (apps/headset/dist), plus a secret next to it that must
// never be served.

export const INDEX_HTML = '<!doctype html><title>Clio test build</title><div id="app"></div>';
export const APP_JS = 'console.log("clio");';
export const SECRET = 'GEMINI_API_KEY=do-not-serve';

export const ASSET = {
  js: '/assets/index-Ab12Cd34.js',
  css: '/assets/index-Ef56Gh78.css',
  font: '/assets/inter-latin-400-normal-Ij90Kl12.woff',
  worklet: '/worklets/pcm-capture.js',
} as const;

export async function fakeBuild(): Promise<string> {
  const root = await tempDir();
  const dist = join(root, 'dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await mkdir(join(dist, 'worklets'), { recursive: true });
  await writeFile(join(dist, 'index.html'), INDEX_HTML);
  await writeFile(join(dist, ASSET.js), APP_JS);
  await writeFile(join(dist, ASSET.css), 'body { margin: 0; }');
  await writeFile(join(dist, ASSET.font), new Uint8Array([0x77, 0x4f, 0x46, 0x46]));
  await writeFile(join(dist, ASSET.worklet), 'registerProcessor("pcm-capture", class {});');
  await writeFile(join(root, 'secret.txt'), SECRET);
  return dist;
}

/** What a browser sends when it opens a page. */
export const NAVIGATE = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};
