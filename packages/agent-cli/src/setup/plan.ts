// The one `discover -> inspect -> plan` pipeline behind `setup`, `remove`, and status
// configuration. It projects adapter output through closed allowlists, sorts and canonicalizes
// it, digests the plan, and gates execution on a digest the person approved for the plan
// computed from fresh state in this same invocation. Nothing here writes, locks, or prompts;
// every effect goes through the injected executor.
import { createHash } from 'node:crypto';
import { ClaudeSetupRefusal } from './adapters/claude.js';
import { sha256 } from './filesystem.js';
import { parseManifest, type ManifestEntry } from './manifest.js';
import { resolveSetupPaths } from './paths.js';
import { summarizeSetupJournal, type ExecutablePlan, type ExecutionOutcome, type SetupJournalSummary } from './transaction.js';
import {
  HARNESS_IDS, SETUP_COMPONENTS, SETUP_SCHEMA_VERSION, setupExitCode,
  type ComponentState, type ConfirmationAction, type HarnessDetection, type HarnessId, type HarnessObservation,
  type HarnessReport, type SetupAdapter, type SetupComponent, type SetupDiagnostic, type SetupEnvironment,
  type SetupOperation, type SetupOperationReport, type SetupPlanRequest, type SetupResult, type SetupState,
  type Sha256Digest,
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

/** The bytes behind one adapter plan, and the foreign files it owns one entry of. */
export type SetupPlanBytes = Readonly<{
  contents: ReadonlyMap<Sha256Digest, Uint8Array>;
  entryOwnedPaths?: readonly string[];
}>;

/**
 * A harness adapter as the planner composes it. Operations carry hashes only, so an adapter
 * that writes anything also supplies the bytes behind the exact plan it returned.
 */
export type ComposedSetupAdapter = SetupAdapter & Readonly<{
  planBytes?(request: SetupPlanRequest): SetupPlanBytes;
}>;

/** One installer-owned file below `$XDG_DATA_HOME/khala`: the runtime, a launcher, or a plugin copy. */
export type InstallerFile = Readonly<{
  path: string;
  component: 'payload' | 'launcher';
  bytes: Uint8Array;
  /** Harnesses whose installed configuration runs this file; it is staged only when one is set up. */
  harnesses: readonly HarnessId[];
  /** A mode other than the executor default (0400; launchers 0500). Modes are digest inputs. */
  mode?: number;
}>;

/** The packaged installer payload, resolved against the invocation's environment. */
export type SetupPayloadSource = (environment: SetupEnvironment) => Promise<readonly InstallerFile[]>;

const EMPTY_PAYLOAD: SetupPayloadSource = async () => [];

/**
 * Harnesses that only report. Claude Desktop has no proven route and Cursor installs no hook,
 * so their `unsupported` never refuses setup for another harness and never gates readiness.
 */
const REPORT_ONLY_WHEN_UNSUPPORTED: ReadonlySet<HarnessId> = new Set(['cursor', 'claude-app']);
const INSTALLER_COMPONENTS: ReadonlySet<SetupComponent> = new Set(['payload', 'launcher']);
/** Stands for a path the probe could not read; never equals a real hash. */
const UNREADABLE = 'sha256:unreadable' as Sha256Digest;

export type SetupService = Readonly<{
  configuration(): Promise<SetupResult>;
  lifecycle(command: LifecycleCommand, options: LifecycleOptions): Promise<SetupResult>;
}>;

export type SetupServiceOptions = Readonly<{
  /** Resolved per invocation so a bad HOME/XDG input fails that command, not module load. */
  environment: () => SetupEnvironment;
  adapters: readonly ComposedSetupAdapter[];
  execute: SetupExecute;
  payload?: SetupPayloadSource;
}>;

type Prepared = Readonly<{
  snapshot: Snapshot;
  /** A refusal or recovery state that stops planning, or `null` when a plan was built. */
  stop: SetupState | null;
  operations: readonly SetupOperation[];
  diagnostics: readonly SetupDiagnostic[];
  executable: ExecutablePlan;
  /** The interrupted transaction to recover first, or `null` when no journal exists. */
  recovery: SetupJournalSummary | null;
}>;

type Refusal = Readonly<{ state: 'conflict' | 'drifted' | 'unsupported'; diagnostics: readonly SetupDiagnostic[] }>;

type Observed = Readonly<{
  adapter: ComposedSetupAdapter;
  report: HarnessReport;
  /** Operations toward `present` (installer files included), used for status readiness. */
  setupOperations: readonly SetupOperation[];
  /** Set when the adapter refused to plan `present`; setup then refuses as this state. */
  refusal: Refusal | null;
  /** The adapter's own observation object, which it keys its plan inputs by. Never reported. */
  observation: HarnessObservation;
}>;

type InstallerTarget = Readonly<{ file: InstallerFile; operation: SetupOperation | null }>;

type Snapshot = Readonly<{
  environment: SetupEnvironment;
  observed: readonly Observed[];
  /**
   * Harnesses with no executable. They are reported, but never inspected or planned and never
   * inputs to readiness or the plan digest, so their config roots stay untouched.
   */
  absent: readonly HarnessReport[];
  diagnostics: readonly SetupDiagnostic[];
  recovery: boolean;
  /** The interrupted transaction's journal bytes; only a recovery digest and summary use them. */
  journal: Uint8Array | null;
  fallbackRoute: string | null;
  /** Installer files this setup stages, each attributed to the first harness that runs it. */
  installer: readonly InstallerTarget[];
  /** Committed manifest entries for installer files, whichever harness they were recorded under. */
  installerEntries: readonly ManifestEntry[];
  /** Current hash of every path an installer entry or file names. */
  installerCurrent: ReadonlyMap<string, Sha256Digest | null>;
}>;

export function createSetupService(options: SetupServiceOptions): SetupService {
  const adapters = orderedAdapters(options.adapters);
  const payload = options.payload ?? EMPTY_PAYLOAD;

  // Every invocation, including a confirmed one and the executor's replan under its lock,
  // starts from fresh state. An approval is never checked against a plan computed earlier.
  async function prepare(command: LifecycleCommand): Promise<Prepared> {
    const snapshot = await observe(options.environment(), adapters, payload);
    if (snapshot.journal !== null) {
      // An interrupted transaction is recovered before anything is planned. Its plan changes
      // no file of its own, and its digest binds the exact journal the person approves.
      return { snapshot, stop: 'recovery_required', operations: [], diagnostics: snapshot.diagnostics,
        recovery: summarizeSetupJournal(snapshot.journal),
        executable: { command, planDigest: recoveryDigest(command, snapshot.journal), operations: [], contents: new Map() } };
    }
    let stop: SetupState | null = refusalState(command, snapshot);
    let diagnostics = snapshot.diagnostics;
    let planned: Planned = { operations: [], contents: new Map(), entryOwnedPaths: [] };
    if (stop === null) {
      const outcome = planOperations(command, snapshot);
      if ('refusal' in outcome) {
        stop = outcome.refusal.state;
        diagnostics = withDiagnostics(diagnostics, outcome.refusal.diagnostics);
      } else planned = outcome;
    }
    const { operations, contents, entryOwnedPaths } = planned;
    const modes = new Map(snapshot.installer.flatMap(({ file, operation }) =>
      operation !== null && file.mode !== undefined ? [[file.path, file.mode] as const] : []));
    const unsupportedHarnesses = snapshot.observed
      .filter(entry => !entry.report.version.supported && !REPORT_ONLY_WHEN_UNSUPPORTED.has(entry.report.harness))
      .map(entry => entry.report.harness);
    const digest = planDigest(command, snapshot, operations, modes, unsupportedHarnesses);
    return { snapshot, stop, operations, diagnostics, recovery: null,
      executable: { command, planDigest: digest, operations, contents, modes, unsupportedHarnesses, entryOwnedPaths } };
  }

  async function lifecycle(command: LifecycleCommand, lifecycleOptions: LifecycleOptions): Promise<SetupResult> {
    const { snapshot, stop, operations, diagnostics, executable, recovery } = await prepare(command);
    if (recovery !== null) return await recover(command, lifecycleOptions, snapshot, executable.planDigest, recovery);
    if (stop !== null) return result(command, stop, snapshot, [], null, NOT_REQUIRED, diagnostics);
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
    return await confirmed(command, digest, snapshot);
  }

  async function recover(
    command: LifecycleCommand, lifecycleOptions: LifecycleOptions, snapshot: Snapshot, digest: Sha256Digest,
    journal: SetupJournalSummary,
  ): Promise<SetupResult> {
    // An unreadable or newer journal has no recovery this build can prove, so nothing is offered.
    if (journal.kind !== 'recoverable') {
      return result(command, 'recovery_required', snapshot, [], null, NOT_REQUIRED,
        [...snapshot.diagnostics, recoveryDiagnostic(snapshot, journal)]);
    }
    if (lifecycleOptions.dryRun || lifecycleOptions.confirm !== digest) {
      return result(command, 'confirmation_required', snapshot, [], digest,
        recoveryRequest(command, snapshot, journal, digest), [...snapshot.diagnostics, { code: 'recovery_available',
          severity: 'warning', message: `An interrupted \`khala ${journal.command}\` must be recovered before anything `
            + `else changes. Relay this recovery plan; once approved, run \`khala ${command} --confirm ${digest}\`.` }]);
    }
    return await confirmed(command, digest, snapshot);
  }

  async function confirmed(command: LifecycleCommand, digest: Sha256Digest, snapshot: Snapshot): Promise<SetupResult> {
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
      case 'recovered': {
        // Recovery applied nothing new; the fresh plan (or settled state) is what comes next.
        const fresh = await lifecycle(command, { dryRun: false, confirm: null });
        const done = outcome.resolution === 'finalized' ? 'finished committing' : 'was rolled back';
        const next = fresh.state === 'confirmation_required'
          ? `Relay this plan to continue \`khala ${command}\`.` : 'Nothing else is needed.';
        return { ...fresh, changed: true, diagnostics: [...fresh.diagnostics, { code: 'recovered', severity: 'info',
          message: `The interrupted setup transaction ${done}. ${next}` }] };
      }
      case 'committed': {
        const after = await observe(options.environment(), adapters, payload);
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
    const after = await observe(options.environment(), adapters, payload);
    const base = result(command, state, after, [], digest, CONFIRMED, after.diagnostics);
    return { ...base, operations, diagnostics: [...base.diagnostics, ...diagnostics.map(projectExecutorDiagnostic)] };
  }

  return Object.freeze({
    async configuration() {
      const snapshot = await observe(options.environment(), adapters, payload);
      const state = statusState(snapshot);
      const recovery = snapshot.journal === null ? [] : [recoveryDiagnostic(snapshot, summarizeSetupJournal(snapshot.journal))];
      return result('status', state, snapshot, [], null, NOT_REQUIRED,
        [...snapshot.diagnostics, ...recovery, ...fallbackDiagnostics(state, snapshot.fallbackRoute)]);
    },
    lifecycle,
  });
}

export function setupResultExitCode(value: SetupResult, check = false): number {
  return setupExitCode(value.command, value.state, { check });
}

function orderedAdapters(adapters: readonly ComposedSetupAdapter[]): readonly ComposedSetupAdapter[] {
  const byHarness = new Map<string, ComposedSetupAdapter>();
  for (const adapter of adapters) {
    if (!HARNESS_IDS.includes(adapter.harness) || byHarness.has(adapter.harness)) {
      throw new Error(`invalid setup adapter set: ${adapter.harness}`);
    }
    byHarness.set(adapter.harness, adapter);
  }
  return HARNESS_IDS.flatMap(harness => byHarness.get(harness) ?? []);
}

async function observe(
  environment: SetupEnvironment, adapters: readonly ComposedSetupAdapter[], payload: SetupPayloadSource,
): Promise<Snapshot> {
  const paths = resolveSetupPaths({
    HOME: environment.home, XDG_CONFIG_HOME: environment.xdgConfigHome,
    XDG_DATA_HOME: environment.xdgDataHome, XDG_STATE_HOME: environment.xdgStateHome,
  });
  // Only a decoded summary of the journal (its command, operations, and paths) reaches a result.
  const journal = await environment.probe.readFile(paths.transactionPath);
  const recovery = journal !== null;
  const observed: Observed[] = [];
  const absent: HarnessReport[] = [];
  let diagnostics: SetupDiagnostic[] = [];
  for (const adapter of adapters) {
    const harness = adapter.harness;
    let detection: HarnessDetection;
    let observation: HarnessObservation;
    try {
      detection = projectDetection(await adapter.detect(environment));
      if (detection.executable === null) {
        absent.push(absentReport(harness));
        continue;
      }
      observation = await adapter.inspect(environment, detection);
    } catch {
      diagnostics.push(inspectionFailed(harness));
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
    diagnostics.push(...observation.diagnostics.map(diagnostic => projectDiagnostic(diagnostic, harness)));
    // Adapters key their plan inputs by the exact observation object `inspect` returned, so the
    // planner hands that object back; only projected fields ever reach a result.
    let setupOperations: readonly SetupOperation[] = [];
    let refusal: Refusal | null = null;
    try {
      setupOperations = projectOperations(adapter, adapter.plan({ desired: 'present', observation }));
    } catch (error) {
      refusal = refusalOf(error, harness);
      if (refusal === null) {
        diagnostics.push(inspectionFailed(harness));
        observed.push(failedObservation(adapter));
        continue;
      }
    }
    // Setup still to do with nothing planned is an adapter refusal (Cursor plans nothing on a
    // conflict), never a silent no-op that reports success.
    if (refusal === null && detection.supported && setupOperations.length === 0
      && components.some(component => component.state === 'absent')) {
      refusal = { state: 'conflict', diagnostics: [{ code: 'setup_not_planned', severity: 'error', harness,
        message: 'Khala is not fully configured for this harness, but no safe change could be planned.' }] };
    }
    if (refusal !== null) diagnostics = withDiagnostics(diagnostics, refusal.diagnostics);
    observed.push({ adapter, report, observation, setupOperations, refusal });
  }
  const installer = await observeInstaller(environment, paths.manifestPath, payload, observed);
  diagnostics = withDiagnostics(diagnostics, installer.diagnostics);
  const khala = await environment.probe.resolveExecutable('khala');
  return {
    environment, observed: installer.observed, absent, diagnostics, recovery, journal, fallbackRoute: khala === null ? null : 'khala read',
    installer: installer.targets, installerEntries: installer.entries, installerCurrent: installer.current,
  };
}

function absentReport(harness: HarnessId): HarnessReport {
  return { harness, executable: { present: false, path: null }, version: { detected: null, supported: false },
    components: [], route: 'unavailable' };
}

function inspectionFailed(harness: HarnessId): SetupDiagnostic {
  return { code: 'inspection_failed', severity: 'error', harness, message: 'The harness configuration could not be inspected.' };
}

/** A structured adapter refusal, or `null` for any other failure. */
function refusalOf(error: unknown, harness: HarnessId): Refusal | null {
  if (!(error instanceof ClaudeSetupRefusal)) return null;
  return { state: error.state, diagnostics: error.diagnostics.map(diagnostic => projectDiagnostic(diagnostic, harness)) };
}

/** Appends diagnostics not already present, so a refusal never repeats what inspection said. */
function withDiagnostics(base: readonly SetupDiagnostic[], extra: readonly SetupDiagnostic[]): SetupDiagnostic[] {
  const key = (diagnostic: SetupDiagnostic) => canonical(projectExecutorDiagnostic(diagnostic));
  const seen = new Set(base.map(key));
  const merged = [...base];
  for (const diagnostic of extra) {
    if (seen.has(key(diagnostic))) continue;
    seen.add(key(diagnostic));
    merged.push(diagnostic);
  }
  return merged;
}

function failedObservation(adapter: ComposedSetupAdapter): Observed {
  const detection = { executable: null, version: null, supported: false };
  return {
    adapter, setupOperations: [], refusal: null,
    observation: { detection, components: [], route: 'unknown', diagnostics: [] },
    report: { harness: adapter.harness, executable: { present: true, path: null },
      version: { detected: null, supported: false }, components: [], route: 'unknown' },
  };
}

const COMPONENT_RANK: readonly ComponentState[] = ['ready', 'absent', 'awaiting_hook_review', 'drifted', 'conflict', 'unsupported'];

/**
 * Plans the installer files (runtime, launcher, plugin copies) the harness entries run. Each
 * file is staged for the first harness, in harness order, whose configuration runs it and whose
 * setup is not refused; its state joins that harness's report and its drift or conflict refuses
 * that harness. Ownership comes only from the committed manifest.
 */
async function observeInstaller(
  environment: SetupEnvironment, manifestPath: string, payload: SetupPayloadSource, observed: readonly Observed[],
): Promise<Readonly<{
  observed: Observed[]; targets: InstallerTarget[]; entries: ManifestEntry[];
  current: Map<string, Sha256Digest | null>; diagnostics: SetupDiagnostic[];
}>> {
  const read = async (target: string): Promise<Sha256Digest | null> => {
    try {
      const bytes = await environment.probe.readFile(target);
      return bytes === null ? null : sha256(bytes);
    } catch {
      return UNREADABLE;
    }
  };
  const diagnostics: SetupDiagnostic[] = [];
  let entries: ManifestEntry[] = [];
  const manifest = await environment.probe.readFile(manifestPath).catch(() => null);
  if (manifest !== null) {
    try {
      entries = parseManifest(manifest).entries.filter(entry => INSTALLER_COMPONENTS.has(entry.component));
    } catch {
      // Adapters report the unreadable manifest; installer ownership is then unknown.
    }
  }
  const current = new Map<string, Sha256Digest | null>();
  for (const entry of entries) current.set(entry.path, await read(entry.path));
  const managed = new Map(entries.map(entry => [entry.path, entry]));
  type Draft = {
    setupOperations: SetupOperation[]; components: { component: SetupComponent; state: ComponentState }[]; refusal: Refusal | null;
  };
  const byHarness = new Map<HarnessId, Draft>(observed.map(entry => [entry.report.harness, {
    setupOperations: [...entry.setupOperations], components: [...entry.report.components], refusal: entry.refusal,
  }]));
  const targets: InstallerTarget[] = [];
  for (const file of await payload(environment)) {
    const owner = observed.find(entry => file.harnesses.includes(entry.report.harness)
      && entry.report.version.supported && entry.refusal === null);
    if (owner === undefined) continue;
    const harness = owner.report.harness;
    const hash = current.get(file.path) ?? await read(file.path);
    current.set(file.path, hash);
    const desired = sha256(file.bytes);
    const entry = managed.get(file.path);
    const base = { harness, component: file.component, path: file.path };
    let state: ComponentState;
    let operation: SetupOperation | null = null;
    if (entry !== undefined) {
      if (hash !== entry.postimage) {
        state = 'drifted';
        diagnostics.push({ code: 'installer_drifted', severity: 'error', harness, component: file.component,
          message: `${file.path} changed since Khala installed it; setup will not overwrite it.` });
      } else if (entry.postimage === desired) {
        state = 'ready';
      } else {
        state = 'absent';
        operation = { ...base, id: `installer:${file.component}:replace:${file.path}`, type: 'file_replace', preimage: hash, postimage: desired };
      }
    } else if (hash === null) {
      state = 'absent';
      operation = { ...base, id: `installer:${file.component}:create:${file.path}`, type: 'file_create', postimage: desired };
    } else {
      state = 'conflict';
      diagnostics.push({ code: 'installer_unowned', severity: 'error', harness, component: file.component,
        message: `${file.path} exists but Khala did not install it; setup will not replace it.` });
    }
    const target = byHarness.get(harness)!;
    const existing = target.components.find(item => item.component === file.component);
    if (existing === undefined) target.components.push({ component: file.component, state });
    else if (COMPONENT_RANK.indexOf(state) > COMPONENT_RANK.indexOf(existing.state)) {
      target.components.splice(target.components.indexOf(existing), 1, { component: file.component, state });
    }
    if (operation !== null) target.setupOperations.push(operation);
    if ((state === 'drifted' || state === 'conflict') && target.refusal === null) target.refusal = { state, diagnostics: [] };
    targets.push({ file, operation });
  }
  const merged = observed.map((entry): Observed => {
    const draft = byHarness.get(entry.report.harness)!;
    return {
      ...entry,
      refusal: draft.refusal,
      setupOperations: draft.setupOperations.sort(compareOperations),
      report: { ...entry.report, components: projectComponents(draft.components) },
    };
  });
  return { observed: merged, targets, entries, current, diagnostics };
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

function projectOperations(adapter: ComposedSetupAdapter, values: readonly SetupOperation[]): readonly SetupOperation[] {
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

type Planned = Readonly<{
  operations: readonly SetupOperation[];
  contents: ReadonlyMap<Sha256Digest, Uint8Array>;
  entryOwnedPaths: readonly string[];
}>;

/** The command's operations with the bytes behind them, or the refusal an adapter raised. */
function planOperations(command: LifecycleCommand, snapshot: Snapshot): Planned | Readonly<{ refusal: Refusal }> {
  const desired = command === 'setup' ? 'present' : 'absent';
  const operations: SetupOperation[] = [];
  const contents = new Map<Sha256Digest, Uint8Array>();
  const entryOwnedPaths = new Set<string>();
  // Installer files are shared by every harness that runs them, so they are removed from the
  // manifest by path, never by whichever adapter's entry happens to record them.
  const installerPaths = new Set(snapshot.installerEntries.map(entry => entry.path));
  for (const entry of snapshot.observed) {
    // A harness whose inspection failed has no observation its adapter could plan from.
    if (entry.report.executable.path === null) continue;
    const request = { desired, observation: entry.observation } as const;
    let planned: readonly SetupOperation[];
    try {
      planned = command === 'setup'
        ? entry.setupOperations.filter(operation => !operation.id.startsWith('installer:'))
        : projectOperations(entry.adapter, entry.adapter.plan(request)).filter(operation => !installerPaths.has(operation.path));
    } catch (error) {
      const refusal = refusalOf(error, entry.report.harness);
      if (refusal === null) throw error;
      return { refusal };
    }
    if (planned.length === 0) continue;
    operations.push(...planned);
    const bytes = entry.adapter.planBytes?.(request);
    for (const [digest, value] of bytes?.contents ?? []) contents.set(digest, value);
    for (const target of bytes?.entryOwnedPaths ?? []) entryOwnedPaths.add(target);
  }
  if (command === 'setup') {
    for (const { file, operation } of snapshot.installer) {
      if (operation === null) continue;
      operations.push(operation);
      contents.set(sha256(file.bytes), file.bytes);
    }
  } else {
    const drifted: SetupDiagnostic[] = [];
    for (const entry of snapshot.installerEntries) {
      const base = { harness: entry.harness, component: entry.component, path: entry.path };
      if (snapshot.installerCurrent.get(entry.path) !== entry.postimage) {
        drifted.push({ code: 'installer_drifted', severity: 'error', harness: entry.harness, component: entry.component,
          message: `${entry.path} changed since Khala installed it; removal preserves it.` });
        continue;
      }
      operations.push(entry.baseline.hash === null
        ? { ...base, id: `installer:${entry.component}:delete:${entry.path}`, type: 'file_delete', preimage: entry.postimage }
        : { ...base, id: `installer:${entry.component}:restore:${entry.path}`, type: 'file_restore',
          current: entry.postimage, restored: entry.baseline.hash });
    }
    if (drifted.length > 0) return { refusal: { state: 'drifted', diagnostics: drifted } };
  }
  return { operations: operations.sort(compareOperations), contents, entryOwnedPaths: [...entryOwnedPaths].sort(compareText) };
}

// State derivation. Absent harnesses are excluded from readiness; the most severe detected
// harness state wins, in this order.
const STATE_PRECEDENCE: readonly SetupState[] = [
  'conflict', 'drifted', 'unsupported', 'awaiting_hook_review',
  'configured_effect_unknown', 'configured_restart_required', 'ready',
];

/** A harness's readiness state, or `null` for a report-only harness that has nothing to configure. */
function harnessState(entry: Observed): SetupState | null {
  const { report } = entry;
  const reportOnly = REPORT_ONLY_WHEN_UNSUPPORTED.has(report.harness);
  if (reportOnly && (!report.version.supported || report.components.some(component => component.state === 'unsupported'))) return null;
  if (!report.version.supported) return 'unsupported';
  if (entry.refusal !== null) return entry.refusal.state;
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

/** The next step an agent relays for an interrupted transaction's journal. */
function recoveryDiagnostic(snapshot: Snapshot, journal: SetupJournalSummary): SetupDiagnostic {
  const { transactionPath } = resolveSetupPaths({
    HOME: snapshot.environment.home, XDG_STATE_HOME: snapshot.environment.xdgStateHome,
  });
  switch (journal.kind) {
    case 'recoverable':
      return { code: 'recovery_pending', severity: 'error', message: `An interrupted \`khala ${journal.command}\` `
        + 'left a transaction to recover. Run `khala setup` or `khala remove` and relay the recovery plan it returns.' };
    case 'unsupported':
      return { code: 'journal_unsupported', severity: 'error', message: `${transactionPath} was written by a newer `
        + 'Khala; recover it with that version. This build changes nothing while it exists.' };
    case 'unreadable':
      return { code: 'journal_corrupt', severity: 'error', message: `${transactionPath} is unreadable, so what the `
        + 'interrupted transaction changed cannot be proven. Nothing was changed; the journal and its backups need manual review.' };
  }
}

function statusState(snapshot: Snapshot): SetupState {
  if (snapshot.recovery) return 'recovery_required';
  const states = new Set(snapshot.observed.map(harnessState).filter(state => state !== null));
  if (states.size === 0) return 'no_harness';
  return STATE_PRECEDENCE.find(state => states.has(state)) ?? 'ready';
}

function refusalState(command: LifecycleCommand, snapshot: Snapshot): SetupState | null {
  for (const state of ['conflict', 'drifted', 'unsupported'] as const) {
    const blocked = snapshot.observed.some(entry => {
      if (command === 'setup' && entry.refusal?.state === state) return true;
      const components = entry.report.components.some(component => component.state === state);
      // Removal stays available for an unsupported harness; drift or conflict refuses both. A
      // report-only harness being unsupported never refuses setup for the others.
      if (state === 'unsupported') {
        return command === 'setup' && !REPORT_ONLY_WHEN_UNSUPPORTED.has(entry.report.harness)
          && (components || !entry.report.version.supported);
      }
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
  return digestOf({
    planner: SETUP_PLANNER_ID, schema: SETUP_SCHEMA_VERSION, command,
    harnesses: snapshot.observed.map(entry => entry.report), operations,
    modes: [...modes].sort(([a], [b]) => compareText(a, b)), unsupportedHarnesses,
  });
}

/**
 * A recovery plan's digest binds the command and the exact journal bytes, so an approval
 * recovers only the transaction the person was shown and never matches an ordinary plan.
 */
function recoveryDigest(command: LifecycleCommand, journal: Uint8Array): Sha256Digest {
  return digestOf({ planner: SETUP_PLANNER_ID, schema: SETUP_SCHEMA_VERSION, command, recovery: sha256(journal) });
}

function digestOf(value: unknown): Sha256Digest {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

const ACTIONS: Readonly<Record<SetupOperation['type'], ConfirmationAction['action']>> = {
  file_create: 'create', file_replace: 'replace', file_delete: 'delete', file_restore: 'restore',
  config_entry_set: 'configure', config_entry_remove: 'configure', vendor_command: 'configure',
};

/** The harnesses, deduplicated component actions, and paths a set of operations touches. */
function footprint(
  operations: readonly SetupOperation[], actionOf: (operation: SetupOperation) => ConfirmationAction['action'],
): Readonly<{ harnesses: HarnessId[]; actions: ConfirmationAction[]; paths: string[] }> {
  const actions = new Map<string, ConfirmationAction>();
  const paths = new Set<string>();
  for (const operation of operations) {
    const action = { harness: operation.harness, component: operation.component, action: actionOf(operation) };
    actions.set(`${action.harness}\0${action.component}\0${action.action}`, action);
    paths.add(operation.path);
    if (operation.type === 'vendor_command') for (const writable of operation.writablePaths) paths.add(writable);
  }
  const harnesses = HARNESS_IDS.filter(harness => operations.some(operation => operation.harness === harness));
  return { harnesses, actions: [...actions.values()], paths: [...paths].sort(compareText) };
}

function backupsRootOf(snapshot: Snapshot): string {
  return resolveSetupPaths({ HOME: snapshot.environment.home, XDG_STATE_HOME: snapshot.environment.xdgStateHome }).backupsRoot;
}

function confirmationRequest(
  command: LifecycleCommand, snapshot: Snapshot, operations: readonly SetupOperation[], digest: Sha256Digest,
): SetupResult['confirmation'] {
  const { harnesses, actions, paths } = footprint(operations, operation => ACTIONS[operation.type]);
  const verb = command === 'setup' ? 'install and configure Khala' : 'remove Khala';
  return {
    required: true,
    confirmed: false,
    command,
    harnesses,
    actions,
    paths,
    backup: `Before any existing file is changed or deleted, a byte-exact copy is saved under ${backupsRootOf(snapshot)}; `
      + 'removal restores it. A file you changed since setup is never overwritten.',
    // No adapter yet proves whether a running session picks the change up, so the honest claim is unknown.
    sessionEffect: 'unknown',
    fallbackRoute: snapshot.fallbackRoute,
    planDigest: digest,
    request: `Approve ${operations.length} change(s) to ${verb} for ${harnesses.join(', ')}? `
      + `If approved, run \`khala ${command} --confirm ${digest}\`.`,
  };
}

/**
 * The recovery plan for an interrupted transaction. A committed journal is finished, which
 * keeps its applied changes. Any other is rolled back, which restores every path it started.
 */
function recoveryRequest(
  command: LifecycleCommand, snapshot: Snapshot, journal: Extract<SetupJournalSummary, { kind: 'recoverable' }>,
  digest: Sha256Digest,
): SetupResult['confirmation'] {
  const finishing = journal.state === 'committed';
  const { harnesses, actions, paths } = footprint(journal.started, operation => (finishing ? ACTIONS[operation.type] : 'restore'));
  const count = journal.started.length;
  const interrupted = `the interrupted \`khala ${journal.command}\``;
  const change = finishing ? `finish ${interrupted}, keeping its ${count} applied change(s)`
    : count === 0 ? `discard ${interrupted}, which changed no file yet`
      : `roll back the ${count} change(s) ${interrupted} started`;
  return {
    required: true,
    confirmed: false,
    command,
    harnesses,
    actions,
    paths,
    backup: finishing
      ? `The byte-exact copies under ${backupsRootOf(snapshot)} are kept for a later removal.`
      : `Each changed file is restored from its byte-exact copy under ${backupsRootOf(snapshot)}. `
        + 'A file that no longer holds what the interrupted run wrote is preserved, never overwritten.',
    sessionEffect: 'unknown',
    fallbackRoute: snapshot.fallbackRoute,
    planDigest: digest,
    request: `Approve recovery: ${change}${harnesses.length === 0 ? '' : ` for ${harnesses.join(', ')}`}? `
      + `If approved, run \`khala ${command} --confirm ${digest}\`, then relay the plan it returns.`,
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
    // Absent harnesses are reported here only; readiness and the digest see detected ones.
    harnesses: [...snapshot.observed.map(entry => entry.report), ...snapshot.absent]
      .sort((a, b) => HARNESS_IDS.indexOf(a.harness) - HARNESS_IDS.indexOf(b.harness)),
    operations: operations.map(operation => ({ ...operation, status: 'planned' as const })),
    diagnostics: command === 'status' ? [...diagnostics, ...setupRequiredDiagnostics(snapshot)] : diagnostics,
  };
}

