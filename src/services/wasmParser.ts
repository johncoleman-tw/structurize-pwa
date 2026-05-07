// Bridge to the Structurizr DSL parser, a GraalVM-compiled WASM-GC module
// hosted in /public/wasm-host/. We load parser-bootstrap.html in a hidden
// same-origin iframe and call its globals — same contract WasmParserService.swift
// uses through WKWebView.callAsyncJavaScript today.
//
// Public API:
//   const parser = await getParser();
//   const { workspace, json } = await parser.parse('/workspace.dsl', dslText);
//
// `files` is an absolute-path → contents map for !include resolution.
// The root file is auto-merged into it so callers don't have to.

interface ParserWindow extends Window {
  __parserReady: Promise<void>;
  __structurizrFiles: Record<string, string>;
  structurizrParseDsl: (rootPath: string, rootText: string) => Promise<unknown>;
}

export interface ParseResult {
  /** Parsed workspace object (the JSON envelope, decoded). */
  workspace: WorkspaceJson;
  /** Raw JSON string — feed this directly to renderDiagram. */
  json: string;
}

/**
 * Loose typing for the workspace shape; tightened in Phase 3.
 * The fields we actually need right now are `name` and `views`.
 */
export interface WorkspaceJson {
  name?: string;
  description?: string;
  views?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ParserBridge {
  parse: (
    rootPath: string,
    rootText: string,
    files?: Record<string, string>,
  ) => Promise<ParseResult>;
}

let bridgePromise: Promise<ParserBridge> | null = null;

export function getParser(): Promise<ParserBridge> {
  if (!bridgePromise) {
    bridgePromise = createBridge().catch((err) => {
      // Don't pin a failed boot in cache — let the next call retry.
      bridgePromise = null;
      throw err;
    });
  }
  return bridgePromise;
}

async function createBridge(): Promise<ParserBridge> {
  const frame = document.createElement('iframe');
  frame.id = 'wasm-parser-frame';
  frame.src = import.meta.env.BASE_URL + 'wasm-host/parser-bootstrap.html';
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText =
    'position:absolute;width:0;height:0;border:0;visibility:hidden;';
  document.body.appendChild(frame);

  await new Promise<void>((resolve, reject) => {
    frame.addEventListener('load', () => resolve(), { once: true });
    frame.addEventListener(
      'error',
      () => reject(new Error('parser iframe failed to load')),
      { once: true },
    );
  });

  const win = frame.contentWindow as ParserWindow | null;
  if (!win) throw new Error('parser iframe has no contentWindow');

  await win.__parserReady;

  if (typeof win.structurizrParseDsl !== 'function') {
    throw new Error('structurizrParseDsl not installed by GraalVM boot');
  }

  return {
    async parse(rootPath, rootText, files = {}) {
      win.__structurizrFiles = { ...files, [rootPath]: rootText };
      const result = await win.structurizrParseDsl(rootPath, rootText);
      return unwrapEnvelope(result);
    },
  };
}

/**
 * The WASM parser returns a JSON envelope:
 *   success: { ok: true,  workspace: {...} }
 *   failure: { ok: false, error: "...", cause?: "...", context?: "...", trace?: "..." }
 *
 * The diagram renderer expects the inner workspace object as a JSON string,
 * not the envelope. This helper unwraps and stringifies in one place.
 */
function unwrapEnvelope(result: unknown): ParseResult {
  const envelope: Record<string, unknown> =
    typeof result === 'string'
      ? (JSON.parse(result) as Record<string, unknown>)
      : (result as Record<string, unknown>);

  if (envelope['ok'] !== true) {
    const error = String(envelope['error'] ?? 'Unknown parse error');
    const cause = envelope['cause'];
    throw new Error(cause ? `${error}\nCaused by: ${String(cause)}` : error);
  }

  const workspace = envelope['workspace'];
  if (!workspace || typeof workspace !== 'object') {
    throw new Error("Parser envelope ok=true but missing 'workspace' field");
  }

  return {
    workspace: workspace as WorkspaceJson,
    json: JSON.stringify(workspace),
  };
}
