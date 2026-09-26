import { renderToStaticMarkup } from 'react-dom/server';
import type { MakeExternalJourneyView } from '@khala/contracts/messaging/make-external';
import { describe, expect, it } from 'vitest';
import type { MakeExternalController, MakeExternalState } from './controller';
import { ROSTER, agentOf, conversionView, signedIn } from './fixtures/views';
import { MakeExternalScreen } from './MakeExternalScreen';

function render(view: MakeExternalJourneyView, over: Partial<MakeExternalState> = {}): string {
  const state: MakeExternalState = { phase: 'ready', view, busy: null, announcement: '', error: null, retryable: false, ...over };
  const controller: MakeExternalController = {
    getState: () => state, subscribe: () => () => undefined, start() {}, async act() {}, async retry() {}, dispose() {},
  };
  return renderToStaticMarkup(<MakeExternalScreen controller={controller} onBack={() => undefined} />);
}

const checked = (html: string, name: string, value: string) =>
  new RegExp(`<input(?=[^>]*name="${name}")(?=[^>]*value="${value}")(?=[^>]*checked="")[^>]*>`).test(html);

describe('make-external screen', () => {
  it('asks for an explicit history choice and defaults visibility to secret', () => {
    const html = render(signedIn());
    expect(checked(html, 'history', 'carry_history')).toBe(false);
    expect(checked(html, 'history', 'start_fresh')).toBe(false);
    expect(checked(html, 'visibility', 'secret')).toBe(true);
    for (const agent of ROSTER) expect(html).toContain(`${agent.harness} session ${agent.sessionId}, generation ${agent.generation}`);
  });

  it('keeps the switch unavailable, with a reason, until every agent is ready or skipped', () => {
    const html = render(conversionView({ agents: [agentOf(ROSTER[0]!, { status: 'blocked', block: 'revoked' })] }));
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Switch to the external channel<\/button>/);
    expect(html).toContain('You can switch once every agent is ready or skipped.');
    expect(html).toContain('Retry Builder');
    expect(html).toContain('Skip Builder');
  });

  it('offers a paused drain after catch-up did not converge', () => {
    const html = render(conversionView({ state: 'drain_required' }));
    expect(html).toContain('Pause this channel and finish copying');
    expect(html).toContain('Cancel conversion');
  });

  it('finishes activation forward and never offers to reopen the internal channel', () => {
    const html = render(conversionView({ state: 'activating', agents: [agentOf(ROSTER[0]!, { status: 'ready' })] }, { sourceWrite: 'linked' }));
    expect(html).toContain('Retry activation');
    expect(html).not.toContain('Cancel');
    expect(html).toContain('never reopens this channel');
  });

  it('after a restart, asks for sign-in to finish activation and still never offers a cancel', () => {
    const html = render(conversionView({ state: 'activating' }, {
      sourceWrite: 'linked', signIn: { status: 'signed_out', verificationUrl: null, failure: null },
    }));
    expect(html).toContain('Sign in to continue');
    expect(html).toContain('>Sign in</button>');
    expect(html).toContain('it never reopens this channel');
    expect(html).not.toContain('Cancel');
  });

  it('reports an orphaned external channel after a cancel', () => {
    const html = render(conversionView({ state: 'cancelled', orphanDestinationChannelId: 'external-1' }));
    expect(html).toContain('<code>external-1</code>');
    expect(html).toContain('It is not deleted automatically');
  });

  it('shows the external channel as authoritative and deletion as a separate step', () => {
    const html = render(conversionView({ state: 'externalized' }, { sourceWrite: 'linked' }));
    expect(html).toContain('Open the external channel');
    expect(html).toContain('khala internal delete internal-planning');
  });

  it('explains an absent journey, an ended session and a failed load', () => {
    expect(render(signedIn(), { phase: 'absent' })).toContain('Make external is not available for this channel in this launch.');
    expect(render(signedIn(), { phase: 'session_ended' })).toContain('Relaunch Khala from your terminal to continue.');
    expect(render(signedIn(), { phase: 'load_failed', error: 'down' })).toMatch(/<p>down<\/p>[\s\S]*<button type="button">Try again<\/button>/);
  });

  it('has one polite status region and one alert region', () => {
    const html = render(signedIn(), { announcement: 'Signed in.', error: 'Nope', retryable: true });
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toMatch(/role="alert"[^>]*><p>Nope<\/p><button type="button">Try again<\/button>/);
  });
});
