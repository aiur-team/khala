import { defineConfig } from 'vite';
export default defineConfig({ optimizeDeps: { exclude: ['@matrix-org/matrix-sdk-crypto-wasm'] } });
