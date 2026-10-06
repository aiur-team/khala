#!/usr/bin/env node
// Checkout entry: runs the TypeScript source through tsx. The published package's
// entry is the esbuild bundle of src/cli-bundle.ts (see scripts/build-package.mjs).
import { existsSync } from 'node:fs';
import { register } from 'tsx/esm/api';

register();
const found = relative => {
  const url = new URL(relative, import.meta.url);
  return existsSync(url) ? () => import(url.href) : undefined;
};
const { runCli } = await import('../src/cli.ts');
process.exitCode = await runCli(process.argv.slice(2), {
  mcp: () => found('../src/mcp/main.ts'),
  watch: () => found('../src/watch.ts'),
  local: () => found('../src/local/cli.ts'),
  install: () => found('../src/install/main.ts'),
  wake: () => found('../src/wake/cli.ts'),
  hook: name => found(`../hooks/${name}.ts`),
});
