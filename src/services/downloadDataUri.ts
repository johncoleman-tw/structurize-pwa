// Trigger a browser download from a `data:` URI. The Structurizr JS export
// pipeline emits both base64 PNGs (`data:image/png;base64,...`) and
// URL-encoded SVGs (`data:image/svg+xml;...,...`). Anchors handle both.

export function downloadDataUri(filename: string, dataUri: string): void {
  const a = document.createElement('a');
  a.href = dataUri;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/** Sanitise a view key into something safe for a filename. */
export function safeFilename(key: string, ext: string): string {
  const cleaned = key.replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '') || 'diagram';
  return `${cleaned}.${ext}`;
}
