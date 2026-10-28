import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // packages/extension
const dist = path.join(root, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

/** Content scripts and pages must be plain scripts (IIFE); the service worker is ESM. */
const entries = [
  { in: 'src/injected/interceptor.ts', out: 'interceptor.js', format: 'iife' },
  { in: 'src/content/controller.ts', out: 'content.js', format: 'iife' },
  { in: 'src/background/service-worker.ts', out: 'background.js', format: 'esm' },
  { in: 'src/sidepanel/main.ts', out: 'sidepanel.js', format: 'iife' },
  { in: 'src/options/main.ts', out: 'options.js', format: 'iife' },
];

for (const entry of entries) {
  await build({
    entryPoints: [path.join(root, entry.in)],
    bundle: true,
    format: entry.format,
    platform: 'browser',
    target: 'chrome116',
    outfile: path.join(dist, entry.out),
    sourcemap: false,
    minify: false,
    legalComments: 'none',
  });
}

// Static assets: manifest, pages, icons
for (const file of [
  'manifest.json',
  'sidepanel.html',
  'sidepanel.css',
  'options.html',
  'options.css',
]) {
  fs.copyFileSync(path.join(root, 'static', file), path.join(dist, file));
}
const iconsDir = path.join(root, 'static', 'icons');
fs.mkdirSync(path.join(dist, 'icons'), { recursive: true });
for (const icon of fs.readdirSync(iconsDir)) {
  fs.copyFileSync(path.join(iconsDir, icon), path.join(dist, 'icons', icon));
}

console.log('extension built to', dist);
