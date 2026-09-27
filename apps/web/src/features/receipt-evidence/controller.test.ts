import type { RoomId } from '@khala/contracts/messaging/ids';
import { describe, expect, it } from 'vitest';
import { createReceiptEvidenceController, type ReceiptEvidencePort } from './controller';
import { wireBody, wireFact } from './fixtures';
import { decodeReceiptEvidence, type ReceiptEvidenceRead } from './model';

const channelId = 'channel_1' as RoomId;

function scripted(reads: Array<ReceiptEvidenceRead | Error>): ReceiptEvidencePort & { calls: number } {
  const port = {
    calls: 0,
    async read() {
      const next = reads[Math.min(port.calls, reads.length - 1)]!;
      port.calls += 1;
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return port;
}

const context = wireFact({ kind: 'context_consumed', releaseId: 'rel_1', events: ['E1'], receiptId: 'r_context' });
const token = wireFact({ kind: 'agent_acknowledged', releaseId: 'rel_1', events: ['E1'], receiptId: 'r_token' });
const completed = wireFact({ kind: 'completed', releaseId: 'rel_1', events: ['E1'], receiptId: 'r_completed' });

describe('receipt evidence controller', () => {
  it('starts loading and moves to ready only on a complete read', async () => {
    const controller = createReceiptEvidenceController(scripted([decodeReceiptEvidence(wireBody([context]))]), channelId);
    expect(controller.getSnapshot().status).toBe('loading');
    await controller.refresh();
    expect(controller.getSnapshot().status).toBe('ready');
  });

  it('reports a failed or thrown read as unavailable and keeps the evidence it already had', async () => {
    const controller = createReceiptEvidenceController(scripted([
      decodeReceiptEvidence(wireBody([context])),
      { kind: 'unavailable' },
      new Error('network'),
    ]), channelId);
    await controller.refresh();
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ status: 'unavailable' });
    expect(controller.getSnapshot().units).toHaveLength(1);
    await controller.refresh();
    expect(controller.getSnapshot().status).toBe('unavailable');
  });

  it('keeps previously shown facts when a later read is only partial', async () => {
    const controller = createReceiptEvidenceController(scripted([
      decodeReceiptEvidence(wireBody([context, token])),
      { kind: 'partial', facts: [] },
    ]), channelId);
    await controller.refresh();
    await controller.refresh();
    const [unit] = controller.getSnapshot().units;
    expect(controller.getSnapshot().status).toBe('partial');
    expect(unit!.tokenReturn?.receiptId).toBe('r_token');
  });

  it('keeps hydration and replayed facts silent, then announces each later fact exactly once', async () => {
    const controller = createReceiptEvidenceController(scripted([
      decodeReceiptEvidence(wireBody([context])),
      decodeReceiptEvidence(wireBody([context])),
      decodeReceiptEvidence(wireBody([context, completed, token])),
      decodeReceiptEvidence(wireBody([context, completed, token])),
    ]), channelId);
    await controller.refresh();
    expect(controller.getSnapshot().announcement).toBeNull();
    await controller.refresh();
    expect(controller.getSnapshot().announcement).toBeNull();

    await controller.refresh();
    const announced = controller.getSnapshot().announcement;
    expect(announced).toEqual({ sequence: 1, text: 'New delivery evidence: Batch token returned; Agent turn completed.' });

    await controller.refresh();
    expect(controller.getSnapshot().announcement).toBe(announced);
  });

  it('treats the first successful read after a failure as hydration, not news', async () => {
    const controller = createReceiptEvidenceController(scripted([
      { kind: 'unavailable' },
      decodeReceiptEvidence(wireBody([context, token])),
    ]), channelId);
    await controller.refresh();
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ status: 'ready', announcement: null });
  });

  it('shares one in-flight read and stops after dispose', async () => {
    const port = scripted([decodeReceiptEvidence(wireBody([context]))]);
    const controller = createReceiptEvidenceController(port, channelId);
    await Promise.all([controller.refresh(), controller.refresh()]);
    expect(port.calls).toBe(1);
    controller.dispose();
    await controller.refresh();
    expect(port.calls).toBe(1);
  });
});
