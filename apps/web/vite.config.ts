import { defineConfig, loadEnv, type Plugin } from 'vite';
import { renderNetlifyHeaders } from './src/composition/human/hosted-config';

// Publishes dist/_headers with a CSP whose connect-src names exactly this
// deploy context's PUBLIC_HOMESERVER_ORIGIN (see hosted-config.ts).
function netlifyHeaders(homeserverOrigin: string | undefined): Plugin {
  return {
    name: 'khala-netlify-headers',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '_headers', source: renderNetlifyHeaders(homeserverOrigin) });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, 'PUBLIC_');
  return {
    envPrefix: 'PUBLIC_',
    plugins: [netlifyHeaders(env.PUBLIC_HOMESERVER_ORIGIN)],
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
  };
});
