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

// Inject a CSP meta tag into the two iframe HTML files.
//
// The parent index.html has its own (tighter) CSP, but it does NOT cascade
// into iframes — each document is constrained by its own CSP. Without one,
// a compromised iframe could fetch() to anywhere on the internet. The CSP
// below keeps connect-src locked to 'self' (the central anti-exfiltration
// guarantee) while leaving script-src/style-src permissive enough that the
// vendored jQuery/JointJS/structurizr-* code keeps working.
//
// 'unsafe-inline' on script-src is needed because parser-bootstrap.html and
// DiagramViewer.html both contain inline <script> blocks that we don't want
// to rewrite (keeps upstream sync clean). 'unsafe-eval' is needed because
// jQuery 3.6.x uses Function() in DOMEval/globalEval. Both are acceptable
// in the presence of a strict connect-src — even if an attacker can run
// arbitrary code, they cannot send anything off-machine.

const iframeCsp =
  '<meta http-equiv="Content-Security-Policy" content="' +
  "default-src 'self'; " +
  "connect-src 'self'; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; " +
  "font-src 'self' data:; " +
  "frame-ancestors 'self'; " +
  "base-uri 'self'; " +
  "form-action 'none'; " +
  "object-src 'none';" +
  '">';

async function injectIframeCsp(htmlPath, label) {
  if (!(await exists(htmlPath))) return;
  let html = await readFile(htmlPath, 'utf8');
  if (html.includes('Content-Security-Policy')) return; // already injected
  html = html.replace(/<head([^>]*)>/i, (m, attrs) => `<head${attrs}>\n    ${iframeCsp}`);
  await writeFile(htmlPath, html, 'utf8');
  console.log(`[copy-assets] injected CSP meta into ${label}`);
}

await injectIframeCsp(bootstrap, 'parser-bootstrap.html');
await injectIframeCsp(
  join(projectRoot, 'public/diagram-viewer/DiagramViewer.html'),
  'DiagramViewer.html',
);
