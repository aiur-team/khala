// Server-shaped binding list entries for listening-control tests and the browser harness.

const IDLE = 'Idle agents receive messages only at their next turn.';

/** A Codex agent whose installed version and trusted hooks prove steer and sync; async awaits a receipt proof. */
export function provenCodexEntry(overrides: Readonly<{
  requested?: string | null; effective?: string | null; version?: number; paused?: boolean; changedBy?: 'owner' | 'agent';
}> = {}) {
  const requested = overrides.requested === undefined ? 'sync' : overrides.requested;
  return {
    binding: { v: 1, bindingId: 'binding-ada', ownerId: 'owner-1', agentParticipantId: 'participant-ada', deviceId: 'device-ada', harness: 'codex', sessionId: 'digest-ada', generation: 1 },
    displayName: 'Ada',
    harnessVersion: '0.156.1',
    ownedByViewer: true,
    paused: overrides.paused ?? false,
    idleDelivery: 'unproven',
    view: {
      bindingId: 'binding-ada', generation: 1, requested, version: overrides.version ?? 1,
      lastChangedBy: overrides.changedBy === undefined
        ? { kind: 'unknown' }
        : { kind: overrides.changedBy, participantId: overrides.changedBy === 'owner' ? 'owner-1' : 'participant-ada' },
      effective: overrides.effective === undefined ? requested : overrides.effective,
      effectiveReason: null,
      support: {
        steer: { status: 'proven', route: 'codex-hooks-next-tool-boundary', reason: `steer means the next tool boundary. ${IDLE}` },
        sync: { status: 'proven', route: 'codex-hooks-stop-or-prompt', reason: `Delivered after the turn at Stop, or with the next prompt. ${IDLE}` },
        async: { status: 'unknown', route: 'codex-khala-read', reason: `Awaiting a receipt proof: async is not offered until the batch token is proven to come back. ${IDLE}` },
      },
    },
  };
}

/** A Claude agent: no internal route is proven, so nothing is requested or in effect. */
export function unprovenClaudeEntry(overrides: Readonly<{ paused?: boolean }> = {}) {
  // As Claude's released claim reads: it says nothing about idle delivery, so the panel must.
  const unknown = { status: 'unknown', route: 'claude-unproven', reason: 'This exact Claude version and interactive hook route have not been inspected.' };
  return {
    binding: { v: 1, bindingId: 'binding-bea', ownerId: 'owner-1', agentParticipantId: 'participant-bea', deviceId: 'device-bea', harness: 'claude', sessionId: 'digest-bea', generation: 1 },
    displayName: 'Bea',
    harnessVersion: null,
    ownedByViewer: true,
    paused: overrides.paused ?? false,
    idleDelivery: 'unproven',
    view: {
      bindingId: 'binding-bea', generation: 1, requested: null, version: 1, effective: null, effectiveReason: 'no_requested_mode',
      lastChangedBy: { kind: 'unknown' },
      support: { steer: unknown, sync: unknown, async: unknown },
    },
  };
}
