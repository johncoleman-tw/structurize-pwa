// Bridge to the Structurizr JS diagram renderer (Shared/Web/) hosted in
// /public/diagram-viewer/. We load DiagramViewer.html in a same-origin iframe
// and bridge messages over the same contract DiagramWebView.swift uses today:
//
//   parent → iframe : iframeWindow.renderDiagram(json, viewKey)  (direct call)
//   iframe → parent : window.webkit.messageHandlers.diagramEvents.postMessage(msg)
//
// DiagramViewer.html does not reference DiagramViewer.js — Swift injects it
// post-load to keep the upstream JS files byte-identical. We do the same.

export interface DiagramMessage {
  type: string;
  [key: string]: unknown;
}

interface DiagramWindow extends Window {
  webkit?: {
    messageHandlers: {
      diagramEvents: {
        postMessage: (msg: DiagramMessage) => void;
      };
    };
  };
  renderDiagram?: (json: string, viewKey: string) => unknown;
  changeView?: (viewKey: string) => unknown;
}

export interface DiagramHost {
  render: (workspaceJSON: string, viewKey: string) => Promise<void>;
  changeView: (viewKey: string) => Promise<void>;
  destroy: () => void;
}

export interface DiagramHostOptions {
  iframe: HTMLIFrameElement;
  onMessage?: (msg: DiagramMessage) => void;
}

export async function attachDiagramHost(
  opts: DiagramHostOptions,
): Promise<DiagramHost> {
  const { iframe, onMessage } = opts;

  await new Promise<void>((resolve, reject) => {
    iframe.addEventListener('load', () => resolve(), { once: true });
    iframe.addEventListener(
      'error',
      () => reject(new Error('diagram iframe load failed')),
      { once: true },
    );
  });

  const win = iframe.contentWindow as DiagramWindow | null;
  const doc = iframe.contentDocument;
  if (!win || !doc) throw new Error('diagram iframe missing window/document');

  let resolveReady!: () => void;
  let rejectReady!: (err: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  // Install the webkit-messageHandlers shim BEFORE injecting DiagramViewer.js
  // so its postToSwift() calls land here. Same-origin iframe → direct property
  // access works; no postMessage() round-trip needed.
  win.webkit = {
    messageHandlers: {
      diagramEvents: {
        postMessage: (msg) => {
          if (msg && msg.type === 'jsReady') resolveReady();
          if (msg && msg.type === 'error') {
            console.warn('[diagram-iframe error]', msg['message']);
          }
          onMessage?.(msg);
        },
      },
    },
  };

  // Safety: if jsReady never arrives, fail loudly within 30s rather than hang.
  const timeoutId = window.setTimeout(() => {
    rejectReady(new Error('DiagramViewer.js never posted jsReady within 30s'));
  }, 30_000);
  ready.finally(() => window.clearTimeout(timeoutId));

  // Inject DiagramViewer.js. Mirrors Swift's evaluateJavaScript-after-didFinish
  // approach (DiagramWebView.swift `injectDiagramViewerJS`). Same-origin so a
  // <script src> works fine; no need to fetch+inline.
  await new Promise<void>((resolve, reject) => {
    const script = doc.createElement('script');
    script.src = '/diagram-viewer/js/DiagramViewer.js';
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener(
      'error',
      () => reject(new Error('failed to load DiagramViewer.js')),
      { once: true },
    );
    doc.body.appendChild(script);
  });

  await ready;

  return {
    async render(workspaceJSON, viewKey) {
      if (typeof win.renderDiagram !== 'function') {
        throw new Error('renderDiagram not available on iframe window');
      }
      await win.renderDiagram(workspaceJSON, viewKey);
    },
    async changeView(viewKey) {
      if (typeof win.changeView !== 'function') {
        throw new Error('changeView not available on iframe window');
      }
      await win.changeView(viewKey);
    },
    destroy() {
      iframe.remove();
    },
  };
}
