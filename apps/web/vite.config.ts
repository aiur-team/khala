import { defineConfig } from 'vite';

export default defineConfig({
  envPrefix: 'PUBLIC_',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
