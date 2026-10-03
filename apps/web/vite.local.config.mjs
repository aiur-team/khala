// Builds the local web app that `khala local serve` hosts on 127.0.0.1 into
// dist-local: the hosted screens composed over the loopback helper
// (src/local-main.tsx). No Netlify headers, no public dir, no Google Fonts and
// no Matrix: the bundle guard below fails the build if any reaches it.
import { defineConfig } from 'vite';

// import.meta.dirname, not node:path/url: apps/web may not import node built-ins.
const here = import.meta.dirname;

/** Module ids that must never reach the local bundle (D3, AE10). */
export const FORBIDDEN_LOCAL_MODULE = new RegExp([
  String.raw`[\\/]node_modules[\\/](?:matrix-js-sdk|@matrix-org)[\\/]`,
  String.raw`[\\/]packages[\\/]messaging[\\/]src[\\/]browser-device[\\/]`,
  String.raw`[\\/]src[\\/]composition[\\/]human[\\/](?:matrix-browser|browser-api|hosted-config|tab-handoff)\.tsx?$`,
].join('|'));

const forbiddenStrings = ['matrix-js-sdk', 'initRustCrypto', '.wasm', '/api/human/', 'khala.aiur.team', 'fonts.googleapis.com'];

/** Fails the build when hosted code, hosted origins or WebAssembly reach the bundle. */
function localBundleGuard() {
  return {
    name: 'khala-local-bundle-guard',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type === 'asset' && output.fileName.endsWith('.wasm')) this.error(`WebAssembly in the local bundle: ${output.fileName}`);
        if (output.type !== 'chunk') continue;
        for (const id of output.moduleIds) if (FORBIDDEN_LOCAL_MODULE.test(id)) this.error(`forbidden module in the local bundle: ${id}`);
        for (const value of forbiddenStrings) if (output.code.includes(value)) this.error(`forbidden string in the local bundle: ${output.fileName}: ${value}`);
      }
    },
  };
}

/** Vite names the page after its input; the helper serves index.html (contracts L11). */
function localIndexHtml() {
  return {
    name: 'khala-local-index-html',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const page = bundle['local.html'];
      if (!page || page.type !== 'asset') return this.error(`local.html is missing from the local bundle: ${Object.keys(bundle).join(', ')}`);
      delete bundle['local.html'];
      this.emitFile({ type: 'asset', fileName: 'index.html', source: page.source });
    },
  };
}

export default defineConfig({
  root: here,
  base: '/',
  publicDir: false,
  logLevel: 'warn',
  plugins: [localBundleGuard(), localIndexHtml()],
  build: {
    outDir: `${here}/dist-local`,
    emptyOutDir: true,
    rollupOptions: { input: `${here}/local.html` },
  },
});
