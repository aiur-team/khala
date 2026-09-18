// Evidence records carry a mandatory mode so a fake contract proof can never stand
// in for live SDK or harness evidence. Records hold identifiers only: no message
// text, payload bytes or credentials.

import type { ClockReading, ClockSource, ScenarioClock } from './clock';

export const EVIDENCE_MODES = ['fake-contract', 'live-sdk', 'live-harness'] as const;
export type EvidenceMode = (typeof EVIDENCE_MODES)[number];

export type EvidenceRecord = Readonly<{
  mode: EvidenceMode;
  kind: string;
  operationId: string;
  ownerId: string;
  /** Elapsed milliseconds on `clockId`; comparable only with the same clock. */
  at: number;
  clockId: string;
  clockSource: ClockSource;
  wallClock: string | null;
}>;

/** A component whose behaviour the evidence describes, pinned to an exact version. */
export type SourceVersion = Readonly<{ component: string; version: string }>;

export type EvidenceManifest = Readonly<{
  runId: string;
  mode: EvidenceMode;
  sources: readonly SourceVersion[];
  records: readonly EvidenceRecord[];
}>;

export class EvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceError';
  }
}

// Kinds and identifiers are short, whitespace-free tokens. This keeps accidental
// plaintext (a message body, an error string) out of the evidence log.
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/;

export function evidenceToken(value: string, field: string): string {
  if (!TOKEN.test(value)) throw new EvidenceError(`${field} must be an identifier token, not free text`);
  return value;
}

export function isLiveMode(mode: EvidenceMode): boolean {
  return mode !== 'fake-contract';
}

export interface EvidenceLog {
  readonly runId: string;
  readonly mode: EvidenceMode;
  record(kind: string, subject: Readonly<{ ownerId: string; operationId: string }>, clock: ScenarioClock): EvidenceRecord;
  records(): readonly EvidenceRecord[];
  manifest(): EvidenceManifest;
}

export function createEvidenceLog(
  config: Readonly<{ runId: string; mode: EvidenceMode; sources: readonly SourceVersion[] }>,
): EvidenceLog {
  const { mode } = config;
  const runId = evidenceToken(config.runId, 'runId');
  if (!EVIDENCE_MODES.includes(mode)) throw new EvidenceError(`unknown evidence mode ${String(mode)}`);
  for (const source of config.sources) {
    evidenceToken(source.component, 'source.component');
    evidenceToken(source.version, 'source.version');
  }
  if (isLiveMode(mode) && config.sources.length === 0) {
    throw new EvidenceError('live evidence must name the exact source versions it observed');
  }
  const sources = Object.freeze([...config.sources]);
  const records: EvidenceRecord[] = [];

  return {
    runId,
    mode,
    record(kind, subject, clock) {
      if (isLiveMode(mode) && clock.source === 'fake') {
        throw new EvidenceError('live evidence cannot be timed by a fake clock');
      }
      const entry: EvidenceRecord = Object.freeze({
        mode,
        kind: evidenceToken(kind, 'kind'),
        operationId: evidenceToken(subject.operationId, 'operationId'),
        ownerId: evidenceToken(subject.ownerId, 'ownerId'),
        at: clock.now(),
        clockId: clock.id,
        clockSource: clock.source,
        wallClock: clock.wallClock(),
      });
      records.push(entry);
      return entry;
    },
    records: () => Object.freeze([...records]),
    manifest: () => Object.freeze({ runId, mode, sources, records: Object.freeze([...records]) }),
  };
}

export function reading(record: EvidenceRecord): ClockReading {
  return { clockId: record.clockId, at: record.at };
}

/**
 * Combines manifests from one run. Fake and live evidence never merge: a consumer
 * holding the result can trust that every record has the manifest's mode.
 */
export function combineManifests(manifests: readonly EvidenceManifest[]): EvidenceManifest {
  const [first] = manifests;
  if (!first) throw new EvidenceError('no manifests to combine');
  for (const manifest of manifests) {
    if (manifest.mode !== first.mode) {
      throw new EvidenceError(`cannot mix ${first.mode} and ${manifest.mode} evidence in one manifest`);
    }
    if (manifest.runId !== first.runId) throw new EvidenceError('cannot combine manifests from different runs');
  }
  const sources = new Map<string, SourceVersion>();
  for (const source of manifests.flatMap(manifest => manifest.sources)) {
    const known = sources.get(source.component);
    if (known && known.version !== source.version) {
      throw new EvidenceError(`conflicting versions for ${source.component}: ${known.version} and ${source.version}`);
    }
    sources.set(source.component, source);
  }
  return Object.freeze({
    runId: first.runId,
    mode: first.mode,
    sources: Object.freeze([...sources.values()]),
    records: Object.freeze(manifests.flatMap(manifest => manifest.records)),
  });
}

export type EvidenceQuery = Readonly<{
  kind: string;
  ownerId?: string;
  operationId?: string;
  /** Modes that may satisfy the query; there is no default. */
  modes: readonly EvidenceMode[];
}>;

/**
 * Returns the matching records, or throws naming why none qualify. A fake record of
 * the right kind is reported as such rather than silently accepted.
 */
export function requireEvidence(records: readonly EvidenceRecord[], query: EvidenceQuery): readonly EvidenceRecord[] {
  if (query.modes.length === 0) throw new EvidenceError('an evidence query must name the modes it accepts');
  const subject = records.filter(record => record.kind === query.kind
    && (query.ownerId === undefined || record.ownerId === query.ownerId)
    && (query.operationId === undefined || record.operationId === query.operationId));
  const accepted = subject.filter(record => query.modes.includes(record.mode));
  if (accepted.length > 0) return accepted;
  const found = [...new Set(subject.map(record => record.mode))];
  throw new EvidenceError(found.length === 0
    ? `no ${query.kind} evidence recorded`
    : `${query.kind} evidence exists only as ${found.join(', ')}; ${query.modes.join(' or ')} is required`);
}
