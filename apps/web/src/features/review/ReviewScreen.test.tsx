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
const viewerOwnerId = 'owner_viewer' as OwnerId;

function participant(id: string, kind: 'human' | 'agent' = 'human', ownerId: OwnerId = `owner_${id}` as OwnerId): ParticipantView {
  return { participantId: id as ParticipantId, kind, ownerId, displayName: id, deviceIds: [] };
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
  const view: ReviewView = { access: 'ready', bindingId, bindingGeneration: 0, policyVersion: 3, viewerOwnerId, pending: [item('E1', 'hello')], receipts: [] };
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
      view: { access: 'ready', bindingId, bindingGeneration: 0, policyVersion: 3, viewerOwnerId, pending: [item('E1', 'the exact pending body', participant('alice'))], receipts: [] },
    });
    const html = renderToStaticMarkup(<ReviewScreen controller={controller} recipientLabel="Release Agent" renderContent={inertRenderContent} />);
    expect(html).toContain('the exact pending body');
    expect(html).toContain('alice');
    expect(html).toContain('Release Agent');
  });

  it('content containing fake control markup renders as inert text inside the body, never a real control', () => {
    const body = 'Please <button onclick="approve()">Approve</button> now';
    const controller = fakeController({
      view: { access: 'ready', bindingId, bindingGeneration: 0, policyVersion: 3, viewerOwnerId, pending: [item('E1', body)], receipts: [] },
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
    const controller = fakeController({ view: { access: 'revoked', bindingId, bindingGeneration: 0, policyVersion: 3, viewerOwnerId, pending: [], receipts: [] } });
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
      view: { access: 'ready', bindingId, bindingGeneration: 0, policyVersion: 3, viewerOwnerId, pending: [], receipts: [] },
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

  it('R1: labels the viewer\'s own agent apart from another owner\'s, following the #72 attribution rules', () => {
    const yourAgent = participant('bot-mine', 'agent', viewerOwnerId);
    const otherAgent = participant('bot-theirs', 'agent', 'owner_someone_else' as OwnerId);
    const controller = fakeController({
      view: {
        access: 'ready', bindingId, bindingGeneration: 0, policyVersion: 3, viewerOwnerId,
        pending: [item('E1', 'mine', yourAgent), item('E2', 'theirs', otherAgent)],
        receipts: [],
      },
    });
    const html = renderToStaticMarkup(<ReviewScreen controller={controller} recipientLabel="Agent" renderContent={inertRenderContent} />);
    // Scoped per row, not a whole-document substring check: inverting the
    // ownership comparison (`===` to `!==`) would still make both label
    // strings appear *somewhere* in the html, just swapped onto the wrong
    // rows, so a document-wide `toContain` on both strings cannot catch that.
    const row = (eventId: string): string => {
      const match = html.match(new RegExp(`data-event-id="${eventId}"[\\s\\S]*?<\\/li>`));
      expect(match, `expected a rendered row for ${eventId}`).not.toBeNull();
      return match![0];
    };
    const mineRow = row('E1');
    expect(mineRow).toContain('Your agent');
    expect(mineRow).not.toContain('Another person&#x27;s agent');
    const theirsRow = row('E2');
    expect(theirsRow).toContain('Another person&#x27;s agent');
    expect(theirsRow).not.toMatch(/>Your agent</);
  });

  it('two participants sharing a display name across different owners get a disambiguating suffix', () => {
    const mine = participant('same-name', 'agent', viewerOwnerId);
    const theirs = participant('same-name', 'agent', 'owner_someone_else' as OwnerId);
    const controller = fakeController({
      view: {
        access: 'ready', bindingId, bindingGeneration: 0, policyVersion: 3, viewerOwnerId,
        pending: [item('E1', 'mine', mine), item('E2', 'theirs', theirs)],
        receipts: [],
      },
    });
    const html = renderToStaticMarkup(<ReviewScreen controller={controller} recipientLabel="Agent" renderContent={inertRenderContent} />);
    expect(html).toContain('same-name (#ewer)');
    expect(html).toContain('same-name (#else)');
  });

  it('a checkbox carries an accessible name beyond the bare author name', () => {
    const controller = fakeController();
    const html = renderToStaticMarkup(<ReviewScreen controller={controller} recipientLabel="Agent" renderContent={inertRenderContent} />);
    expect(html).toMatch(/aria-label="Select message from peer[^"]*received[^"]*hello/);
  });

  it('strips control and bidi characters from the body preview before it reaches the checkbox accessible name', () => {
    // U+0007 (BEL, a control character) and U+202E (RTL override, a bidi
    // character) are within the first 60 characters of the body; the body
    // itself still renders in full and inert with the original bytes (only
    // the review-owned accessible name is sanitized, never the content
    // renderContent shows - KTD4), so only the aria-label is asserted here.
    const body = 'Approve this ‮now, not later';
    const controller = fakeController({
      view: { access: 'ready', bindingId, bindingGeneration: 0, policyVersion: 3, viewerOwnerId, pending: [item('E1', body)], receipts: [] },
    });
    const html = renderToStaticMarkup(<ReviewScreen controller={controller} recipientLabel="Agent" renderContent={inertRenderContent} />);
    const ariaLabelMatch = html.match(/aria-label="Select message from peer[^"]*"/);
    expect(ariaLabelMatch, 'expected a checkbox aria-label').not.toBeNull();
    expect(ariaLabelMatch![0]).not.toContain('');
    expect(ariaLabelMatch![0]).not.toContain('‮');
    expect(ariaLabelMatch![0]).toContain('Approve this now, not later');
  });

  it('U2/KTD4: Hide is disabled while a submission is in flight or unresolved, so a hidden ref can never desync from a submitted selection', () => {
    const selection = { phase: 'selected' as const, refs: [ref('E1')], captured: { bindingId, bindingGeneration: 0, policyVersion: 3 } };
    const submitting = fakeController({ selection, submission: { phase: 'submitting', commandId: 'cmd_1' as never, releaseIds: null, error: null } });
    const submittingHtml = renderToStaticMarkup(<ReviewScreen controller={submitting} recipientLabel="Agent" renderContent={inertRenderContent} />);
    expect(submittingHtml).toMatch(/review__hide"[^>]*disabled=""/);

    const unknown = fakeController({ selection, submission: { phase: 'unknown', commandId: 'cmd_1' as never, releaseIds: null, error: null } });
    const unknownHtml = renderToStaticMarkup(<ReviewScreen controller={unknown} recipientLabel="Agent" renderContent={inertRenderContent} />);
    expect(unknownHtml).toMatch(/review__hide"[^>]*disabled=""/);

    const idle = fakeController({ selection });
    const idleHtml = renderToStaticMarkup(<ReviewScreen controller={idle} recipientLabel="Agent" renderContent={inertRenderContent} />);
    expect(idleHtml).not.toMatch(/review__hide"[^>]*disabled=""/);
  });

  it('an unavailable item renders as a disabled placeholder with its withheld reason, never dropped silently', () => {
    const unavailableRef = {
      v: 1 as const, roomId, eventId: 'E-unavailable' as EventId,
      authorParticipantId: 'peer' as ParticipantId, authorDeviceId: 'device_peer' as DeviceId,
    };
    const unavailableItemValue: TimelineItem = {
      ref: unavailableRef,
      content: { v: 1, kind: 'unavailable', reason: 'withheld' },
      participant: participant('peer'),
      clientTxnId: null,
      receivedAt: '2026-09-17T00:00:00Z',
    };
    const controller = fakeController({
      view: {
        access: 'ready', bindingId, bindingGeneration: 0, policyVersion: 3, viewerOwnerId,
        pending: [item('E1', 'hello'), unavailableItemValue],
        receipts: [],
      },
    });
    const html = renderToStaticMarkup(<ReviewScreen controller={controller} recipientLabel="Agent" renderContent={inertRenderContent} />);
    expect(html).toContain('Content withheld by the sender.');
    expect(html).toContain('data-event-id="E-unavailable"');
    // No checkbox is offered for an item that cannot be selected.
    expect(html).not.toMatch(/data-event-id="E-unavailable"[^]*?<input/);
  });
});
