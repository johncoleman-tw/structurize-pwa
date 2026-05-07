import { useEffect, useRef, useState } from 'react';
import {
  attachDiagramHost,
  type DiagramHost,
  type DiagramMessage,
} from '../services/diagramHost';

interface DiagramFrameProps {
  /** Full workspace JSON, as a string. Re-renders when this changes. */
  workspaceJSON: string;
  /** View key to display; '' shows the workspace home page. */
  viewKey: string;
  onMessage?: (msg: DiagramMessage) => void;
  className?: string;
  style?: React.CSSProperties;
}

export function DiagramFrame({
  workspaceJSON,
  viewKey,
  onMessage,
  className,
  style,
}: DiagramFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const hostRef = useRef<DiagramHost | null>(null);
  const loadedJSONRef = useRef<string>('');
  const loadedViewRef = useRef<string>('');
  const [error, setError] = useState<string | null>(null);

  // Mount the iframe + bridge once.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    let cancelled = false;
    setError(null);

    attachDiagramHost({ iframe, onMessage })
      .then(async (host) => {
        if (cancelled) {
          host.destroy();
          return;
        }
        hostRef.current = host;
        await host.render(workspaceJSON, viewKey);
        loadedJSONRef.current = workspaceJSON;
        loadedViewRef.current = viewKey;
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      cancelled = true;
      hostRef.current = null;
    };
    // The bridge is mounted once per iframe element; we don't tear it down on
    // prop changes. Re-renders are dispatched in the second effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Forward prop changes after the bridge is ready.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    (async () => {
      try {
        if (loadedJSONRef.current !== workspaceJSON) {
          await host.render(workspaceJSON, viewKey);
          loadedJSONRef.current = workspaceJSON;
          loadedViewRef.current = viewKey;
        } else if (loadedViewRef.current !== viewKey) {
          await host.changeView(viewKey);
          loadedViewRef.current = viewKey;
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceJSON, viewKey]);

  return (
    <div className={className} style={{ position: 'relative', ...style }}>
      <iframe
        ref={iframeRef}
        src={import.meta.env.BASE_URL + 'diagram-viewer/DiagramViewer.html'}
        title="Structurizr diagram"
        style={{
          width: '100%',
          height: '100%',
          border: 0,
          display: 'block',
        }}
      />
      {error && (
        <pre
          style={{
            position: 'absolute',
            inset: 12,
            background: 'rgba(255,240,240,0.95)',
            color: '#a00',
            padding: 12,
            borderRadius: 4,
            whiteSpace: 'pre-wrap',
            overflow: 'auto',
            fontSize: 12,
          }}
        >
          Diagram error: {error}
        </pre>
      )}
    </div>
  );
}
