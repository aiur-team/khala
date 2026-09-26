// The Make-external journey as the internal channel's browser sees it: one view of
// sign-in, the confirmable roster and the journaled conversion, and the actions the
// human may take. The loopback server builds the view from the conversion journal;
// the browser decodes it strictly and never infers a state the view does not name.

import {
  type Decoded, type Reader, array, decodeWith, elementPath, fail, identifier, label, literal, nullable, object, safeInteger, version,
} from './decode';
import {
  CONVERSION_AGENT_BLOCKS, CONVERSION_AGENT_STATUSES, CONVERSION_STATES, type ConversionAgentBlock, type ConversionAgentStatus,
  type ConversionState, type ConversionVisibility, DEFAULT_CONVERSION_VISIBILITY, type HistoryMode, type HistoryTransferPhase,
} from './externalization';

export const MAKE_EXTERNAL_VERSION = 1;

/** Largest number of agents one journey shows or selects. */
export const MAX_MAKE_EXTERNAL_AGENTS = 64;

const MAX_LABEL_BYTES = 1_024;
const MAX_URL_BYTES = 2_048;

/** Catch-up rounds a carry-history transfer attempts before it asks for a paused drain. */
export const MAX_HISTORY_CATCH_UP_ROUNDS = 3;

export const HISTORY_BLOCKS =['ceiling_exceeded', 'source_changed'] as const;

/**
 * Why a history transfer stopped for good. `ceiling_exceeded`: the paused drain could
 * not finish within its bound and the internal channel was resumed. `source_changed`:
 * already copied source history no longer matches what was sealed.
 */
export type HistoryBlock = typeof HISTORY_BLOCKS[number];

/** Journaled progress of a carry-history transfer; counts only, never content. */
export type ConversionHistoryProgress = Readonly<{
  /** The last step that completed, or null before the first copy finishes. */
  phase: HistoryTransferPhase | null;
  round: number;
  outcome: 'more' | 'converged' | 'drain_required' | null;
  acknowledgedChunks: number;
  chunkCount: number;
  /** Digest of the archive manifest once the final step converged; the importer verifies against it. */
  manifestDigest: string | null;
  /** The human confirmed a paused drain after catch-up did not converge. */
  drainConfirmed: boolean;
  blocked: HistoryBlock | null;
}>;

export const EMPTY_HISTORY_PROGRESS: ConversionHistoryProgress = {
  phase: null, round: 0, outcome: null, acknowledgedChunks: 0, chunkCount: 0, manifestDigest: null, drainConfirmed: false, blocked: null,
};

export const SIGN_IN_STATUSES = ['signed_out', 'pending', 'signed_in', 'failed'] as const;
export type SignInStatus = typeof SIGN_IN_STATUSES[number];

export const SIGN_IN_FAILURES = ['denied', 'expired', 'unavailable'] as const;
export type SignInFailure = typeof SIGN_IN_FAILURES[number];

export type MakeExternalSignIn = Readonly<{
  status: SignInStatus;
  /** Hosted page that completes the sign-in, opened in a new tab; never carries a secret. */
  verificationUrl: string | null;
  failure: SignInFailure | null;
}>;

/** One agent of the internal channel as its verified session stands now. */
export type MakeExternalRosterAgent = Readonly<{
  participantId: string;
  displayName: string;
  harness: string;
  sessionId: string;
  generation: number;
}>;

export type MakeExternalAgent = MakeExternalRosterAgent & Readonly<{
  status: ConversionAgentStatus;
  block: ConversionAgentBlock | null;
  /** The individual access request of the current attempt; granted only one at a time. */
  requestHandle: string | null;
  released: boolean;
}>;

export const CONVERSION_FAILURES = ['ceiling_exceeded', 'source_changed', 'commit_failed'] as const;
export type ConversionFailure = typeof CONVERSION_FAILURES[number];

export type MakeExternalConversion = Readonly<{
  conversionId: string;
  state: ConversionState;
  historyMode: HistoryMode;
  visibility: ConversionVisibility;
  destinationChannelId: string | null;
  /** Where the human opens the external channel; present once it exists. */
  destinationUrl: string | null;
  agents: readonly MakeExternalAgent[];
  history: ConversionHistoryProgress | null;
  canCommit: boolean;
  /** An external channel a cancelled or failed conversion left behind, for explicit cleanup. */
  orphanDestinationChannelId: string | null;
  failure: ConversionFailure | null;
}>;

export type SourceWriteState = 'open' | 'paused' | 'linked';

export type MakeExternalJourneyView = Readonly<{
  v: 1;
  channelId: string;
  title: string | null;
  /** `linked`: the internal channel is read-only for good and the external channel is authoritative. */
  sourceWrite: SourceWriteState;
  signIn: MakeExternalSignIn;
  /** Agents the human may select; empty once a conversion snapshotted its own roster. */
  roster: readonly MakeExternalRosterAgent[];
  conversion: MakeExternalConversion | null;
}>;

export type MakeExternalAction =
  | Readonly<{ kind: 'sign_in' | 'resume' | 'drain' | 'commit' | 'cancel' | 'dismiss'; operationId: string }>
  | Readonly<{
    kind: 'start';
    operationId: string;
    historyMode: HistoryMode;
    visibility: ConversionVisibility;
    agents: readonly string[];
  }>
  | Readonly<{ kind: 'grant'; operationId: string; requestHandles: readonly string[] }>
  | Readonly<{ kind: 'retry' | 'skip'; operationId: string; participantId: string }>;

export type MakeExternalActionKind = MakeExternalAction['kind'];

/** Finite refusals a journey action may report; each maps to one human-readable message. */
export const MAKE_EXTERNAL_REJECTIONS = [
  'invalid_request', 'not_found', 'forbidden', 'conflict', 'wrong_state', 'not_ready', 'sign_in_required', 'unsupported',
  'invalid_selection',
] as const;
export type MakeExternalRejection = typeof MAKE_EXTERNAL_REJECTIONS[number];

/** A URL the browser may open: https, or plain http on loopback for local hosted fakes. */
function url(input: unknown, path: string): string {
  const value = label(input, path, MAX_URL_BYTES);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail(path, 'invalid_value');
  }
  const loopback = parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1';
  if ((parsed.protocol !== 'https:' && !loopback) || parsed.username || parsed.password) fail(path, 'invalid_value');
  return value;
}

const nullableUrl = (r: Reader, key: string) => nullable(r.field(key), value => url(value, r.at(key)));
const nullableId = (r: Reader, key: string) => nullable(r.field(key), value => identifier(value, r.at(key)));

function rosterAgent(r: Reader): MakeExternalRosterAgent {
  return {
    participantId: identifier(r.field('participantId'), r.at('participantId')),
    displayName: label(r.field('displayName'), r.at('displayName'), MAX_LABEL_BYTES),
    harness: identifier(r.field('harness'), r.at('harness')),
    sessionId: identifier(r.field('sessionId'), r.at('sessionId')),
    generation: safeInteger(r.field('generation'), r.at('generation')),
  };
}

const ROSTER_KEYS = ['participantId', 'displayName', 'harness', 'sessionId', 'generation'] as const;
const AGENT_KEYS = [...ROSTER_KEYS, 'status', 'block', 'requestHandle', 'released'] as const;

function bounded<T>(r: Reader, key: string, read: (value: unknown, path: string) => T): T[] {
  const values = array(r.field(key), r.at(key));
  if (values.length > MAX_MAKE_EXTERNAL_AGENTS) fail(r.at(key), 'too_long');
  return values.map((value, index) => read(value, elementPath(r.at(key), index)));
}

function unique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) fail(path, 'duplicate');
}

function history(input: unknown, path: string): ConversionHistoryProgress {
  const r = object(input, path, [
    'phase', 'round', 'outcome', 'acknowledgedChunks', 'chunkCount', 'manifestDigest', 'drainConfirmed', 'blocked',
  ]);
  const drainConfirmed = r.field('drainConfirmed');
  if (typeof drainConfirmed !== 'boolean') fail(r.at('drainConfirmed'), 'wrong_type');
  const acknowledgedChunks = safeInteger(r.field('acknowledgedChunks'), r.at('acknowledgedChunks'));
  const chunkCount = safeInteger(r.field('chunkCount'), r.at('chunkCount'));
  if (acknowledgedChunks > chunkCount) fail(r.at('acknowledgedChunks'), 'invalid_value');
  return {
    phase: nullable(r.field('phase'), value => literal(value, r.at('phase'), ['copy', 'catch_up', 'final_drain'])),
    round: safeInteger(r.field('round'), r.at('round')),
    outcome: nullable(r.field('outcome'), value => literal(value, r.at('outcome'), ['more', 'converged', 'drain_required'])),
    acknowledgedChunks,
    chunkCount,
    manifestDigest: nullableId(r, 'manifestDigest'),
    drainConfirmed,
    blocked: nullable(r.field('blocked'), value => literal(value, r.at('blocked'), HISTORY_BLOCKS)),
  };
}

/** Strict decoder for the stored and served history progress. */
export function decodeConversionHistoryProgress(input: unknown): Decoded<ConversionHistoryProgress> {
  return decodeWith(() => history(input, ''));
}

function conversion(input: unknown, path: string): MakeExternalConversion {
  const r = object(input, path, [
    'conversionId', 'state', 'historyMode', 'visibility', 'destinationChannelId', 'destinationUrl', 'agents', 'history', 'canCommit',
    'orphanDestinationChannelId', 'failure',
  ]);
  const canCommit = r.field('canCommit');
  if (typeof canCommit !== 'boolean') fail(r.at('canCommit'), 'wrong_type');
  const agents = bounded(r, 'agents', (value, at) => {
    const a = object(value, at, AGENT_KEYS);
    const released = a.field('released');
    if (typeof released !== 'boolean') fail(a.at('released'), 'wrong_type');
    return {
      ...rosterAgent(a),
      status: literal(a.field('status'), a.at('status'), CONVERSION_AGENT_STATUSES),
      block: nullable(a.field('block'), block => literal(block, a.at('block'), CONVERSION_AGENT_BLOCKS)),
      requestHandle: nullableId(a, 'requestHandle'),
      released,
    };
  });
  unique(agents.map(agent => agent.participantId), r.at('agents'));
  const historyMode = literal(r.field('historyMode'), r.at('historyMode'), ['start_fresh', 'carry_history']);
  const progress = nullable(r.field('history'), value => history(value, r.at('history')));
  // Start-fresh copies nothing, so it never carries history progress.
  if (historyMode === 'start_fresh' && progress !== null) fail(r.at('history'), 'invalid_value');
  return {
    conversionId: identifier(r.field('conversionId'), r.at('conversionId')),
    state: literal(r.field('state'), r.at('state'), CONVERSION_STATES),
    historyMode,
    visibility: literal(r.field('visibility'), r.at('visibility'), ['public', 'private', 'secret']),
    destinationChannelId: nullableId(r, 'destinationChannelId'),
    destinationUrl: nullableUrl(r, 'destinationUrl'),
    agents,
    history: progress,
    canCommit,
    orphanDestinationChannelId: nullableId(r, 'orphanDestinationChannelId'),
    failure: nullable(r.field('failure'), value => literal(value, r.at('failure'), CONVERSION_FAILURES)),
  };
}

export function decodeMakeExternalJourneyView(input: unknown): Decoded<MakeExternalJourneyView> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'channelId', 'title', 'sourceWrite', 'signIn', 'roster', 'conversion']);
    const s = object(r.field('signIn'), r.at('signIn'), ['status', 'verificationUrl', 'failure']);
    const roster = bounded(r, 'roster', (value, at) => rosterAgent(object(value, at, ROSTER_KEYS)));
    unique(roster.map(agent => agent.participantId), r.at('roster'));
    return {
      v: version(r.field('v'), r.at('v')),
      channelId: identifier(r.field('channelId'), r.at('channelId')),
      title: nullable(r.field('title'), value => label(value, r.at('title'), MAX_LABEL_BYTES)),
      sourceWrite: literal(r.field('sourceWrite'), r.at('sourceWrite'), ['open', 'paused', 'linked']),
      signIn: {
        status: literal(s.field('status'), s.at('status'), SIGN_IN_STATUSES),
        verificationUrl: nullableUrl(s, 'verificationUrl'),
        failure: nullable(s.field('failure'), value => literal(value, s.at('failure'), SIGN_IN_FAILURES)),
      },
      roster,
      conversion: nullable(r.field('conversion'), value => conversion(value, r.at('conversion'))),
    };
  });
}

const SIMPLE_ACTIONS = ['sign_in', 'resume', 'drain', 'commit', 'cancel', 'dismiss'] as const;
const ACTION_KINDS = [...SIMPLE_ACTIONS, 'start', 'grant', 'retry', 'skip'] as const;

/** An omitted `visibility` on `start` decodes as `secret`: an unanswered choice never widens access. */
export function decodeMakeExternalAction(input: unknown): Decoded<MakeExternalAction> {
  return decodeWith(() => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) fail('', 'not_object');
    const kind = literal((input as Record<string, unknown>).kind, 'kind', ACTION_KINDS);
    const base = ['kind', 'operationId'];
    switch (kind) {
      case 'start': {
        const chosen = Object.hasOwn(input, 'visibility');
        const r = object(input, '', [...base, 'historyMode', 'agents', ...(chosen ? ['visibility'] : [])]);
        const agents = bounded(r, 'agents', identifier);
        unique(agents, r.at('agents'));
        return {
          kind,
          operationId: identifier(r.field('operationId'), r.at('operationId')),
          historyMode: literal(r.field('historyMode'), r.at('historyMode'), ['start_fresh', 'carry_history']),
          visibility: chosen ? literal(r.field('visibility'), r.at('visibility'), ['public', 'private', 'secret']) : DEFAULT_CONVERSION_VISIBILITY,
          agents,
        };
      }
      case 'grant': {
        const r = object(input, '', [...base, 'requestHandles']);
        const requestHandles = bounded(r, 'requestHandles', identifier);
        if (requestHandles.length === 0) fail(r.at('requestHandles'), 'empty');
        unique(requestHandles, r.at('requestHandles'));
        return { kind, operationId: identifier(r.field('operationId'), r.at('operationId')), requestHandles };
      }
      case 'retry':
      case 'skip': {
        const r = object(input, '', [...base, 'participantId']);
        return {
          kind,
          operationId: identifier(r.field('operationId'), r.at('operationId')),
          participantId: identifier(r.field('participantId'), r.at('participantId')),
        };
      }
      default: {
        const r = object(input, '', base);
        return { kind, operationId: identifier(r.field('operationId'), r.at('operationId')) };
      }
    }
  });
}

export function decodeMakeExternalRejection(input: unknown): MakeExternalRejection | null {
  return (MAKE_EXTERNAL_REJECTIONS as readonly unknown[]).includes(input) ? input as MakeExternalRejection : null;
}

export type { ConversionAgentBlock, ConversionAgentStatus, ConversionState, ConversionVisibility, HistoryMode };
