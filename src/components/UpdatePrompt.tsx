import { useRegisterSW } from 'virtual:pwa-register/react';

/**
 * Prompts the user to activate a newly-downloaded service-worker version.
 *
 * vite-plugin-pwa is configured with `registerType: 'prompt'` (see
 * vite.config.ts), which means new SW versions install in the background
 * but stay in the "waiting" state until we explicitly call
 * `updateServiceWorker(true)`. This lets the user control when a new
 * build takes over — useful as a defence against silent replacement
 * after a compromised deploy.
 *
 * In dev mode the SW is disabled (`devOptions.enabled: false`) and
 * `needRefresh` stays false, so this component renders nothing.
 */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError(error) {
      console.error('[sw] registration error:', error);
    },
  });

  if (!needRefresh) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 24,
        left: 24,
        background: '#222',
        color: '#fff',
        padding: '12px 16px',
        borderRadius: 6,
        fontSize: 13,
        boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        maxWidth: 420,
      }}
    >
      <span style={{ flex: 1 }}>A new version of Structurize is available.</span>
      <button
        onClick={() => updateServiceWorker(true)}
        style={{
          padding: '6px 14px',
          fontSize: 13,
          cursor: 'pointer',
          background: '#3066B7',
          color: 'white',
          border: 0,
          borderRadius: 4,
        }}
      >
        Update
      </button>
      <button
        onClick={() => setNeedRefresh(false)}
        style={{
          padding: '6px 12px',
          fontSize: 13,
          cursor: 'pointer',
          background: 'transparent',
          color: '#bbb',
          border: '1px solid #555',
          borderRadius: 4,
        }}
      >
        Later
      </button>
    </div>
  );
}
