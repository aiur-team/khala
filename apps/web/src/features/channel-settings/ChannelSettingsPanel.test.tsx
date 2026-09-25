import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RoomId } from '@khala/contracts/messaging/index';
import { ChannelSettingsPanel } from './ChannelSettingsPanel';
import type { ChannelSettingsController } from './controller';
import { KNOWN_AGENTS, createFakeCatalog } from './fakes';
import { INITIAL_VIEW, projectListing, toAllowlisted, type ChannelSettingsView } from './model';
import type { ChannelSettingsSnapshot } from './ports';

const ROOM = '!channel:example.test' as RoomId;
const ports = { settings: createFakeCatalog().port };

const SAVED: ChannelSettingsSnapshot = {
  roomId: ROOM,
  channelName: 'Release planning',
  visibility: 'secret',
  listedTitle: null,
  revision: null,
  allowlist: [],
  publicDiscovery: 'enabled',
  canManage: true,
};

function editing(overrides: Partial<ChannelSettingsView> = {}): ChannelSettingsView {
  return {
    ...INITIAL_VIEW,
    phase: 'editing',
    saved: SAVED,
    readOnly: false,
    draftTitle: 'Release planning',
    picker: { kind: 'ready', principals: KNOWN_AGENTS },
    ...overrides,
  };
}

function render(view: ChannelSettingsView): string {
  const controller: ChannelSettingsController = {
    getView: () => view,
    subscribe: () => () => {},
    load: () => {},
    setVisibility: () => {},
    setTitle: () => {},
    save: () => {},
    confirm: () => {},
    cancel: () => {},
    allow: () => {},
    revoke: () => {},
    retry: () => {},
    dispose: () => {},
  };
  return renderToStaticMarkup(<ChannelSettingsPanel ports={ports} roomId={ROOM} controller={controller} />);
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('ChannelSettingsPanel', () => {
  it('announces loading through a mounted live region and renders no controls yet', () => {
    const html = render(INITIAL_VIEW);
    expect(html).toMatch(/<p[^>]*aria-live="polite"[^>]*role="status"[^>]*>Loading channel settings…<\/p>/);
    expect(html).not.toContain('type="radio"');
  });

  it('shows a new channel as secret, checked, with no listing preview', () => {
    const html = render(editing());
    expect(text(html)).toContain('Currently Secret : listed to no agent.');
    expect(html).toMatch(/<input(?=[^>]*value="secret")(?=[^>]*checked="")[^>]*>/);
    expect(text(html)).toContain('Not listed. No agent receives anything about this channel from discovery.');
    expect(html).not.toContain('channel-settings-title');
  });

  it('renders every projection field and nothing that the contract omits', () => {
    const preview = projectListing('private', 'Release planning');
    const html = render(editing({ draftVisibility: 'private', preview }));
    const fields = [...html.matchAll(/<dt>([^<]+)<\/dt>/g)].map(match => match[1]);
    expect(fields.slice(0, 5)).toEqual(['title', 'visibility', 'serviceKind', 'requestState', 'listingRef']);
    expect(text(html)).toContain('Release planning');
    expect(html).not.toMatch(/!room:example\.test/);
  });

  it('disables public with an explanation when public discovery is off', () => {
    const html = render(editing({ saved: { ...SAVED, publicDiscovery: 'disabled' } }));
    expect(html).toMatch(/<input(?=[^>]*value="public")(?=[^>]*disabled="")[^>]*>/);
    expect(text(html)).toContain('Public listing is not enabled on this Khala service yet.');
  });

  it('renders the increase confirmation as a labelled alertdialog with a keep-current choice', () => {
    const html = render(editing({
      phase: 'confirming',
      draftVisibility: 'public',
      pending: { kind: 'visibility', visibility: 'public', title: 'Release planning' },
    }));
    expect(html).toMatch(/role="alertdialog"[^>]*aria-labelledby="channel-settings-confirm-heading"/);
    expect(text(html)).toContain('Make this channel public?');
    expect(text(html)).toContain('Keep secret');
    expect(text(html)).toContain('No agent joins without your approval.');
  });

  it('disables every control and announces progress while submitting', () => {
    const html = render(editing({
      phase: 'submitting',
      draftVisibility: 'private',
      pending: { kind: 'visibility', visibility: 'private', title: 'Release planning' },
    }));
    expect(html).toMatch(/<fieldset[^>]*disabled=""/);
    expect(html).toContain('Saving: changing visibility to private…');
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""/);
  });

  it('announces success in the live region', () => {
    const html = render(editing({ status: { kind: 'saved', visibility: 'private' } }));
    expect(html).toContain('Saved. This channel is now private.');
  });

  it('keeps the pending edit visible with Retry on a retryable failure and never claims success', () => {
    const html = render(editing({
      draftVisibility: 'private',
      pending: { kind: 'visibility', visibility: 'private', title: 'Release planning' },
      status: { kind: 'failed', code: 'unavailable', retryable: true },
    }));
    expect(text(html)).toContain('Could not reach the server. Nothing was saved. Your change is still pending.');
    expect(html).toContain('>Retry<');
    expect(html).not.toContain('Saved.');
  });

  it('announces a stale refresh and an authority loss as read-only', () => {
    expect(text(render(editing({ status: { kind: 'stale_refreshed' } })))).toContain('changed elsewhere. They have been reloaded; nothing was saved.');
    const html = render(editing({ readOnly: true, saved: { ...SAVED, canManage: false }, status: { kind: 'authority_lost' } }));
    expect(text(html)).toContain('You no longer manage this channel.');
    expect(html).toMatch(/<fieldset[^>]*disabled=""/);
  });

  it('leads each picker row with the verified fingerprint and marks agent labels unverified', () => {
    const html = render(editing({ saved: { ...SAVED, visibility: 'private', listedTitle: 'Release planning', revision: '1' } }));
    const body = text(html);
    expect(body).toContain('Verified fingerprint SHA256:peer-9Xb1 Known from: Completed pairing');
    expect(body).toContain('Name (reported by the agent, unverified) Your agent (trusted)');
    expect(body).toContain('Known from: Your agent session');
    expect(html).toContain('>Allow agent SHA256:peer-9Xb1<');
  });

  it('has no global or free-text agent search', () => {
    const html = render(editing({ draftVisibility: 'private', saved: { ...SAVED, visibility: 'private', listedTitle: 'X', revision: '1' } }));
    // The only text input is the listed title; the picker has no query field.
    expect(html).not.toMatch(/type="search"|role="searchbox"|role="combobox"/);
    expect([...html.matchAll(/<input[^>]*type="text"/g)]).toHaveLength(1);
  });

  it('explains an empty picker without offering to launch an agent', () => {
    const body = text(render(editing({ picker: { kind: 'ready', principals: [] } })));
    expect(body).toContain('No verified agents are known to your account yet.');
    expect(body).toContain('share this channel’s URL instead');
    expect(body).not.toMatch(/launch|start agent/i);
  });

  it('lists allowlisted agents by fingerprint with a remove control', () => {
    const agent = toAllowlisted(KNOWN_AGENTS[0]!);
    const html = render(editing({ saved: { ...SAVED, visibility: 'private', listedTitle: 'X', revision: '2', allowlist: [agent] } }));
    expect(html).toContain('>Remove agent SHA256:own-7Q2c<');
    expect(text(html)).toContain('Already allowed.');
  });
});
