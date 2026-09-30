import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ParticipantId } from '@khala/contracts/messaging/index';
import type { ResolvedAgentParticipant } from '../composition/agent/participant-directory';
import type { ConnectorDevicePort, MatrixDeviceSession } from '@khala/connector/bootstrap/ports';
import { openMatrixConnectorSubstrate, type MatrixConnectorSubstrate } from './matrix';

/** Endpoint-owned credential file, outside the hosted control plane and the crypto profile. */
export function createMatrixBootstrapDevice(input: Readonly<{
  stateDirectory: string;
  profileDirectory: string;
  chromiumExecutablePath?: string;
  browserBundleDirectory?: string;
  browserDriverDirectory?: string;
  open?: typeof openMatrixConnectorSubstrate;
  resolveParticipants?: (userIds: readonly string[], targetParticipantIds: readonly string[]) => Promise<ReadonlyMap<string, ResolvedAgentParticipant> | null>;
  onText?: Parameters<typeof openMatrixConnectorSubstrate>[0]['onText'];
  onCurrentNames?: Parameters<typeof openMatrixConnectorSubstrate>[0]['onCurrentNames'];
  onRename?: Parameters<typeof openMatrixConnectorSubstrate>[0]['onRename'];
}>): Readonly<{
  devices: ConnectorDevicePort;
  fingerprint(): string | null;
  substrate(): MatrixConnectorSubstrate | null;
  close(): Promise<void>;
}> {
  const credentialPath = path.join(input.stateDirectory, 'matrix-session.json');
  const reservationPath = path.join(input.stateDirectory, 'matrix-reservation.json');
  let substrate: MatrixConnectorSubstrate | null = null;
  let currentSession: MatrixDeviceSession | null = null;
  let reservation: Readonly<{ operationId: string; deviceId: string }> | null = null;
  const open = input.open ?? openMatrixConnectorSubstrate;

  async function readJson(file: string): Promise<unknown | null> {
    try { return JSON.parse(await readFile(file, 'utf8')) as unknown; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async function saveOnce(file: string, value: unknown): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      // Never replace a prior credential or reservation on retry or restart.
      await link(temporary, file);
    } finally { await rm(temporary, { force: true }); }
  }
  async function reserved(operationId: string): Promise<Readonly<{ operationId: string; deviceId: string }>> {
    if (reservation !== null) {
      if (reservation.operationId !== operationId) throw new Error('matrix_reservation_conflict');
      return reservation;
    }
    const current = await readJson(reservationPath);
    if (current !== null) {
      if (typeof current !== 'object' || current === null || !('operationId' in current) || !('deviceId' in current)
        || current.operationId !== operationId || typeof current.deviceId !== 'string') throw new Error('matrix_reservation_conflict');
      reservation = current as { operationId: string; deviceId: string };
      return reservation;
    }
    const candidate = { operationId, deviceId: `KHALA_${randomBytes(16).toString('hex')}` };
    await saveOnce(reservationPath, candidate).catch(async error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    reservation = null;
    return reserved(operationId);
  }
  async function ready(provided?: MatrixDeviceSession): Promise<MatrixConnectorSubstrate> {
    if (substrate) {
      if (provided && JSON.stringify(provided) !== JSON.stringify(currentSession)) throw new Error('matrix_session_changed');
      return substrate;
    }
    const persisted = await readJson(credentialPath);
    if (persisted !== null && JSON.stringify(persisted) !== JSON.stringify(provided ?? persisted)) throw new Error('matrix_session_changed');
    const candidate = (persisted ?? provided) as MatrixDeviceSession | null;
    if (!candidate || typeof candidate.accessToken !== 'string' || candidate.accessToken.length < 16
      || typeof candidate.roomId !== 'string' || typeof candidate.ownerUserId !== 'string'
      || typeof candidate.ownerParticipantId !== 'string' || typeof candidate.userId !== 'string'
      || typeof candidate.deviceId !== 'string') throw new Error('matrix_session_missing');
    if (persisted === null) {
      await saveOnce(credentialPath, candidate);
    }
    await mkdir(input.profileDirectory, { recursive: true, mode: 0o700 });
    const agentParticipantId = `agent_${createHash('sha256').update(candidate.userId).digest('hex').slice(0, 40)}` as ParticipantId;
    substrate = await open({
      baseUrl: candidate.baseUrl, userId: candidate.userId, deviceId: candidate.deviceId,
      accessToken: candidate.accessToken, roomId: candidate.roomId,
      profileDirectory: input.profileDirectory,
      participantIdFor: userId => userId === candidate.userId ? agentParticipantId
        : userId === candidate.ownerUserId ? candidate.ownerParticipantId as ParticipantId : null,
      ...(input.resolveParticipants ? { resolveParticipants: input.resolveParticipants } : {}),
      ...(input.onText ? { onText: input.onText } : {}),
      ...(input.onCurrentNames ? { onCurrentNames: input.onCurrentNames } : {}),
      ...(input.onRename ? { onRename: input.onRename } : {}),
      ...(input.chromiumExecutablePath ? { chromiumExecutablePath: input.chromiumExecutablePath } : {}),
      ...(input.browserBundleDirectory ? { browserBundleDirectory: input.browserBundleDirectory } : {}),
      ...(input.browserDriverDirectory ? { browserDriverDirectory: input.browserDriverDirectory } : {}),
    });
    currentSession = candidate;
    return substrate;
  }
  return {
    devices: {
      async reserve(operationId) {
        try {
          const value = await reserved(operationId);
          return { kind: 'reserved', deviceId: value.deviceId };
        } catch { return { kind: 'unavailable' }; }
      },
      async activate(activation) {
        try {
          const fixed = await reserved(activation.operationId);
          if (fixed.deviceId !== activation.deviceId || activation.binding.deviceId !== fixed.deviceId
            || (activation.matrixSession && activation.matrixSession.deviceId !== fixed.deviceId)) return { kind: 'failed', reason: 'capability_rejected' };
          const active = await ready(activation.matrixSession);
          const inner = await active.devices.reserve(activation.operationId);
          if (inner.kind !== 'reserved' || inner.deviceId !== fixed.deviceId) return { kind: 'failed', reason: 'initialization_failed' };
          return active.devices.activate(activation);
        } catch { return { kind: 'failed', reason: 'initialization_failed' }; }
      },
      async status(deviceId) {
        try {
          const fixed = reservation ?? (await readJson(reservationPath)) as { operationId: string; deviceId: string } | null;
          if (!fixed || fixed.deviceId !== deviceId) return 'missing';
          const active = await ready();
          return active.devices.status(deviceId);
        } catch { return 'unavailable'; }
      },
    },
    fingerprint: () => substrate?.fingerprint ?? null,
    substrate: () => substrate,
    async close() { await substrate?.close(); substrate = null; currentSession = null; },
  };
}
