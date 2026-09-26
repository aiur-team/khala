// The Claude Code setup adapter (E09 `setup-cli-claude`). It installs the single
// producer-owned user-scope plugin (skill, hooks, MCP entry) from a versioned local Khala
// marketplace inside the installer payload, and registers both through one guarded edit of
// `~/.claude/settings.json`: `extraKnownMarketplaces.khala` and `enabledPlugins["khala@khala"]`.
//
// It never calls `claude plugin ...`. On the certified version that command also rewrites
// `~/.claude.json` (random machine and user IDs) and writes a timestamped
// `~/.claude/backups/.claude.json.backup.<ms>`, so its footprint cannot be declared up front.
// The settings keys are Claude's documented user-scope surface, and the certified version
// loads the plugin from them alone. Removal is manifest-driven: every managed path returns
// to its byte-exact pre-Khala preimage or absence.
//
// Optional hardening and folder trust are reported as separate informational diagnostics.
// Neither gates readiness, and setup never writes a hardening profile (decision 25).
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../filesystem.js';
import { ManifestSchemaError, parseManifest, type ManifestEntry } from '../manifest.js';
import { shellWord } from '../paths.js';
import { setupStatePaths } from '../transaction.js';
import type {
  ComponentState, HarnessDetection, HarnessObservation, SetupAdapter, SetupComponent, SetupDiagnostic,
  SetupEnvironment, SetupOperation, SetupPlanRequest, Sha256Digest,
} from '../types.js';

/** Exact versions whose mutation footprint and settings-only plugin loading are certified. */
export const CLAUDE_SUPPORTED_VERSIONS: readonly string[] = Object.freeze(['2.1.283']);

export const CLAUDE_MARKETPLACE_NAME = 'khala';
export const CLAUDE_PLUGIN_NAME = 'khala';
export const CLAUDE_PLUGIN_ID = `${CLAUDE_PLUGIN_NAME}@${CLAUDE_MARKETPLACE_NAME}`;
/** The literal `/khala <verb>` command the bundled skill must own without a competitor. */
export const CLAUDE_COMMAND = 'khala';
/** New plugin configuration loads when Claude next starts; the running session is unchanged. */
export const CLAUDE_SESSION_EFFECT = 'restart_required' as const;

/** Top-level entries of the plugin package that ship; sources, tests, and package metadata do not. */
const SHIPPED_PLUGIN_ENTRIES: readonly string[] = ['.claude-plugin', '.mcp.json', 'hooks', 'skills'];
const SETTINGS_ENTRY = `enabledPlugins.${CLAUDE_PLUGIN_ID},extraKnownMarketplaces.${CLAUDE_MARKETPLACE_NAME}`;

export type ClaudeAdapterOptions = Readonly<{
  /** The Khala payload version; the marketplace lives below `versions/<version>/`. */
  version: string;
  /** Plugin files keyed by their path relative to the plugin root, e.g. `.claude-plugin/plugin.json`. */
  assets: ReadonlyMap<string, Uint8Array>;
  /** The absolute Node that runs setup; the installed hook commands run it, never a `node` from PATH. */
  nodePath: string;
  /** Folder whose Claude trust is reported; omitted means folder trust is not reported. */
  cwd?: string;
}>;

export type ClaudeHardening = 'present' | 'absent' | 'unknown';
export type ClaudeFolderTrust = 'trusted' | 'untrusted' | 'unknown';

export type ClaudePaths = Readonly<{
  claudeDirectory: string;
  settings: string;
  userState: string;
  installedPlugins: string;
  marketplaceRoot: string;
  catalog: string;
  pluginRoot: string;
  /** The staged launcher the installed MCP entry and hooks run by absolute path. */
  launcher: string;
  manifest: string;
}>;

export function claudePaths(environment: Pick<SetupEnvironment, 'home' | 'xdgConfigHome' | 'xdgDataHome' | 'xdgStateHome'>, version: string): ClaudePaths {
  const claudeDirectory = path.join(environment.home, '.claude');
  const marketplaceRoot = path.join(environment.xdgDataHome, 'khala', 'versions', version, 'claude', 'marketplace');
  return {
    claudeDirectory,
    settings: path.join(claudeDirectory, 'settings.json'),
    userState: path.join(environment.home, '.claude.json'),
    installedPlugins: path.join(claudeDirectory, 'plugins', 'installed_plugins.json'),
    marketplaceRoot,
    catalog: path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
    pluginRoot: path.join(marketplaceRoot, 'plugins', CLAUDE_PLUGIN_NAME),
    launcher: path.join(environment.xdgDataHome, 'khala', 'bin', 'khala'),
    manifest: setupStatePaths(environment).manifest,
  };
}

/** A setup the adapter refuses to plan: a conflict, drift, or an unsupported version. */
export class ClaudeSetupRefusal extends Error {
  constructor(readonly state: 'conflict' | 'drifted' | 'unsupported', readonly diagnostics: readonly SetupDiagnostic[]) {
    super(`claude setup refused: ${state}`);
    this.name = 'ClaudeSetupRefusal';
  }
}

export type ClaudePlan = Readonly<{
  operations: readonly SetupOperation[];
  /** Postimage bytes for every create and config write, keyed by digest. */
  contents: ReadonlyMap<Sha256Digest, Uint8Array>;
}>;

type Json = Record<string, unknown>;
type Target = Readonly<{ path: string; component: SetupComponent; bytes: Uint8Array; current: Sha256Digest | null }>;
type Settings =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'invalid' }>
  | Readonly<{ kind: 'present'; hash: Sha256Digest; value: Json }>;

type Inspection = Readonly<{
  paths: ClaudePaths;
  detection: HarnessDetection;
  settings: Settings;
  /** Desired bytes of the settings file, or `null` when it cannot be edited safely. */
  settingsPostimage: Uint8Array | null;
  targets: readonly Target[];
  managed: ReadonlyMap<string, ManifestEntry>;
  current: ReadonlyMap<string, Sha256Digest | null>;
  collisions: readonly string[];
  hardening: ClaudeHardening;
  folderTrust: ClaudeFolderTrust | null;
}>;

/** Stands for a path the probe could not read (for example a symbolic link); never equals a real hash. */
const UNREADABLE = 'sha256:unreadable' as Sha256Digest;
const encoder = new TextEncoder();
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const encodeJson = (value: unknown) => encoder.encode(JSON.stringify(value, null, 2) + '\n');
const diagnostic = (code: string, severity: SetupDiagnostic['severity'], message: string, component?: SetupComponent): SetupDiagnostic =>
  ({ code, severity, harness: 'claude', ...(component === undefined ? {} : { component }), message });

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

/** Parses `claude --version` output such as `2.1.283 (Claude Code)`. */
export function parseClaudeVersion(output: string): string | null {
  return /^\s*(\d+\.\d+\.\d+)(?:\s|$)/.exec(output)?.[1] ?? null;
}

/** The marketplace catalog naming the one bundled plugin. */
export function claudeCatalog(): Uint8Array {
  return encodeJson({
    name: CLAUDE_MARKETPLACE_NAME,
    owner: { name: 'Khala' },
    plugins: [{ name: CLAUDE_PLUGIN_NAME, source: `./plugins/${CLAUDE_PLUGIN_NAME}` }],
  });
}

/** The two settings values that register the marketplace and enable the plugin. */
function desiredMarketplace(paths: ClaudePaths) {
  return { source: { source: 'directory', path: paths.marketplaceRoot } };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Settings with both Khala keys set, or `null` when an existing container is not an object. */
function withKhala(settings: Json, paths: ClaudePaths): Json | null {
  const marketplaces = settings.extraKnownMarketplaces ?? {};
  const plugins = settings.enabledPlugins ?? {};
  if (!isObject(marketplaces) || !isObject(plugins)) return null;
  return {
    ...settings,
    extraKnownMarketplaces: { ...marketplaces, [CLAUDE_MARKETPLACE_NAME]: desiredMarketplace(paths) },
    enabledPlugins: { ...plugins, [CLAUDE_PLUGIN_ID]: true },
  };
}

function khalaKeys(settings: Json) {
  const marketplaces = isObject(settings.extraKnownMarketplaces) ? settings.extraKnownMarketplaces : {};
  const plugins = isObject(settings.enabledPlugins) ? settings.enabledPlugins : {};
  return {
    marketplace: Object.hasOwn(marketplaces, CLAUDE_MARKETPLACE_NAME) ? marketplaces[CLAUDE_MARKETPLACE_NAME] : undefined,
    plugin: Object.hasOwn(plugins, CLAUDE_PLUGIN_ID) ? plugins[CLAUDE_PLUGIN_ID] : undefined,
  };
}

/**
 * Optional hardening: Claude's sandbox is enabled in user settings. Reported only; setup
 * never writes it, and its absence never changes readiness.
 */
function hardeningOf(settings: Settings): ClaudeHardening {
  if (settings.kind !== 'present') return settings.kind === 'absent' ? 'absent' : 'unknown';
  const sandbox = settings.value.sandbox;
  return isObject(sandbox) && sandbox.enabled === true ? 'present' : 'absent';
}

function validateAssets(assets: ReadonlyMap<string, Uint8Array>): void {
  if (!assets.has('.claude-plugin/plugin.json')) throw new Error('claude plugin assets need .claude-plugin/plugin.json');
  for (const name of assets.keys()) {
    const normal = path.posix.normalize(name);
    if (normal !== name || path.posix.isAbsolute(name) || name.split('/').includes('..')
      || !SHIPPED_PLUGIN_ENTRIES.includes(name.split('/')[0]!)) {
      throw new Error(`claude plugin asset ${name} is outside the shipped plugin layout`);
    }
  }
}

/** Reads the shipped plugin files from a plugin package directory (the packaged Claude assets). */
export async function readClaudePluginAssets(pluginPackage: string): Promise<Map<string, Uint8Array>> {
  const assets = new Map<string, Uint8Array>();
  async function walk(relative: string): Promise<void> {
    const absolute = path.join(pluginPackage, relative);
    const stat = await fs.lstat(absolute).catch(() => null);
    if (stat === null) return;
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(absolute)).sort()) await walk(path.posix.join(relative, name));
    } else if (stat.isFile()) {
      assets.set(relative, new Uint8Array(await fs.readFile(absolute)));
    } else {
      throw new Error(`claude plugin asset ${relative} is not a regular file`);
    }
  }
  for (const entry of SHIPPED_PLUGIN_ENTRIES) await walk(entry);
  validateAssets(assets);
  return assets;
}

/** A packaged hook command: the plugin's own `node "${CLAUDE_PLUGIN_ROOT}/hooks/<role>.mjs"`. */
const PACKAGED_HOOK_COMMAND = /^node ("\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/[a-z-]+\.mjs")$/;

/**
 * The plugin files as installed. The packaged `.mcp.json` and hooks name a bare `khala`
 * and `node`, which Claude would resolve from the person's PATH. Setup never puts either on
 * PATH, so the installed MCP entry runs the staged launcher by absolute path, and every hook
 * runs the Node that ran setup with the launcher as its argument. Both paths are fixed
 * across upgrades. Any other packaged form fails closed rather than install a PATH lookup.
 */
export function installedPluginAssets(
  assets: ReadonlyMap<string, Uint8Array>, runtime: Readonly<{ launcher: string; nodePath: string }>,
): Map<string, Uint8Array> {
  const installed = new Map(assets);
  const mcp = parseJson(assets.get('.mcp.json') ?? new Uint8Array());
  const server = isObject(mcp) && isObject(mcp.mcpServers) ? mcp.mcpServers[CLAUDE_PLUGIN_NAME] : undefined;
  if (!isObject(mcp) || !isObject(server) || server.command !== 'khala') throw new Error('claude plugin .mcp.json must run khala');
  installed.set('.mcp.json', encodeJson({ ...mcp, mcpServers: { ...mcp.mcpServers as Json, [CLAUDE_PLUGIN_NAME]: { ...server, command: runtime.launcher } } }));

  const hooks = parseJson(assets.get('hooks/hooks.json') ?? new Uint8Array());
  if (!isObject(hooks) || !isObject(hooks.hooks)) throw new Error('claude plugin hooks/hooks.json is not hook configuration');
  const rendered = Object.fromEntries(Object.entries(hooks.hooks).map(([event, groups]) => [event, (groups as Json[]).map(group => ({
    ...group,
    hooks: (group.hooks as Json[]).map(handler => {
      const script = PACKAGED_HOOK_COMMAND.exec(String(handler.command))?.[1];
      if (script === undefined) throw new Error(`claude plugin hook ${String(handler.command)} is not a packaged hook script`);
      return { ...handler, command: `${shellWord(runtime.nodePath)} ${script} ${shellWord(runtime.launcher)}` };
    }),
  }))]));
  installed.set('hooks/hooks.json', encodeJson({ ...hooks, hooks: rendered }));
  return installed;
}

export class ClaudeSetupAdapter implements SetupAdapter {
  readonly harness = 'claude' as const;
  readonly #options: ClaudeAdapterOptions;
  readonly #inspections = new WeakMap<HarnessObservation, Inspection>();

  constructor(options: ClaudeAdapterOptions) {
    if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(options.version)) throw new Error('invalid khala payload version');
    validateAssets(options.assets);
    if (!path.isAbsolute(options.nodePath)) throw new Error('claude hook node path must be absolute');
    this.#options = options;
  }

  async detect(environment: SetupEnvironment): Promise<HarnessDetection> {
    const executable = await environment.probe.resolveExecutable('claude');
    if (executable === null) return { executable: null, version: null, supported: false };
    let version: string | null = null;
    try {
      version = parseClaudeVersion(await environment.probe.runVersion(executable, ['--version']));
    } catch {
      version = null;
    }
    return { executable, version, supported: version !== null && CLAUDE_SUPPORTED_VERSIONS.includes(version) };
  }

  async inspect(environment: SetupEnvironment, detection: HarnessDetection): Promise<HarnessObservation> {
    const inspection = await this.#read(environment, detection);
    const diagnostics: SetupDiagnostic[] = [];
    let components: { component: SetupComponent; state: ComponentState }[];
    if (detection.executable === null) {
      components = [{ component: 'marketplace', state: 'absent' }, { component: 'plugin', state: 'absent' }];
    } else if (!detection.supported) {
      components = [{ component: 'marketplace', state: 'unsupported' }, { component: 'plugin', state: 'unsupported' }];
      diagnostics.push(diagnostic('claude_version_unsupported', 'error',
        `Claude Code ${detection.version ?? '(unknown version)'} is not a certified version (${CLAUDE_SUPPORTED_VERSIONS.join(', ')}); setup refuses it.`));
    } else {
      components = (['marketplace', 'plugin'] as const).map(component => ({ component, state: componentState(inspection, component, diagnostics) }));
    }
    if (detection.executable !== null) {
      diagnostics.push(inspection.hardening === 'present'
        ? diagnostic('claude_hardening_present', 'info', 'Optional hardening check: the Claude sandbox is enabled in user settings.')
        : diagnostic(`claude_hardening_${inspection.hardening}`, 'info',
          'Optional hardening check: the Claude sandbox is not enabled in user settings. Delivery does not depend on it, and setup does not change it.'));
      if (inspection.folderTrust !== null) {
        diagnostics.push(diagnostic(`claude_folder_${inspection.folderTrust === 'unknown' ? 'trust_unknown' : inspection.folderTrust}`, 'info',
          `Folder trust for ${this.#options.cwd}: ${inspection.folderTrust}. Claude asks for it in its own dialog; setup does not change it.`));
      }
    }
    const configured = components.every(item => item.state === 'ready');
    const observation: HarnessObservation = {
      detection,
      components,
      // Configuration alone never proves a delivery route.
      route: detection.executable === null || !detection.supported || !configured ? 'unavailable' : 'unknown',
      diagnostics,
    };
    this.#inspections.set(observation, inspection);
    return observation;
  }

  plan(request: SetupPlanRequest): readonly SetupOperation[] {
    return this.planWithContents(request).operations;
  }

  /** The plan plus the bytes the executor writes for it. Pure over the inspected observation. */
  planWithContents(request: SetupPlanRequest): ClaudePlan {
    const inspection = this.#inspections.get(request.observation);
    if (inspection === undefined) throw new Error('plan requires an observation from this adapter');
    return request.desired === 'absent' ? planRemoval(inspection) : planSetup(inspection, request.observation);
  }

  /** The optional hardening check for an inspected observation; never a readiness input. */
  hardening(observation: HarnessObservation): ClaudeHardening {
    return this.#inspections.get(observation)?.hardening ?? 'unknown';
  }

  async #read(environment: SetupEnvironment, detection: HarnessDetection): Promise<Inspection> {
    const { probe } = environment;
    const paths = claudePaths(environment, this.#options.version);
    const read = async (target: string): Promise<Uint8Array | null | undefined> => {
      try {
        return await probe.readFile(target);
      } catch {
        return undefined;
      }
    };

    let managed = new Map<string, ManifestEntry>();
    const manifestBytes = await read(paths.manifest);
    if (manifestBytes) {
      try {
        managed = new Map(parseManifest(manifestBytes).entries.filter(entry => entry.harness === 'claude').map(entry => [entry.path, entry]));
      } catch (error) {
        if (!(error instanceof ManifestSchemaError)) throw error;
      }
    }

    const settingsBytes = await read(paths.settings);
    let settings: Settings;
    if (settingsBytes === null) settings = { kind: 'absent' };
    else if (settingsBytes === undefined) settings = { kind: 'invalid' };
    else {
      const value = parseJson(settingsBytes);
      settings = isObject(value) ? { kind: 'present', hash: sha256(settingsBytes), value } : { kind: 'invalid' };
    }
    const next = settings.kind === 'invalid' ? null : withKhala(settings.kind === 'present' ? settings.value : {}, paths);
    const settingsPostimage = next === null ? null : encodeJson(next);

    const desired: { path: string; component: SetupComponent; bytes: Uint8Array }[] = [
      { path: paths.catalog, component: 'marketplace', bytes: claudeCatalog() },
      ...[...installedPluginAssets(this.#options.assets, { launcher: paths.launcher, nodePath: this.#options.nodePath })]
        .map(([name, bytes]) => ({ path: path.join(paths.pluginRoot, ...name.split('/')), component: 'plugin' as const, bytes })),
    ];
    const current = new Map<string, Sha256Digest | null>();
    const targets: Target[] = [];
    for (const item of desired) {
      const bytes = await read(item.path);
      const hash = bytes === null ? null : bytes === undefined ? UNREADABLE : sha256(bytes);
      current.set(item.path, hash);
      targets.push({ ...item, current: hash });
    }
    for (const entry of managed.values()) {
      if (current.has(entry.path)) continue;
      const bytes = await read(entry.path);
      current.set(entry.path, bytes === null ? null : bytes === undefined ? UNREADABLE : sha256(bytes));
    }
    current.set(paths.settings, settings.kind === 'present' ? settings.hash : settings.kind === 'absent' ? null : UNREADABLE);

    const collisions = detection.executable === null ? [] : await this.#collisions(environment, paths, settings);
    let folderTrust: ClaudeFolderTrust | null = null;
    if (this.#options.cwd !== undefined && detection.executable !== null) {
      const state = await read(paths.userState);
      const value = state ? parseJson(state) : undefined;
      const project = isObject(value) && isObject(value.projects) ? value.projects[this.#options.cwd] : undefined;
      folderTrust = !isObject(project) ? 'unknown' : project.hasTrustDialogAccepted === true ? 'trusted' : 'untrusted';
    }
    return {
      paths, detection, settings, settingsPostimage, targets, managed, current, collisions,
      hardening: hardeningOf(settings), folderTrust,
    };
  }

  /** Every existing user or plugin command or skill that competes for `/khala`. */
  async #collisions(environment: SetupEnvironment, paths: ClaudePaths, settings: Settings): Promise<string[]> {
    const { probe } = environment;
    const exists = async (target: string) => {
      try {
        return (await probe.readFile(target)) !== null || (await probe.listDirectory(target)) !== null;
      } catch {
        // Unreadable (for example a symbolic link): something occupies the name.
        return true;
      }
    };
    const occupied = async (root: string) => {
      const found: string[] = [];
      for (const candidate of [
        path.join(root, 'commands', `${CLAUDE_COMMAND}.md`),
        path.join(root, 'commands', CLAUDE_COMMAND),
        path.join(root, 'skills', CLAUDE_COMMAND),
      ]) if (await exists(candidate)) found.push(candidate);
      return found;
    };
    const collisions = [...await occupied(paths.claudeDirectory)];
    if (settings.kind !== 'present' || !isObject(settings.value.enabledPlugins)) return collisions;
    const enabled = Object.entries(settings.value.enabledPlugins)
      .filter(([id, on]) => on === true && id !== CLAUDE_PLUGIN_ID)
      .map(([id]) => id);
    for (const id of enabled) if (id.split('@')[0] === CLAUDE_COMMAND) collisions.push(`plugin ${id}`);
    let installed: unknown;
    try {
      const bytes = await probe.readFile(paths.installedPlugins);
      installed = bytes === null ? undefined : parseJson(bytes);
    } catch {
      installed = undefined;
    }
    const registry = isObject(installed) && isObject(installed.plugins) ? installed.plugins : {};
    for (const id of enabled) {
      const records = registry[id];
      if (!Array.isArray(records)) continue;
      for (const record of records) {
        if (!isObject(record) || typeof record.installPath !== 'string' || !path.isAbsolute(record.installPath)) continue;
        for (const found of await occupied(record.installPath)) collisions.push(`plugin ${id}: ${found}`);
      }
    }
    return collisions;
  }
}

function componentState(inspection: Inspection, component: SetupComponent, diagnostics: SetupDiagnostic[]): ComponentState {
  const { paths, settings, managed } = inspection;
  let conflict = false;
  let drifted = false;
  let pending = false;
  for (const target of inspection.targets.filter(item => item.component === component)) {
    const entry = managed.get(target.path);
    const desired = sha256(target.bytes);
    if (entry === undefined) {
      if (target.current === null) pending = true;
      else {
        conflict = true;
        diagnostics.push(diagnostic('claude_unowned_target', 'error', `${target.path} exists but is not Khala-managed.`, component));
      }
    } else if (target.current !== entry.postimage) {
      drifted = true;
      diagnostics.push(diagnostic('claude_drifted', 'error', `${target.path} changed since Khala wrote it.`, component));
    } else if (entry.postimage !== desired) {
      pending = true;
    }
  }

  // The settings file carries this component's registration key.
  const key = component === 'marketplace' ? 'marketplace' : 'plugin';
  const desiredValue = component === 'marketplace' ? desiredMarketplace(paths) : true;
  const entry = managed.get(paths.settings);
  if (settings.kind === 'invalid' || inspection.settingsPostimage === null) {
    conflict = true;
    diagnostics.push(diagnostic('claude_settings_unusable', 'error',
      `${paths.settings} is not a readable JSON object with object-valued plugin keys; setup will not edit it.`, component));
  } else if (entry !== undefined && inspection.current.get(paths.settings) !== entry.postimage) {
    drifted = true;
    diagnostics.push(diagnostic('claude_drifted', 'error', `${paths.settings} changed since Khala wrote it.`, component));
  } else {
    const value = settings.kind === 'present' ? khalaKeys(settings.value)[key] : undefined;
    if (value === undefined) pending = true;
    else if (entry === undefined) {
      conflict = true;
      diagnostics.push(diagnostic('claude_unowned_entry', 'error',
        `${paths.settings} already has a ${key === 'marketplace' ? `"${CLAUDE_MARKETPLACE_NAME}" marketplace` : `"${CLAUDE_PLUGIN_ID}" plugin`} entry that Khala did not write.`, component));
    } else if (!sameJson(value, desiredValue)) pending = true;
  }

  if (component === 'plugin') {
    for (const collision of inspection.collisions) {
      conflict = true;
      diagnostics.push(diagnostic('claude_command_collision', 'error',
        `/${CLAUDE_COMMAND} is already provided by ${collision}; remove it before setup so /${CLAUDE_COMMAND} <verb> resolves to Khala.`, component));
    }
  }
  if (conflict) return 'conflict';
  if (drifted) return 'drifted';
  return pending ? 'absent' : 'ready';
}

function refusalFor(observation: HarnessObservation): ClaudeSetupRefusal | null {
  const states = observation.components.map(item => item.state);
  const errors = observation.diagnostics.filter(item => item.severity === 'error');
  for (const state of ['unsupported', 'conflict', 'drifted'] as const) {
    if (states.includes(state)) return new ClaudeSetupRefusal(state, errors);
  }
  return null;
}

function sortOperations(operations: SetupOperation[]): SetupOperation[] {
  const key = (op: SetupOperation) => `${op.component}\u0000${op.path}`;
  return operations.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

function planSetup(inspection: Inspection, observation: HarnessObservation): ClaudePlan {
  // Absent Claude: nothing is planned, so no `~/.claude` is created.
  if (inspection.detection.executable === null) return { operations: [], contents: new Map() };
  const refusal = refusalFor(observation);
  if (refusal !== null) throw refusal;
  const operations: SetupOperation[] = [];
  const contents = new Map<Sha256Digest, Uint8Array>();
  for (const target of inspection.targets) {
    const postimage = sha256(target.bytes);
    const entry = inspection.managed.get(target.path);
    if (target.current === postimage && entry !== undefined) continue;
    contents.set(postimage, target.bytes);
    operations.push(target.current === null
      ? { id: `claude:${target.component}:create:${target.path}`, harness: 'claude', component: target.component, path: target.path, type: 'file_create', postimage }
      : { id: `claude:${target.component}:replace:${target.path}`, harness: 'claude', component: target.component, path: target.path, type: 'file_replace', preimage: target.current, postimage });
  }
  const { settings, settingsPostimage, paths } = inspection;
  const preimage = settings.kind === 'present' ? settings.hash : null;
  const postimage = sha256(settingsPostimage!);
  if (postimage !== preimage) {
    contents.set(postimage, settingsPostimage!);
    operations.push({
      id: `claude:plugin:settings:${paths.settings}`, harness: 'claude', component: 'plugin', path: paths.settings,
      type: 'config_entry_set', entry: SETTINGS_ENTRY, preimage, postimage,
    });
  }
  return { operations: sortOperations(operations), contents };
}

/** Every managed Claude path returns to its pre-Khala baseline; drift refuses the whole removal. */
function planRemoval(inspection: Inspection): ClaudePlan {
  const operations: SetupOperation[] = [];
  const drifted: SetupDiagnostic[] = [];
  for (const entry of inspection.managed.values()) {
    const base = { harness: 'claude' as const, component: entry.component, path: entry.path };
    if (inspection.current.get(entry.path) !== entry.postimage) {
      drifted.push(diagnostic('claude_drifted', 'error', `${entry.path} changed since Khala wrote it; removal preserves it.`, entry.component));
      continue;
    }
    operations.push(entry.baseline.hash === null
      ? { ...base, id: `claude:${entry.component}:delete:${entry.path}`, type: 'file_delete', preimage: entry.postimage }
      : { ...base, id: `claude:${entry.component}:restore:${entry.path}`, type: 'file_restore', current: entry.postimage, restored: entry.baseline.hash });
  }
  if (drifted.length > 0) throw new ClaudeSetupRefusal('drifted', drifted);
  return { operations: sortOperations(operations), contents: new Map() };
}

export function createClaudeSetupAdapter(options: ClaudeAdapterOptions): ClaudeSetupAdapter {
  return new ClaudeSetupAdapter(options);
}
