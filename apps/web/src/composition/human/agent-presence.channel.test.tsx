// The acknowledgement capability end to end in the browser: the strict status
// decoder, the channel controller and the presence panel carry the closed value
// unchanged, and a snapshot that predates the field presents it as unknown.

import { renderToStaticMarkup } from 'react-dom/server';
import type { RoomId } from '@khala/contracts/messaging/ids';
import { describe, expect, it, vi } from 'vitest';
import { AgentPresencePanel } from '../../features/channel/AgentPresencePanel';
import { createChannelController } from '../../features/channel/controller';
import { createChannelUiPort } from './agent-presence';

function agent(extra: Record<string, unknown>) {
  return {
    participantId: 'agent-1',
    displayName: 'Build agent',
    ownerDisplayName: 'Owner',
    connection: 'connected',
    routeLabel: 'Codex CLI',
    lastReceipt: null,
    installCommand: "khala connect 'https://khala.example/channel/link'",
    ...extra,
  };
}

function statusPort(body: unknown) {
  return createChannelUiPort({
    fetch: async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
    // Polling is not under test.
    setInterval: () => 0,
    clearInterval: () => undefined,
  });
}

async function renderPanel(extra: Record<string, unknown>): Promise<string> {
  const controller = createChannelController(statusPort({ generation: 1, agents: [agent(extra)] }), {
    roomId: 'room-1' as RoomId,
    generation: 1,
  });
  await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe('ready'));
  const html = renderToStaticMarkup(<AgentPresencePanel controller={controller} />);
  controller.dispose();
  return html;
}

describe('acknowledgement capability through the channel panel', () => {
  it.each([
    ['legacy snapshot without the field', {}, 'unknown', 'Batch-token return support not verified'],
    ['unknown', { acknowledgement: 'unknown' }, 'unknown', 'Batch-token return support not verified'],
    ['unsupported', { acknowledgement: 'unsupported' }, 'unsupported', 'Batch-token return not supported'],
    ['supported without any receipt', { acknowledgement: 'batch_token_next_call' }, 'batch_token_next_call', 'Batch-token return supported'],
  ] as const)('%s reaches the panel unchanged', async (_name, extra, expected, label) => {
    const snapshot = await statusPort({ generation: 1, agents: [agent(extra)] }).agents('room-1' as RoomId, new AbortController().signal);
    expect(snapshot.agents[0]!.acknowledgement).toBe(expected);

    const html = await renderPanel(extra);
    expect(html).toContain(`<dd>${label}</dd>`);
    // Supported with no receipt is neutral, never an error, unread or absence claim.
    expect(html).toContain('No delivery receipt yet');
    expect(html).not.toMatch(/unread|No token-return fact|role="alert"/i);
  });

  it.each([
    ['an unknown capability value', { acknowledgement: 'read' }],
    ['a boolean capability', { acknowledgement: true }],
    ['a null capability', { acknowledgement: null }],
  ])('fails closed on %s', async (_name, extra) => {
    await expect(statusPort({ generation: 1, agents: [agent(extra)] }).agents('room-1' as RoomId, new AbortController().signal))
      .rejects.toThrow('invalid_agent_status');
  });

  it('never derives support from the last receipt or the route label', async () => {
    const html = await renderPanel({
      acknowledgement: 'unsupported',
      lastReceipt: { kind: 'agent_acknowledged', observedAt: '2026-09-19T12:00:00.000Z' },
    });
    expect(html).toContain('<dd>Batch-token return not supported</dd>');
  });
});
