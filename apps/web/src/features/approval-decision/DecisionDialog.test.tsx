import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DecisionDialog } from './DecisionDialog';
import { isDecidable, type DecisionPrompt, type DecisionStatus } from './model';
import { PAIRING_FIXTURE, pairingFixturePrompt } from './pairing-fixture';

const PROMPT: DecisionPrompt = {
  kind: 'Test request',
  question: 'Allow this?',
  verified: [{ label: 'Session fingerprint', value: 'SHA256:abc', code: true }],
  untrusted: [{ label: 'Name', value: '<b>Trusted admin</b>' }],
  capabilities: [{ label: 'history', value: 'none' }],
  notices: ['Only this session.'],
  progress: [{ label: 'Your decision', value: 'Pending' }],
  approveLabel: 'Approve',
  denyLabel: 'Deny',
};

const noop = () => {};
const render = (status: DecisionStatus, prompt = PROMPT) => renderToStaticMarkup(
  <DecisionDialog id="t" prompt={prompt} status={status} onDecide={noop} onRetry={noop} onDismiss={noop} />,
);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('DecisionDialog', () => {
  it('is a labelled modal dialog that leads with verified facts', () => {
    const html = render({ kind: 'idle' });
    expect(html).toMatch(/role="dialog" aria-modal="true" aria-labelledby="t-question" aria-describedby="t-kind"/);
    expect(html.indexOf('Verified by Khala')).toBeLessThan(html.indexOf('Reported by the agent'));
    expect(text(html)).toContain('Name (unverified)');
    expect(html).toContain('&lt;b&gt;Trusted admin&lt;/b&gt;');
    expect(html).not.toContain('<b>');
  });

  it('keeps a mounted live region and disables decisions while submitting', () => {
    const html = render({ kind: 'submitting', decision: 'approve' });
    expect(html).toMatch(/<p role="status" aria-live="polite" class="decision-dialog__status">Sending: Approve…<\/p>/);
    expect(html).toMatch(/<button type="button" disabled="">Deny<\/button>/);
    expect(html).toContain('aria-busy="true"');
  });

  it('announces a retryable failure as an alert and offers the same decision again', () => {
    const html = render({ kind: 'retryable', decision: 'deny', message: 'Could not confirm.' });
    expect(html).toContain('<p role="alert" class="decision-dialog__alert">Could not confirm.</p>');
    expect(text(html)).toContain('Retry: Deny');
    expect(text(html)).not.toMatch(/ Approve /);
  });

  it('removes the decision buttons once decided or blocked', () => {
    for (const status of [{ kind: 'decided', message: 'Done.' }, { kind: 'blocked', message: 'Expired.' }] as const) {
      const html = render(status);
      expect(text(html)).toContain(status.message);
      expect(html).not.toContain('>Approve<');
      expect(text(html)).toContain('Close');
    }
  });

  it('lets the owner decide again after a refresh', () => {
    expect(isDecidable({ kind: 'refreshed', message: 'Reloaded.' })).toBe(true);
    expect(render({ kind: 'refreshed', message: 'Reloaded.' })).toContain('>Approve<');
  });

  it('renders a pairing request through the same shell', () => {
    const html = render({ kind: 'idle' }, pairingFixturePrompt(PAIRING_FIXTURE));
    expect(html).toMatch(/role="dialog" aria-modal="true"/);
    expect(text(html)).toContain('Pairing request');
    expect(text(html)).toContain('Session fingerprint SHA256:pair-4Kd9');
    expect(text(html)).toContain('Approve pairing');
    expect(html).not.toContain('Reported by the agent');
  });
});
