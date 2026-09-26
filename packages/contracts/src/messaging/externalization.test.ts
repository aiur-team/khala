import { describe, expect, it } from 'vitest';
import {
  CONVERSION_STATES, CONVERSION_TRANSITIONS, type ConversionAdvance, type ConversionState,
  decodeConversionAdvance, decodeConversionCreate, decodeConversionRecord, decodeConversionStart,
  decodeHistoryTransferProgress, decodeHistoryTransferStep, isAllowedTransition,
} from './externalization';
import { createFakeConversionJournal } from './externalization.fake';

const create = { v: 1, conversionId: 'conv_1', operationId: 'op_create', historyMode: 'carry_history' } as const;
const advance = (over: Partial<ConversionAdvance> = {}): ConversionAdvance => ({
  v: 1, conversionId: 'conv_1', operationId: 'op_1', expectedRevision: 0, from: 'preparing', to: 'external_created', ...over,
});

describe('conversion state machine', () => {
  it('decodes exactly the listed transitions and rejects every other pair', () => {
    for (const from of CONVERSION_STATES) {
      for (const to of CONVERSION_STATES) {
        const decoded = decodeConversionAdvance(advance({ from, to }));
        expect(decoded.ok, `${from} -> ${to}`).toBe(CONVERSION_TRANSITIONS[from].includes(to));
      }
    }
  });

  it('never leaves a terminal state and never reopens after activation', () => {
    for (const terminal of ['externalized', 'cancelled', 'failed'] as const) expect(CONVERSION_TRANSITIONS[terminal]).toEqual([]);
    expect(CONVERSION_TRANSITIONS.activating).toEqual(['externalized']);
    expect(isAllowedTransition('committing', 'cancelled')).toBe(false);
  });

  it('reports a skipped state at the target field', () => {
    expect(decodeConversionAdvance(advance({ to: 'committing' }))).toEqual({ ok: false, error: { path: 'to', code: 'invalid_value' } });
  });
});

describe('strict decoders', () => {
  it('reject unknown fields, unknown states and unsupported versions', () => {
    expect(decodeConversionCreate({ ...create, extra: 1 })).toEqual({ ok: false, error: { path: 'extra', code: 'unknown_field' } });
    expect(decodeConversionAdvance({ ...advance(), extra: 1 }).ok).toBe(false);
    expect(decodeConversionRecord({ ...create, state: 'bogus', revision: 0 }).ok).toBe(false);
    expect(decodeConversionRecord({ ...create, state: 'preparing', revision: 0, v: 2 })).toEqual({ ok: false, error: { path: 'v', code: 'unsupported_version' } });
    const step = { v: 1, conversionId: 'c', operationId: 'o', phase: 'copy', round: 0, afterChunk: 0 };
    expect(decodeHistoryTransferStep(step).ok).toBe(true);
    expect(decodeHistoryTransferStep({ ...step, extra: true }).ok).toBe(false);
    const progress = { v: 1, conversionId: 'c', operationId: 'o', outcome: 'more', lastAckChunk: 1, chunkCount: 2, manifestDigest: 'd' };
    expect(decodeHistoryTransferProgress(progress).ok).toBe(true);
    expect(decodeHistoryTransferProgress({ ...progress, extra: true }).ok).toBe(false);
  });
});

describe('fake conversion journal', () => {
  it('replays a create and an advance by operation ID without a second effect', async () => {
    const journal = createFakeConversionJournal();
    const created = await journal.create(create);
    expect(await journal.create(create)).toEqual(created);
    const first = await journal.advance(advance());
    expect(await journal.advance(advance())).toEqual(first);
    expect(await journal.read('conv_1')).toMatchObject({ kind: 'ok', value: { state: 'external_created', revision: 1 } });
  });

  it('rejects an operation ID reused with different input', async () => {
    const journal = createFakeConversionJournal();
    await journal.create(create);
    await journal.advance(advance());
    expect(await journal.advance(advance({ to: 'cancelled' }))).toEqual({ kind: 'rejected', code: 'operation_mismatch' });
    expect(await journal.create({ ...create, historyMode: 'start_fresh' })).toEqual({ kind: 'rejected', code: 'operation_mismatch' });
  });

  it('rejects a stale revision and an unknown conversion', async () => {
    const journal = createFakeConversionJournal();
    await journal.create(create);
    await journal.advance(advance());
    expect(await journal.advance(advance({ operationId: 'op_2' }))).toEqual({ kind: 'rejected', code: 'stale_revision' });
    expect(await journal.advance(advance({ conversionId: 'nope', operationId: 'op_3' }))).toEqual({ kind: 'rejected', code: 'not_found' });
  });

  // Wrong implementation: a journal that lets a transition skip a state must fail here.
  it('refuses to skip a state, for every pair the machine does not list', async () => {
    for (const from of CONVERSION_STATES) {
      for (const to of CONVERSION_STATES) {
        if (isAllowedTransition(from, to)) continue;
        const journal = createFakeConversionJournal();
        await journal.create(create);
        const path = pathTo(from);
        let revision = 0;
        for (const [index, step] of path.entries()) {
          const result = await journal.advance(advance({ operationId: `walk_${index}`, expectedRevision: revision, from: step.from, to: step.to }));
          expect(result.kind).toBe('ok');
          revision += 1;
        }
        const result = await journal.advance(advance({ operationId: 'skip', expectedRevision: revision, from, to }));
        expect(result, `${from} -> ${to}`).toEqual({ kind: 'rejected', code: 'invalid_transition' });
        expect(await journal.read('conv_1')).toMatchObject({ value: { state: from, revision } });
      }
    }
  });
});

describe('conversion start', () => {
  const start = {
    v: 1, conversionId: 'conv_1', operationId: 'op_start', sourceChannelId: 'channel_1', historyMode: 'start_fresh', agents: ['agent_1'],
  } as const;

  it('defaults an omitted visibility to secret and keeps every explicit choice', () => {
    expect(decodeConversionStart(start)).toEqual({ ok: true, value: { ...start, visibility: 'secret' } });
    for (const visibility of ['public', 'private', 'secret'] as const) {
      expect(decodeConversionStart({ ...start, visibility })).toEqual({ ok: true, value: { ...start, visibility } });
    }
    expect(decodeConversionStart({ ...start, visibility: 'open' }).ok).toBe(false);
    expect(decodeConversionStart({ ...start, visibility: undefined }).ok).toBe(false);
  });

  it('rejects a repeated agent and unknown fields', () => {
    expect(decodeConversionStart({ ...start, agents: ['agent_1', 'agent_1'] })).toEqual({ ok: false, error: { path: 'agents', code: 'invalid_value' } });
    expect(decodeConversionStart({ ...start, extra: 1 }).ok).toBe(false);
  });
});

/** Shortest listed path from `preparing` to `target`. */
function pathTo(target: ConversionState): { from: ConversionState; to: ConversionState }[] {
  const queue: { state: ConversionState; path: { from: ConversionState; to: ConversionState }[] }[] = [{ state: 'preparing', path: [] }];
  const seen = new Set<ConversionState>(['preparing']);
  for (const item of queue) {
    if (item.state === target) return item.path;
    for (const to of CONVERSION_TRANSITIONS[item.state]) {
      if (seen.has(to)) continue;
      seen.add(to);
      queue.push({ state: to, path: [...item.path, { from: item.state, to }] });
    }
  }
  throw new Error(`unreachable ${target}`);
}
