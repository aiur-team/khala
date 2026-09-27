import { describe, expect, it } from 'vitest';
import { wireBody, wireFact } from './fixtures';
import { decodeReceiptEvidence, evidenceUnits, isInlineUnit, type ReceiptEvidenceFact } from './model';
import { compareReceiptEvidence, inCanonicalOrder, receiptEvidenceLabel } from './vocabulary';

function ready(body: unknown): readonly ReceiptEvidenceFact[] {
  const read = decodeReceiptEvidence(body);
  if (read.kind !== 'ready') throw new Error(`expected ready, got ${read.kind}`);
  return read.facts;
}

describe('strict receipt evidence decoding', () => {
  it('decodes v1 and v2 facts from one read', () => {
    const facts = ready(wireBody([
      wireFact({ kind: 'context_consumed', releaseId: 'rel_1', events: ['E1'] }),
      wireFact({ kind: 'agent_acknowledged', releaseId: 'rel_1', events: ['E1'] }),
    ]));
    expect(facts.map(fact => [fact.receipt.v, fact.receipt.kind])).toEqual([[1, 'context_consumed'], [2, 'agent_acknowledged']]);
  });

  it.each([
    ['a missing envelope', null],
    ['an unknown version', { v: 2, facts: [], groups: [] }],
    ['an extra envelope key', { v: 1, facts: [], groups: [], body: 'x' }],
    ['non-array facts', { v: 1, facts: {}, groups: [] }],
  ])('treats %s as unavailable, never as an empty ready read', (_name, body) => {
    expect(decodeReceiptEvidence(body)).toEqual({ kind: 'unavailable' });
  });

  it.each([
    ['a harness-sourced token return', (fact: ReturnType<typeof wireFact>) => ({ ...fact, receipt: { ...fact.receipt, source: 'harness' } })],
    ['a v1 token return', (fact: ReturnType<typeof wireFact>) => ({ ...fact, receipt: { ...fact.receipt, v: 1 } })],
    ['a content-bearing fact', (fact: ReturnType<typeof wireFact>) => ({ ...fact, body: 'secret' })],
    ['a mismatched evidence reference', (fact: ReturnType<typeof wireFact>) => ({ ...fact, evidenceRef: 'other' })],
    ['a fact without events', (fact: ReturnType<typeof wireFact>) => ({ ...fact, events: [] })],
  ])('drops %s and reports the read partial so it is never shown absent', (_name, corrupt) => {
    const good = wireFact({ kind: 'context_consumed', releaseId: 'rel_1', events: ['E1'] });
    const bad = corrupt(wireFact({ kind: 'agent_acknowledged', releaseId: 'rel_1', events: ['E1'] }));
    const read = decodeReceiptEvidence({ v: 1, facts: [good, bad], groups: [] });
    expect(read.kind).toBe('partial');
    expect(read.kind !== 'unavailable' && read.facts.map(fact => fact.receipt.kind)).toEqual(['context_consumed']);
  });

  it('reports a group naming an undecoded fact as partial', () => {
    const body = wireBody([wireFact({ kind: 'context_consumed', releaseId: 'rel_1', events: ['E1'] })]);
    const read = decodeReceiptEvidence({ ...body, groups: [...body.groups, { evidenceRef: 'ack_batch', receiptIds: ['receipt_missing'] }] });
    expect(read.kind).toBe('partial');
  });
});

describe('truthful labels and canonical ordering', () => {
  it('names each boundary without claiming read, action or completion', () => {
    expect(receiptEvidenceLabel({ kind: 'context_consumed', errorCode: null })).toBe('Added to agent context');
    expect(receiptEvidenceLabel({ kind: 'agent_acknowledged', errorCode: null })).toBe('Batch token returned');
    expect(receiptEvidenceLabel({ kind: 'completed', errorCode: null })).toBe('Agent turn completed');
    expect(receiptEvidenceLabel({ kind: 'harness_queued', errorCode: null })).toBe('Queued at agent session');
  });

  it('orders unordered facts deterministically by kind code, then timestamp and receipt ID', () => {
    const facts = [
      wireFact({ kind: 'completed', releaseId: 'r', events: ['E1'], receiptId: 'c', observedAt: '2026-09-25T00:00:01.000Z' }),
      wireFact({ kind: 'context_consumed', releaseId: 'r', events: ['E1'], receiptId: 'b', observedAt: '2026-09-25T00:00:03.000Z' }),
      wireFact({ kind: 'transport_written', releaseId: 'r', events: ['E1'], receiptId: 'a', observedAt: '2026-09-25T00:00:00.000Z' }),
      wireFact({ kind: 'context_consumed', releaseId: 'r', events: ['E1'], receiptId: 'd', observedAt: '2026-09-25T00:00:02.000Z' }),
    ];
    const expected = ['c', 'd', 'b', 'a'];
    for (const permutation of [facts, [...facts].reverse(), [facts[2]!, facts[0]!, facts[3]!, facts[1]!]]) {
      const receipts = ready(wireBody(permutation)).map(fact => fact.receipt);
      expect(inCanonicalOrder(receipts).map(receipt => receipt.receiptId)).toEqual(expected);
    }
    expect(compareReceiptEvidence(
      { kind: 'transport_written', observedAt: '2026-09-25T00:00:00.000Z', receiptId: 'z' } as never,
      { kind: 'completed', observedAt: '2026-09-26T00:00:00.000Z', receiptId: 'a' } as never,
    )).toBeGreaterThan(0);
  });
});

describe('evidence units', () => {
  it('keeps one-event, one-release evidence inline', () => {
    const units = evidenceUnits(ready(wireBody([
      wireFact({ kind: 'context_consumed', releaseId: 'rel_1', events: ['E1'] }),
      wireFact({ kind: 'agent_acknowledged', releaseId: 'rel_1', events: ['E1'], batch: 'ack_solo' }),
    ])));
    expect(units).toHaveLength(1);
    expect(isInlineUnit(units[0]!)).toBe(true);
    expect(units[0]!.tokenReturn?.kind).toBe('agent_acknowledged');
    expect(units[0]!.releases[0]!.receipts.map(receipt => receipt.kind)).toEqual(['context_consumed']);
  });

  it('renders one batch as one token-return observation, never as separate agent actions', () => {
    const units = evidenceUnits(ready(wireBody([
      wireFact({ kind: 'agent_acknowledged', releaseId: 'rel_1', events: ['E1'], batch: 'ack_1' }),
      wireFact({ kind: 'agent_acknowledged', releaseId: 'rel_2', events: ['E2'], batch: 'ack_1' }),
      wireFact({ kind: 'agent_acknowledged', releaseId: 'rel_3', events: ['E3'], batch: 'ack_1' }),
      wireFact({ kind: 'completed', releaseId: 'rel_2', events: ['E2'] }),
    ])));
    expect(units).toHaveLength(1);
    const [batch] = units;
    expect(batch!.kind).toBe('batch');
    expect(isInlineUnit(batch!)).toBe(false);
    expect(batch!.releases.map(release => release.releaseId)).toEqual(['rel_1', 'rel_2', 'rel_3']);
    expect(batch!.eventIds).toEqual(['E1', 'E2', 'E3']);
    // The per-release lists never repeat the token return.
    expect(batch!.releases.flatMap(release => release.receipts.map(receipt => receipt.kind))).toEqual(['completed']);
  });

  it('groups a multi-message release and orders its members by timeline sequence', () => {
    const units = evidenceUnits(ready(wireBody([
      wireFact({ kind: 'harness_queued', releaseId: 'rel_1', events: [{ eventId: 'E9', sequence: 9 }, { eventId: 'E2', sequence: 2 }] }),
    ])));
    expect(units[0]!.kind).toBe('release');
    expect(isInlineUnit(units[0]!)).toBe(false);
    expect(units[0]!.eventIds).toEqual(['E2', 'E9']);
    expect(units[0]!.tokenReturn).toBeNull();
  });

  it('gives distinct units distinct DOM-safe ids', () => {
    const units = evidenceUnits(ready(wireBody([
      wireFact({ kind: 'queued', releaseId: 'rel/1', events: ['E1'] }),
      wireFact({ kind: 'queued', releaseId: 'rel_2f_1', events: ['E2'] }),
    ])));
    const ids = units.map(unit => unit.id);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
