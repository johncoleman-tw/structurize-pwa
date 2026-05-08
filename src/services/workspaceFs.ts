// Loads a workspace folder from the user's file system into the absolute-path
// → contents map the WASM parser expects (window.__structurizrFiles).
//
// Three universal entry points:
//   • loadFromFileList   — <input type="file" webkitdirectory>
//   • loadFromDrop       — drag-and-drop folder onto the window
//   • loadFromDirHandle  — File System Access API (Chromium only, optional)
//
// Path scheme: every file gets a virtual absolute path of the form
//   `/<webkitRelativePath>` — e.g. `/myproject/workspace.dsl`.
// The Java !include resolver inside the WASM joins paths relative to the
// includer's directory, so as long as every file in the picked folder lives
// under the same virtual root, includes resolve correctly.
//
// Multi-workspace detection: every `workspace.dsl` file in the picked tree
// is treated as one entry, whether or not it uses `workspace extends`. This
// is intentionally looser than the Swift app's findAllExtensionWorkspaces
// (which requires `workspace extends`) — it picks up plain standalone
// workspaces in subdirectories that the strict rule would otherwise skip.
// Fallback for projects with no workspace.dsl: any single .dsl file
// containing the `workspace` keyword.

const ALLOWED_EXTS = new Set(['dsl', 'md', 'adoc', 'markdown']);

export interface WorkspaceFile {
  /** Virtual absolute path used as the WASM file-map key. */
  path: string;
  /** UTF-8 contents. */
  content: string;
  /** Base filename (no directories). */
  name: string;
}

export interface WorkspaceEntry {
  /** Stable id, derived from the entry's parent directory name. */
  id: string;
  /** Display label — parent directory name (or root folder). */
  name: string;
  /** Virtual absolute path to this entry's workspace.dsl. */
  entryPath: string;
  /** Contents of the entry file. */
  entryContent: string;
}

export interface LoadedProject {
  /** Human label for the picked folder — shown in the header. */
  rootName: string;
  /** Every text file we loaded, in discovery order. */
  files: WorkspaceFile[];
  /** path → contents map ready for window.__structurizrFiles. */
  filesMap: Record<string, string>;
  /** One entry per workspace found. Always 1+. */
  workspaces: WorkspaceEntry[];
}

export class WorkspaceLoadError extends Error {}

// ── Public entry points ───────────────────────────────────────────────────

export async function loadFromFileList(fileList: FileList): Promise<LoadedProject> {
  const files: WorkspaceFile[] = [];
  let rootName = 'workspace';

  for (let i = 0; i < fileList.length; i++) {
    const f = fileList[i];
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
    if (!rel) continue;
    const firstSegment = rel.split('/')[0];
    if (firstSegment) rootName = firstSegment;
    if (!ALLOWED_EXTS.has(extOf(f.name))) continue;
    const content = await f.text();
    files.push({ path: '/' + rel, content, name: f.name });
  }

  return assemble(files, rootName);
}

export async function loadFromDrop(items: DataTransferItemList): Promise<LoadedProject> {
  const entries: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const e = items[i].webkitGetAsEntry?.();
    if (e) entries.push(e);
  }
  if (entries.length === 0) {
    throw new WorkspaceLoadError('Nothing dropped, or browser does not expose FileSystemEntry.');
  }

  let rootName = 'workspace';
  if (entries.length === 1 && entries[0].isDirectory) {
    rootName = entries[0].name;
  } else if (entries.length === 1 && entries[0].isFile) {
    rootName = entries[0].name.replace(/\.[^.]+$/, '') || 'workspace';
  }

  const files: WorkspaceFile[] = [];
  for (const entry of entries) {
    await walkEntry(entry, files);
  }
  return assemble(files, rootName);
}

export async function loadFromDirHandle(
  handle: FileSystemDirectoryHandle,
): Promise<LoadedProject> {
  const files: WorkspaceFile[] = [];
  await walkHandle(handle, '/' + handle.name, files);
  return assemble(files, handle.name);
}

/** True if the browser supports `window.showDirectoryPicker` (Chromium-only today). */
export function supportsDirectoryPicker(): boolean {
  return typeof (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

/** Convenience wrapper around showDirectoryPicker. Throws if unsupported or cancelled. */
export async function pickDirectory(): Promise<LoadedProject> {
  const w = window as Window & {
    showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  };
  if (!w.showDirectoryPicker) {
    throw new WorkspaceLoadError('showDirectoryPicker is not supported in this browser.');
  }
  const handle = await w.showDirectoryPicker({ mode: 'read' });
  return loadFromDirHandle(handle);
}

// ── Internal walkers ──────────────────────────────────────────────────────

async function walkEntry(entry: FileSystemEntry, out: WorkspaceFile[]): Promise<void> {
  if (entry.isFile) {
    if (!ALLOWED_EXTS.has(extOf(entry.name))) return;
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File>((resolve, reject) => {
      fileEntry.file(resolve, reject);
    });
    const content = await file.text();
    out.push({ path: fileEntry.fullPath, content, name: fileEntry.name });
    return;
  }
  if (entry.isDirectory) {
    const dirEntry = entry as FileSystemDirectoryEntry;
    const reader = dirEntry.createReader();
    while (true) {
      const batch: FileSystemEntry[] = await new Promise((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (batch.length === 0) break;
      for (const child of batch) {
        await walkEntry(child, out);
      }
    }
  }
}

async function walkHandle(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  out: WorkspaceFile[],
): Promise<void> {
  const iter = (dir as FileSystemDirectoryHandle & {
    entries: () => AsyncIterable<[string, FileSystemHandle]>;
  }).entries();
  for await (const [name, handle] of iter) {
    if (handle.kind === 'file') {
      if (!ALLOWED_EXTS.has(extOf(name))) continue;
      const file = await (handle as FileSystemFileHandle).getFile();
      const content = await file.text();
      out.push({ path: prefix + '/' + name, content, name });
    } else if (handle.kind === 'directory') {
      await walkHandle(handle as FileSystemDirectoryHandle, prefix + '/' + name, out);
    }
  }
}

// ── Assembly + entry-point detection ──────────────────────────────────────

function assemble(files: WorkspaceFile[], rootName: string): LoadedProject {
  if (files.length === 0) {
    throw new WorkspaceLoadError(
      `No .dsl/.md files found in "${rootName}". Pick a folder containing a workspace.dsl.`,
    );
  }

  const dslFiles = files.filter((f) => extOf(f.name) === 'dsl');
  if (dslFiles.length === 0) {
    throw new WorkspaceLoadError(
      `No .dsl files found in "${rootName}". The folder needs at least one workspace.dsl.`,
    );
  }

  const workspaces = findWorkspaceEntries(dslFiles);
  if (workspaces.length === 0) {
    throw new WorkspaceLoadError(
      `Could not find an entry-point DSL in "${rootName}". Expected workspace.dsl or a .dsl file containing the "workspace" keyword.`,
    );
  }

  const filesMap: Record<string, string> = {};
  for (const f of files) filesMap[f.path] = f.content;

  return { rootName, files, filesMap, workspaces };
}

/**
 * Find every `workspace.dsl` in the tree and treat each as one entry —
 * whether or not it uses `workspace extends`. A folder containing two or
 * more such files becomes a multi-workspace project; a folder with one is
 * single-entry. Falls back to any single .dsl file with the `workspace`
 * keyword for projects that don't follow the workspace.dsl naming
 * convention at all.
 */
function findWorkspaceEntries(dslFiles: WorkspaceFile[]): WorkspaceEntry[] {
  const wsDsl = dslFiles.filter((f) => f.name === 'workspace.dsl');
  if (wsDsl.length > 0) {
    // Sort by path for stable ordering across reloads.
    return wsDsl
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(makeEntry);
  }

  const anyWorkspace = dslFiles.find((f) => /\bworkspace\b/.test(f.content));
  return anyWorkspace ? [makeEntry(anyWorkspace)] : [];
}

/**
 * Turn a .dsl file into a workspace entry. The id/display name comes from
 * the parent directory — that's how multi-workspace projects are typically
 * structured (one subdirectory per workspace).
 */
function makeEntry(f: WorkspaceFile): WorkspaceEntry {
  const parts = f.path.split('/').filter(Boolean);
  // For "/myproject/sub-a/workspace.dsl" we want "sub-a";
  // for "/myproject/workspace.dsl" we want "myproject" (the root folder).
  const parent = parts.length >= 2 ? parts[parts.length - 2] : 'root';
  return {
    id: parent,
    name: parent,
    entryPath: f.path,
    entryContent: f.content,
  };
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}
