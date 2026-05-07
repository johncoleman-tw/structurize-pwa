import { useRef, useState } from 'react';
import {
  loadFromDrop,
  loadFromFileList,
  pickDirectory,
  supportsDirectoryPicker,
  WorkspaceLoadError,
  type LoadedProject,
} from '../services/workspaceFs';

interface WelcomePaneProps {
  onLoaded: (project: LoadedProject) => void;
  /** Optional: shown as a secondary action (e.g. sample-DSL button). */
  secondary?: React.ReactNode;
}

export function WelcomePane({ onLoaded, secondary }: WelcomePaneProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const handle = async (loadingPromise: Promise<LoadedProject>) => {
    setError(null);
    setBusy(true);
    try {
      const project = await loadingPromise;
      onLoaded(project);
    } catch (err) {
      if (err instanceof WorkspaceLoadError) setError(err.message);
      else if ((err as DOMException)?.name === 'AbortError') return; // user cancelled
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onPick = () => {
    if (supportsDirectoryPicker()) {
      handle(pickDirectory());
    } else {
      inputRef.current?.click();
    }
  };

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handle(loadFromFileList(e.target.files));
    }
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer?.items) {
      handle(loadFromDrop(e.dataTransfer.items));
    }
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: 16,
        margin: 24,
        padding: '48px 32px',
        border: `2px dashed ${dragOver ? '#3066B7' : '#ccc'}`,
        borderRadius: 8,
        background: dragOver ? '#eef4ff' : '#fafafa',
        color: '#444',
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 18, fontWeight: 600 }}>Open a Structurizr workspace</div>
      <div style={{ fontSize: 13, color: '#666', maxWidth: 460 }}>
        Drop a folder here, or pick one. The folder should contain a{' '}
        <code>workspace.dsl</code>. Files never leave your browser.
      </div>

      <button
        onClick={onPick}
        disabled={busy}
        style={{
          padding: '10px 24px',
          fontSize: 14,
          cursor: busy ? 'wait' : 'pointer',
          background: '#3066B7',
          color: 'white',
          border: 0,
          borderRadius: 4,
        }}
      >
        {busy ? 'Loading…' : 'Open Folder…'}
      </button>

      {/* Hidden input fallback (used when FSA is unavailable). */}
      <input
        ref={inputRef}
        type="file"
        // @ts-expect-error — webkitdirectory is a non-standard attribute that
        // React doesn't know about, but it's the only universal directory picker.
        webkitdirectory=""
        directory=""
        multiple
        style={{ display: 'none' }}
        onChange={onInputChange}
      />

      {secondary && <div style={{ marginTop: 8 }}>{secondary}</div>}

      {error && (
        <pre
          style={{
            color: '#a00',
            background: '#fff5f5',
            border: '1px solid #fcc',
            borderRadius: 4,
            padding: 12,
            margin: 0,
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            maxWidth: 600,
          }}
        >
          {error}
        </pre>
      )}
    </div>
  );
}
