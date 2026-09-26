// The packaged installer payload. The published package carries the self-contained CLI
// runtime (`dist/khala.js`), the OpenCode plugin (`dist/opencode.js`), and the reviewed harness
// assets under `dist/payload/`. Setup stages the runtime under a versioned directory, the stable
// `khala` launcher every installed harness entry runs by its absolute path, and a stable copy of
// the OpenCode plugin.
import fs from 'node:fs/promises';
import path from 'node:path';
import { readClaudePluginAssets } from './adapters/claude.js';
import { shellWord } from './paths.js';
import type { InstallerFile, SetupPayloadSource } from './plan.js';
import type { HarnessId, SetupEnvironment } from './types.js';

/** Below the package's `dist/`: the Claude plugin files and the Codex skill. */
export const PAYLOAD_DIRECTORY = 'payload';
export const PAYLOAD_CLAUDE_PLUGIN = 'claude-plugin';
export const PAYLOAD_CODEX_SKILL = 'codex/SKILL.md';

/** Harnesses whose installed entries run `$XDG_DATA_HOME/khala/bin/khala`; none depends on PATH. */
const LAUNCHER_HARNESSES: readonly HarnessId[] = ['claude', 'codex', 'opencode', 'cursor'];

export type PackagedPayload = Readonly<{
  /** The package version; the runtime and the Claude marketplace live below `versions/<version>/`. */
  version: string;
  runtime: Uint8Array;
  openCodePlugin: Uint8Array;
  claudePlugin: ReadonlyMap<string, Uint8Array>;
  codexSkill: Uint8Array;
}>;

/** Reads the payload a packaged `dist/` directory carries; a missing file fails the read. */
export async function readPackagedPayload(distDirectory: string): Promise<PackagedPayload> {
  const read = async (...parts: string[]) => new Uint8Array(await fs.readFile(path.join(distDirectory, ...parts)));
  const manifest = JSON.parse(await fs.readFile(path.join(distDirectory, '..', 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof manifest.version !== 'string') throw new Error('khala package version is missing');
  return {
    version: manifest.version,
    runtime: await read('khala.js'),
    openCodePlugin: await read('opencode.js'),
    claudePlugin: await readClaudePluginAssets(path.join(distDirectory, PAYLOAD_DIRECTORY, PAYLOAD_CLAUDE_PLUGIN)),
    codexSkill: await read(PAYLOAD_DIRECTORY, ...PAYLOAD_CODEX_SKILL.split('/')),
  };
}

/**
 * The stable launcher. It runs the versioned runtime with the Node that ran setup, so the
 * bytes name only absolute paths and never a port, token, or channel.
 */
export function launcherScript(nodePath: string, runtimePath: string): Uint8Array {
  if (!path.isAbsolute(nodePath) || !path.isAbsolute(runtimePath)) throw new Error('launcher paths must be absolute');
  return new TextEncoder().encode(`#!/bin/sh\nexec ${shellWord(nodePath)} ${shellWord(runtimePath)} "$@"\n`);
}

/** The installer files for one environment, each tagged with the harnesses that run it. */
export function installerFiles(
  environment: Pick<SetupEnvironment, 'xdgDataHome'>, payload: PackagedPayload, nodePath: string,
): readonly InstallerFile[] {
  const root = path.join(environment.xdgDataHome, 'khala');
  const runtime = path.join(root, 'versions', payload.version, 'khala.js');
  return [
    { path: runtime, component: 'payload', bytes: payload.runtime, harnesses: LAUNCHER_HARNESSES },
    { path: path.join(root, 'bin', 'khala'), component: 'launcher', bytes: launcherScript(nodePath, runtime), harnesses: LAUNCHER_HARNESSES },
    // OpenCode imports its plugin from this stable path (`openCodePaths().plugin`).
    { path: path.join(root, 'bin', 'opencode.js'), component: 'payload', bytes: payload.openCodePlugin, harnesses: ['opencode'] },
  ];
}

export function packagedPayloadSource(payload: PackagedPayload, nodePath: string): SetupPayloadSource {
  return async environment => installerFiles(environment, payload, nodePath);
}
