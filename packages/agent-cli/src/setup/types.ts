// Frozen setup contract (E09 `setup-cli-contract`): result schemas, exit codes, the
// operation vocabulary, and the side-effect-free adapter interface. Later tickets
// (planner, executor, adapters) consume this module and must not widen it in place;
// a new operation type or state is a versioned contract change.
import { AGENT_ROUTES, type AgentRoute } from '../cli/types.js';

export const SETUP_SCHEMA_VERSION = 1 as const;

export const SETUP_COMMANDS = Object.freeze(['setup', 'remove', 'status'] as const);
export type SetupCommand = (typeof SETUP_COMMANDS)[number];

export const HARNESS_IDS = Object.freeze(['claude', 'codex', 'opencode'] as const);
export type HarnessId = (typeof HARNESS_IDS)[number];

export const SETUP_COMPONENTS = Object.freeze([
  'payload', 'launcher', 'marketplace', 'plugin', 'skill', 'hooks', 'mcp_entry',
] as const);
export type SetupComponent = (typeof SETUP_COMPONENTS)[number];

/** Per-component observed state. */
export const COMPONENT_STATES = Object.freeze([
  'absent', 'ready', 'awaiting_hook_review', 'drifted', 'conflict', 'unsupported',
] as const);
export type ComponentState = (typeof COMPONENT_STATES)[number];

/** Top-level command state; see the status truth table in `setup-cli.md`. */
export const SETUP_STATES = Object.freeze([
  'no_harness', 'ready', 'awaiting_hook_review', 'configured_restart_required',
  'configured_effect_unknown', 'drifted', 'conflict', 'unsupported', 'recovery_required',
  'confirmation_required',
] as const);
export type SetupState = (typeof SETUP_STATES)[number];

export const SETUP_EXIT_CODES = Object.freeze({
  ok: 0,
  invalid: 2,
  refused: 3,
  indeterminate: 4,
  confirmationRequired: 5,
} as const);
export type SetupExitCode = (typeof SETUP_EXIT_CODES)[keyof typeof SETUP_EXIT_CODES];

/** Executor-facing operation vocabulary. Every mutation an adapter proposes is one of these. */
export const SETUP_OPERATION_TYPES = Object.freeze([
  'file_create', 'file_replace', 'file_delete', 'file_restore',
  'config_entry_set', 'config_entry_remove', 'vendor_command',
] as const);
export type SetupOperationType = (typeof SETUP_OPERATION_TYPES)[number];

export const OPERATION_STATUSES = Object.freeze([
  'planned', 'applied', 'rolled_back', 'rollback_failed',
] as const);
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export const DIAGNOSTIC_SEVERITIES = Object.freeze(['info', 'warning', 'error'] as const);
export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];

export const SESSION_EFFECTS = Object.freeze([
  'effective', 'restart_required', 'unknown',
] as const);
export type SessionEffect = (typeof SESSION_EFFECTS)[number];

/** `sha256:<64 lowercase hex>`; the only digest form a plan, hash, or confirmation may carry. */
export type Sha256Digest = `sha256:${string}`;
/** A `null` preimage records an absent file; contents are never embedded. */
type Base = Readonly<{ id: string; harness: HarnessId; component: SetupComponent; path: string }>;

export type SetupOperation =
  | (Base & Readonly<{ type: 'file_create'; postimage: Sha256Digest }>)
  | (Base & Readonly<{ type: 'file_replace'; preimage: Sha256Digest; postimage: Sha256Digest }>)
  | (Base & Readonly<{ type: 'file_delete'; preimage: Sha256Digest }>)
  | (Base & Readonly<{ type: 'file_restore'; current: Sha256Digest; restored: Sha256Digest | null }>)
  | (Base & Readonly<{
    type: 'config_entry_set'; entry: string; preimage: Sha256Digest | null; postimage: Sha256Digest;
  }>)
  | (Base & Readonly<{
    type: 'config_entry_remove'; entry: string; preimage: Sha256Digest; postimage: Sha256Digest;
  }>)
  | (Base & Readonly<{
    type: 'vendor_command'; executable: string; args: readonly string[]; writablePaths: readonly string[];
  }>);

export type SetupOperationReport = SetupOperation & Readonly<{ status: OperationStatus }>;

export type SetupDiagnostic = Readonly<{
  code: string;
  severity: DiagnosticSeverity;
  harness?: HarnessId;
  component?: SetupComponent;
  message: string;
}>;

/** Executable presence, supported version, component states, and route are separate facts. */
export type HarnessReport = Readonly<{
  harness: HarnessId;
  executable: Readonly<{ present: boolean; path: string | null }>;
  version: Readonly<{ detected: string | null; supported: boolean }>;
  components: readonly Readonly<{ component: SetupComponent; state: ComponentState }>[];
  route: AgentRoute;
}>;

export type ConfirmationAction = Readonly<{
  harness: HarnessId; component: SetupComponent; action: 'create' | 'replace' | 'delete' | 'restore' | 'configure';
}>;

export type SetupConfirmation =
  | Readonly<{ required: false; confirmed: boolean }>
  | Readonly<{
    required: true;
    confirmed: false;
    command: 'setup' | 'remove';
    harnesses: readonly HarnessId[];
    actions: readonly ConfirmationAction[];
    paths: readonly string[];
    backup: string;
    sessionEffect: SessionEffect;
    fallbackRoute: string | null;
    planDigest: Sha256Digest;
    request: string;
  }>;

export type SetupResult = Readonly<{
  v: typeof SETUP_SCHEMA_VERSION;
  command: SetupCommand;
  ok: boolean;
  changed: boolean;
  state: SetupState;
  planDigest: Sha256Digest | null;
  confirmation: SetupConfirmation;
  harnesses: readonly HarnessReport[];
  operations: readonly SetupOperationReport[];
  diagnostics: readonly SetupDiagnostic[];
}>;

/** Exit code for a result state. Bare `status` is informational; `check` is the CI form. */
export function setupExitCode(command: SetupCommand, state: SetupState, options: Readonly<{ check?: boolean }> = {}): SetupExitCode {
  if (state === 'confirmation_required') return SETUP_EXIT_CODES.confirmationRequired;
  const informational = command === 'status' && options.check !== true;
  if (state === 'recovery_required') return informational ? SETUP_EXIT_CODES.ok : SETUP_EXIT_CODES.indeterminate;
  if (informational) return SETUP_EXIT_CODES.ok;
  switch (state) {
    case 'no_harness':
    case 'ready':
      return SETUP_EXIT_CODES.ok;
    case 'awaiting_hook_review':
    case 'configured_restart_required':
    case 'configured_effect_unknown':
      // A completed setup/remove reached its requested state; only `status --check` gates on these.
      return command === 'status' ? SETUP_EXIT_CODES.refused : SETUP_EXIT_CODES.ok;
    case 'drifted':
    case 'conflict':
    case 'unsupported':
      return SETUP_EXIT_CODES.refused;
  }
}

// ---------------------------------------------------------------------------
// Adapter interface. Adapters are data/operation providers: they detect, inspect,
// and return operations. They never print, prompt, lock, write, or run a command;
// every effect goes through the executor, and every read goes through `SetupProbe`.
// ---------------------------------------------------------------------------

/** Read-only view of the machine. Implementations must not mutate anything. */
export interface SetupProbe {
  /** Resolves an executable on the injected PATH to an absolute path, or `null`. */
  resolveExecutable(name: string): Promise<string | null>;
  /** Runs a resolved absolute executable with a fixed argument array and no shell; returns stdout. */
  runVersion(executable: string, args: readonly string[]): Promise<string>;
  /** Reads a file without following symlinks; `null` when absent. */
  readFile(path: string): Promise<Uint8Array | null>;
  /** Names of directory entries, or `null` when the directory is absent. */
  listDirectory(path: string): Promise<readonly string[] | null>;
}

export type SetupEnvironment = Readonly<{
  home: string;
  xdgConfigHome: string;
  xdgDataHome: string;
  xdgStateHome: string;
  probe: SetupProbe;
}>;

export type HarnessDetection = Readonly<{
  executable: string | null;
  version: string | null;
  supported: boolean;
}>;

export type HarnessObservation = Readonly<{
  detection: HarnessDetection;
  components: readonly Readonly<{ component: SetupComponent; state: ComponentState }>[];
  route: AgentRoute;
  diagnostics: readonly SetupDiagnostic[];
}>;

export type SetupPlanRequest = Readonly<{
  desired: 'present' | 'absent';
  observation: HarnessObservation;
}>;

export interface SetupAdapter {
  readonly harness: HarnessId;
  detect(environment: SetupEnvironment): Promise<HarnessDetection>;
  inspect(environment: SetupEnvironment, detection: HarnessDetection): Promise<HarnessObservation>;
  /** Pure: returns the operations that move the observation to the desired state. */
  plan(request: SetupPlanRequest): readonly SetupOperation[];
}

// ---------------------------------------------------------------------------
// Strict decoding. Unknown keys, wrong types, and out-of-vocabulary values are
// rejected so a result can never carry unreviewed fields (such as file contents).
// ---------------------------------------------------------------------------

export class SetupSchemaError extends Error {
  constructor(readonly path: string) {
    super(`invalid setup result at ${path}`);
    this.name = 'SetupSchemaError';
  }
}

type Rec = Record<string, unknown>;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function fail(path: string): never { throw new SetupSchemaError(path); }
function rec(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Rec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(path);
  const object = value as Rec;
  for (const key of Object.keys(object)) if (!required.includes(key) && !optional.includes(key)) fail(`${path}.${key}`);
  for (const key of required) if (!Object.hasOwn(object, key)) fail(`${path}.${key}`);
  return object;
}
function oneOf<T extends string>(value: unknown, members: readonly T[], path: string): T {
  if (typeof value !== 'string' || !(members as readonly string[]).includes(value)) fail(path);
  return value as T;
}
function str(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(path);
  return value;
}
function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path);
  return value;
}
function digest(value: unknown, path: string): Sha256Digest {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail(path);
  return value as Sha256Digest;
}
function nullable<T>(value: unknown, path: string, decode: (v: unknown, p: string) => T): T | null {
  return value === null ? null : decode(value, path);
}
function list<T>(value: unknown, path: string, decode: (v: unknown, p: string) => T): T[] {
  if (!Array.isArray(value)) fail(path);
  return value.map((item, index) => decode(item, `${path}[${index}]`));
}

function decodeComponentState(value: unknown, path: string) {
  const o = rec(value, path, ['component', 'state']);
  return { component: oneOf(o.component, SETUP_COMPONENTS, `${path}.component`),
    state: oneOf(o.state, COMPONENT_STATES, `${path}.state`) };
}

function decodeHarness(value: unknown, path: string): HarnessReport {
  const o = rec(value, path, ['harness', 'executable', 'version', 'components', 'route']);
  const exe = rec(o.executable, `${path}.executable`, ['present', 'path']);
  const ver = rec(o.version, `${path}.version`, ['detected', 'supported']);
  return {
    harness: oneOf(o.harness, HARNESS_IDS, `${path}.harness`),
    executable: { present: bool(exe.present, `${path}.executable.present`),
      path: nullable(exe.path, `${path}.executable.path`, str) },
    version: { detected: nullable(ver.detected, `${path}.version.detected`, str),
      supported: bool(ver.supported, `${path}.version.supported`) },
    components: list(o.components, `${path}.components`, decodeComponentState),
    route: oneOf(o.route, AGENT_ROUTES, `${path}.route`),
  };
}

function decodeOperation(value: unknown, path: string): SetupOperationReport {
  const type = oneOf((value as Rec | null)?.type, SETUP_OPERATION_TYPES, `${path}.type`);
  const base = ['id', 'type', 'harness', 'component', 'path', 'status'];
  const fields: Record<SetupOperationType, readonly string[]> = {
    file_create: ['postimage'],
    file_replace: ['preimage', 'postimage'],
    file_delete: ['preimage'],
    file_restore: ['current', 'restored'],
    config_entry_set: ['entry', 'preimage', 'postimage'],
    config_entry_remove: ['entry', 'preimage', 'postimage'],
    vendor_command: ['executable', 'args', 'writablePaths'],
  };
  const o = rec(value, path, [...base, ...fields[type]]);
  const common = {
    id: str(o.id, `${path}.id`),
    harness: oneOf(o.harness, HARNESS_IDS, `${path}.harness`),
    component: oneOf(o.component, SETUP_COMPONENTS, `${path}.component`),
    path: str(o.path, `${path}.path`),
    status: oneOf(o.status, OPERATION_STATUSES, `${path}.status`),
  };
  const d = (key: string) => digest(o[key], `${path}.${key}`);
  const dn = (key: string) => nullable(o[key], `${path}.${key}`, digest);
  switch (type) {
    case 'file_create': return { ...common, type, postimage: d('postimage') };
    case 'file_replace': return { ...common, type, preimage: d('preimage'), postimage: d('postimage') };
    case 'file_delete': return { ...common, type, preimage: d('preimage') };
    case 'file_restore': return { ...common, type, current: d('current'), restored: dn('restored') };
    case 'config_entry_set':
      return { ...common, type, entry: str(o.entry, `${path}.entry`), preimage: dn('preimage'), postimage: d('postimage') };
    case 'config_entry_remove':
      return { ...common, type, entry: str(o.entry, `${path}.entry`), preimage: d('preimage'), postimage: d('postimage') };
    case 'vendor_command': {
      const executable = str(o.executable, `${path}.executable`);
      if (!executable.startsWith('/')) fail(`${path}.executable`);
      return { ...common, type, executable, args: list(o.args, `${path}.args`, str),
        writablePaths: list(o.writablePaths, `${path}.writablePaths`, str) };
    }
  }
}

function decodeDiagnostic(value: unknown, path: string): SetupDiagnostic {
  const o = rec(value, path, ['code', 'severity', 'message'], ['harness', 'component']);
  return {
    code: str(o.code, `${path}.code`),
    severity: oneOf(o.severity, DIAGNOSTIC_SEVERITIES, `${path}.severity`),
    ...(o.harness === undefined ? {} : { harness: oneOf(o.harness, HARNESS_IDS, `${path}.harness`) }),
    ...(o.component === undefined ? {} : { component: oneOf(o.component, SETUP_COMPONENTS, `${path}.component`) }),
    message: str(o.message, `${path}.message`),
  };
}

function decodeConfirmation(value: unknown, path: string): SetupConfirmation {
  const probe = rec(value, path, ['required', 'confirmed'],
    ['command', 'harnesses', 'actions', 'paths', 'backup', 'sessionEffect', 'fallbackRoute', 'planDigest', 'request']);
  if (!bool(probe.required, `${path}.required`)) {
    for (const key of Object.keys(probe)) if (key !== 'required' && key !== 'confirmed') fail(`${path}.${key}`);
    return { required: false, confirmed: bool(probe.confirmed, `${path}.confirmed`) };
  }
  const o = rec(value, path, ['required', 'confirmed', 'command', 'harnesses', 'actions', 'paths', 'backup',
    'sessionEffect', 'fallbackRoute', 'planDigest', 'request']);
  if (o.confirmed !== false) fail(`${path}.confirmed`);
  return {
    required: true,
    confirmed: false,
    command: oneOf(o.command, ['setup', 'remove'] as const, `${path}.command`),
    harnesses: list(o.harnesses, `${path}.harnesses`, (v, p) => oneOf(v, HARNESS_IDS, p)),
    actions: list(o.actions, `${path}.actions`, (v, p): ConfirmationAction => {
      const a = rec(v, p, ['harness', 'component', 'action']);
      return {
        harness: oneOf(a.harness, HARNESS_IDS, `${p}.harness`),
        component: oneOf(a.component, SETUP_COMPONENTS, `${p}.component`),
        action: oneOf(a.action, ['create', 'replace', 'delete', 'restore', 'configure'] as const, `${p}.action`),
      };
    }),
    paths: list(o.paths, `${path}.paths`, str),
    backup: str(o.backup, `${path}.backup`),
    sessionEffect: oneOf(o.sessionEffect, SESSION_EFFECTS, `${path}.sessionEffect`),
    fallbackRoute: nullable(o.fallbackRoute, `${path}.fallbackRoute`, str),
    planDigest: digest(o.planDigest, `${path}.planDigest`),
    request: str(o.request, `${path}.request`),
  };
}

/** Decodes an untrusted value as a v1 setup result, or throws `SetupSchemaError` naming the field. */
export function decodeSetupResult(value: unknown): SetupResult {
  const o = rec(value, '$', ['v', 'command', 'ok', 'changed', 'state', 'planDigest', 'confirmation',
    'harnesses', 'operations', 'diagnostics']);
  if (o.v !== SETUP_SCHEMA_VERSION) fail('$.v');
  const state = oneOf(o.state, SETUP_STATES, '$.state');
  const confirmation = decodeConfirmation(o.confirmation, '$.confirmation');
  const planDigest = nullable(o.planDigest, '$.planDigest', digest);
  // A confirmation request must name the exact plan the result carries.
  if (state === 'confirmation_required' !== confirmation.required) fail('$.confirmation.required');
  if (confirmation.required && confirmation.planDigest !== planDigest) fail('$.confirmation.planDigest');
  return {
    v: SETUP_SCHEMA_VERSION,
    command: oneOf(o.command, SETUP_COMMANDS, '$.command'),
    ok: bool(o.ok, '$.ok'),
    changed: bool(o.changed, '$.changed'),
    state,
    planDigest,
    confirmation,
    harnesses: list(o.harnesses, '$.harnesses', decodeHarness),
    operations: list(o.operations, '$.operations', decodeOperation),
    diagnostics: list(o.diagnostics, '$.diagnostics', decodeDiagnostic),
  };
}
