// The Codex setup adapter (E09 `setup-cli-codex`). Codex needs no plugin: setup installs
// the global Khala skill, the native Khala hooks (`hooks.json`), and the MCP entry
// (`config.toml`), all as guarded direct edits the executor applies. No vendor command
// runs, so the mutation footprint is exactly the three planned paths.
//
// Hook trust belongs to the person. Codex records it as `[hooks.state."…"] trusted_hash`
// tables in the same `config.toml` that carries the MCP entry, so Khala owns only its
// `mcp_servers.khala` table there (an entry-owned path) and edits it surgically: setup,
// upgrade, and removal never write or delete a trust byte. `hooks.json` stays whole-file
// managed; Codex never rewrites it, and removal restores its byte-exact preimage.
import path from 'node:path';
import { CODEX_HOOK_COMMAND, codexHookReviewState, codexHooksFragment } from '../../codex/hooks-config.js';
import { CODEX_HOOK_EVENTS } from '../../codex/hook.js';
import { plainObject } from '../../cli/validation.js';
import { codexAppSetupEntries } from '../../composition/codex-app.js';
import { sha256 } from '../filesystem.js';
import { MANIFEST_FILE, parseManifest, type ManifestEntry, type SetupManifest } from '../manifest.js';
import type {
  ComponentState, HarnessDetection, HarnessObservation, SetupAdapter, SetupComponent, SetupDiagnostic,
  SetupEnvironment, SetupOperation, SetupPlanRequest, Sha256Digest,
} from '../types.js';

/** Exact Codex versions whose skill, hook, and MCP layout this adapter has proven. */
export const CODEX_SUPPORTED_VERSIONS: readonly string[] = Object.freeze(['0.154.0']);
export const CODEX_MCP_ENTRY = 'mcp_servers.khala';
export const CODEX_HOOKS_ENTRY = 'hooks.khala';

export type CodexSetupAssets = Readonly<{
  /** Reviewed `SKILL.md` bytes installed at `~/.codex/skills/khala/SKILL.md`. */
  skill: Uint8Array;
}>;

export type CodexPaths = Readonly<{
  codexHome: string;
  skill: string;
  hooks: string;
  config: string;
  /** The stable installer-owned launcher the MCP entry runs; it never moves across upgrades. */
  launcher: string;
}>;

export function codexPaths(environment: Pick<SetupEnvironment, 'home' | 'xdgDataHome'>): CodexPaths {
  const codexHome = path.join(environment.home, '.codex');
  return {
    codexHome,
    skill: path.join(codexHome, 'skills', 'khala', 'SKILL.md'),
    hooks: path.join(codexHome, 'hooks.json'),
    config: path.join(codexHome, 'config.toml'),
    launcher: path.join(environment.xdgDataHome, 'khala', 'bin', 'khala'),
  };
}

/** Parses `codex --version` output (`codex-cli 0.154.0`). */
export function parseCodexVersion(output: string): string | null {
  const match = /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\s*$/.exec(output.trim());
  return match === null ? null : match[1]!;
}

// ---------------------------------------------------------------------------
// The MCP table. Static: the launcher resolves the live port and token from the
// owner-only runtime descriptor on every call, so neither is ever written here.
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** The exact bytes Khala owns in `config.toml`. JSON string escapes are valid TOML basic strings. */
export function codexMcpBlock(launcher: string): string {
  return '# Khala MCP server, managed by `npx @aiur/khala setup`; `npx @aiur/khala remove` deletes this table.\n'
    + '[mcp_servers.khala]\n'
    + `command = ${JSON.stringify(launcher)}\n`
    + 'args = ["mcp-serve"]\n';
}

/**
 * Appends the block. A non-empty file always gets exactly one separating line feed, so
 * removing `"\n" + block` restores the prior bytes whether or not they ended in one.
 */
export function withMcpBlock(config: string, block: string): string {
  return config.length === 0 ? block : `${config}\n${block}`;
}

/** The file with Khala's block removed, or `null` when the block is not present exactly once. */
export function withoutMcpBlock(config: string, block: string): string | null {
  if (config.startsWith(block)) {
    const rest = config.slice(block.length);
    return rest.includes(block) ? null : rest;
  }
  const first = config.indexOf(`\n${block}`);
  if (first < 0 || config.indexOf(`\n${block}`, first + 1) >= 0) return null;
  return config.slice(0, first) + config.slice(first + 1 + block.length);
}

const BARE_OR_QUOTED_KHALA = String.raw`(?:khala|"khala"|'khala')`;
const MCP_TABLE = new RegExp(String.raw`^\s*\[\[?\s*mcp_servers\s*\.\s*${BARE_OR_QUOTED_KHALA}\s*[\].]`);
const MCP_DOTTED = new RegExp(String.raw`^\s*mcp_servers\s*\.\s*${BARE_OR_QUOTED_KHALA}\s*[.=]`);
const MCP_INLINE = /^\s*mcp_servers\s*=/;
const MCP_PARENT = /^\s*\[\s*mcp_servers\s*\]\s*(?:#.*)?$/;
const KHALA_KEY = new RegExp(String.raw`^\s*${BARE_OR_QUOTED_KHALA}\s*[.=]`);
const TABLE = /^\s*\[/;

/**
 * Whether the TOML defines `mcp_servers.khala` anywhere, in any spelling this line scan
 * recognises. An inline `mcp_servers = {…}` table cannot take an appended table either,
 * so it also counts: both are conflicts Khala refuses rather than edits.
 */
export function definesKhalaMcpServer(config: string): boolean {
  let inParent = false;
  for (const line of config.split(/\r?\n/)) {
    if (MCP_TABLE.test(line) || MCP_DOTTED.test(line) || MCP_INLINE.test(line)) return true;
    if (TABLE.test(line)) {
      inParent = MCP_PARENT.test(line);
      continue;
    }
    if (inParent && KHALA_KEY.test(line)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// hooks.json
// ---------------------------------------------------------------------------

type HooksDocument = Record<string, unknown> & { hooks?: Record<string, unknown> };

/** A parsed `hooks.json` Khala can merge into, or `null` when it is not hook configuration. */
function parseHooks(text: string): HooksDocument | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!plainObject(value)) return null;
  if (value.hooks !== undefined && !plainObject(value.hooks)) return null;
  for (const event of CODEX_HOOK_EVENTS) {
    const groups = (value.hooks as Record<string, unknown> | undefined)?.[event];
    if (groups !== undefined && !Array.isArray(groups)) return null;
  }
  return value as HooksDocument;
}

function hasKhalaHandler(document: HooksDocument): boolean {
  return Object.values(document.hooks ?? {}).some(groups => Array.isArray(groups) && groups.some(group =>
    plainObject(group) && Array.isArray(group.hooks) && group.hooks.some(handler =>
      plainObject(handler) && handler.command === CODEX_HOOK_COMMAND)));
}

/** Appends Khala's groups after the person's own, so their trust positions never move. */
export function withKhalaHooks(document: HooksDocument | null): string {
  const fragment = codexHooksFragment().hooks;
  const hooks: Record<string, unknown> = { ...(document?.hooks ?? {}) };
  for (const event of CODEX_HOOK_EVENTS) {
    hooks[event] = [...((hooks[event] as unknown[] | undefined) ?? []), ...fragment[event]];
  }
  return `${JSON.stringify({ ...(document ?? {}), hooks }, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

type Target = Readonly<{
  path: string;
  bytes: Uint8Array | null;
  hash: Sha256Digest | null;
  managed: ManifestEntry | undefined;
}>;

type Component = Readonly<{ component: SetupComponent; state: ComponentState }>;

/** Everything `plan` needs, kept off the observation so foreign bytes can never reach a result. */
type CodexInspection = Readonly<{
  paths: CodexPaths;
  skill: Target;
  hooks: Target;
  config: Target;
  /** The installed skill directory's entries, for spotting unowned files beside `SKILL.md`. */
  skillDirectory: readonly string[] | null;
  components: readonly Component[];
}>;

const inspections = new WeakMap<HarnessObservation, CodexInspection>();

function text(bytes: Uint8Array | null): string | null {
  if (bytes === null) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

async function readTarget(environment: SetupEnvironment, target: string, manifest: SetupManifest | null): Promise<Target> {
  const bytes = await environment.probe.readFile(target);
  return {
    path: target,
    bytes,
    hash: bytes === null ? null : sha256(bytes),
    managed: manifest?.entries.find(entry => entry.path === target && entry.harness === 'codex'),
  };
}

function skillState(target: Target, directory: readonly string[] | null, desired: Sha256Digest): ComponentState {
  if (target.managed !== undefined) {
    // The older version Khala installed is replaced by setup; report it as not yet in place.
    if (target.hash !== target.managed.postimage) return 'drifted';
    return target.hash === desired ? 'ready' : 'absent';
  }
  if (target.bytes !== null || (directory !== null && directory.length > 0)) return 'conflict';
  return 'absent';
}

function hooksState(target: Target, config: Target, diagnostics: SetupDiagnostic[]): ComponentState {
  const content = text(target.bytes);
  if (target.managed === undefined) {
    if (target.bytes === null) return 'absent';
    const document = content === null ? null : parseHooks(content);
    if (document === null) {
      diagnostics.push(diagnostic('codex_hooks_unparseable', `${target.path} is not hook configuration Khala can extend.`, 'hooks'));
      return 'conflict';
    }
    if (hasKhalaHandler(document)) {
      diagnostics.push(diagnostic('codex_hooks_unowned', `${target.path} already runs \`${CODEX_HOOK_COMMAND}\` outside Khala setup.`, 'hooks'));
      return 'conflict';
    }
    return 'absent';
  }
  if (target.hash !== target.managed.postimage || content === null) return 'drifted';
  const review = codexHookReviewState({
    hooksPath: target.path, hooksJson: JSON.parse(content) as unknown, configToml: text(config.bytes),
  });
  if (review.state === 'trusted') return 'ready';
  diagnostics.push({ ...diagnostic('codex_hook_review', review.reason, 'hooks'), severity: 'info' });
  return review.state === 'awaiting_hook_review' ? 'awaiting_hook_review' : 'drifted';
}

function mcpState(target: Target, block: string, diagnostics: SetupDiagnostic[]): ComponentState {
  const content = text(target.bytes);
  if (target.bytes !== null && content === null) {
    diagnostics.push(diagnostic('codex_config_unreadable', `${target.path} is not UTF-8 text.`, 'mcp_entry'));
    return target.managed === undefined ? 'conflict' : 'drifted';
  }
  if (target.managed === undefined) {
    if (content !== null && definesKhalaMcpServer(content)) {
      diagnostics.push(diagnostic('codex_mcp_unowned', `${target.path} already defines mcp_servers.khala outside Khala setup.`, 'mcp_entry'));
      return 'conflict';
    }
    return 'absent';
  }
  // Only Khala's exact table counts: a missing, edited, or duplicated entry is drift, never ready.
  const rest = content === null ? null : withoutMcpBlock(content, block);
  if (rest === null || definesKhalaMcpServer(rest)) return 'drifted';
  return 'ready';
}

function diagnostic(code: string, message: string, component?: SetupComponent): SetupDiagnostic {
  return { code, severity: 'error', harness: 'codex', ...(component === undefined ? {} : { component }), message };
}

async function readManifest(environment: SetupEnvironment, diagnostics: SetupDiagnostic[]): Promise<SetupManifest | null> {
  const bytes = await environment.probe.readFile(path.join(environment.xdgStateHome, 'khala', 'setup', MANIFEST_FILE));
  if (bytes === null) return null;
  try {
    return parseManifest(bytes);
  } catch {
    diagnostics.push(diagnostic('setup_manifest_unreadable', 'The setup manifest is unreadable; Codex ownership is unknown.'));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export type CodexExecutablePlan = Readonly<{
  operations: readonly SetupOperation[];
  /** Postimage bytes keyed by digest, for the executor's `ExecutablePlan.contents`. */
  contents: ReadonlyMap<Sha256Digest, Uint8Array>;
  /** For the executor's `ExecutablePlan.entryOwnedPaths`. */
  entryOwnedPaths: readonly string[];
}>;

const NOTHING: CodexExecutablePlan = { operations: [], contents: new Map(), entryOwnedPaths: [] };
const BLOCKED: readonly ComponentState[] = ['drifted', 'conflict', 'unsupported'];

function planSetup(inspection: CodexInspection, assets: CodexSetupAssets): CodexExecutablePlan {
  const { paths, skill, hooks, config } = inspection;
  const operations: SetupOperation[] = [];
  const contents = new Map<Sha256Digest, Uint8Array>();
  const state = (component: SetupComponent) => inspection.components.find(item => item.component === component)!.state;
  const put = (bytes: Uint8Array) => {
    const digest = sha256(bytes);
    contents.set(digest, bytes);
    return digest;
  };
  if (state('skill') === 'absent') {
    const postimage = put(assets.skill);
    operations.push(skill.hash === null
      ? { id: 'codex:skill:create', harness: 'codex', component: 'skill', path: skill.path, type: 'file_create', postimage }
      : { id: 'codex:skill:replace', harness: 'codex', component: 'skill', path: skill.path, type: 'file_replace', preimage: skill.hash, postimage });
  }
  if (state('hooks') === 'absent') {
    const document = hooks.bytes === null ? null : parseHooks(text(hooks.bytes)!);
    operations.push({
      id: 'codex:hooks:set', harness: 'codex', component: 'hooks', path: hooks.path, type: 'config_entry_set',
      entry: CODEX_HOOKS_ENTRY, preimage: hooks.hash, postimage: put(encoder.encode(withKhalaHooks(document))),
    });
  }
  if (state('mcp_entry') === 'absent') {
    const current = text(config.bytes) ?? '';
    operations.push({
      id: 'codex:mcp_entry:set', harness: 'codex', component: 'mcp_entry', path: config.path, type: 'config_entry_set',
      entry: CODEX_MCP_ENTRY, preimage: config.hash, postimage: put(encoder.encode(withMcpBlock(current, codexMcpBlock(paths.launcher)))),
    });
  }
  return { operations, contents, entryOwnedPaths: [config.path] };
}

function planRemove(inspection: CodexInspection): CodexExecutablePlan {
  const { paths, skill, hooks, config } = inspection;
  const operations: SetupOperation[] = [];
  const contents = new Map<Sha256Digest, Uint8Array>();
  // Whole-file paths go back to their pre-Khala baseline; the executor proves the bytes.
  for (const target of [skill, hooks]) {
    const entry = target.managed;
    if (entry === undefined || target.hash === null) continue;
    const base = { id: `codex:${entry.component}:remove`, harness: 'codex', component: entry.component, path: target.path } as const;
    operations.push(entry.baseline.hash === null
      ? { ...base, type: 'file_delete', preimage: target.hash }
      : { ...base, type: 'file_restore', current: target.hash, restored: entry.baseline.hash });
  }
  // `config.toml` loses exactly Khala's table; every other byte, trust records included, stays.
  const entry = config.managed;
  const rest = entry === undefined || config.hash === null ? null : withoutMcpBlock(text(config.bytes) ?? '', codexMcpBlock(paths.launcher));
  if (entry !== undefined && config.hash !== null && rest !== null) {
    const base = { id: 'codex:mcp_entry:remove', harness: 'codex', component: 'mcp_entry', path: config.path } as const;
    if (rest.length === 0 && entry.baseline.hash === null) {
      operations.push({ ...base, type: 'file_delete', preimage: config.hash });
    } else {
      const bytes = encoder.encode(rest);
      const postimage = sha256(bytes);
      contents.set(postimage, bytes);
      operations.push({ ...base, type: 'config_entry_remove', entry: CODEX_MCP_ENTRY, preimage: config.hash, postimage });
    }
  }
  return { operations, contents, entryOwnedPaths: [config.path] };
}

/**
 * The full executable plan for a Codex observation this adapter produced. Setup refuses
 * (returns nothing) when any component is drifted or conflicting; removal refuses when any
 * managed component drifted, so one unsafe target never yields a partial cleanup.
 */
export function planCodex(request: SetupPlanRequest, assets: CodexSetupAssets): CodexExecutablePlan {
  const inspection = inspections.get(request.observation);
  if (inspection === undefined) throw new Error('planCodex needs an observation from the Codex adapter');
  const states = inspection.components.map(item => item.state);
  if (request.desired === 'present') {
    if (!request.observation.detection.supported || states.some(state => BLOCKED.includes(state))) return NOTHING;
    return planSetup(inspection, assets);
  }
  if (states.includes('drifted')) return NOTHING;
  return planRemove(inspection);
}

export function createCodexSetupAdapter(assets: CodexSetupAssets): SetupAdapter & Readonly<{
  executablePlan(request: SetupPlanRequest): CodexExecutablePlan;
}> {
  const desiredSkill = sha256(assets.skill);
  return {
    harness: 'codex',

    async detect(environment): Promise<HarnessDetection> {
      const executable = await environment.probe.resolveExecutable('codex');
      if (executable === null) return { executable: null, version: null, supported: false };
      let output: string;
      try {
        output = await environment.probe.runVersion(executable, ['--version']);
      } catch {
        return { executable, version: null, supported: false };
      }
      const version = parseCodexVersion(output);
      // An unparseable version is still a detected Codex, distinct from an absent one.
      return { executable, version: version ?? 'unknown', supported: version !== null && CODEX_SUPPORTED_VERSIONS.includes(version) };
    },

    async inspect(environment, detection): Promise<HarnessObservation> {
      const diagnostics: SetupDiagnostic[] = [];
      const paths = codexPaths(environment);
      const manifest = await readManifest(environment, diagnostics);
      const [skill, hooks, config] = await Promise.all([
        readTarget(environment, paths.skill, manifest),
        readTarget(environment, paths.hooks, manifest),
        readTarget(environment, paths.config, manifest),
      ]);
      const skillDirectory = await environment.probe.listDirectory(path.dirname(paths.skill));
      const components: Component[] = [
        { component: 'skill', state: skillState(skill, skillDirectory, desiredSkill) },
        { component: 'hooks', state: hooksState(hooks, config, diagnostics) },
        { component: 'mcp_entry', state: mcpState(config, codexMcpBlock(paths.launcher), diagnostics) },
      ];
      if (detection.executable !== null && !detection.supported) {
        diagnostics.push(diagnostic('codex_version_unsupported',
          `Codex ${detection.version ?? 'unknown'} is not a supported version (${CODEX_SUPPORTED_VERSIONS.join(', ')}).`));
      }
      // The Codex desktop app and cloud tasks are reported whether or not a Codex CLI is
      // detected. Their entries only diagnose; they never add an operation.
      diagnostics.push(...codexAppSetupEntries().diagnostics);
      const observation: HarnessObservation = {
        detection,
        components,
        // Configuration is not a proven delivery route; route support stays a separate capability fact.
        route: detection.supported ? 'unknown' : 'unavailable',
        diagnostics,
      };
      inspections.set(observation, { paths, skill, hooks, config, skillDirectory, components });
      return observation;
    },

    plan(request) {
      return planCodex(request, assets).operations;
    },

    executablePlan(request) {
      return planCodex(request, assets);
    },
  };
}
