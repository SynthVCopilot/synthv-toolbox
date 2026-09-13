# Progress

- Read the Electron main-process, preload, Vite, and HTML entrypoint sources.
- Created this task audit before modifying product code.
- Installed the desktop package dependencies, built the runtime protocol, and built the renderer.
- Confirmed that `dist/index.html` refers to `/assets/index-*.js`, `/assets/index-*.css`, and `/assets/synthv-toolbox-logo.svg` while Electron loads it through `file:`.
- Set Vite's production asset base to `./`.
- Added `test/electron-renderer-assets.mjs` and registered it in `test:contracts`; it checks the built HTML has relative asset URLs and rejects filesystem-root asset URLs.
- Passed `npm run build:electron`, `npm run test:contracts`, and `npm run test:electron-main` from `src/PiDesktop.Tauri`.
- Committed the renderer asset-path repair locally.
