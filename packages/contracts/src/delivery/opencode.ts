// OpenCode plugin route vocabulary. Support is scoped to exact recorded evidence
// keys: a claim that is not byte-for-byte one of them is unproven, never promoted by
// version range, surface similarity or a successful API call.

import {
  type Decoded, type DeliveryLimits, decodeWith, fail, identifier, literal, nullable, object, safeInteger,
  utf8Length,
} from './decode';
import type { HarnessCapabilities } from './harness';
import { type BindingId, readId } from './ids';
import { LISTENING_MODES, type ListeningMode, type ModeSupport, type ModeSupportMap } from './listening-mode';

export const OPENCODE_HARNESS = 'opencode';
/** Presence label for the `opencode_plugin` route. */
export const OPENCODE_PLUGIN_ROUTE_LABEL = 'OpenCode plugin';
export const OPENCODE_PLUGIN_ADAPTER_VERSION = 'opencode-plugin-1';
/** The `@aiur/khala` package export OpenCode loads in-process; setup registers exactly this specifier. */
export const OPENCODE_PLUGIN_SPECIFIER = '@aiur/khala/opencode';

/** #180: interactive OpenCode 1.17.10 proof, agent-launched with default settings and retained replay commands. */
export const OPENCODE_EVIDENCE_REF = 'experiments/interactive-cli/opencode/evidence/results.md';
export const OPENCODE_EVIDENCE_REVISION = '0ae3e4c9bea92cc652224bebb78b23c6bfdbd58c';
export const OPENCODE_RETAINED_COMMANDS_REF = 'experiments/interactive-cli/opencode/README.md#reproduce';

/** Session state a route delivers in. `on_read` is the explicit `khala_read` pull. */
export const OPENCODE_SESSION_STATES = ['busy', 'idle', 'on_read'] as const;
/** Where the route runs. Only the in-process plugin reaches the person's TUI session (decision 24). */
export const OPENCODE_ROUTE_SURFACES = ['in_process_plugin', 'server_session', 'tui_endpoint'] as const;
/** Who started the proven session (decision 33 wording). */
export const OPENCODE_SESSION_ORIGINS = [
  'person_started', 'agent_launched_default_settings', 'khala_started', 'server_created',
] as const;

export const OPENCODE_NEXT_TURN_ONLY_REASON =
  'Idle agents receive messages only at their next turn until the OpenCode idle route matches its evidence key.';
export const OPENCODE_UNPROVEN_REASON =
  'No retained interactive OpenCode evidence matches this exact route key; the mode is unproven.';
export const OPENCODE_ACKNOWLEDGEMENT_UNPROVEN_REASON =
  'OpenCode automation requires acknowledgement through the batch token on the next Khala call.';

export type OpenCodeRouteEvidenceKey = Readonly<{
  harnessVersion: string;
  pluginApiVersion: string;
  mode: ListeningMode;
  sessionState: (typeof OPENCODE_SESSION_STATES)[number];
  route: string;
  surface: (typeof OPENCODE_ROUTE_SURFACES)[number];
  sessionOrigin: (typeof OPENCODE_SESSION_ORIGINS)[number];
  retainedCommandsRef: string | null;
  evidenceRef: string;
  evidenceRevision: string;
}>;

const recorded = (
  mode: ListeningMode,
  sessionState: OpenCodeRouteEvidenceKey['sessionState'],
  route: string,
  anchor: string,
): OpenCodeRouteEvidenceKey => ({
  harnessVersion: '1.17.10',
  pluginApiVersion: '1.17.10',
  mode,
  sessionState,
  route,
  surface: 'in_process_plugin',
  sessionOrigin: 'agent_launched_default_settings',
  retainedCommandsRef: OPENCODE_RETAINED_COMMANDS_REF,
  evidenceRef: `${OPENCODE_EVIDENCE_REF}#${anchor}`,
  evidenceRevision: OPENCODE_EVIDENCE_REVISION,
});

/**
 * The five retained OpenCode 1.17.10 routes. Busy `promptAsync`, server sessions and the
 * TUI endpoints are deliberately absent: #180 shows they miss the boundary or target the
 * wrong session.
 */
export const OPENCODE_ROUTE_EVIDENCE: readonly OpenCodeRouteEvidenceKey[] = Object.freeze([
  // `tool.execute.after` marks the batch; the next `experimental.chat.messages.transform` appends it.
  recorded('steer', 'busy', 'opencode-plugin-tool-after-transform', 'steer-on-the-built-in-bash-tool'),
  // The idle watcher re-reads session status, then calls session-addressed `promptAsync` once.
  recorded('steer', 'idle', 'opencode-plugin-idle-watcher-prompt', 'delivery-to-an-idle-agent-decision-34'),
  // Held while busy; `session.idle` then session-addressed `promptAsync` once.
  recorded('sync', 'busy', 'opencode-plugin-session-idle-prompt', 'sync-with-the-agent-busy'),
  recorded('sync', 'idle', 'opencode-plugin-idle-watcher-prompt', 'delivery-to-an-idle-agent-decision-34'),
  // Nothing automatic; the plugin's `khala_read` tool delegates to the shared pull.
  recorded('async', 'on_read', 'opencode-plugin-khala-read', 'async'),
]);

export const OPENCODE_TESTED_VERSIONS: readonly string[] = Object.freeze(
  [...new Set(OPENCODE_ROUTE_EVIDENCE.map(key => key.harnessVersion))],
);

const KEY_FIELDS = [
  'harnessVersion', 'pluginApiVersion', 'mode', 'sessionState', 'route', 'surface', 'sessionOrigin',
  'retainedCommandsRef', 'evidenceRef', 'evidenceRevision',
] as const satisfies readonly (keyof OpenCodeRouteEvidenceKey)[];

export function decodeOpenCodeRouteEvidenceKey(input: unknown): Decoded<OpenCodeRouteEvidenceKey> {
  return decodeWith(() => {
    const r = object(input, '', KEY_FIELDS);
    return {
      harnessVersion: identifier(r.field('harnessVersion'), r.at('harnessVersion')),
      pluginApiVersion: identifier(r.field('pluginApiVersion'), r.at('pluginApiVersion')),
      mode: literal(r.field('mode'), r.at('mode'), LISTENING_MODES),
      sessionState: literal(r.field('sessionState'), r.at('sessionState'), OPENCODE_SESSION_STATES),
      route: identifier(r.field('route'), r.at('route')),
      surface: literal(r.field('surface'), r.at('surface'), OPENCODE_ROUTE_SURFACES),
      sessionOrigin: literal(r.field('sessionOrigin'), r.at('sessionOrigin'), OPENCODE_SESSION_ORIGINS),
      retainedCommandsRef: nullable(r.field('retainedCommandsRef'), value => identifier(value, r.at('retainedCommandsRef'))),
      evidenceRef: identifier(r.field('evidenceRef'), r.at('evidenceRef')),
      evidenceRevision: identifier(r.field('evidenceRevision'), r.at('evidenceRevision')),
    };
  });
}

/** Whether `claim` is exactly one recorded key. Every field participates. */
export function isRecordedOpenCodeRoute(claim: OpenCodeRouteEvidenceKey): boolean {
  return OPENCODE_ROUTE_EVIDENCE.some(key => KEY_FIELDS.every(field => key[field] === claim[field]));
}

function proven(route: string, version: string, reason: string | null): ModeSupport {
  return {
    status: 'proven',
    route,
    testedVersion: version,
    evidenceRef: OPENCODE_EVIDENCE_REF,
    evidenceRevision: OPENCODE_EVIDENCE_REVISION,
    reason,
  };
}

function unproven(mode: ListeningMode, version: string, reason = OPENCODE_UNPROVEN_REASON): ModeSupport {
  return {
    status: 'unknown',
    route: `opencode-plugin-${mode}`,
    testedVersion: version,
    evidenceRef: null,
    evidenceRevision: null,
    reason,
  };
}

/**
 * `steer` and `sync` need their busy route. Without the matching idle route the claim is
 * honest about idle agents (decisions 34 and 37) and names a narrower route, so a grant or
 * dispatch snapshot for the full route never carries over.
 */
function modeFromKeys(mode: ListeningMode, version: string, matched: readonly OpenCodeRouteEvidenceKey[]): ModeSupport {
  const has = (state: OpenCodeRouteEvidenceKey['sessionState']) =>
    matched.some(key => key.mode === mode && key.sessionState === state && key.harnessVersion === version);
  if (mode === 'async') return has('on_read') ? proven('opencode-plugin-async', version, null) : unproven(mode, version);
  if (!has('busy')) return unproven(mode, version);
  return has('idle')
    ? proven(`opencode-plugin-${mode}`, version, null)
    : proven(`opencode-plugin-${mode}-busy`, version, OPENCODE_NEXT_TURN_ONLY_REASON);
}

/** Projects claimed route keys into mode support; any key that is not recorded counts for nothing. */
export function openCodeModeSupport(version: string, claims: readonly OpenCodeRouteEvidenceKey[]): ModeSupportMap {
  const matched = claims.filter(isRecordedOpenCodeRoute);
  return {
    steer: modeFromKeys('steer', version, matched),
    sync: modeFromKeys('sync', version, matched),
    async: modeFromKeys('async', version, matched),
  };
}

/** Every mode-support row a recorded key set can produce for `mode` at `version`. */
function admissibleRows(mode: ListeningMode, version: string): readonly ModeSupport[] {
  const keys = OPENCODE_ROUTE_EVIDENCE.filter(key => key.harnessVersion === version && key.mode === mode);
  const subsets = [keys, keys.filter(key => key.sessionState !== 'idle')];
  return subsets.map(subset => modeFromKeys(mode, version, subset)).filter(row => row.status === 'proven');
}

const sameRow = (a: ModeSupport, b: ModeSupport) =>
  a.status === b.status && a.route === b.route && a.testedVersion === b.testedVersion
  && a.evidenceRef === b.evidenceRef && a.evidenceRevision === b.evidenceRevision && a.reason === b.reason;

/**
 * The mode support `HarnessCapabilities` may actually carry for an OpenCode plugin route.
 * A `proven` or `experimental` row that no recorded key produces — server-session evidence,
 * an unretained proof, a stale or unknown version — resolves to unproven, and so does every
 * mode when acknowledgement is not `batch_token_next_call`.
 */
export function resolveOpenCodeModes(capabilities: HarnessCapabilities): ModeSupportMap {
  const { version } = capabilities;
  const ack = capabilities.acknowledgement === 'batch_token_next_call';
  const resolve = (mode: ListeningMode): ModeSupport => {
    const row = capabilities.modes[mode];
    if (row.status !== 'proven' && row.status !== 'experimental') return row;
    if (!ack) return unproven(mode, version, OPENCODE_ACKNOWLEDGEMENT_UNPROVEN_REASON);
    return admissibleRows(mode, version).some(allowed => sameRow(allowed, row)) ? row : unproven(mode, version);
  };
  return { steer: resolve('steer'), sync: resolve('sync'), async: resolve('async') };
}

/**
 * Capabilities for the in-process plugin at `version`, from the route keys the plugin
 * implements. An unrecorded version or a claim set that proves no mode is `unsupported`.
 */
export function openCodePluginCapabilities(
  input: Readonly<{ version: string; limits: DeliveryLimits; claims: readonly OpenCodeRouteEvidenceKey[] }>,
): HarnessCapabilities {
  const modes = openCodeModeSupport(input.version, input.claims);
  const anyProven = LISTENING_MODES.some(mode => modes[mode].status === 'proven');
  if (!OPENCODE_TESTED_VERSIONS.includes(input.version) || !anyProven) {
    return {
      v: 3,
      harness: OPENCODE_HARNESS,
      version: input.version,
      adapterVersion: OPENCODE_PLUGIN_ADAPTER_VERSION,
      support: 'unsupported',
      existingSession: 'unknown',
      immediateNotification: 'unknown',
      busy: 'unknown',
      receiptEvidence: [],
      reconcileByReleaseId: 'unknown',
      limits: input.limits,
      evidenceRef: OPENCODE_EVIDENCE_REF,
      modes: {
        steer: unproven('steer', input.version),
        sync: unproven('sync', input.version),
        async: unproven('async', input.version),
      },
      acknowledgement: 'unknown',
    };
  }
  return {
    v: 3,
    harness: OPENCODE_HARNESS,
    version: input.version,
    adapterVersion: OPENCODE_PLUGIN_ADAPTER_VERSION,
    support: 'tested',
    existingSession: 'opencode_plugin',
    immediateNotification: 'opencode_plugin',
    // The plugin holds a batch while the session is busy; `steer` is a mode claim, not harness busy behavior.
    busy: 'queue',
    // `promptAsync` acceptance is a queued claim only; consumption is not observed here.
    receiptEvidence: ['harness_queued', 'outcome_unknown', 'failed'],
    reconcileByReleaseId: 'unsupported',
    limits: input.limits,
    evidenceRef: OPENCODE_EVIDENCE_REF,
    modes,
    // #180 restart trial: the next Khala call acknowledged the retained token without host dedupe.
    acknowledgement: 'batch_token_next_call',
  };
}

// Notifier hint wire format: one UTF-8 JSON object per `\n`-terminated line on the
// per-binding/generation socket. It carries no message, body, token or release ID; the
// plugin always re-reads the bounded inbox batch. Duplicate and catch-up hints are harmless.

export const OPENCODE_HINT_KIND = 'khala.inbox.hint';
export const OPENCODE_HINT_REASONS = ['released', 'catch_up'] as const;
export const OPENCODE_HINT_MAX_BYTES = 1024;

export type OpenCodeInboxHint = Readonly<{
  v: 1;
  kind: typeof OPENCODE_HINT_KIND;
  bindingId: BindingId;
  generation: number;
  reason: (typeof OPENCODE_HINT_REASONS)[number];
}>;

export function encodeOpenCodeInboxHint(hint: OpenCodeInboxHint): string {
  const line = `${JSON.stringify({
    v: 1, kind: OPENCODE_HINT_KIND, bindingId: hint.bindingId, generation: hint.generation, reason: hint.reason,
  })}\n`;
  if (utf8Length(line) > OPENCODE_HINT_MAX_BYTES) throw new RangeError('opencode_hint_too_large');
  return line;
}

/** Decodes one line, with or without its terminator. Extra fields — any content — are refused. */
export function decodeOpenCodeInboxHint(line: string): Decoded<OpenCodeInboxHint> {
  return decodeWith(() => {
    if (typeof line !== 'string' || utf8Length(line) > OPENCODE_HINT_MAX_BYTES) fail('', 'limit_exceeded');
    const text = line.endsWith('\n') ? line.slice(0, -1) : line;
    if (text.includes('\n')) fail('', 'invalid_field');
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { fail('', 'invalid_field'); }
    const r = object(parsed, '', ['v', 'kind', 'bindingId', 'generation', 'reason']);
    if (r.field('v') !== 1) fail(r.at('v'), 'invalid_version');
    return {
      v: 1,
      kind: literal(r.field('kind'), r.at('kind'), [OPENCODE_HINT_KIND] as const),
      bindingId: readId<'BindingId'>(r.field('bindingId'), r.at('bindingId')),
      generation: safeInteger(r.field('generation'), r.at('generation')),
      reason: literal(r.field('reason'), r.at('reason'), OPENCODE_HINT_REASONS),
    };
  });
}
