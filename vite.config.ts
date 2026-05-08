import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Base path. Default `/` for local dev and the offline-bundle launcher.
// GitHub Pages serves at `/<repo-name>/` — set `VITE_BASE=/<repo-name>/` in CI.
const base = process.env.VITE_BASE || '/';

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      // 'prompt' (vs 'autoUpdate'): a new SW is downloaded in the background
      // but parks in the waiting state. Activation only happens when the user
      // explicitly clicks the update button rendered by UpdatePrompt.tsx.
      // This means a compromised build cannot silently replace the running
      // version on the user's device — they see the prompt and decide.
      registerType: 'prompt',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Structurize',
        short_name: 'Structurize',
        description: 'View Structurizr DSL workspaces in the browser.',
        start_url: base,
        scope: base,
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#3066B7',
        icons: [
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        // The 15 MB WASM blows past Workbox's 2 MB default precache cap;
        // raise the limit and let runtime caching pull it in on first use.
        maximumFileSizeToCacheInBytes: 25 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        // Keep the heavy parser/renderer assets OUT of the precache manifest
        // (slow first install, big bandwidth). They get cached on first fetch.
        globIgnores: ['**/wasm-host/**', '**/diagram-viewer/**'],
        // Workbox's SPA navigateFallback defaults to serving index.html for
        // any navigation that doesn't match a precached asset. That's right
        // for client routes — but iframes navigating to parser-bootstrap.html
        // or DiagramViewer.html ARE navigations, and we must NOT have them
        // fall through to index.html. The runtime-caching rules below handle
        // those URLs; this denylist makes sure navigateFallback gets out of
        // the way first.
        navigateFallbackDenylist: [
          /\/wasm-host\//,
          /\/diagram-viewer\//,
        ],
        runtimeCaching: [
          {
            urlPattern: /\/wasm-host\/.*\.(?:wasm|js|html)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'structurize-wasm-parser',
              expiration: { maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /\/diagram-viewer\/.*$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'structurize-diagram-viewer',
              expiration: { maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
      devOptions: {
        enabled: false, // SW off in dev; HMR + SW interact badly.
      },
    }),
  ],
  server: {
    headers: {
      // Future-proof for SharedArrayBuffer-based parsers; harmless today.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
    watch: {
      // The vendored WASM/JS in these directories are rewritten by `predev`
      // (copy-assets), which bumps mtime even when content is identical.
      // Vite would then send a "page reload" to any iframe pointing at them,
      // which kills the GraalVM boot mid-flight. They're static drops — don't
      // watch them.
      ignored: [
        '**/public/wasm-host/**',
        '**/public/diagram-viewer/**',
      ],
    },
  },
  build: {
    target: 'es2022',
  },
});
