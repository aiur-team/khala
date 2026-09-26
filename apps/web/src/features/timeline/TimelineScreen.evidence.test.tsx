// The channel timeline as the durable receipt evidence surface. Every assertion
// here guards a wrong implementation named by the read-receipt contract.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DeviceId, EventId, OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/ids';
import type { ChannelPort, TimelineItem } from '@khala/contracts/messaging/index';
import type { ReceiptEvidenceController, ReceiptEvidenceStatus } from '../receipt-evidence/controller';
import { type WireFact, wireBody, wireFact } from '../receipt-evidence/fixtures';
import { decodeReceiptEvidence, evidenceUnits } from '../receipt-evidence/model';
import type { TimelineController, TimelineData } from './controller';
import { TimelineScreen } from './TimelineScreen';

const roomId = 'room_demo' as RoomId;
const viewer = { participantId: 'viewer' as ParticipantId, kind: 'human' as const, ownerId: 'owner' as OwnerId, displayName: 'Viewer', deviceIds: [] as DeviceId[] };
const noopSendPort: Pick<ChannelPort, 'send'> = { send: async () => ({ kind: 'unavailable', retryable: true }) };

function item(eventId: string, body = `body of ${eventId}`): TimelineItem {
  return {
    ref: {
      v: 1, roomId, eventId: eventId as EventId, authorParticipantId: viewer.participantId,
      authorDeviceId: 'device' as DeviceId, contentDigest: `sha256:${'0'.repeat(64)}`,
    },
    content: { v: 1, kind: 'text', body },
    participant: viewer,
    clientTxnId: null,
    receivedAt: '2026-09-25T00:00:00Z',
  };
}

function timeline(eventIds: readonly string[]): TimelineController {
  const data: TimelineData = { phase: 'ready', items: eventIds.map(eventId => item(eventId)), nextCursor: null, newMessageCount: 0, membership: null };
  return { getSnapshot: () => data, subscribe: () => () => {}, loadOlder: async () => null, setReaderAtLatest: () => {}, dispose: () => {} };
}

function evidence(status: ReceiptEvidenceStatus, facts: readonly WireFact[] = []): ReceiptEvidenceController {
  const read = decodeReceiptEvidence(wireBody(facts));
  if (read.kind === 'unavailable') throw new Error('fixture');
  const view = { status, units: evidenceUnits(read.facts), announcement: null };
  return { getSnapshot: () => view, subscribe: () => () => {}, refresh: async () => {}, dispose: () => {} };
}

function render(eventIds: readonly string[], controller?: ReceiptEvidenceController): string {
  return renderToStaticMarkup(
    <TimelineScreen
      controller={timeline(eventIds)}
      roomPort={noopSendPort}
      roomId={roomId}
      viewer={viewer}
      {...(controller ? { evidence: controller } : {})}
    />,
  );
}

const count = (html: string, text: string) => html.split(text).length - 1;

describe('timeline receipt evidence', () => {
  it('shows one-event, one-release evidence beside its message with an accessible token-return description', () => {
    const html = render(['E1'], evidence('ready', [
      wireFact({ kind: 'context_consumed', releaseId: 'rel_1', events: ['E1'] }),
      wireFact({ kind: 'agent_acknowledged', releaseId: 'rel_1', events: ['E1'], batch: 'ack_solo' }),
    ]));
    const row = html.slice(html.indexOf('data-event-id="E1"'));
    expect(row).toContain('Added to agent context');
    expect(row).toContain('Batch token returned');
    const describedBy = /aria-describedby="([^"]+)"><span>Batch token returned/.exec(html)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`aria-controls="${describedBy}"`);
    expect(html).toMatch(new RegExp(`<button type="button" class="receipt-evidence__help" aria-expanded="false" aria-controls="${describedBy}">`));
    expect(html).toContain(`id="${describedBy}"`);
    expect(html).toContain('This does not prove the agent acted on the message');
    expect(html).not.toContain('View batch evidence');
  });

  it('never renders a failed evidence read as a confirmed absence, and keeps messages visible', () => {
    for (const status of ['unavailable', 'partial', 'loading'] as const) {
      const html = render(['E1'], evidence(status, [wireFact({ kind: 'harness_queued', releaseId: 'rel_1', events: ['E1'] })]));
      expect(html, status).not.toContain('No token-return fact');
      expect(html, status).toContain('body of E1');
    }
    const failed = render(['E1'], evidence('unavailable'));
    expect(failed).toContain('Delivery evidence unavailable');
    expect(failed).toContain('>Retry</button>');
    expect(render(['E1'], evidence('partial'))).toContain('Delivery evidence unavailable for some messages');
  });

  it('confirms the absence of a token return only after a ready read', () => {
    const html = render(['E1'], evidence('ready', [wireFact({ kind: 'harness_queued', releaseId: 'rel_1', events: ['E1'] })]));
    expect(html).toContain('No token-return fact');
    expect(html).not.toContain('Delivery evidence unavailable');
  });

  it('never renders a completed-only release as acknowledged or read', () => {
    const html = render(['E1'], evidence('ready', [wireFact({ kind: 'completed', releaseId: 'rel_1', events: ['E1'] })]));
    expect(html).toContain('Agent turn completed');
    expect(html).not.toContain('Batch token returned');
    // A completed turn is not a returned token: the ready read confirms there is none.
    expect(html).toContain('No token-return fact');
    expect(html).not.toContain('receipt-evidence__fact--token-return');
    expect(html).not.toMatch(/\bread by\b|\bread\b<|acknowledged/i);
  });

  it('keeps earlier context evidence visible beside a later completion', () => {
    const html = render(['E1'], evidence('ready', [
      wireFact({ kind: 'context_consumed', releaseId: 'rel_1', events: ['E1'], observedAt: '2026-09-25T00:00:01.000Z' }),
      wireFact({ kind: 'completed', releaseId: 'rel_1', events: ['E1'], observedAt: '2026-09-25T00:00:09.000Z' }),
    ]));
    expect(html).toContain('Added to agent context');
    expect(html).toContain('Agent turn completed');
    expect(html.indexOf('Agent turn completed')).toBeLessThan(html.indexOf('Added to agent context'));
  });

  it('renders a multi-release batch once, before its members, with a focusable target each member links to', () => {
    const html = render(['E0', 'E1', 'E2', 'E3'], evidence('ready', [
      wireFact({ kind: 'agent_acknowledged', releaseId: 'rel_1', events: ['E1'], batch: 'ack_1' }),
      wireFact({ kind: 'agent_acknowledged', releaseId: 'rel_2', events: ['E2'], batch: 'ack_1' }),
      wireFact({ kind: 'agent_acknowledged', releaseId: 'rel_3', events: ['E3'], batch: 'ack_1' }),
    ]));
    expect(count(html, 'Batch token returned')).toBe(1);
    const id = /<section id="([^"]+)" class="receipt-evidence receipt-evidence--group"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`<h3 id="${id}-heading" tabindex="-1">Batch evidence: 3 releases, 3 messages</h3>`);
    expect(html.indexOf(`id="${id}"`)).toBeGreaterThan(html.indexOf('data-event-id="E0"'));
    expect(html.indexOf(`id="${id}"`)).toBeLessThan(html.indexOf('data-event-id="E1"'));
    expect(count(html, `href="#${id}">View batch evidence</a>`)).toBe(3);
    const e0 = html.slice(html.indexOf('data-event-id="E0"'), html.indexOf(`id="${id}"`));
    expect(e0).not.toContain('View batch evidence');
  });

  it('keeps a paginated batch target present as older members load', () => {
    const facts = [
      wireFact({ kind: 'agent_acknowledged', releaseId: 'rel_1', events: [{ eventId: 'E1', sequence: 1 }], batch: 'ack_1' }),
      wireFact({ kind: 'agent_acknowledged', releaseId: 'rel_2', events: [{ eventId: 'E5', sequence: 5 }], batch: 'ack_1' }),
    ];
    // Only the newer page is loaded: the group anchors before its loaded member.
    const newest = render(['E4', 'E5'], evidence('ready', facts));
    const id = /<section id="([^"]+)"/.exec(newest)?.[1];
    expect(id).toBeTruthy();
    expect(newest.indexOf(`id="${id}"`)).toBeLessThan(newest.indexOf('data-event-id="E5"'));
    expect(count(newest, `href="#${id}"`)).toBe(1);
    // After the older page loads, the same target moves before the earliest member.
    const both = render(['E1', 'E2', 'E3', 'E4', 'E5'], evidence('ready', facts));
    expect(both).toContain(`<section id="${id}"`);
    expect(both.indexOf(`id="${id}"`)).toBeLessThan(both.indexOf('data-event-id="E1"'));
    expect(count(both, `href="#${id}"`)).toBe(2);
    // With no member loaded, no link can point at a missing target.
    const none = render(['E2', 'E3'], evidence('ready', facts));
    expect(none).not.toContain('View batch evidence');
    expect(none).not.toContain(`id="${id}"`);
  });

  it('shows nothing about evidence when no evidence source is composed', () => {
    const html = render(['E1']);
    expect(html).not.toMatch(/Delivery evidence|token-return/);
  });
});
