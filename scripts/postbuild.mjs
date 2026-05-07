#!/usr/bin/env node
// Drop a "double-click to launch" script into dist/ alongside a brief README,
// so the built folder is self-contained: zip it up, share it, recipient runs
// the launcher and gets a localhost URL in their browser.

import { chmod, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../dist');

// macOS / Linux launcher. Picks a free-ish port, prefers python3 (preinstalled
// on macOS), falls back to python or `npx serve`. Opens the browser.
const shCommand = `#!/bin/bash
# Structurize PWA — local launcher
# Double-click on macOS to start a local web server and open the app.

set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

PORT=8765
URL="http://localhost:$PORT/"

# Find a server we can use.
if command -v python3 >/dev/null 2>&1; then
  SERVER="python3 -m http.server $PORT --bind 127.0.0.1"
elif command -v python >/dev/null 2>&1; then
  SERVER="python -m http.server $PORT --bind 127.0.0.1"
elif command -v npx >/dev/null 2>&1; then
  SERVER="npx --yes serve -l $PORT -s ."
else
  echo "Need python3, python, or npx to serve the app."
  echo "Install Python (https://www.python.org/) or Node.js (https://nodejs.org/) and try again."
  read -p "Press Enter to close…"
  exit 1
fi

# Open the browser shortly after the server starts.
( sleep 0.8; \
  if command -v open >/dev/null 2>&1; then open "$URL"; \
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"; \
  fi ) &

echo "Serving Structurize at $URL"
echo "Press Ctrl+C in this window to stop."
exec $SERVER
`;

// Windows launcher.
const batCommand = `@echo off
REM Structurize PWA — local launcher (Windows)
REM Double-click to start a local web server and open the app.

set DIR=%~dp0
cd /d "%DIR%"

set PORT=8765
set URL=http://localhost:%PORT%/

where python >nul 2>nul
if %errorlevel% == 0 (
  start "" "%URL%"
  python -m http.server %PORT% --bind 127.0.0.1
  goto :end
)

where npx >nul 2>nul
if %errorlevel% == 0 (
  start "" "%URL%"
  npx --yes serve -l %PORT% -s .
  goto :end
)

echo Need Python or Node.js to serve the app.
echo Install from https://www.python.org/ or https://nodejs.org/ and try again.
pause

:end
`;

const readme = `Structurize PWA — offline bundle
================================

This folder is a self-contained build of the Structurize PWA. It needs a tiny
local web server (browsers refuse to run service workers + WebAssembly from
file:// URLs) but it does NOT need internet access once started.

Quick start
-----------
  • macOS:   double-click  serve.command
  • Windows: double-click  serve.bat
  • Linux:   ./serve.command   (or run a static server in this folder)

The launcher starts a local server on http://localhost:8765 and opens it in
your default browser. Press Ctrl+C in the terminal window to stop.

Manual alternative (any OS with Python 3 installed):
  cd into this folder
  python3 -m http.server 8765
  open http://localhost:8765 in a browser

Sharing
-------
Zip this whole folder and send it. The recipient extracts and runs the
launcher; no install or network access required after extraction.
`;

await writeFile(join(dist, 'serve.command'), shCommand, 'utf8');
await chmod(join(dist, 'serve.command'), 0o755);
await writeFile(join(dist, 'serve.bat'), batCommand, 'utf8');
await writeFile(join(dist, 'README.txt'), readme, 'utf8');

console.log('[postbuild] dropped serve.command, serve.bat, README.txt into dist/');
