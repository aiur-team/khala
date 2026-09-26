// Cursor setup adapter. Every Cursor listening mode is unproven (the 2026-09-25 proof
// kept each cell Blocked), so setup installs no hook: it adds only the `khala` stdio
// MCP entry to the person's global `~/.cursor/mcp.json`, which gives their own Agent
// Chat the shared channel operations. Status says plainly that delivery is unproven.
// The entry names the stable launcher and a fixed argument; the launcher reads the
// port and token from the runtime descriptor on every call, so neither is written here.
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { plainObject } from '../cli/validation.js';
import { sha256 } from '../setup/filesystem.js';
import type { SetupManifest } from '../setup/manifest.js';
import type {
  ComponentState, HarnessDetection, HarnessObservation, SetupAdapter, SetupDiagnostic, SetupEnvironment, SetupOperation,
  Sha256Digest,
} from '../setup/types.js';

export const CURSOR_EXECUTABLE = 'cursor';
export const CURSOR_MCP_SERVER = 'khala';
export const CURSOR_MCP_ENTRY = `mcpServers.${CURSOR_MCP_SERVER}`;

export const CURSOR_DELIVERY_UNPROVEN =
  'Cursor delivery is unproven: steer, sync and async all report unknown until an exact Cursor version, account tier '
  + 'and policy proof exists, so Khala selects no listening mode for a Cursor agent. Idle agents receive messages only '
  + 'at their next turn. Setup installs only the Khala MCP tools for channel operations.';

// `cursor --version` prints the version, the commit, then the architecture, one per line.
const VERSION_LINE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** The exact Cursor version from `cursor --version`, or `null` when the output is not one. */
export function parseCursorVersion(stdout: string): string | null {
  const first = stdout.split(/\r?\n/, 1)[0]?.trim() ?? '';
  return VERSION_LINE.test(first) && first.length <= 64 ? first : null;
}

export const cursorMcpConfigPath = (environment: Pick<SetupEnvironment, 'home'>) =>
  path.join(environment.home, '.cursor', 'mcp.json');

/** The stable owned launcher setup installs; never an ephemeral npx path. */
export const khalaLauncherPath = (environment: Pick<SetupEnvironment, 'xdgDataHome'>) =>
  path.join(environment.xdgDataHome, 'khala', 'bin', 'khala');

/** The installed MCP server entry. It carries no channel, binding, token, port or message bytes. */
export function cursorMcpServerEntry(environment: Pick<SetupEnvironment, 'xdgDataHome'>) {
  return { command: khalaLauncherPath(environment), args: ['mcp-serve'] };
}

type ObservedConfig = Readonly<{ path: string; bytes: Uint8Array | null; entry: ReturnType<typeof cursorMcpServerEntry> }>;

export interface CursorSetupAdapter extends SetupAdapter {
  readonly harness: 'cursor';
  /** Postimage bytes, by digest, for every operation this adapter has planned. */
  contents(): ReadonlyMap<Sha256Digest, Uint8Array>;
}

const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

/** Parsed config, or `null` when it is not a JSON object whose `mcpServers` (if any) is an object. */
function parseConfig(bytes: Uint8Array): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  if (!plainObject(value)) return null;
  if (value.mcpServers !== undefined && !plainObject(value.mcpServers)) return null;
  return value;
}

export function createCursorSetupAdapter(): CursorSetupAdapter {
  // Plans are pure over an observation; the bytes behind each observation stay here so
  // a plan can only ever be computed from this adapter's own read.
  const observed = new WeakMap<HarnessObservation, ObservedConfig>();
  const contents = new Map<Sha256Digest, Uint8Array>();

  return {
    harness: 'cursor',

    async detect(environment): Promise<HarnessDetection> {
      const executable = await environment.probe.resolveExecutable(CURSOR_EXECUTABLE);
      if (executable === null) return { executable: null, version: null, supported: false };
      let version: string | null;
      try {
        version = parseCursorVersion(await environment.probe.runVersion(executable, ['--version']));
      } catch {
        version = null;
      }
      // Presence alone never claims safety: an unreadable version is unsupported.
      return { executable, version, supported: version !== null };
    },

    async inspect(environment, detection): Promise<HarnessObservation> {
      const diagnostics: SetupDiagnostic[] = [];
      const configPath = cursorMcpConfigPath(environment);
      const entry = cursorMcpServerEntry(environment);
      const observation = (state: ComponentState, bytes: Uint8Array | null): HarnessObservation => {
        const result: HarnessObservation = {
          detection,
          components: [{ component: 'mcp_entry', state }],
          route: 'unknown',
          diagnostics,
        };
        observed.set(result, { path: configPath, bytes, entry });
        return result;
      };
      // An absent Cursor is reported without reading or creating its config root.
      if (detection.executable === null) return observation('absent', null);
      diagnostics.push({ code: 'cursor_delivery_unproven', severity: 'warning', harness: 'cursor', message: CURSOR_DELIVERY_UNPROVEN });
      if (!detection.supported) {
        diagnostics.push({
          code: 'unsupported_version', severity: 'error', harness: 'cursor',
          message: 'The Cursor version could not be read from `cursor --version`.',
        });
        return observation('unsupported', null);
      }
      const bytes = await environment.probe.readFile(configPath);
      if (bytes === null) return observation('absent', null);
      const config = parseConfig(bytes);
      if (config === null) {
        diagnostics.push({
          code: 'cursor_mcp_config_invalid', severity: 'error', harness: 'cursor', component: 'mcp_entry',
          message: `${configPath} is not a JSON object with an object-valued mcpServers; it was left untouched.`,
        });
        return observation('conflict', bytes);
      }
      const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
      if (!Object.hasOwn(servers, CURSOR_MCP_SERVER)) return observation('absent', bytes);
      if (isDeepStrictEqual(servers[CURSOR_MCP_SERVER], entry)) return observation('ready', bytes);
      diagnostics.push({
        code: 'cursor_mcp_entry_conflict', severity: 'error', harness: 'cursor', component: 'mcp_entry',
        message: `${configPath} already has a different "${CURSOR_MCP_SERVER}" MCP server; it was left untouched.`,
      });
      return observation('conflict', bytes);
    },

    plan({ desired, observation }): readonly SetupOperation[] {
      const seen = observed.get(observation);
      if (seen === undefined) throw new Error('cursor setup: plan needs an observation from this adapter');
      // Removal returns every managed path to its pre-Khala bytes from the manifest
      // (`cursorRemovalOperations`), never by editing the config back.
      if (desired === 'absent') return [];
      const state = observation.components[0]?.state;
      if (!observation.detection.supported || state !== 'absent') return [];
      const config = seen.bytes === null ? {} : parseConfig(seen.bytes)!;
      const servers = plainObject(config.mcpServers) ? config.mcpServers : {};
      const next = { ...config, mcpServers: { ...servers, [CURSOR_MCP_SERVER]: seen.entry } };
      const postimage = encoder.encode(`${JSON.stringify(next, null, 2)}\n`);
      const digest = sha256(postimage);
      contents.set(digest, postimage);
      return [{
        id: 'cursor:mcp_entry',
        type: 'config_entry_set',
        harness: 'cursor',
        component: 'mcp_entry',
        path: seen.path,
        entry: CURSOR_MCP_ENTRY,
        preimage: seen.bytes === null ? null : sha256(seen.bytes),
        postimage: digest,
      }];
    },

    contents: () => contents,
  };
}

/** The remove operations for Cursor's managed paths: each goes back to its recorded baseline. */
export function cursorRemovalOperations(manifest: SetupManifest | null): readonly SetupOperation[] {
  return (manifest?.entries ?? []).filter(entry => entry.harness === 'cursor').map((entry): SetupOperation => {
    const base = { id: `cursor:remove:${entry.path}`, harness: 'cursor' as const, component: entry.component, path: entry.path };
    return entry.baseline.hash === null
      ? { ...base, type: 'file_delete', preimage: entry.postimage }
      : { ...base, type: 'file_restore', current: entry.postimage, restored: entry.baseline.hash };
  });
}
