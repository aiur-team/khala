// Builds the internal-mode browser bundle (src/internal) into
// dist/internal-web, the INTERNAL_WEB_BUNDLE_DIRECTORY the `khala internal`
// launcher serves on 127.0.0.1. It is a separate entry with its own output
// directory: it never writes the hosted dist/index.html or dist/assets, and the
// hosted entry has no import path into it.
//
// The loopback server's CSP admits only same-origin external scripts and
// styles, and it serves the document at both `/` and `/channels/<id>`, so
// assets use absolute `/assets/...` URLs and no inline module preload.
import { defineConfig } from 'vite';

// import.meta.dirname, not node:path/url: apps/web may not import node built-ins.
const here = import.meta.dirname;

export default defineConfig({
  root: `${here}/src/internal`,
  base: '/',
  // The hosted public directory (and any hosted-only env) never enters this bundle.
  publicDir: false,
  envPrefix: 'KHALA_INTERNAL_PUBLIC_',
  logLevel: 'warn',
  build: {
    outDir: `${here}/dist/internal-web`,
    emptyOutDir: true,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
  },
});
