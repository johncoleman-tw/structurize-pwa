#!/usr/bin/env node
// Copies the WASM parser host and diagram-viewer JS from the upstream
// structurize repo into ./public so Vite can serve them at /wasm-host/*
// and /diagram-viewer/*. Runs automatically before `dev` and `build`.

import { access, cp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

const exists = async (p) => {
  try { await access(p); return true; } catch { return false; }
};

// CI / Pages builds vendor the assets directly into the repo — skip this
// script entirely when the env var is set.
if (process.env.SKIP_COPY_ASSETS) {
  console.log('[copy-assets] SKIP_COPY_ASSETS set — using vendored public/ as-is.');
  process.exit(0);
}

const candidates = [
  process.env.STRUCTURIZE_REPO,
  resolve(projectRoot, '../structurize'),
  resolve(projectRoot, '../../XcodeProjects/structurize'),
  join(homedir(), 'XcodeProjects/structurize'),
].filter(Boolean);

let repo = null;
for (const c of candidates) {
  if (await exists(join(c, 'Shared/WasmHost/structurizr-parser.js.wasm'))) {
    repo = c;
    break;
  }
}

if (!repo) {
  console.error('[copy-assets] could not locate the structurize repo.');
  console.error('              set STRUCTURIZE_REPO to its absolute path.');
  console.error('              looked in:');
  for (const c of candidates) console.error('                ' + c);
  process.exit(1);
}

console.log(`[copy-assets] source: ${repo}`);

const targets = [
  { from: join(repo, 'Shared/WasmHost'), to: join(projectRoot, 'public/wasm-host') },
  { from: join(repo, 'Shared/Web'),      to: join(projectRoot, 'public/diagram-viewer') },
];

for (const { from, to } of targets) {
  if (!(await exists(from))) {
    console.warn(`[copy-assets] skipping (not found): ${from}`);
    continue;
  }
  await rm(to, { recursive: true, force: true });
  await cp(from, to, { recursive: true });
  console.log(`[copy-assets]   ${from}\n            ->  ${to}`);
}

// Patch parser-bootstrap.html: the Swift app loads it via a custom
// structurizr:// URL scheme, so the bundled HTML hardcodes
//   <script src="structurizr://parser/structurizr-parser.js"></script>
// In a browser that scheme silently no-ops. Rewrite to a relative URL.
const bootstrap = join(projectRoot, 'public/wasm-host/parser-bootstrap.html');
if (await exists(bootstrap)) {
  const original = await readFile(bootstrap, 'utf8');
  const patched = original.replaceAll('structurizr://parser/', './');
  if (patched !== original) {
    await writeFile(bootstrap, patched, 'utf8');
    console.log('[copy-assets] patched parser-bootstrap.html scheme URLs -> relative');
  }
}
