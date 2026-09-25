// Screenshot baselines for the public splash (src/landing) and the React shell
// harness (src/shell/browser-harness). Run through `pnpm test:visual`.
//
// Baselines are only comparable when they come from the same browser build,
// fonts and rasteriser, so they are taken and checked inside the pinned
// mcr.microsoft.com/playwright image that CI uses (see .github/workflows/ci.yml).
// A run outside that image is expected to differ.
//
// Each web server is this file run as a script (`tsx playwright.visual.config.ts
// --serve <target>`), so the preview options, including the production CSP,
// live here and nowhere else.
import { defineConfig } from '@playwright/test';
import type { InlineConfig } from 'vite';

// import.meta.dirname, not node:path/url: apps/web may not import node built-ins.
const here = import.meta.dirname;

// The site-wide header from netlify.toml (`[[headers]] for = "/*"`). The splash
// spec checks the served header still equals the netlify.toml value.
export const PRODUCTION_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";

export const LANDING_PORT = 4311;
export const SHELL_PORT = 4312;

const servers: Record<string, { port: number; build: InlineConfig; preview: InlineConfig }> = {
  // The production splash build, written to dist/landing exactly as `pnpm build` does.
  landing: {
    port: LANDING_PORT,
    build: { configFile: `${here}/vite.landing.config.mjs`, logLevel: 'error' },
    preview: {
      configFile: `${here}/vite.landing.config.mjs`,
      logLevel: 'error',
      preview: { headers: { 'Content-Security-Policy': PRODUCTION_CSP } },
    },
  },
  // The same harness the shell browser spec builds.
  shell: {
    port: SHELL_PORT,
    build: {
      configFile: false,
      root: `${here}/src/shell/browser-harness`,
      build: { outDir: `${here}/dist/visual-shell-harness`, emptyOutDir: true },
      logLevel: 'error',
    },
    preview: {
      configFile: false,
      root: `${here}/src/shell/browser-harness`,
      build: { outDir: `${here}/dist/visual-shell-harness` },
      logLevel: 'error',
    },
  },
};

const serveFlag = process.argv.indexOf('--serve');
if (serveFlag !== -1) {
  const target = servers[process.argv[serveFlag + 1] ?? ''];
  if (!target) throw new Error(`--serve expects one of: ${Object.keys(servers).join(', ')}`);
  const { build, preview, mergeConfig } = await import('vite');
  await build(target.build);
  await preview(mergeConfig(target.preview, { preview: { host: '127.0.0.1', port: target.port, strictPort: true } }));
}

const server = (name: string, port: number) => ({
  command: `tsx playwright.visual.config.ts --serve ${name}`,
  cwd: here,
  url: `http://127.0.0.1:${port}/`,
  reuseExistingServer: false,
  timeout: 120_000,
  stdout: 'ignore' as const,
  stderr: 'pipe' as const,
});

export default defineConfig({
  testDir: './src',
  testMatch: '**/*.visual.spec.ts',
  // No platform or project suffix: baselines exist for the pinned image only.
  snapshotPathTemplate: '{testDir}/{testFileDir}/{testFileName}-snapshots/{arg}{ext}',
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  // CI never writes a baseline, not even a missing one: a missing baseline fails.
  updateSnapshots: process.env.CI ? 'none' : 'missing',
  expect: {
    toHaveScreenshot: { maxDiffPixels: 0, animations: 'disabled', caret: 'hide', scale: 'css' },
  },
  use: {
    browserName: 'chromium',
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
  },
  webServer: [server('landing', LANDING_PORT), server('shell', SHELL_PORT)],
});
