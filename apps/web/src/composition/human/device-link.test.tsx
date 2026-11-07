import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CryptoEvent, VerificationPhase, VerificationRequestEvent, VerifierEvent, type VerificationRequest } from 'matrix-js-sdk/lib/crypto-api';
import { createDeviceLink, DeviceLinkPrompt, type LinkCrypto } from './device-link';

function setup(verified = false) {
  const client = Object.assign(new EventEmitter(), { getUserId: () => '@me:test', getDeviceId: () => 'NEW' });
  const crypto = {
    requestOwnUserVerification: vi.fn(),
    getKeyBackupInfo: vi.fn(async () => null),
    resetKeyBackup: vi.fn(async () => {}),
    checkKeyBackupAndEnable: vi.fn(async () => null),
    restoreKeyBackup: vi.fn(async () => ({ total: 0, imported: 0 })),
    getDeviceVerificationStatus: vi.fn(async () => ({ crossSigningVerified: verified })),
    pushSecretToVerifiedDevices: vi.fn<(name: string) => Promise<void>>(async () => {}),
  };
  return { client, crypto: crypto as unknown as LinkCrypto & typeof crypto };
}

function request(initiatedByMe: boolean) {
  const verifier = Object.assign(new EventEmitter(), { verify: vi.fn(() => new Promise<void>(() => {})) });
  const req = Object.assign(new EventEmitter(), {
    isSelfVerification: true, initiatedByMe, phase: VerificationPhase.Requested, verifier: undefined as unknown,
    accept: vi.fn(async () => { req.phase = VerificationPhase.Started; req.verifier = verifier; req.emit(VerificationRequestEvent.Change); }),
    startVerification: vi.fn(async () => { req.verifier = verifier; return verifier; }),
    cancel: vi.fn(async () => {}),
  });
  return { req, verifier, asRequest: req as unknown as VerificationRequest };
}

const sas = { sas: { emoji: [['🐶', 'Dog'], ['🔑', 'Key']] }, confirm: vi.fn(async () => {}), mismatch: vi.fn(), cancel: vi.fn() };

describe('device approval (#1420)', () => {
  it('starts the encrypted backup on the device that holds the signing keys', async () => {
    const { client, crypto } = setup();
    const link = await createDeviceLink(client as never, crypto, 'bootstrapped');
    expect(crypto.resetKeyBackup).toHaveBeenCalledOnce();
    expect(link.state().kind).toBe('idle');
  });
  it('keeps an existing backup', async () => {
    const { client, crypto } = setup();
    crypto.getKeyBackupInfo.mockResolvedValueOnce({ version: '1' } as never);
    await createDeviceLink(client as never, crypto, 'present');
    expect(crypto.resetKeyBackup).not.toHaveBeenCalled();
  });
  it.each([[false, 'locked'], [true, 'idle']])('a later device (cross-signed: %s) starts %s', async (verified, kind) => {
    const { client, crypto } = setup(verified);
    expect((await createDeviceLink(client as never, crypto, 'foreign')).state().kind).toBe(kind);
    expect(crypto.resetKeyBackup).not.toHaveBeenCalled();
  });

  it('a locked device asks for approval, starts SAS when ready and shows the emoji', async () => {
    const { client, crypto } = setup();
    const { req, verifier, asRequest } = request(true);
    crypto.requestOwnUserVerification.mockResolvedValue(asRequest);
    const link = await createDeviceLink(client as never, crypto, 'foreign');
    link.unlock();
    expect(link.state().kind).toBe('waiting');
    await vi.waitFor(() => expect(crypto.requestOwnUserVerification).toHaveBeenCalledOnce());
    req.phase = VerificationPhase.Ready; req.emit(VerificationRequestEvent.Change);
    await vi.waitFor(() => expect(req.startVerification).toHaveBeenCalledWith('m.sas.v1'));
    await vi.waitFor(() => expect(verifier.verify).toHaveBeenCalled());
    verifier.emit(VerifierEvent.ShowSas, sas);
    expect(link.state()).toEqual({ kind: 'compare', sas });
    const html = renderToStaticMarkup(<DeviceLinkPrompt link={link} />);
    expect(html).toContain('Dog');
    expect(html).toContain('They match');
  });

  it('an approving device pushes the backup and signing keys once verified', async () => {
    const { client, crypto } = setup();
    const { verifier, asRequest } = request(false);
    let finish!: () => void;
    verifier.verify.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const link = await createDeviceLink(client as never, crypto, 'present');
    client.emit(CryptoEvent.VerificationRequestReceived, asRequest);
    expect(link.state().kind).toBe('incoming');
    link.approve();
    await vi.waitFor(() => expect(verifier.verify).toHaveBeenCalled());
    finish();
    await vi.waitFor(() => expect(link.state()).toEqual({ kind: 'linked', approver: true }));
    expect(crypto.pushSecretToVerifiedDevices.mock.calls.map(call => call[0]))
      .toEqual(['m.megolm_backup.v1', 'm.cross_signing.master', 'm.cross_signing.self_signing', 'm.cross_signing.user_signing']);
  });

  it('ignores requests from other users and its own requests', async () => {
    const { client, crypto } = setup();
    const link = await createDeviceLink(client as never, crypto, 'present');
    client.emit(CryptoEvent.VerificationRequestReceived, { ...request(false).req, isSelfVerification: false });
    client.emit(CryptoEvent.VerificationRequestReceived, request(true).asRequest);
    expect(link.state().kind).toBe('idle');
  });

  it('clears the prompt when another device answers first', async () => {
    const { client, crypto } = setup();
    const { req, asRequest } = request(false);
    const link = await createDeviceLink(client as never, crypto, 'present');
    client.emit(CryptoEvent.VerificationRequestReceived, asRequest);
    req.phase = VerificationPhase.Cancelled; req.emit(VerificationRequestEvent.Change);
    await vi.waitFor(() => expect(link.state().kind).toBe('idle'));
  });

  it('restores the backup when its key arrives', async () => {
    const { client, crypto } = setup();
    await createDeviceLink(client as never, crypto, 'foreign');
    client.emit(CryptoEvent.KeyBackupDecryptionKeyCached, '1');
    await vi.waitFor(() => expect(crypto.restoreKeyBackup).toHaveBeenCalledOnce());
  });
});
