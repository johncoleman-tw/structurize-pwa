import { useCallback, useMemo, useState } from 'react';
import { getParser, type WorkspaceJson } from './services/wasmParser';
import { DiagramFrame } from './components/DiagramFrame';
import type { DiagramMessage } from './services/diagramHost';
import { downloadDataUri, safeFilename } from './services/downloadDataUri';
import { WelcomePane } from './components/WelcomePane';
import type { LoadedProject } from './services/workspaceFs';

interface ViewSummary {
  key: string;
  type: string;
  title: string;
}

/** Pull `{ key, title }` out of every diagram-view array on `workspace.views`. */
function listViews(workspace: WorkspaceJson): ViewSummary[] {
  const out: ViewSummary[] = [];
  const views = workspace.views;
  if (!views || typeof views !== 'object') return out;
  for (const [collectionName, value] of Object.entries(views)) {
    if (!Array.isArray(value)) continue;
    for (const v of value) {
      if (v && typeof v === 'object' && typeof (v as { key?: unknown }).key === 'string') {
        const view = v as { key: string; title?: string };
        out.push({
          key: view.key,
          type: collectionName,
          title: view.title || view.key,
        });
      }
    }
  }
  return out;
}

interface ParsedWorkspace {
  id: string;
  name: string;
  workspace: WorkspaceJson;
  json: string;
  elapsedMs: number;
}

type AppPhase =
  | { kind: 'idle' }
  | { kind: 'parsing'; rootName: string; current: number; total: number }
  | {
      kind: 'ready';
      rootName: string;
      fileCount: number;
      workspaces: ParsedWorkspace[];
      activeId: string;
    }
  | { kind: 'error'; rootName: string; message: string };

export function App() {
  const [phase, setPhase] = useState<AppPhase>({ kind: 'idle' });
  const [viewKey, setViewKey] = useState<string>('');
  const [exportToast, setExportToast] = useState<string | null>(null);

  const handleDiagramMessage = useCallback((msg: DiagramMessage) => {
    if (msg.type === 'exportDiagram') {
      const key = typeof msg['viewKey'] === 'string' ? msg['viewKey'] : '';
      const format = typeof msg['format'] === 'string' ? msg['format'] : '';
      const dataURI = typeof msg['dataURI'] === 'string' ? msg['dataURI'] : '';
      if (key && (format === 'svg' || format === 'png') && dataURI) {
        downloadDataUri(safeFilename(key, format), dataURI);
      }
      return;
    }
    if (msg.type === 'exportCompleted') {
      const count = typeof msg['count'] === 'number' ? msg['count'] : 0;
      const format =
        typeof msg['format'] === 'string' ? msg['format'].toUpperCase() : '';
      const noun = count === 1 ? 'diagram' : 'diagrams';
      setExportToast(`Downloaded ${count} ${format} ${noun}`);
      window.setTimeout(() => setExportToast(null), 4000);
    }
  }, []);

  const active = useMemo(() => {
    if (phase.kind !== 'ready') return null;
    return phase.workspaces.find((w) => w.id === phase.activeId) ?? phase.workspaces[0];
  }, [phase]);

  const views = useMemo(
    () => (active ? listViews(active.workspace) : []),
    [active],
  );

  const parseLoadedProject = async (project: LoadedProject) => {
    const total = project.workspaces.length;
    setPhase({ kind: 'parsing', rootName: project.rootName, current: 0, total });
    setViewKey('');

    try {
      const parser = await getParser();
      const parsed: ParsedWorkspace[] = [];

      for (let i = 0; i < total; i++) {
        const entry = project.workspaces[i];
        setPhase({
          kind: 'parsing',
          rootName: project.rootName,
          current: i + 1,
          total,
        });
        const t0 = performance.now();
        const result = await parser.parse(
          entry.entryPath,
          entry.entryContent,
          project.filesMap,
        );
        parsed.push({
          id: entry.id,
          name: entry.name,
          workspace: result.workspace,
          json: result.json,
          elapsedMs: Math.round(performance.now() - t0),
        });
      }

      setPhase({
        kind: 'ready',
        rootName: project.rootName,
        fileCount: project.files.length,
        workspaces: parsed,
        activeId: parsed[0].id,
      });
    } catch (err) {
      setPhase({
        kind: 'error',
        rootName: project.rootName,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const closeWorkspace = () => {
    setPhase({ kind: 'idle' });
    setViewKey('');
  };

  const switchWorkspace = (id: string) => {
    if (phase.kind !== 'ready') return;
    setPhase({ ...phase, activeId: id });
    setViewKey('');
  };

  const isMulti = phase.kind === 'ready' && phase.workspaces.length > 1;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateRows: 'auto 1fr',
        height: '100vh',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <header
        style={{
          padding: '10px 20px',
          borderBottom: '1px solid #ddd',
          display: 'flex',
          gap: 16,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <strong style={{ fontSize: 16 }}>Structurize</strong>

        {phase.kind === 'ready' && (
          <>
            <span style={{ color: '#444', fontSize: 14 }}>{phase.rootName}</span>

            {isMulti && active && (
              <select
                value={active.id}
                onChange={(e) => switchWorkspace(e.target.value)}
                style={{
                  padding: '4px 8px',
                  fontSize: 13,
                  border: '1px solid #ccc',
                  borderRadius: 4,
                  background: 'white',
                  cursor: 'pointer',
                }}
              >
                {phase.workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            )}

            <span style={{ color: '#888', fontSize: 12 }}>
              {phase.fileCount} file{phase.fileCount === 1 ? '' : 's'}
              {isMulti
                ? ` · ${phase.workspaces.length} workspaces · `
                : ' · '}
              {views.length} view{views.length === 1 ? '' : 's'}
            </span>

            <button
              onClick={closeWorkspace}
              style={{
                marginLeft: 'auto',
                padding: '6px 12px',
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              Close
            </button>
          </>
        )}

        {phase.kind === 'parsing' && (
          <span style={{ color: '#666', fontSize: 13 }}>
            Parsing {phase.rootName}
            {phase.total > 1 ? ` (${phase.current}/${phase.total})` : ''}…
          </span>
        )}

        {phase.kind === 'error' && (
          <button
            onClick={closeWorkspace}
            style={{ marginLeft: 'auto', padding: '6px 12px', cursor: 'pointer' }}
          >
            Close
          </button>
        )}
      </header>

      {phase.kind === 'idle' && <WelcomePane onLoaded={parseLoadedProject} />}

      {phase.kind === 'parsing' && (
        <main
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#777',
          }}
        >
          {phase.total > 1
            ? `Parsing workspace ${phase.current} of ${phase.total}…`
            : 'Booting WASM parser and parsing workspace…'}
        </main>
      )}

      {phase.kind === 'error' && (
        <main style={{ padding: 24 }}>
          <pre
            style={{
              color: '#a00',
              background: '#fff5f5',
              border: '1px solid #fcc',
              borderRadius: 4,
              padding: 16,
              whiteSpace: 'pre-wrap',
              fontSize: 13,
            }}
          >
            Parse failed for "{phase.rootName}":{'\n\n'}
            {phase.message}
          </pre>
        </main>
      )}

      {phase.kind === 'ready' && active && (
        <main style={{ display: 'grid', gridTemplateColumns: '240px 1fr', minHeight: 0 }}>
          <aside
            style={{
              borderRight: '1px solid #ddd',
              overflowY: 'auto',
              padding: '8px 0',
            }}
          >
            <ViewListItem
              label="Home"
              type="workspace"
              active={viewKey === ''}
              onClick={() => setViewKey('')}
            />
            {views.map((v) => (
              <ViewListItem
                key={v.key}
                label={v.title}
                type={v.type}
                active={viewKey === v.key}
                onClick={() => setViewKey(v.key)}
              />
            ))}
          </aside>
          <DiagramFrame
            workspaceJSON={active.json}
            viewKey={viewKey}
            onMessage={handleDiagramMessage}
          />
        </main>
      )}

      {exportToast && (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            right: 24,
            background: '#222',
            color: '#fff',
            padding: '10px 16px',
            borderRadius: 6,
            fontSize: 13,
            boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
          }}
        >
          {exportToast}
        </div>
      )}
    </div>
  );
}

interface ViewListItemProps {
  label: string;
  type: string;
  active: boolean;
  onClick: () => void;
}

function ViewListItem({ label, type, active, onClick }: ViewListItemProps) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '8px 14px',
        border: 0,
        background: active ? '#e7f0ff' : 'transparent',
        cursor: 'pointer',
        fontSize: 13,
        borderLeft: active ? '3px solid #3066B7' : '3px solid transparent',
      }}
    >
      <div style={{ fontWeight: active ? 600 : 400 }}>{label}</div>
      <div style={{ fontSize: 11, color: '#888' }}>{type}</div>
    </button>
  );
}
