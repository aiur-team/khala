import { createHash } from 'node:crypto';
import type { AgentJoinView } from '@khala/contracts/m1/agent-join';
import { agentOwnerRecordKey, type AgentOwnerRecord } from '@khala/contracts/m1/participants';
import { defaultAgentName, suggestUsername } from '@khala/contracts/m1/names';
import { decodeProfileRecord, profileRecordKey } from '@khala/contracts/m1/profile';
import type { AuthPrincipal, ControlStore, OwnerId, RoomId } from '@khala/contracts/messaging/index';
import type { AuthService } from '../auth/index';
import type { GatewayInspection } from '../invitations/index';
import { safeRead, writeAndResolve } from '../invitations/internal';
import { allocateAgentName, indexOwnerAgent, retainAgentName } from './names';
import type { AgentProvisioner } from './provision';
import { createJoinStore, effectiveState, isJoinId, sealCredentials, type JoinRecord } from './store';

export const AGENT_JOIN_HUMAN_VIEW_PATH = '/api/human/agent-join';
export const AGENT_JOIN_HUMAN_CONFIRM_PATH = '/api/human/agent-join/confirm';
export const AGENT_JOIN_HUMAN_STATUS_PATH = '/api/human/agent-join/status';
export type AgentJoinHumanDeps = Readonly<{
  auth: Pick<AuthService, 'authenticateRequest' | 'requireHumanMutation'>;
  joins: ReturnType<typeof createJoinStore>; store: ControlStore; clock: () => number;
  random: (bytes: number) => Uint8Array; sealSecret: string;
  inspectMembership(ownerId: OwnerId, roomId: RoomId): Promise<GatewayInspection>;
  provisioner: AgentProvisioner;
}>;
const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: {
  'cache-control': 'no-store', 'content-type': 'application/json', 'x-content-type-options': 'nosniff',
} });
const error = (status: number, code: string) => json(status, { error: code });
const unavailable = () => error(503, 'unavailable');

export function createAgentJoinHumanHandlers(deps: AgentJoinHumanDeps) {
  async function usernameOf(principal: AuthPrincipal): Promise<string | null> {
    const read = await safeRead(deps.store, profileRecordKey(principal.ownerId));
    if (read.kind === 'unavailable') return null;
    if (read.kind === 'absent') return suggestUsername(principal.verifiedEmail);
    const decoded = decodeProfileRecord(read.record.value);
    return decoded.ok && decoded.value.ownerId === principal.ownerId ? decoded.value.username : null;
  }
  function viewOf(record: JoinRecord): AgentJoinView {
    const state = effectiveState(record, deps.clock());
    return { joinId: record.joinId, label: record.label, harness: record.harness, channelName: record.channelName,
      roomId: record.roomId, state: state === 'claimed' ? 'confirmed' : state,
      ...(record.agentUserId ? { agentUserId: record.agentUserId } : {}),
    };
  }
  async function membership(principal: AuthPrincipal, record: JoinRecord): Promise<Response | null> {
    const result = await deps.inspectMembership(principal.ownerId, record.roomId as RoomId);
    return result.kind === 'joined' ? null : result.kind === 'absent' ? error(403, 'not_member') : unavailable();
  }
  async function confirm(joinId: string, principal: AuthPrincipal): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const read = await deps.joins.read(joinId);
      if (read.kind !== 'found') return read.kind === 'absent' ? error(404, 'not_found') : unavailable();
      let { record, revision } = read;
      if (effectiveState(record, deps.clock()) === 'expired') return error(404, 'not_found');
      const denied = await membership(principal, record);
      if (denied) return denied;
      if (record.ownerId && record.ownerId !== principal.ownerId) return error(409, 'already_confirmed_by_other');
      if (record.state === 'confirmed' || record.state === 'claimed' || record.state === 'ready') {
        return json(200, viewOf(record));
      }
      if (!record.ownerId) {
        const locked = { ...record, ownerId: principal.ownerId };
        const result = await deps.joins.replace(joinId, revision, locked, 'owner');
        if (result.kind === 'conflict') continue;
        if (result.kind !== 'applied') return unavailable();
        record = locked; revision = result.revision;
      }
      const username = await usernameOf(principal);
      if (!username) return unavailable();
      const userId = deps.provisioner.agentUserId(joinId, principal.ownerId);
      const name = record.agentUserId === userId ? record.label : await allocateAgentName(deps.store, { ownerId: principal.ownerId, matrixUserId: userId, username, harness: record.harness, expiresAt: record.expiresAt });
      if (!name) return unavailable();
      const provisioned = await deps.provisioner.provision({ joinId, ownerId: principal.ownerId, label: name, roomId: record.roomId });
      if (provisioned.kind !== 'ok') return unavailable();
      const { credentials } = provisioned;
      if (credentials.userId !== userId) return unavailable();
      const owner: AgentOwnerRecord = { matrixUserId: credentials.userId, ownerId: principal.ownerId,
        ownerLabel: username, harness: record.harness, label: name, createdAt: new Date(deps.clock()).toISOString() };
      const mapped = await writeAndResolve(deps.store, { key: agentOwnerRecordKey(credentials.userId), expectedRevision: null,
        operationId: `agents.${createHash('sha256').update(credentials.userId).digest('hex')}.create.${Buffer.from(deps.random(8)).toString('hex')}`,
        next: { value: owner, expiresAt: null },
      });
      if (mapped.kind !== 'applied' && !(mapped.kind === 'conflict' && mapped.current?.value.ownerId === principal.ownerId)) return unavailable();
      if (effectiveState(record, deps.clock()) === 'expired') return error(404, 'not_found');
      // Persist the cleanup pointer before making the claim permanent. A failed final
      // confirmation (including a process crash) remains a pending, expirable join.
      const staged: JoinRecord = { ...record, label: name, agentUserId: userId };
      let stagedResult = await deps.joins.replace(joinId, revision, staged, 'name');
      if (stagedResult.kind === 'conflict') {
        const latest = await deps.joins.read(joinId);
        if (latest.kind !== 'found' || latest.record.ownerId !== principal.ownerId) return unavailable();
        if (['confirmed', 'claimed', 'ready'].includes(latest.record.state)) return json(200, viewOf(latest.record));
        if (latest.record.state !== 'pending' || effectiveState(latest.record, deps.clock()) === 'expired') return error(404, 'not_found');
        if (latest.record.agentUserId === userId && latest.record.label === name) stagedResult = { kind: 'applied', revision: latest.revision };
        else stagedResult = await deps.joins.replace(joinId, latest.revision, staged, 'name');
      }
      if (stagedResult.kind !== 'applied') return unavailable();
      record = staged; revision = stagedResult.revision;
      if (effectiveState(record, deps.clock()) === 'expired') { await deps.joins.read(joinId); return error(404, 'not_found'); }
      if (!await retainAgentName(deps.store, name, principal.ownerId, userId)) return unavailable();
      if (effectiveState(record, deps.clock()) === 'expired') { await deps.joins.read(joinId); return error(404, 'not_found'); }
      const next: JoinRecord = { ...record, label: name, ownerId: principal.ownerId, state: 'confirmed', agentUserId: credentials.userId,
        sealedCredentials: sealCredentials(deps.sealSecret, joinId, credentials) };
      const result = await deps.joins.replace(joinId, revision, next, 'confirm');
      if (result.kind === 'applied') {
        await indexOwnerAgent(deps.store, principal.ownerId, userId);
        return json(200, viewOf(next));
      }
      if (result.kind === 'conflict') {
        const latest = await deps.joins.read(joinId);
        if (latest.kind === 'found' && latest.record.ownerId === principal.ownerId
          && ['confirmed', 'claimed', 'ready'].includes(latest.record.state)) {
          await indexOwnerAgent(deps.store, principal.ownerId, userId);
          return json(200, viewOf(latest.record));
        }
      }
      return unavailable();
    }
    return unavailable();
  }
  const handler = (mutation: boolean) => async (request: Request): Promise<Response> => {
    try {
      if (request.method !== (mutation ? 'POST' : 'GET')) return error(405, 'method_not_allowed');
      let principal: AuthPrincipal;
      if (mutation) {
        const auth = await deps.auth.requireHumanMutation(request);
        if (auth.kind === 'unavailable') return unavailable();
        if (auth.kind === 'rejected') return error(auth.code === 'signed_out' ? 401 : auth.code === 'not_a_mutation' ? 405 : 403,
          auth.code === 'not_a_mutation' ? 'method_not_allowed' : auth.code);
        principal = auth.context.principal;
      } else {
        const auth = await deps.auth.authenticateRequest(request);
        if (auth.kind !== 'authenticated') return auth.kind === 'signed_out' ? error(401, 'signed_out') : unavailable();
        principal = auth.context.principal;
      }
      const params = new URL(request.url).searchParams;
      const keys = [...params.keys()], joinId = params.get('joinId');
      if (keys.length !== 1 || keys[0] !== 'joinId' || !isJoinId(joinId)) return error(404, 'not_found');
      if (mutation) return await confirm(joinId, principal);
      const read = await deps.joins.read(joinId);
      if (read.kind !== 'found') return read.kind === 'absent' ? error(404, 'not_found') : unavailable();
      const denied = await membership(principal, read.record);
      if (denied) return denied;
      const view = viewOf(read.record);
      if (view.state === 'pending') {
        const username = await usernameOf(principal);
        if (!username) return unavailable();
        view.label = defaultAgentName(username, read.record.harness);
      }
      return json(200, view);
    } catch { return unavailable(); }
  };
  return { view: handler(false), confirm: handler(true), status: handler(false) };
}
