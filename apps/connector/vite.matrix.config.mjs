import { defineConfig } from 'vite';

export default defineConfig({
  root: 'substrate-browser',
  base: '/',
  build: {
    outDir: '../dist/substrate-browser',
    emptyOutDir: true,
    target: 'es2022',
  },
});
