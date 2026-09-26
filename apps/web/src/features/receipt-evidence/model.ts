// Strict browser decoding of the owner-gated receipt evidence read, and its
// grouping into evidence units. A unit is one release's facts, or every release a
// single returned batch token covered: that token return is one observation, so it
// is shown once for the batch, never repeated as if each release were a separate
// agent action.

import {
  type DeliveryReceiptTransport, type ReceiptId, type ReleaseId, decodeDeliveryReceiptTransport,
} from '@khala/contracts/delivery/index';
import type { EventId } from '@khala/contracts/messaging/ids';
import { inCanonicalOrder } from './vocabulary';

export type ReceiptEvidenceFact = Readonly<{
  receipt: DeliveryReceiptTransport;
  evidenceRef: string;
  /** This channel's events the release carried, with their timeline sequence when known. */
  events: readonly Readonly<{ eventId: EventId; sequence: number | null }>[];
}>;

/**
 * `ready` is a complete read; `partial` kept only the facts that decoded; and
 * `unavailable` proves nothing. Only `ready` may ever confirm an absence.
 */
export type ReceiptEvidenceRead =
  | Readonly<{ kind: 'ready'; facts: readonly ReceiptEvidenceFact[] }>
  | Readonly<{ kind: 'partial'; facts: readonly ReceiptEvidenceFact[] }>
  | Readonly<{ kind: 'unavailable' }>;

export type EvidenceRelease = Readonly<{
  releaseId: ReleaseId;
  /** Every fact except the batch token return, in canonical order. */
  receipts: readonly DeliveryReceiptTransport[];
}>;

export type EvidenceUnit = Readonly<{
  /** Stable, DOM-safe target for navigation. */
  id: string;
  kind: 'batch' | 'release';
  /** The one token-return observation for this unit, or `null` when none is recorded. */
  tokenReturn: DeliveryReceiptTransport | null;
  releases: readonly EvidenceRelease[];
  /** Member events in timeline order. */
  eventIds: readonly EventId[];
}>;

const MAX_IDENTIFIER_BYTES = 256;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_BYTES
    && /^[\x21-\x7e]+$/.test(value);
}

function decodeFact(value: unknown): ReceiptEvidenceFact | null {
  if (!record(value) || !exactKeys(value, ['receipt', 'evidenceRef', 'events'])) return null;
  const receipt = decodeDeliveryReceiptTransport(value.receipt);
  if (!receipt.ok || !identifier(value.evidenceRef)) return null;
  // A token return's own evidence reference must be the group it is reported in.
  if (receipt.value.evidenceRef !== null && receipt.value.evidenceRef !== value.evidenceRef) return null;
  if (!Array.isArray(value.events) || value.events.length === 0) return null;
  const events: { eventId: EventId; sequence: number | null }[] = [];
  for (const event of value.events) {
    if (!record(event) || !exactKeys(event, ['eventId', 'sequence']) || !identifier(event.eventId)
      || !(event.sequence === null || (Number.isSafeInteger(event.sequence) && (event.sequence as number) >= 0))) return null;
    events.push({ eventId: event.eventId as EventId, sequence: event.sequence as number | null });
  }
  return { receipt: receipt.value, evidenceRef: value.evidenceRef, events };
}

/**
 * Decodes the receipts route body. A malformed envelope is `unavailable`; a
 * malformed fact, a duplicate, or a group naming a fact that did not decode makes
 * the read `partial`, so a fact the browser could not verify is never presented
 * as absent.
 */
export function decodeReceiptEvidence(body: unknown): ReceiptEvidenceRead {
  if (!record(body) || !exactKeys(body, ['v', 'facts', 'groups']) || body.v !== 1
    || !Array.isArray(body.facts) || !Array.isArray(body.groups)) return { kind: 'unavailable' };
  let complete = true;
  const facts = new Map<ReceiptId, ReceiptEvidenceFact>();
  for (const raw of body.facts) {
    const fact = decodeFact(raw);
    if (fact === null || facts.has(fact.receipt.receiptId)) complete = false;
    else facts.set(fact.receipt.receiptId, fact);
  }
  for (const group of body.groups) {
    if (!record(group) || !exactKeys(group, ['evidenceRef', 'receiptIds']) || !identifier(group.evidenceRef)
      || !Array.isArray(group.receiptIds)) {
      complete = false;
      continue;
    }
    for (const receiptId of group.receiptIds) {
      if (facts.get(receiptId as ReceiptId)?.evidenceRef !== group.evidenceRef) complete = false;
    }
  }
  const decoded = [...facts.values()];
  return complete ? { kind: 'ready', facts: decoded } : { kind: 'partial', facts: decoded };
}

/** Maps an arbitrary identifier onto `[A-Za-z0-9_-]` reversibly, so distinct units never share a DOM id. */
function domSafe(value: string): string {
  return value.replace(/[^A-Za-z0-9-]/g, character => `_${character.charCodeAt(0).toString(16)}_`);
}

function eventOrder(
  a: Readonly<{ eventId: EventId; sequence: number | null }>,
  b: Readonly<{ eventId: EventId; sequence: number | null }>,
): number {
  if (a.sequence !== null && b.sequence !== null && a.sequence !== b.sequence) return a.sequence - b.sequence;
  if (a.sequence !== b.sequence) return a.sequence === null ? 1 : -1;
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

/**
 * Groups facts into evidence units. Releases whose token returns share one
 * evidence reference form one batch unit; every other release is its own unit.
 * The result is independent of input order.
 */
export function evidenceUnits(facts: readonly ReceiptEvidenceFact[]): readonly EvidenceUnit[] {
  const byRelease = new Map<ReleaseId, ReceiptEvidenceFact[]>();
  for (const fact of facts) byRelease.set(fact.receipt.releaseId, [...(byRelease.get(fact.receipt.releaseId) ?? []), fact]);
  const releasesByBatch = new Map<string, Set<ReleaseId>>();
  for (const fact of facts) {
    if (fact.receipt.kind !== 'agent_acknowledged') continue;
    const releases = releasesByBatch.get(fact.evidenceRef) ?? new Set<ReleaseId>();
    releases.add(fact.receipt.releaseId);
    releasesByBatch.set(fact.evidenceRef, releases);
  }
  const unitKeyOf = (releaseId: ReleaseId): string => {
    const tokenReturn = byRelease.get(releaseId)!.find(fact => fact.receipt.kind === 'agent_acknowledged');
    return tokenReturn && releasesByBatch.get(tokenReturn.evidenceRef)!.size > 1
      ? `batch:${tokenReturn.evidenceRef}`
      : `release:${releaseId}`;
  };
  const members = new Map<string, ReleaseId[]>();
  for (const releaseId of byRelease.keys()) {
    const key = unitKeyOf(releaseId);
    members.set(key, [...(members.get(key) ?? []), releaseId]);
  }
  const units: EvidenceUnit[] = [];
  for (const [key, releaseIds] of members) {
    const unitFacts = releaseIds.flatMap(releaseId => byRelease.get(releaseId)!);
    const tokenReturns = inCanonicalOrder(unitFacts.map(fact => fact.receipt).filter(receipt => receipt.kind === 'agent_acknowledged'));
    const events = new Map<EventId, { eventId: EventId; sequence: number | null }>();
    for (const fact of unitFacts) {
      for (const event of fact.events) if (!events.has(event.eventId)) events.set(event.eventId, event);
    }
    units.push({
      id: `receipt-evidence-${domSafe(key)}`,
      kind: key.startsWith('batch:') ? 'batch' : 'release',
      tokenReturn: tokenReturns[0] ?? null,
      releases: [...releaseIds].sort().map(releaseId => ({
        releaseId,
        receipts: inCanonicalOrder(byRelease.get(releaseId)!.map(fact => fact.receipt)
          .filter(receipt => receipt.kind !== 'agent_acknowledged')),
      })),
      eventIds: [...events.values()].sort(eventOrder).map(event => event.eventId),
    });
  }
  return units.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** One event carried by one release: its evidence belongs beside that message. */
export function isInlineUnit(unit: EvidenceUnit): boolean {
  return unit.releases.length === 1 && unit.eventIds.length === 1;
}
