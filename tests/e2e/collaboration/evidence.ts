// Turns a collaboration run into an acceptance result and a report section. Only live
// evidence that a scenario issued can pass a row. Rows held by an open gate stay
// `blocked`, and a blocked or failed run is appended under its own run id. It never
// replaces an earlier run.

import { randomUUID } from 'node:crypto';
import { elapsed } from '../harness/clock';
import { type EvidenceManifest, type EvidenceRecord, isIssuedManifest, isLiveMode, reading } from '../harness/evidence';
import { ASSERTIONS, type AssertionSpec } from './assertions';
import type { BoundCase, CollaborationCase } from './scenario';

export type Outcome = 'pass' | 'fail' | 'blocked';

export type AssertionRow = Readonly<{
  id: string;
  covers: readonly string[];
  outcome: Outcome;
  /** `<runId>#<kind>/<operationId>` references for a pass; null otherwise. */
  evidenceRef: string | null;
  detail: string;
}>;

/** A duration measured on one owner's monotonic clock. Cross-host latency is never derived. */
export type Timing = Readonly<{
  ownerId: string;
  operationId: string;
  from: string;
  to: string;
  ms: number;
  clockId: string;
}>;

export type AcceptanceResult = Readonly<{
  runId: string;
  caseId: string;
  outcome: Outcome;
  assertions: readonly AssertionRow[];
  timings: readonly Timing[];
  /** Why the case was blocked before any action; empty when it ran. */
  blockers: readonly string[];
  limitations: readonly string[];
}>;

export function newRunId(now: Date = new Date()): string {
  return `collab-${now.toISOString().replace(/[:.]/g, '').toLowerCase()}-${randomUUID().slice(0, 8)}`;
}

function overall(rows: readonly AssertionRow[]): Outcome {
  if (rows.some(row => row.outcome === 'fail')) return 'fail';
  if (rows.some(row => row.outcome === 'blocked')) return 'blocked';
  return 'pass';
}

const STANDING_LIMITATIONS = [
  'Latency is reported only as durations on one owner\'s monotonic clock; no cross-host latency is claimed.',
  'A relay or transport receipt is not model consumption; only context.consumed or model.input counts.',
  'Isolation from an unrestricted agent on the same host is not claimed.',
  'Nothing is released automatically: a human approves every message (G-AUTOMATION). Hosted automation stays closed.',
];

/** Result for a case that was blocked before any action: every row is blocked. */
export function blockedResult(runId: string, bound: Extract<BoundCase, { kind: 'blocked' }>): AcceptanceResult {
  const detail = (spec: AssertionSpec): string => {
    const own = spec.gates.filter(gate => bound.openGates.includes(gate));
    return `not run: case blocked before action${own.length > 0 ? `; also needs ${own.join(', ')}` : ''}`;
  };
  return Object.freeze({
    runId,
    caseId: bound.caseId,
    outcome: 'blocked',
    blockers: bound.reasons,
    assertions: ASSERTIONS.map(spec => Object.freeze({
      id: spec.id, covers: spec.covers, outcome: 'blocked' as const, evidenceRef: null, detail: detail(spec),
    })),
    timings: [],
    limitations: [...STANDING_LIMITATIONS, 'No live collaboration was executed.'],
  });
}

/** Queued-to-consumed and released-to-input durations, each on the recipient's own clock. */
export function measure(records: readonly EvidenceRecord[]): Timing[] {
  const pairs: readonly (readonly [string, string])[] = [['delivery.queued', 'context.consumed'], ['review.released', 'model.input']];
  const timings: Timing[] = [];
  for (const [from, to] of pairs) {
    for (const start of records.filter(record => record.kind === from)) {
      const end = records.find(record => record.kind === to && record.ownerId === start.ownerId
        && record.operationId === start.operationId);
      if (!end) continue;
      const ms = elapsed(reading(start), reading(end));
      // An end before its start is a gating failure the rows report; never a negative duration.
      if (ms < 0) throw new Error(`${to}/${end.operationId} precedes ${from} for ${start.ownerId}`);
      timings.push(Object.freeze({
        ownerId: start.ownerId, operationId: start.operationId, from, to,
        ms, clockId: start.clockId,
      }));
    }
  }
  return timings;
}

function row(spec: AssertionSpec, manifest: EvidenceManifest, acceptance: CollaborationCase): AssertionRow {
  const base = { id: spec.id, covers: spec.covers };
  const blockedBy = spec.gates.filter(gate => acceptance.openGates.includes(gate));
  if (blockedBy.length > 0) {
    return Object.freeze({ ...base, outcome: 'blocked', evidenceRef: null, detail: `open gate: ${blockedBy.join(', ')}` });
  }
  try {
    const verdict = spec.check(manifest.records, acceptance);
    return verdict.passed
      ? Object.freeze({ ...base, outcome: 'pass', evidenceRef: `${manifest.runId}#${verdict.evidenceRef}`, detail: 'passed' })
      : Object.freeze({ ...base, outcome: 'fail', evidenceRef: null, detail: verdict.reason });
  } catch (error) {
    return Object.freeze({ ...base, outcome: 'fail', evidenceRef: null, detail: error instanceof Error ? error.message : 'check threw' });
  }
}

/** Evidence counts only from the exact harness versions the case was bound to. */
function unpinnedHarness(manifest: EvidenceManifest, acceptance: CollaborationCase): string | null {
  for (const [component, version] of Object.entries(acceptance.harnessVersions)) {
    const observed = manifest.sources.find(source => source.component === component);
    if (observed?.version !== version) {
      return `harness ${component} ${version} was not observed (manifest has ${observed?.version ?? 'none'})`;
    }
  }
  return null;
}

/** Evaluates every assertion over the manifest of a live run of a bound case. */
export function evaluate(manifest: EvidenceManifest, acceptance: CollaborationCase): AcceptanceResult {
  const limitations = [...STANDING_LIMITATIONS];
  if (acceptance.browserClosedMode === 'required') {
    limitations.push('With the browser closed, only messages approved earlier are delivered. New messages wait until the owner opens the app (P02).');
  }
  if (acceptance.browserClosedMode === 'unsupported') limitations.push('Operation with every browser closed is unsupported.');
  if (acceptance.browserClosedMode === 'unresolved') limitations.push('Browser-closed operation is unresolved (P02 open).');
  let assertions: AssertionRow[];
  const refusal = !isIssuedManifest(manifest) ? 'the manifest was not issued by a scenario'
    : !isLiveMode(manifest.mode) ? `${manifest.mode} evidence cannot prove acceptance`
      : unpinnedHarness(manifest, acceptance);
  if (refusal !== null) {
    assertions = ASSERTIONS.map(spec => Object.freeze({
      id: spec.id, covers: spec.covers, outcome: 'fail' as const, evidenceRef: null, detail: refusal,
    }));
  } else {
    assertions = ASSERTIONS.map(spec => row(spec, manifest, acceptance));
  }
  let timings: Timing[] = [];
  try {
    timings = measure(manifest.records);
  } catch (error) {
    limitations.push(`Timing not reported: ${error instanceof Error ? error.message : 'measurement failed'}.`);
  }
  return Object.freeze({
    runId: manifest.runId, caseId: acceptance.caseId, outcome: overall(assertions), blockers: [], assertions, timings, limitations,
  });
}

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** A report section for one run. Holds identifiers and outcomes only, never message content. */
export function renderRun(result: AcceptanceResult, context: Readonly<{ sourceSha: string; mode: string; date: string }>): string {
  const lines = [
    `### Run \`${result.runId}\``,
    '',
    `- Case: \`${result.caseId}\``,
    `- Outcome: **${result.outcome}**`,
    `- Source: \`${context.sourceSha}\`, evidence mode \`${context.mode}\`, ${context.date}`,
    ...(result.blockers.length > 0 ? ['', 'Blocked before any action:', '', ...result.blockers.map(blocker => `- ${blocker}`)] : []),
    '',
    '| Assertion | Covers | Outcome | Evidence or reason |',
    '| --- | --- | --- | --- |',
    ...result.assertions.map(row =>
      `| \`${row.id}\` | ${row.covers.join(', ')} | ${row.outcome} | ${cell(row.evidenceRef ?? row.detail)} |`),
    '',
  ];
  if (result.timings.length > 0) {
    lines.push('| Owner | Operation | From → to | ms | Clock |', '| --- | --- | --- | --- | --- |');
    lines.push(...result.timings.map(timing =>
      `| ${timing.ownerId} | ${timing.operationId} | ${timing.from} → ${timing.to} | ${timing.ms.toFixed(1)} | ${cell(timing.clockId)} |`));
    lines.push('');
  }
  lines.push('Limitations:', '', ...result.limitations.map(limitation => `- ${limitation}`), '');
  return lines.join('\n');
}

/** Appends a run section. A run id already in the report is refused, so evidence is never overwritten. */
export function appendRun(report: string, result: AcceptanceResult, section: string): string {
  if (report.includes(`### Run \`${result.runId}\``)) {
    throw new Error(`run ${result.runId} is already reported; reruns need a new run id`);
  }
  return `${report.trimEnd()}\n\n${section.trimEnd()}\n`;
}
