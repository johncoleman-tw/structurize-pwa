# Structurize

A view-only Progressive Web App for browsing [Structurizr DSL](https://docs.structurizr.com/dsl) workspaces. Open a folder of `.dsl` files and the app parses them, lists every diagram, and renders them with the upstream Structurizr JS UI — all in the browser, with no server round-trip. Files never leave your machine.

Under the hood it reuses two artifacts from the native [Structurize macOS app](https://github.com/johncoleman-tw/structurize):

- A GraalVM-compiled WebAssembly build of the Java DSL parser (~15 MB), hosted in a same-origin iframe.
- The Structurizr JointJS-based diagram renderer, hosted in a second iframe.

The React shell handles file pickup, workspace selection, and view navigation. Image export (SVG / PNG) downloads through the browser. Multi-workspace projects (folders containing multiple `workspace extends` files) are detected automatically and exposed via a workspace switcher in the header.

## Usage

Open the deployed PWA at **https://johncoleman-tw.github.io/structurize-pwa/**

1. Click **Open Folder…** (or drag-drop a folder onto the page) and pick a directory containing a `workspace.dsl`.
2. Wait for the parser to boot — first visit downloads the 15 MB WASM module; subsequent visits load it from the service-worker cache.
3. Pick a view from the left sidebar to render it. The home page shows a card for every view in the active workspace.
4. To save a diagram, use the existing **Export** menu inside the diagram view — files download to your browser's default download folder.
5. To install as a desktop/mobile app, click the install icon in your browser's address bar (Chrome, Edge, Brave, Arc on desktop; Add to Home Screen on iOS/Android).

Once visited online the app works fully offline — the service worker caches the app shell, the WASM parser, and the renderer. Reopen the installed PWA on a flight with no network and it still parses and renders.

### Browser support

- Chrome / Edge / Brave / Arc 119+
- Firefox 120+
- Safari 18.2+ (macOS / iOS)

WebAssembly GC is required by the parser; older browsers will not work.

## Local development

```bash
pnpm install
pnpm dev          # http://localhost:5173/
pnpm build        # produces dist/
pnpm preview      # serve the production build locally
```

The `predev` and `prebuild` hooks run `scripts/copy-assets.mjs`, which copies the WASM parser and diagram-viewer JS from the upstream `structurize` macOS app repo into `public/wasm-host/` and `public/diagram-viewer/`. The script auto-detects a sibling checkout; override with `STRUCTURIZE_REPO=/abs/path` if it lives elsewhere. CI sets `SKIP_COPY_ASSETS=1` and uses the vendored copies committed to the repo.

## Deployment

The included [GitHub Actions workflow](./.github/workflows/deploy.yml) builds the PWA and publishes to GitHub Pages on every push to `main`. The workflow derives `VITE_BASE` from the repo name so the same code deploys to any Pages URL without further config.

## License

The PWA shell is unlicensed source code in this repo. The bundled WASM parser and diagram-renderer JS belong to the upstream Structurizr project and are governed by their respective licenses.
