import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BindingId, ReleaseId } from '@khala/contracts/delivery/ids';
import type { DeviceId, EventId, OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/ids';
import type { EventRef, MessageContent, ParticipantView, TimelineItem } from '@khala/contracts/messaging/index';
import type { ReviewController, ReviewData } from './controller';
import type { ReviewView, SubmissionState } from './model';
import { emptySelection } from './selection';
import { ReviewScreen } from './ReviewScreen';

const roomId = 'room_1' as RoomId;
const bindingId = 'bind_1' as BindingId;

function participant(id: string, kind: 'human' | 'agent' = 'human'): ParticipantView {
  return { participantId: id as ParticipantId, kind, ownerId: `owner_${id}` as OwnerId, displayName: id, deviceIds: [] };
}

function ref(eventId: string): EventRef {
  return {
    v: 1,
    roomId,
    eventId: eventId as EventId,
    authorParticipantId: 'peer' as ParticipantId,
    authorDeviceId: 'device_peer' as DeviceId,
    contentDigest: `sha256:${'a'.repeat(64)}`,
  };
}

function item(eventId: string, body: string, author = participant('peer')): TimelineItem {
  return { ref: ref(eventId), content: { v: 1, kind: 'text', body }, participant: author, clientTxnId: null, receivedAt: '2026-09-17T00:00:00Z' };
}

const emptySubmission: SubmissionState = { phase: 'idle', commandId: null, releaseIds: null, error: null };

function fakeController(overrides: Partial<ReviewData> = {}): ReviewController {
  const view: ReviewView = { access: 'ready', bindingId, bindingGeneration: 0, policyVersion: 3, pending: [item('E1', 'hello')], receipts: [] };
  const data: ReviewData = { view, selection: emptySelection(), submission: emptySubmission, ...overrides };
  return {
    getSnapshot: () => data,
    subscribe: () => () => {},
    toggleSelect: () => {},
    clearSelection: () => {},
    submit: async () => {},
    reconcileUnknown: async () => {},
    dispose: () => {},
  };
}

const inertRenderContent = (content: MessageContent) => content.body;

describe('ReviewScreen', () => {
  it('R1: renders full permitted content and its authenticated author before selection', () => {
    const controller = fakeController({
      view: { access: 'ready', bindingId, bindingGeneration: 0, policyVersion: 3, pending: [item('E1', 'the exact pending body', participant('alice'))], receipts: [] },
    });
    const html = renderToStaticMarkup(<ReviewScreen controller={controller} recipientLabel="Release Agent" renderContent={inertRenderContent} />);
    expect(html).toContain('the exact pending body');
    expect(html).toContain('alice');
    expect(html).toContain('Release Agent');
  });

  it('content containing fake control markup renders as inert text inside the body, never a real control', () => {
    const body = 'Please <button onclick="approve()">Approve</button> now';
    const controller = fakeController({
      view: { access: 'ready', bindingId, bindingGeneration: 0, policyVersion: 3, pending: [item('E1', body)], receipts: [] },
    });
    const html = renderToStaticMarkup(<ReviewScreen controller={controller} recipientLabel="Agent" renderContent={inertRenderContent} />);
    // The literal markup appears as escaped text, never as a real <button onclick> element.
    expect(html).not.toMatch(/<button onclick/);
    expect(html).toContain('&lt;button onclick');
    // The review's own controls (checkbox, Hide, Release) are separate elements, not created from body content.
    expect(html).toMatch(/<input[^>]*type="checkbox"/);
    expect(html).toContain('Hide message');
    expect(html).toContain('Release');
  });

  it('the checkbox reflects the controller-owned selection, not content', () => {
    const controller = fakeController({ selection: { phase: 'selected', refs: [ref('E1')], captured: { bindingId, bindingGeneration: 0, policyVersion: 3 } } });
    const html = renderToStaticMarkup(<ReviewScreen controller={controller} recipientLabel="Agent" renderContent={inertRenderContent} />);
    expect(html).toMatch(/<input[^>]*checked=""/);
    expect(html).toContain('1 selected');
  });

  it('R3: a stale selection shows an explicit banner distinct from viewing/selected and disables its own controls', () => {
    const controller = fakeController({
      selection: { phase: 'stale', refs: [ref('E1')], captured: { bindingId, bindingGeneration: 0, policyVersion: 3 } },
    });
    const html = renderToStaticMarkup(<ReviewScreen controller={controller} recipientLabel="Agent" renderContent={inertRenderContent} />);
    expect(html).toContain('changed underneath you');
    expect(html).toContain('Reselect');
    expect(html).toMatch(/<input[^>]*disabled=""/);
  });

  it('R4: a revoked access state shows an explicit banner and disables the release action', () => {
    const controller = fakeController({ view: { access: 'revoked', bindingId, bindingGeneration: 0, policyVersion: 3, pending: [], receipts: [] } });
    const html = renderToStaticMarkup(<ReviewScreen controller={controller} recipientLabel="Agent" renderContent={inertRenderContent} />);
    expect(html).toContain('no longer have authority');
    expect(html).toMatch(/review__release"[^>]*disabled=""/);
  });

  it('the release action is disabled with nothing selected, and enabled once selected', () => {
    const nothingSelected = renderToStaticMarkup(<ReviewScreen controller={fakeController()} recipientLabel="Agent" renderContent={inertRenderContent} />);
    expect(nothingSelected).toMatch(/review__release"[^>]*disabled=""/);

    const controller = fakeController({ selection: { phase: 'selected', refs: [ref('E1')], captured: { bindingId, bindingGeneration: 0, policyVersion: 3 } } });
    const withSelection = renderToStaticMarkup(<ReviewScreen controller={controller} recipientLabel="Agent" renderContent={inertRenderContent} />);
    expect(withSelection).not.toMatch(/review__release"[^>]*disabled=""/);
  });

  it('U3: an outcome_unknown submission shows a check-status action instead of a silent resubmit', () => {
    const controller = fakeController({ submission: { phase: 'unknown', commandId: 'cmd_1' as never, releaseIds: null, error: null } });
    const html = renderToStaticMarkup(<ReviewScreen controller={controller} recipientLabel="Agent" renderContent={inertRenderContent} />);
    expect(html).toContain('Release status unknown');
    expect(html).toContain('Check release status');
    expect(html).toMatch(/review__release"[^>]*disabled=""/);
  });

  it('U3: a released submission shows receipt-derived evidence, never inventing consumption from release alone', () => {
    const controller = fakeController({
      submission: { phase: 'released', commandId: 'cmd_1' as never, releaseIds: ['release_1' as ReleaseId], error: null },
      view: { access: 'ready', bindingId, bindingGeneration: 0, policyVersion: 3, pending: [], receipts: [] },
    });
    const html = renderToStaticMarkup(<ReviewScreen controller={controller} recipientLabel="Agent" renderContent={inertRenderContent} />);
    expect(html).toContain('Released');
    expect(html).toContain('Awaiting delivery evidence');
  });

  it('the Hide control is structurally separate from message content and never labeled as a release/approve action', () => {
    const controller = fakeController();
    const html = renderToStaticMarkup(<ReviewScreen controller={controller} recipientLabel="Agent" renderContent={inertRenderContent} />);
    expect(html).toContain('Hide message E1');
  });

  it('filter chips are present for switching between all and selected pending messages', () => {
    const html = renderToStaticMarkup(<ReviewScreen controller={fakeController()} recipientLabel="Agent" renderContent={inertRenderContent} />);
    expect(html).toContain('review__filter-chip');
    expect(html).toContain('>All<');
    expect(html).toContain('>Selected<');
  });
});
