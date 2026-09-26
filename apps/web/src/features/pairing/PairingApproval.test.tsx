import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PAIRING_FIXTURE } from '../approval-decision/pairing-fixture';
import { INITIAL_PAIRING_VIEW, toDecisionPrompt } from './model';
import { PairingApproval } from './PairingApproval';
import type { PairingApprovalController } from './controller';
import type { PairingView } from './model';

const controllerFor = (view: PairingView): PairingApprovalController => ({
  getView: () => view,
  subscribe: () => () => {},
  start: () => {},
  refresh: () => {},
  decide: () => {},
  retry: () => {},
  dispose: () => {},
});
const render = (view: PairingView) => renderToStaticMarkup(<PairingApproval controller={controllerFor(view)} />);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('PairingApproval', () => {
  it('announces loading through a mounted status region', () => {
    expect(render(INITIAL_PAIRING_VIEW)).toMatch(/role="status"[^>]*>Loading pairing request…</);
  });

  it('shows the verified session, never opens the dialog by itself', () => {
    const html = render({ ...INITIAL_PAIRING_VIEW, phase: 'ready', pairing: PAIRING_FIXTURE });
    expect(text(html)).toContain('codex session SHA256:pair-4Kd9');
    expect(html).not.toContain('role="dialog"');
    expect(text(html)).toContain('Review pairing');
  });

  it('renders a terminal state without a decision to review', () => {
    const html = render({
      ...INITIAL_PAIRING_VIEW,
      phase: 'ready',
      pairing: { ...PAIRING_FIXTURE, state: 'denied', decidedAt: '2026-09-25T10:05:00Z' },
      status: { kind: 'decided', message: 'Denied. Nothing was granted.' },
    });
    expect(text(html)).toContain('Denied. Nothing was granted.');
    expect(text(html)).toContain('View details');
  });
});

describe('toDecisionPrompt', () => {
  it('leads with the verified identity, generation, and target channel', () => {
    const prompt = toDecisionPrompt(PAIRING_FIXTURE);
    const labels = prompt.verified.map(fact => fact.label);
    expect(labels).toEqual(['Harness', 'Session fingerprint', 'Session ID', 'Session generation', 'Target channel', 'Service']);
    expect(prompt.verified.find(f => f.label === 'Session generation')?.value).toBe('2');
    expect(prompt.untrusted).toEqual([]);
  });
});
