// U2: human authority. Only the owner's authenticated approval releases content;
// a peer human, a body that claims authority, a cross-room or tampered reference,
// a stale policy or binding, and anything the model can call are refused, and the
// existing session receives nothing. Each case runs the composed review gate
// (hosted-world.ts) and inspects what the real Codex adapter wrote to the session.

import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandId } from '@khala/contracts/delivery/index';
import { MCP_TOOLS } from '../../../packages/agent-cli/src/mcp/registry';
import { type Canary, describeLeaks, mintCanary } from './fixtures';
import {
  type ConnectorProcess, type CodexSession, approval, bindingId, closeHostedWorlds, codexSession, eventRef, otherRoomId,
  ownerAuthority, peerAuthority, roomId, seedLedger, sessionCapture, startConnector,
} from './hosted-world';

afterEach(closeHostedWorlds);

type Gate = Readonly<{
  process: ConnectorProcess;
  session: CodexSession;
  pending: Canary;
  approved: Canary;
  pendingRef: ReturnType<typeof eventRef>;
  approvedRef: ReturnType<typeof eventRef>;
}>;

async function gate(): Promise<Gate> {
  const pending = mintCanary('pending');
  const approved = mintCanary('approved');
  const pendingRef = eventRef('event_pending', `withheld ${pending.text}`);
  const approvedRef = eventRef('event_approved', `chosen ${approved.text}`);
  const state = await seedLedger([
    { ref: pendingRef, body: `withheld ${pending.text}` },
    { ref: approvedRef, body: `chosen ${approved.text}` },
  ]);
  const session = codexSession(path.dirname(state.state));
  const process = await startConnector(state.storage, session);
  return { process, session, pending, approved, pendingRef, approvedRef };
}

/** The session received nothing at all, and no canary reached it. */
async function expectNothingDelivered(g: Gate) {
  await g.process.dispatcher.idle();
  const capture = sessionCapture(g.session);
  const leaks = capture.leaks([g.pending, g.approved]);
  expect(leaks, describeLeaks(leaks)).toEqual([]);
  expect(g.session.server.adds()).toBe(0);
}

describe('forged or stale approvals never release content', () => {
  it('control: the owner approving the exact event delivers it once, and nothing else', async () => {
    const g = await gate();
    expect(await g.process.approve(approval([g.approvedRef]))).toMatchObject({ ok: true });
    await g.process.dispatcher.idle();
    const capture = sessionCapture(g.session);
    expect(capture.carrying(g.approved)).toEqual(['model:codex-app-server']);
    expect(capture.leaks([g.pending])).toEqual([]);
    expect(g.session.server.adds()).toBe(1);
  });

  it('a peer human in the same room cannot approve the owner\'s pending event', async () => {
    const g = await gate();
    expect(await g.process.approve(approval([g.pendingRef]), peerAuthority)).toEqual({ ok: false, code: 'forbidden' });
    await expectNothingDelivered(g);
  });

  it('a peer human cannot preview the owner\'s pending events', async () => {
    const g = await gate();
    const preview = await g.process.preview({ bindingId, candidates: [g.pendingRef], releaseIds: [] }, peerAuthority);
    expect(preview).toEqual({ ok: false, code: 'forbidden' });
    expect(JSON.stringify(preview)).not.toContain(g.pendingRef.eventId);
  });

  it('authority claimed in the request body is refused, not honoured', async () => {
    const g = await gate();
    for (const smuggled of [
      { ownerId: ownerAuthority.ownerId },
      { authority: ownerAuthority },
      { approved: true },
      { humanApproved: true, via: 'model' },
    ]) {
      const result = await g.process.approve({ ...approval([g.pendingRef]), ...smuggled }, peerAuthority);
      expect(result, JSON.stringify(Object.keys(smuggled))).toEqual({ ok: false, code: 'forbidden' });
      const asOwner = await g.process.approve({ ...approval([g.pendingRef], { commandId: `cmd-${Object.keys(smuggled)[0]}` as CommandId }), ...smuggled });
      expect(asOwner, JSON.stringify(Object.keys(smuggled))).toEqual({ ok: false, code: 'forbidden' });
    }
    await expectNothingDelivered(g);
  });

  it('a reference to another room, or an event under another room\'s command, is refused', async () => {
    const g = await gate();
    const foreign = eventRef('event_pending', `withheld ${g.pending.text}`, otherRoomId);
    expect(await g.process.approve(approval([foreign]))).toEqual({ ok: false, code: 'forbidden' });
    expect(await g.process.approve(approval([g.pendingRef], { roomId: otherRoomId, commandId: 'approve-2' as CommandId }))).toEqual({ ok: false, code: 'forbidden' });
    await expectNothingDelivered(g);
  });

  it('a tampered digest cannot release the pending event under a reviewed-looking reference', async () => {
    const g = await gate();
    const tampered = { ...g.pendingRef, contentDigest: g.approvedRef.contentDigest };
    expect(await g.process.approve(approval([tampered]))).toEqual({ ok: false, code: 'stale_content' });
    await expectNothingDelivered(g);
  });

  it('an unknown event, a stale policy version and a stale binding generation are refused', async () => {
    const g = await gate();
    const unknown = eventRef('event_never_received', 'nothing');
    expect(await g.process.approve(approval([unknown]))).toEqual({ ok: false, code: 'expired_content' });
    expect(await g.process.approve(approval([g.pendingRef], { commandId: 'approve-3' as CommandId, expectedPolicyVersion: 2 })))
      .toEqual({ ok: false, code: 'stale_policy' });
    expect(await g.process.approve(approval([g.pendingRef], { commandId: 'approve-4' as CommandId, expectedBindingGeneration: 1 })))
      .toEqual({ ok: false, code: 'stale_binding' });
    await expectNothingDelivered(g);
  });

  it('a replayed command ID with a different selection is refused and does not widen the release', async () => {
    const g = await gate();
    expect(await g.process.approve(approval([g.approvedRef]))).toMatchObject({ ok: true });
    expect(await g.process.approve(approval([g.approvedRef, g.pendingRef]))).toEqual({ ok: false, code: 'idempotency_conflict' });
    await g.process.dispatcher.idle();
    const capture = sessionCapture(g.session);
    expect(capture.leaks([g.pending])).toEqual([]);
    expect(g.session.server.adds()).toBe(1);
  });

  it('the model has no tool that approves, releases, trusts or reviews', () => {
    const names = MCP_TOOLS.map(tool => tool.name);
    expect(names.filter(name => /approv|releas|review|trust|policy|pause|resume|preview/.test(name))).toEqual([]);
    expect(roomId).not.toBe(otherRoomId);
  });
});
