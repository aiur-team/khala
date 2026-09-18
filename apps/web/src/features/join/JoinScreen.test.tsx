import { describe, expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { JoinScreen } from './JoinScreen';
import type { JoinView } from './model';

const noop = () => {};

function render(view: JoinView) {
  return renderToStaticMarkup(<JoinScreen view={view} onSignIn={noop} onRetry={noop} />);
}

describe('JoinScreen normal path', () => {
  test('never renders a homeserver, password, connector or device-key control', () => {
    const phases: JoinView['phase'][] = [
      'checking_identity', 'sign_in', 'checking_invitation', 'initializing_device', 'joining', 'joined',
    ];
    for (const phase of phases) {
      const html = render({ phase, email: 'person@example.com', roomId: phase === 'joined' ? 'room_1' : null, retryAllowed: false, errorCode: null });
      for (const forbidden of [/homeserver/i, /password/i, /mcp/i, /device.?key/i, /connector/i, /model selector/i]) {
        expect(html).not.toMatch(forbidden);
      }
    }
  });

  test('sign_in renders a sign-in action and no protected content', () => {
    const html = render({ phase: 'sign_in', email: null, roomId: null, retryAllowed: false, errorCode: null });
    expect(html).toContain('Sign in');
    expect(html).not.toContain('room_1');
  });

  test('joined shows the room id and no setup controls', () => {
    const html = render({ phase: 'joined', email: 'person@example.com', roomId: 'room_1', retryAllowed: false, errorCode: null });
    expect(html).toContain('room_1');
    expect(html).toContain('Signed in as person@example.com');
  });
});

describe('JoinScreen error states', () => {
  test('expired/revoked/wrong_account announce once via role="alert" and never show room content', () => {
    for (const phase of ['expired', 'revoked', 'wrong_account'] as const) {
      const html = render({ phase, email: 'person@example.com', roomId: null, retryAllowed: false, errorCode: null });
      expect((html.match(/role="alert"/g) ?? []).length).toBe(1);
      expect(html).not.toContain('room_');
      expect(html).not.toContain('<button');
    }
  });

  test('an unrecoverable outcome (AE1: revoked after callback) exposes no retry and no room content', () => {
    const html = render({ phase: 'revoked', email: 'person@example.com', roomId: null, retryAllowed: false, errorCode: null });
    expect(html).not.toContain('Try again');
    expect(html).not.toContain('room_');
  });

  test('a retryable unavailable state renders one focusable recovery action', () => {
    const html = render({ phase: 'unavailable', email: null, roomId: null, retryAllowed: true, errorCode: 'device_unavailable' });
    expect(html).toContain('Try again');
    expect(html).toMatch(/<button[^>]*autofocus/i);
  });

  test('a non-retryable unavailable state (bad link) renders no recovery action', () => {
    const html = render({ phase: 'unavailable', email: null, roomId: null, retryAllowed: false, errorCode: 'invalid_location' });
    expect(html).not.toContain('Try again');
    expect(html).not.toContain('<button');
  });
});
