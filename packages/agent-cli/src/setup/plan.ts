// The one `discover -> inspect -> plan` pipeline behind `setup`, `remove`, and status
// configuration. It projects adapter output through closed allowlists, sorts and canonicalizes
// it, digests the plan, and gates execution on a digest the person approved for the plan
// computed from fresh state in this same invocation. Nothing here writes, locks, or prompts;
// every effect goes through the injected executor.
import { createHash } from 'node:crypto';
import { resolveSetupPaths } from './paths.js';
import type { ExecutablePlan, ExecutionOutcome } from './transaction.js';
import {
  HARNESS_IDS, SETUP_COMPONENTS, SETUP_SCHEMA_VERSION, setupExitCode,
  type ConfirmationAction, type HarnessDetection, type HarnessId, type HarnessReport, type SetupAdapter,
  type SetupDiagnostic, type SetupEnvironment, type SetupOperation, type SetupOperationReport, type SetupResult,
  type SetupState, type Sha256Digest,
} from './types.js';

/** Bumped whenever projection, ordering, or digest input changes, so an old approval never matches. */
export const SETUP_PLANNER_ID = 'khala-setup-planner/1';

export type LifecycleCommand = 'setup' | 'remove';
export type LifecycleOptions = Readonly<{ dryRun: boolean; confirm: Sha256Digest | null }>;

/**
 * Seam for the transaction executor (`executeSetupPlan`). It receives the command and the
 * approved digest, never a plan to trust: it takes its lock, calls `replan` for a fresh plan,
 * and applies only if that plan's digest still equals the approved one.
 */
export type SetupExecute = (request: Readonly<{
  command: LifecycleCommand;
  confirmedDigest: Sha256Digest;
  replan: () => Promise<ExecutablePlan>;
}>) => Promise<ExecutionOutcome>;

/**
 * Supplies the bytes and non-default modes a plan writes. Harness adapters describe operations
 * by hash only; the payload that backs those hashes comes from here. Modes are digest inputs.
 */
export type SetupPayloadSource = (request: Readonly<{ command: LifecycleCommand; operations: readonly SetupOperation[] }>) =>
  Promise<Readonly<{ contents: ReadonlyMap<Sha256Digest, Uint8Array>; modes: ReadonlyMap<string, number> }>>;

const EMPTY_PAYLOAD: SetupPayloadSource = async () => ({ contents: new Map(), modes: new Map() });

export type SetupService = Readonly<{
  configuration(): Promise<SetupResult>;
  lifecycle(command: LifecycleCommand, options: LifecycleOptions): Promise<SetupResult>;
}>;

export type SetupServiceOptions = Readonly<{
  /** Resolved per invocation so a bad HOME/XDG input fails that command, not module load. */
  environment: () => SetupEnvironment;
  adapters: readonly SetupAdapter[];
  execute: SetupExecute;
  payload?: SetupPayloadSource;
}>;

type Prepared = Readonly<{
  snapshot: Snapshot;
  /** A refusal or recovery state that stops planning, or `null` when a plan was built. */
  stop: SetupState | null;
  operations: readonly SetupOperation[];
  executable: ExecutablePlan;
}>;

type Observed = Readonly<{
  adapter: SetupAdapter;
  report: HarnessReport;
  /** Operations toward `present`, used for status readiness. */
  setupOperations: readonly SetupOperation[];
  observation: Parameters<SetupAdapter['plan']>[0]['observation'];
}>;

type Snapshot = Readonly<{
  environment: SetupEnvironment;
  observed: readonly Observed[];
  diagnostics: readonly SetupDiagnostic[];
  recovery: boolean;
  fallbackRoute: string | null;
}>;

export function createSetupService(options: SetupServiceOptions): SetupService {
  const adapters = orderedAdapters(options.adapters);
  const payload = options.payload ?? EMPTY_PAYLOAD;

  // Every invocation, including a confirmed one and the executor's replan under its lock,
  // starts from fresh state. An approval is never checked against a plan computed earlier.
  async function prepare(command: LifecycleCommand): Promise<Prepared> {
    const snapshot = await observe(options.environment(), adapters);
    const stop = snapshot.recovery ? 'recovery_required' : refusalState(command, snapshot);
    const operations = stop === null ? planOperations(command, snapshot) : [];
    const { contents, modes } = await payload({ command, operations });
    const unsupportedHarnesses = snapshot.observed
      .filter(entry => !entry.report.version.supported).map(entry => entry.report.harness);
    const digest = planDigest(command, snapshot, operations, modes, unsupportedHarnesses);
    return { snapshot, stop, operations,
      executable: { command, planDigest: digest, operations, contents, modes, unsupportedHarnesses } };
  }

  async function lifecycle(command: LifecycleCommand, lifecycleOptions: LifecycleOptions): Promise<SetupResult> {
    const { snapshot, stop, operations, executable } = await prepare(command);
    if (stop !== null) return result(command, stop, snapshot, [], null, NOT_REQUIRED);
    if (operations.length === 0) {
      return result(command, command === 'setup' ? statusState(snapshot) : settledRemoveState(snapshot), snapshot,
        [], null, NOT_REQUIRED);
    }
    const digest = executable.planDigest;
    // A dry run never reaches the executor, whatever digest it carries.
    if (lifecycleOptions.dryRun || lifecycleOptions.confirm !== digest) {
      return result(command, 'confirmation_required', snapshot, operations, digest,
        confirmationRequest(command, snapshot, operations, digest));
    }
    // Any throw once execution may have started, including re-inspection afterwards, leaves the
    // final state unproven.
    try {
      const outcome = await options.execute({
        command, confirmedDigest: digest, replan: async () => (await prepare(command)).executable,
      });
      return await settle(command, digest, outcome);
    } catch {
      return result(command, 'recovery_required', snapshot, [], digest, CONFIRMED, [...snapshot.diagnostics,
        { code: 'execution_failed', severity: 'error', message: 'Setup stopped unexpectedly; its final state is not proven.' }]);
    }
  }

  async function settle(
    command: LifecycleCommand, digest: Sha256Digest, outcome: ExecutionOutcome,
  ): Promise<SetupResult> {
    switch (outcome.kind) {
      case 'replanned': {
        // State moved between approval and the lock: relay the fresh plan for a new approval.
        const fresh = await lifecycle(command, { dryRun: false, confirm: null });
        return { ...fresh, diagnostics: [...fresh.diagnostics, { code: 'plan_changed', severity: 'warning',
          message: 'The plan changed since it was approved; nothing was applied. Relay this plan and confirm it again.' }] };
      }
      case 'committed': {
        const after = await observe(options.environment(), adapters);
        const state = command === 'setup' ? statusState(after) : settledRemoveState(after);
        return { ...result(command, state, after, [], digest, CONFIRMED), changed: outcome.changed, operations: outcome.operations };
      }
      case 'refused':
        return executed(command, outcome.state, digest, [], outcome.diagnostics);
      // No member of the frozen state vocabulary means "busy" or "failed and fully reversed";
      // both are safe refusals that changed nothing, reported as conflict with their diagnostics.
      case 'busy':
        return executed(command, 'conflict', digest, [], outcome.diagnostics);
      case 'rolled_back':
        return executed(command, 'conflict', digest, outcome.operations, outcome.diagnostics);
      case 'recovery_required':
        return executed(command, 'recovery_required', digest, outcome.operations, outcome.diagnostics);
    }
  }

  async function executed(
    command: LifecycleCommand, state: SetupState, digest: Sha256Digest,
    operations: readonly SetupOperationReport[], diagnostics: readonly SetupDiagnostic[],
  ): Promise<SetupResult> {
    const after = await observe(options.environment(), adapters);
    const base = result(command, state, after, [], digest, CONFIRMED, after.diagnostics);
    return { ...base, operations, diagnostics: [...base.diagnostics, ...diagnostics.map(projectExecutorDiagnostic)] };
  }

  return Object.freeze({
    async configuration() {
      const snapshot = await observe(options.environment(), adapters);
      const state = statusState(snapshot);
      return result('status', state, snapshot, [], null, NOT_REQUIRED,
        [...snapshot.diagnostics, ...fallbackDiagnostics(state, snapshot.fallbackRoute)]);
    },
    lifecycle,
  });
}

export function setupResultExitCode(value: SetupResult, check = false): number {
  return setupExitCode(value.command, value.state, { check });
}

function orderedAdapters(adapters: readonly SetupAdapter[]): readonly SetupAdapter[] {
  const byHarness = new Map<string, SetupAdapter>();
  for (const adapter of adapters) {
    if (!HARNESS_IDS.includes(adapter.harness) || byHarness.has(adapter.harness)) {
      throw new Error(`invalid setup adapter set: ${adapter.harness}`);
    }
    byHarness.set(adapter.harness, adapter);
  }
  return HARNESS_IDS.flatMap(harness => byHarness.get(harness) ?? []);
}

async function observe(environment: SetupEnvironment, adapters: readonly SetupAdapter[]): Promise<Snapshot> {
  const paths = resolveSetupPaths({
    HOME: environment.home, XDG_CONFIG_HOME: environment.xdgConfigHome,
    XDG_DATA_HOME: environment.xdgDataHome, XDG_STATE_HOME: environment.xdgStateHome,
  });
  // Status only needs to know a journal exists; its contents are never read into a result.
  const recovery = (await environment.probe.readFile(paths.transactionPath)) !== null;
  const observed: Observed[] = [];
  const diagnostics: SetupDiagnostic[] = [];
  for (const adapter of adapters) {
    const harness = adapter.harness;
    let detection: HarnessDetection;
    let observation: Observed['observation'];
    try {
      detection = projectDetection(await adapter.detect(environment));
      if (detection.executable === null) continue;
      observation = await adapter.inspect(environment, detection);
    } catch {
      diagnostics.push({ code: 'inspection_failed', severity: 'error', harness,
        message: 'The harness configuration could not be inspected.' });
      observed.push(failedObservation(adapter));
      continue;
    }
    const components = projectComponents(observation.components);
    const report: HarnessReport = {
      harness,
      executable: { present: true, path: detection.executable },
      version: { detected: detection.version, supported: detection.supported },
      components,
      route: observation.route,
    };
    const cleanObservation = { detection, components, route: observation.route, diagnostics: [] };
    diagnostics.push(...observation.diagnostics.map(diagnostic => projectDiagnostic(diagnostic, harness)));
    observed.push({
      adapter, report, observation: cleanObservation,
      setupOperations: projectOperations(adapter, adapter.plan({ desired: 'present', observation: cleanObservation })),
    });
  }
  const khala = await environment.probe.resolveExecutable('khala');
  return { environment, observed, diagnostics, recovery, fallbackRoute: khala === null ? null : 'khala read' };
}

function failedObservation(adapter: SetupAdapter): Observed {
  const detection = { executable: null, version: null, supported: false };
  return {
    adapter, setupOperations: [],
    observation: { detection, components: [], route: 'unknown', diagnostics: [] },
    report: { harness: adapter.harness, executable: { present: true, path: null },
      version: { detected: null, supported: false }, components: [], route: 'unknown' },
  };
}

// Projections: adapters are in-repo code, but a result must never carry a field this module did
// not name, so every value is copied field by field rather than spread.

function projectDetection(value: HarnessDetection): HarnessDetection {
  return { executable: value.executable, version: value.version, supported: value.supported === true };
}

function projectComponents(values: HarnessReport['components']): HarnessReport['components'] {
  return [...values]
    .map(value => ({ component: value.component, state: value.state }))
    .sort((a, b) => SETUP_COMPONENTS.indexOf(a.component) - SETUP_COMPONENTS.indexOf(b.component));
}

function projectDiagnostic(value: SetupDiagnostic, harness: HarnessId): SetupDiagnostic {
  return {
    code: value.code, severity: value.severity, harness,
    ...(value.component === undefined ? {} : { component: value.component }),
    message: value.message,
  };
}

function projectOperation(value: SetupOperation): SetupOperation {
  const base = { id: value.id, harness: value.harness, component: value.component, path: value.path };
  switch (value.type) {
    case 'file_create': return { ...base, type: value.type, postimage: value.postimage };
    case 'file_replace': return { ...base, type: value.type, preimage: value.preimage, postimage: value.postimage };
    case 'file_delete': return { ...base, type: value.type, preimage: value.preimage };
    case 'file_restore': return { ...base, type: value.type, current: value.current, restored: value.restored };
    case 'config_entry_set':
      return { ...base, type: value.type, entry: value.entry, preimage: value.preimage, postimage: value.postimage };
    case 'config_entry_remove':
      return { ...base, type: value.type, entry: value.entry, preimage: value.preimage, postimage: value.postimage };
    case 'vendor_command':
      return { ...base, type: value.type, executable: value.executable, args: [...value.args],
        writablePaths: [...value.writablePaths].sort() };
  }
}

function compareOperations(a: SetupOperation, b: SetupOperation): number {
  return HARNESS_IDS.indexOf(a.harness) - HARNESS_IDS.indexOf(b.harness)
    || SETUP_COMPONENTS.indexOf(a.component) - SETUP_COMPONENTS.indexOf(b.component)
    || compareText(a.path, b.path)
    || compareText(a.id, b.id);
}

function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

function projectOperations(adapter: SetupAdapter, values: readonly SetupOperation[]): readonly SetupOperation[] {
  const operations = values.map(projectOperation).sort(compareOperations);
  const ids = new Set<string>();
  for (const operation of operations) {
    // An adapter may only plan its own harness, and an operation ID names exactly one step.
    if (operation.harness !== adapter.harness || ids.has(operation.id)) {
      throw new Error(`invalid setup plan from ${adapter.harness}`);
    }
    ids.add(operation.id);
  }
  return operations;
}

function planOperations(command: LifecycleCommand, snapshot: Snapshot): readonly SetupOperation[] {
  return snapshot.observed.flatMap(entry => command === 'setup'
    ? entry.setupOperations
    : projectOperations(entry.adapter, entry.adapter.plan({ desired: 'absent', observation: entry.observation })))
    .sort(compareOperations);
}

// State derivation. Absent harnesses are excluded from readiness; the most severe detected
// harness state wins, in this order.
const STATE_PRECEDENCE: readonly SetupState[] = [
  'conflict', 'drifted', 'unsupported', 'awaiting_hook_review',
  'configured_effect_unknown', 'configured_restart_required', 'ready',
];

function harnessState(entry: Observed): SetupState {
  const { report } = entry;
  if (!report.version.supported) return 'unsupported';
  const states = new Set(report.components.map(component => component.state));
  for (const state of ['conflict', 'drifted', 'unsupported', 'awaiting_hook_review'] as const) {
    if (states.has(state)) return state;
  }
  // The frozen state vocabulary has no "not configured" member. A detected harness with setup
  // still to do reports as drifted from the desired state, with a `setup_required` diagnostic.
  if (entry.setupOperations.length > 0) return 'drifted';
  // Configured components prove nothing about delivery; only an evidence-backed route does.
  if (report.route === 'unknown') return 'configured_effect_unknown';
  if (report.route === 'unavailable') return 'configured_restart_required';
  return 'ready';
}

function statusState(snapshot: Snapshot): SetupState {
  if (snapshot.recovery) return 'recovery_required';
  if (snapshot.observed.length === 0) return 'no_harness';
  const states = new Set(snapshot.observed.map(harnessState));
  return STATE_PRECEDENCE.find(state => states.has(state)) ?? 'ready';
}

function refusalState(command: LifecycleCommand, snapshot: Snapshot): SetupState | null {
  for (const state of ['conflict', 'drifted', 'unsupported'] as const) {
    const blocked = snapshot.observed.some(entry => {
      const components = entry.report.components.some(component => component.state === state);
      // Removal stays available for an unsupported harness; drift or conflict refuses both.
      if (state === 'unsupported') return command === 'setup' && (components || !entry.report.version.supported);
      return components;
    });
    if (blocked) return state;
  }
  return null;
}

function settledRemoveState(snapshot: Snapshot): SetupState {
  return snapshot.observed.length === 0 ? 'no_harness' : 'ready';
}

function okFor(state: SetupState): boolean {
  return state === 'no_harness' || state === 'ready'
    || state === 'configured_restart_required' || state === 'configured_effect_unknown';
}

function fallbackDiagnostics(state: SetupState, fallbackRoute: string | null): SetupDiagnostic[] {
  if (state !== 'configured_restart_required' && state !== 'configured_effect_unknown') return [];
  return fallbackRoute === null
    ? [{ code: 'cli_fallback_unavailable', severity: 'warning',
      message: 'The native route is not yet effective and no installed khala CLI was found on PATH.' }]
    : [{ code: 'cli_fallback', severity: 'info',
      message: 'The native route is not yet effective; use `khala read` and `khala send` until it is.' }];
}

function setupRequiredDiagnostics(snapshot: Snapshot): SetupDiagnostic[] {
  return snapshot.observed.filter(entry => harnessState(entry) === 'drifted' && entry.setupOperations.length > 0
    && !entry.report.components.some(component => component.state === 'drifted'))
    .map(entry => ({ code: 'setup_required', severity: 'warning', harness: entry.report.harness,
      message: 'Khala is not fully configured for this harness.' }));
}

// Canonical encoding and digest.

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => compareText(a, b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Binds the planner identity, command, every detected harness fact, every operation with its
 * pre/post hashes, the installer-file mode overrides, and the unsupported harnesses the
 * executor must honour. Payload bytes are bound through the postimage hashes. Timestamps,
 * transaction IDs, temporary paths, and backup bytes are not inputs, so identical state yields
 * an identical digest.
 */
function planDigest(
  command: LifecycleCommand, snapshot: Snapshot, operations: readonly SetupOperation[],
  modes: ReadonlyMap<string, number>, unsupportedHarnesses: readonly HarnessId[],
): Sha256Digest {
  const input = canonical({
    planner: SETUP_PLANNER_ID, schema: SETUP_SCHEMA_VERSION, command,
    harnesses: snapshot.observed.map(entry => entry.report), operations,
    modes: [...modes].sort(([a], [b]) => compareText(a, b)), unsupportedHarnesses,
  });
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

const ACTIONS: Readonly<Record<SetupOperation['type'], ConfirmationAction['action']>> = {
  file_create: 'create', file_replace: 'replace', file_delete: 'delete', file_restore: 'restore',
  config_entry_set: 'configure', config_entry_remove: 'configure', vendor_command: 'configure',
};

function confirmationRequest(
  command: LifecycleCommand, snapshot: Snapshot, operations: readonly SetupOperation[], digest: Sha256Digest,
): SetupResult['confirmation'] {
  const actions = new Map<string, ConfirmationAction>();
  const paths = new Set<string>();
  for (const operation of operations) {
    const action = { harness: operation.harness, component: operation.component, action: ACTIONS[operation.type] };
    actions.set(`${action.harness}\0${action.component}\0${action.action}`, action);
    paths.add(operation.path);
    if (operation.type === 'vendor_command') for (const writable of operation.writablePaths) paths.add(writable);
  }
  const harnesses = HARNESS_IDS.filter(harness => operations.some(operation => operation.harness === harness));
  const backupsRoot = resolveSetupPaths({
    HOME: snapshot.environment.home, XDG_STATE_HOME: snapshot.environment.xdgStateHome,
  }).backupsRoot;
  const verb = command === 'setup' ? 'install and configure Khala' : 'remove Khala';
  return {
    required: true,
    confirmed: false,
    command,
    harnesses,
    actions: [...actions.values()],
    paths: [...paths].sort(compareText),
    backup: `Before any existing file is changed or deleted, a byte-exact copy is saved under ${backupsRoot}; `
      + 'removal restores it. A file you changed since setup is never overwritten.',
    // No adapter yet proves whether a running session picks the change up, so the honest claim is unknown.
    sessionEffect: 'unknown',
    fallbackRoute: snapshot.fallbackRoute,
    planDigest: digest,
    request: `Approve ${operations.length} change(s) to ${verb} for ${harnesses.join(', ')}? `
      + `If approved, run \`khala ${command} --confirm ${digest}\`.`,
  };
}

// A supplied digest confirms nothing unless it reached the executor, so these paths report false.
const NOT_REQUIRED: SetupResult['confirmation'] = Object.freeze({ required: false, confirmed: false });
const CONFIRMED: SetupResult['confirmation'] = Object.freeze({ required: false, confirmed: true });

function projectExecutorDiagnostic(value: SetupDiagnostic): SetupDiagnostic {
  return {
    code: value.code, severity: value.severity,
    ...(value.harness === undefined ? {} : { harness: value.harness }),
    ...(value.component === undefined ? {} : { component: value.component }),
    message: value.message,
  };
}

function result(
  command: SetupResult['command'], state: SetupState, snapshot: Snapshot, operations: readonly SetupOperation[],
  digest: Sha256Digest | null, confirmation: SetupResult['confirmation'],
  diagnostics: readonly SetupDiagnostic[] = snapshot.diagnostics,
): SetupResult {
  return {
    v: SETUP_SCHEMA_VERSION,
    command,
    ok: okFor(state),
    changed: false,
    state,
    planDigest: digest,
    confirmation,
    harnesses: snapshot.observed.map(entry => entry.report),
    operations: operations.map(operation => ({ ...operation, status: 'planned' as const })),
    diagnostics: command === 'status' ? [...diagnostics, ...setupRequiredDiagnostics(snapshot)] : diagnostics,
  };
}

