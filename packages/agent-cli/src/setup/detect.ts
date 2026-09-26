// Read-only harness discovery. `detectHarness` finds an executable and a version string through
// the injected `SetupProbe`; `createNodeSetupProbe` is the production probe, bounded so a
// user-selected vendor `--version` process cannot hang, flood, or outlive the CLI.
import { spawn } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  HarnessDetection, HarnessId, HarnessObservation, SetupAdapter, SetupEnvironment, SetupProbe,
} from './types.js';

type Descriptor = Readonly<{ executable: string; versionArgs: readonly string[]; version: RegExp }>;

const DESCRIPTORS: Readonly<Record<HarnessId, Descriptor>> = Object.freeze({
  claude: { executable: 'claude', versionArgs: ['--version'], version: /^(\d+\.\d+\.\d+)(?: \(Claude Code\))?$/u },
  codex: { executable: 'codex', versionArgs: ['--version'], version: /^(?:codex-cli )?(\d+\.\d+\.\d+)$/u },
  opencode: { executable: 'opencode', versionArgs: ['--version'], version: /^(?:opencode )?v?(\d+\.\d+\.\d+)$/u },
});

/**
 * Finds the harness executable and parses its version. Absence (`executable: null`) and a
 * failed or unparseable probe (`version: null`) stay distinct. Generic discovery never marks a
 * version supported: only a harness adapter holding a certified version matrix may.
 */
export async function detectHarness(environment: SetupEnvironment, harness: HarnessId): Promise<HarnessDetection> {
  const descriptor = DESCRIPTORS[harness];
  const executable = await environment.probe.resolveExecutable(descriptor.executable);
  if (executable === null) return { executable: null, version: null, supported: false };
  let stdout: string;
  try { stdout = await environment.probe.runVersion(executable, descriptor.versionArgs); }
  catch { return { executable, version: null, supported: false }; }
  // Only the matched version token survives; raw process output never leaves this function.
  return { executable, version: descriptor.version.exec(stdout.trim())?.[1] ?? null, supported: false };
}

/**
 * Stand-in adapter for a harness whose real adapter has not landed. It reports what discovery
 * can prove, inspects nothing, and plans nothing, so a detected harness reads as unsupported.
 */
export function createDiscoveryOnlyAdapter(harness: HarnessId): SetupAdapter {
  return Object.freeze({
    harness,
    detect: (environment: SetupEnvironment) => detectHarness(environment, harness),
    async inspect(_environment: SetupEnvironment, detection: HarnessDetection): Promise<HarnessObservation> {
      const diagnostics = detection.executable === null ? [] : [{
        code: detection.version === null ? 'version_probe_failed' : 'adapter_unavailable',
        severity: 'warning' as const,
        harness,
        message: detection.version === null
          ? 'The harness executable was found but its version could not be determined.'
          : 'This Khala release cannot configure this harness yet.',
      }];
      return { detection, components: [], route: 'unknown', diagnostics };
    },
    plan: () => [],
  });
}

export const VERSION_PROBE_LIMITS = Object.freeze({ timeoutMs: 5_000, outputBytes: 16_384 });

export type NodeSetupProbeOptions = Readonly<{
  /** Absolute PATH directories, already filtered by `resolveSetupPaths`. */
  pathEntries: readonly string[];
  /** The complete environment a version probe receives; nothing is inherited from this process. */
  environment: Readonly<Record<string, string>>;
}>;

export function createNodeSetupProbe(options: NodeSetupProbeOptions): SetupProbe {
  return Object.freeze({
    async resolveExecutable(name: string) {
      if (name.length === 0 || name.includes('/') || name.includes('\0')) return null;
      for (const directory of options.pathEntries) {
        const candidate = path.join(directory, name);
        try {
          await fs.access(candidate, constants.X_OK);
          if ((await fs.stat(candidate)).isFile()) return candidate;
        } catch { /* not executable here; keep searching */ }
      }
      return null;
    },
    runVersion: (executable: string, args: readonly string[]) => runBounded(executable, args, options.environment),
    async readFile(file: string) {
      let handle: fs.FileHandle;
      try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
      try { return new Uint8Array(await handle.readFile()); } finally { await handle.close(); }
    },
    async listDirectory(directory: string) {
      try { return (await fs.readdir(directory)).sort(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    },
  });
}

function runBounded(executable: string, args: readonly string[], environment: Readonly<Record<string, string>>): Promise<string> {
  if (!path.isAbsolute(executable)) return Promise.reject(new Error('relative_executable'));
  return new Promise((resolve, reject) => {
    // `detached` puts the probe in its own process group so a timeout or overflow kills its
    // descendants too, not only the direct child.
    const child = spawn(executable, [...args], {
      shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...environment }, detached: true, windowsHide: true,
    });
    const stdout: Buffer[] = [];
    let bytes = 0;
    let failure: string | null = null;
    const stop = (reason: string) => {
      failure ??= reason;
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* group already gone */ }
    };
    const timer = setTimeout(() => stop('timeout'), VERSION_PROBE_LIMITS.timeoutMs);
    const count = (chunk: Buffer, keep: boolean) => {
      bytes += chunk.byteLength;
      if (bytes > VERSION_PROBE_LIMITS.outputBytes) stop('output_limit');
      else if (keep) stdout.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => count(chunk, true));
    child.stderr.on('data', (chunk: Buffer) => count(chunk, false));
    child.once('error', () => { failure ??= 'spawn_failed'; });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure !== null || code !== 0) reject(new Error(failure ?? 'nonzero_exit'));
      else resolve(Buffer.concat(stdout).toString('utf8'));
    });
  });
}
