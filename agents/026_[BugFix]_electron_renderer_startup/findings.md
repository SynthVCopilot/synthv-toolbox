# Findings

- [Startup screen remains visible] -> Build the renderer and inspect `dist/index.html` -> Vite emits `/assets/...` URLs by default. `BrowserWindow.loadFile()` uses a `file:` URL, so those absolute paths resolve at the filesystem root and the renderer module never loads.
- [Initial build cannot start] -> Run `npm ci` followed by `npm run build:protocol` -> a fresh worktree needs installed TypeScript and generated runtime protocol declarations before the renderer can compile.
- [Relative Vite base] -> Set `base: "./"` and rebuild -> the generated document now references `./assets/index-*.js`, `./assets/index-*.css`, and `./assets/synthv-toolbox-logo.svg`, which resolve beside `file:` `index.html` in the packaged ASAR.
