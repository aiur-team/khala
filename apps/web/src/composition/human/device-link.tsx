// Device approval (#1420): a new device of the same human reads earlier history once another of their
// devices approves it by emoji comparison (Matrix self-verification). The approving device cross-signs it
// and pushes the key-backup key (and its cross-signing keys) over Olm; the new device then restores the
// server-side key backup, which the server holds only encrypted. No recovery key, no escrow (P14 revised).

import { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import type { MatrixClient } from 'matrix-js-sdk';
import {
  CryptoEvent,
  VerificationPhase,
  VerificationRequestEvent,
  VerifierEvent,
  type CryptoApi,
  type ShowSasCallbacks,
  type VerificationRequest,
  type Verifier,
} from 'matrix-js-sdk/lib/crypto-api';
import './device-link.css';

export type DeviceLinkState =
  | { kind: 'idle' }
  | { kind: 'locked' }
  | { kind: 'waiting' }
  | { kind: 'incoming'; request: VerificationRequest }
  | { kind: 'compare'; sas: ShowSasCallbacks }
  | { kind: 'linked'; approver: boolean }
  | { kind: 'failed' };

/** `pushSecretToVerifiedDevices` is public on the rust backend `getCrypto()` returns, though not on `CryptoApi`. */
export type LinkCrypto = Pick<CryptoApi, 'requestOwnUserVerification' | 'getKeyBackupInfo' | 'resetKeyBackup'
  | 'checkKeyBackupAndEnable' | 'restoreKeyBackup' | 'getDeviceVerificationStatus'>
  & { pushSecretToVerifiedDevices(name: string): Promise<void> };
type LinkClient = Pick<MatrixClient, 'on' | 'off' | 'getUserId' | 'getDeviceId'>;
export type CrossSigningResult = 'present' | 'foreign' | 'bootstrapped' | 'failed';

/** What an approving device hands over. The backup key unlocks history; the signing keys let this device approve others. */
const SECRETS = ['m.megolm_backup.v1', 'm.cross_signing.master', 'm.cross_signing.self_signing', 'm.cross_signing.user_signing'];

function until(request: VerificationRequest, done: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (request.phase === VerificationPhase.Cancelled) { stop(); reject(new Error('verification cancelled')); }
      else if (done()) { stop(); resolve(); }
    };
    const stop = () => { request.off(VerificationRequestEvent.Change, check); };
    request.on(VerificationRequestEvent.Change, check);
    check();
  });
}

async function sasVerifier(request: VerificationRequest, approver: boolean): Promise<Verifier> {
  if (approver) {
    await request.accept();
    await until(request, () => request.verifier !== undefined);
    return request.verifier!;
  }
  // Only the requester starts SAS, so the two devices never race to start.
  await until(request, () => request.phase === VerificationPhase.Ready || request.verifier !== undefined);
  return request.verifier ?? await request.startVerification('m.sas.v1');
}

export type DeviceLink = Readonly<{
  state(): DeviceLinkState;
  subscribe(listener: () => void): () => void;
  unlock(): void;
  approve(): void;
  dismiss(): void;
  dispose(): void;
}>;

export async function createDeviceLink(client: LinkClient, crypto: LinkCrypto, crossSigning: CrossSigningResult): Promise<DeviceLink> {
  let state: DeviceLinkState = { kind: 'idle' };
  let pending: VerificationRequest | null = null;
  const listeners = new Set<() => void>();
  const set = (next: DeviceLinkState) => { state = next; for (const listener of listeners) listener(); };
  const userId = client.getUserId(), deviceId = client.getDeviceId();

  async function verify(request: VerificationRequest, approver: boolean) {
    pending = request;
    try {
      const verifier = await sasVerifier(request, approver);
      verifier.on(VerifierEvent.ShowSas, sas => set({ kind: 'compare', sas }));
      await verifier.verify();
      if (approver) for (const name of SECRETS) await crypto.pushSecretToVerifiedDevices(name).catch(() => undefined);
      set({ kind: 'linked', approver });
    } catch {
      set(approver ? { kind: 'idle' } : { kind: 'failed' });
    } finally { pending = null; }
  }

  const received = (request: VerificationRequest) => {
    if (!request.isSelfVerification || request.initiatedByMe || pending) return;
    set({ kind: 'incoming', request });
    // Another of this human's devices may answer first; then this prompt goes away.
    void until(request, () => request.phase !== VerificationPhase.Requested).catch(() => undefined).then(() => {
      if (state.kind === 'incoming' && state.request === request) set({ kind: 'idle' });
    });
  };
  // A later device restores the backup once an approving device sends its key.
  const restore = () => { void crypto.checkKeyBackupAndEnable().then(() => crypto.restoreKeyBackup()).catch(() => undefined); };
  client.on(CryptoEvent.VerificationRequestReceived, received);
  client.on(CryptoEvent.KeyBackupDecryptionKeyCached, restore);

  if (crossSigning === 'present' || crossSigning === 'bootstrapped') {
    // The device holding the signing keys starts the encrypted backup that later devices restore.
    await crypto.getKeyBackupInfo().then(info => info ? undefined : crypto.resetKeyBackup()).catch(() => undefined);
  } else if (crossSigning === 'foreign' && userId && deviceId) {
    const status = await crypto.getDeviceVerificationStatus(userId, deviceId).catch(() => null);
    if (status && !status.crossSigningVerified) set({ kind: 'locked' });
  }

  return {
    state: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    unlock() {
      if (pending) return;
      set({ kind: 'waiting' });
      void crypto.requestOwnUserVerification().then(request => verify(request, false), () => set({ kind: 'failed' }));
    },
    approve() {
      if (state.kind === 'incoming') void verify(state.request, true);
    },
    dismiss() {
      if (state.kind === 'compare') state.sas.mismatch();
      else if (state.kind === 'incoming' || state.kind === 'waiting') (pending ?? (state.kind === 'incoming' ? state.request : null))?.cancel().catch(() => undefined);
      set(state.kind === 'waiting' || state.kind === 'failed' ? { kind: 'locked' } : { kind: 'idle' });
    },
    dispose() {
      client.off(CryptoEvent.VerificationRequestReceived, received);
      client.off(CryptoEvent.KeyBackupDecryptionKeyCached, restore);
      listeners.clear();
    },
  };
}

export function DeviceLinkPrompt({ link }: Readonly<{ link: DeviceLink }>) {
  const state = useSyncExternalStore(link.subscribe, link.state, link.state);
  if (state.kind === 'idle') return null;
  const body = (() => {
    switch (state.kind) {
      case 'locked': return <>
        <p className="kh-devlink-p">Earlier messages are locked on this device.</p>
        <button type="button" className="kh-btn pri" onClick={link.unlock}>Unlock with another device</button>
        <button type="button" className="kh-btn" onClick={link.dismiss}>Not now</button>
      </>;
      case 'waiting': return <>
        <p className="kh-devlink-p">Open Khala on a device you already use, and approve this one there.</p>
        <button type="button" className="kh-btn" onClick={link.dismiss}>Cancel</button>
      </>;
      case 'incoming': return <>
        <p className="kh-devlink-p">A new device signed in as you wants to read your earlier messages. Approve it only if it is yours.</p>
        <button type="button" className="kh-btn pri" onClick={link.approve}>Approve</button>
        <button type="button" className="kh-btn" onClick={link.dismiss}>Not mine</button>
      </>;
      case 'compare': return <>
        <p className="kh-devlink-p">Check that both devices show these emoji, in this order.</p>
        <ol className="kh-devlink-emoji" aria-label="Emoji">
          {(state.sas.sas.emoji ?? []).map(([emoji, name], index) => <li key={index}><span aria-hidden="true">{emoji}</span>{name}</li>)}
        </ol>
        <button type="button" className="kh-btn pri" onClick={() => { void state.sas.confirm(); }}>They match</button>
        <button type="button" className="kh-btn" onClick={link.dismiss}>They don't match</button>
      </>;
      case 'linked': return <>
        <p className="kh-devlink-p">{state.approver ? 'Device approved.' : 'Device approved. Earlier messages are unlocking.'}</p>
        <button type="button" className="kh-btn" onClick={link.dismiss}>Done</button>
      </>;
      case 'failed': return <>
        <p className="kh-devlink-p">Couldn't unlock this device.</p>
        <button type="button" className="kh-btn pri" onClick={link.unlock}>Try again</button>
        <button type="button" className="kh-btn" onClick={link.dismiss}>Close</button>
      </>;
    }
  })();
  return <section className="kh-devlink" role="dialog" aria-label="Device approval">{body}</section>;
}

/** Starts device approval for this signed-in device and shows its prompt over the app. */
export async function startDeviceLink(client: LinkClient, crypto: LinkCrypto, crossSigning: CrossSigningResult): Promise<() => void> {
  const link = await createDeviceLink(client, crypto, crossSigning);
  const host = document.createElement('div');
  // Inside the content root, so the theme tokens and button styles apply.
  (document.querySelector('.khala-content-root') ?? document.body).append(host);
  const root = createRoot(host);
  root.render(<DeviceLinkPrompt link={link} />);
  return () => { link.dispose(); root.unmount(); host.remove(); };
}
