import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AdmissionPort, DevicePort, IdentityPort, RoomId, RoomPort, RoomSummary, SendState } from '@khala/contracts/messaging';
import { ok } from '@khala/contracts/messaging';
import { CreateChatScreen } from '../CreateChatScreen';
import type { CreateChatPorts } from '../ports';

/**
 * Synthetic ports for the browser harness only. No real Matrix credentials,
 * network calls or decrypted content: every response is fabricated in-memory.
 */
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const ROOM_ID = 'room_harness' as RoomId;
const ROOM: RoomSummary = { roomId: ROOM_ID, title: null, membership: 'joined', revision: 'rev_1' };

function accepted(clientTxnId: string): SendState {
  return {
    clientTxnId,
    state: 'accepted',
    eventRef: {
      v: 1,
      roomId: ROOM_ID,
      eventId: `event_${clientTxnId}` as never,
      authorParticipantId: 'participant_harness' as never,
      authorDeviceId: 'device_harness' as never,
      contentDigest: `sha256:${'a'.repeat(64)}`,
    },
  };
}

const identity: IdentityPort = {
  current: async () => ({
    kind: 'signed_in',
    principal: {
      v: 1,
      ownerId: 'owner_harness' as never,
      providerIssuer: 'https://example.test',
      providerSubject: 'harness-subject',
      verifiedEmail: 'harness@example.test',
      sessionExpiresAt: '2099-01-01T00:00:00Z',
    },
  }),
  beginSignIn: async () => ok({ kind: 'navigate', url: '/sign-in' }),
  signOut: async () => ok(null),
};

const device: DevicePort = {
  ensureReady: async () => ok({ deviceId: 'device_harness' as never, state: 'ready', generation: 1, reason: null }),
  current: () => ({ deviceId: 'device_harness' as never, state: 'ready', generation: 1, reason: null }),
  observe: () => () => {},
  stop: async () => {},
};

const room: RoomPort = {
  create: async () => {
    await delay(200);
    return ok(ROOM);
  },
  prepareIntro: async input => {
    await delay(200);
    return ok(input.messages.map((_message, index) => accepted(`t${index}`)));
  },
  resumeIntro: async () => ok([]),
  send: async () => {
    throw new Error('not used by this harness');
  },
  timeline: async () => {
    throw new Error('not used by this harness');
  },
  observe: () => () => {},
};

const admission: AdmissionPort = {
  share: async () => {
    await delay(200);
    return ok({ inviteRef: 'invite_harness', shareUrl: 'https://khala.aiur.team/i/harness', expiresAt: null });
  },
  inspect: async () => 'eligible',
  admit: async () => {
    throw new Error('not used by this harness');
  },
};

const signedInPorts: CreateChatPorts = { identity, device, room, admission };

const signedOutPorts: CreateChatPorts = {
  identity: { ...identity, current: async () => ({ kind: 'signed_out' }) },
  device,
  room,
  admission,
};

function logCopy(text: string) {
  const log = document.getElementById('copy-log')!;
  log.textContent = text;
}

const startSignedOut = new URLSearchParams(window.location.search).get('mode') === 'signed-out';

function Harness() {
  const [signedIn, setSignedIn] = useState(!startSignedOut);
  return (
    <>
      <button type="button" onClick={() => setSignedIn(false)}>
        Simulate sign-out
      </button>
      <CreateChatScreen
        ports={signedIn ? signedInPorts : signedOutPorts}
        onCopyShareLink={async shareUrl => {
          logCopy(shareUrl);
          return { ok: true };
        }}
      />
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
