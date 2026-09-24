// Builds the public splash page (src/landing) into dist/landing. netlify.toml
// rewrites `/` to dist/landing/index.html, so the splash owns the site root
// while every other path keeps its existing routing (/api/* to the control
// function, anything else to the app shell's /index.html).
//
// The splash is kept apart from the application entry on purpose: it has its
// own output directory, so it neither writes nor empties dist/index.html or
// dist/assets. Run it after any build step that empties dist.
import { defineConfig } from 'vite';

// import.meta.dirname, not node:path/url: apps/web may not import node built-ins.
const here = import.meta.dirname;
const root = `${here}/src/landing`;

export default defineConfig({
  root,
  base: '/landing/',
  publicDir: `${here}/src/landing/public`,
  logLevel: 'warn',
  build: {
    outDir: `${here}/dist/landing`,
    emptyOutDir: true,
  },
});
