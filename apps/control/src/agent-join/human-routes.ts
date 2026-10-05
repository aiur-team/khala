import { rejoinIdentity, rejoinApprovalKey, validRejoinApproval, type RejoinApproval } from './rejoin';
import { readRoomRemovals } from '../invitations/removals';
import { rememberAgentSession, rememberRoomAgent } from './session-status';
import { createHash } from 'node:crypto';
import type { AgentJoinView } from '@khala/contracts/m1/agent-join';
import { agentOwnerRecordKey, decodeAgentOwnerRecord, type AgentOwnerRecord } from '@khala/contracts/m1/participants';
import { freeAgentName } from '@khala/contracts/m1/channel-names';
import { suggestUsername } from '@khala/contracts/m1/names';
import { decodeProfileRecord, profileRecordKey } from '@khala/contracts/m1/profile';
import type { AuthPrincipal, ControlStore, OwnerId, RoomId } from '@khala/contracts/messaging/index';
import type { AuthService } from '../auth/index';
import type { GatewayInspection } from '../invitations/index';
import { safeRead, writeAndResolve } from '../invitations/internal';
import { indexOwnerAgent } from './names';
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
  /** The display names the channel's joined members hold there, read as `ownerId`; `null` when unavailable. */
  roomMemberNames(ownerId: OwnerId, roomId: RoomId): Promise<readonly string[] | null>;
  provisioner: AgentProvisioner;
  revokeAgentSession?: (userId: string, roomId: RoomId) => Promise<boolean>;
}>;
const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: {
  'cache-control': 'no-store', 'content-type': 'application/json', 'x-content-type-options': 'nosniff',
} });
const error = (status: number, code: string) => json(status, { error: code });
const unavailable = () => error(503, 'unavailable');

export function createAgentJoinHumanHandlers(deps: AgentJoinHumanDeps) {
  async function usernameOf(principal: Pick<AuthPrincipal, 'ownerId' | 'verifiedEmail'>, fallbackUsername?: string): Promise<string | null> {
    const read = await safeRead(deps.store, profileRecordKey(principal.ownerId));
    if (read.kind === 'unavailable') return null;
    if (read.kind === 'absent') return fallbackUsername ?? suggestUsername(principal.verifiedEmail);
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
  async function membership(principal: Pick<AuthPrincipal, 'ownerId'>, record: JoinRecord): Promise<Response | null> {
    const result = await deps.inspectMembership(principal.ownerId, record.roomId as RoomId);
    return result.kind === 'joined' ? null : result.kind === 'absent' ? error(403, 'not_member') : unavailable();
  }
  async function confirm(joinId: string, principal: Pick<AuthPrincipal, 'ownerId' | 'verifiedEmail'>, approvedUsername?: string): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const read = await deps.joins.read(joinId);
      if (read.kind !== 'found') return read.kind === 'absent' ? error(404, 'not_found') : unavailable();
      let { record, revision } = read;
      if (effectiveState(record, deps.clock()) === 'expired') return error(404, 'not_found');
      const denied = await membership(principal, record);
      if (denied) return denied;
      if (record.ownerId && record.ownerId !== principal.ownerId) return error(409, 'already_confirmed_by_other');
      if (record.state === 'confirmed' || record.state === 'claimed' || record.state === 'ready') {
        if (record.rejoinApproval && !await rememberApproval(record, record.rejoinApproval.ownerLabel, record.rejoinApproval.generation, true)) return unavailable();
        return json(200, viewOf(record));
      }
      if (!record.ownerId) {
        const locked = { ...record, ownerId: principal.ownerId };
        const result = await deps.joins.replace(joinId, revision, locked, 'owner');
        if (result.kind === 'conflict') continue;
        if (result.kind !== 'applied') return unavailable();
        record = locked; revision = result.revision;
      }
      const username = await usernameOf(principal, approvedUsername);
      if (!username) return unavailable();
      const identityId = rejoinIdentity(record) ?? joinId;
      const userId = deps.provisioner.agentUserId(identityId, principal.ownerId);
      const existing = await safeRead(deps.store, agentOwnerRecordKey(userId));
      if (existing.kind === 'unavailable') return unavailable();
      const decoded = existing.kind === 'record' ? decodeAgentOwnerRecord(existing.record.value) : null;
      if (existing.kind === 'record' && (!decoded?.ok || decoded.value.ownerId !== principal.ownerId || decoded.value.harness !== record.harness)) return unavailable();
      const previous = decoded?.ok ? decoded.value : undefined;
      // A rejoining session keeps its name. Agent names are not unique across Khala, only within a
      // channel: a new agent takes its default name, or the lowest free `-N` when someone here holds it.
      const rejoin = previous !== undefined;
      let name = previous?.label ?? (record.agentUserId === userId ? record.label : null);
      if (name === null) {
        const names = await deps.roomMemberNames(principal.ownerId, record.roomId as RoomId);
        if (!names) return unavailable();
        name = freeAgentName(username, record.harness, names);
      }
      const removal = await readRoomRemovals(deps.store, record.roomId as RoomId);
      if (removal === 'unavailable' || removal?.owners[principal.ownerId] && !removal.owners[principal.ownerId]!.complete) return unavailable();
      const issuedGeneration = removal?.generation ?? 0;
      if (!await rememberRoomAgent(deps.store, record.roomId as RoomId, principal.ownerId, userId)) return unavailable();
      const provisioned = await deps.provisioner.provision({ joinId, ...(record.sessionId === undefined ? {} : { identityId }), ownerId: principal.ownerId, label: name, roomId: record.roomId });
      if (provisioned.kind !== 'ok') return unavailable();
      const { credentials } = provisioned;
      if (credentials.userId !== userId) return unavailable();
      if (!await rememberAgentSession(deps.store, credentials, issuedGeneration)) return unavailable();
      const after = await readRoomRemovals(deps.store, record.roomId as RoomId);
      const deniedAfter = await membership(principal, record);
      if (after === 'unavailable' || deniedAfter || (after?.owners[principal.ownerId]?.generation ?? 0) > issuedGeneration) {
        if (!await deps.revokeAgentSession?.(credentials.userId, record.roomId as RoomId)) return unavailable();
        return deniedAfter ?? error(403, 'not_member');
      }
      const owner: AgentOwnerRecord = { matrixUserId: credentials.userId, ownerId: principal.ownerId,
        ownerLabel: username, harness: record.harness, label: name, createdAt: previous?.createdAt ?? new Date(deps.clock()).toISOString() };
      const mapped = await writeAndResolve(deps.store, { key: agentOwnerRecordKey(credentials.userId), expectedRevision: existing.kind === 'record' ? existing.record.revision : null,
        operationId: `agents.${createHash('sha256').update(credentials.userId).digest('hex')}.create.${Buffer.from(deps.random(8)).toString('hex')}`,
        next: { value: owner, expiresAt: null },
      });
      if (mapped.kind !== 'applied' && !(mapped.kind === 'conflict' && mapped.current?.value.ownerId === principal.ownerId && mapped.current.value.label === name)) return unavailable();
      if (effectiveState(record, deps.clock()) === 'expired') return error(404, 'not_found');
      // Persist the cleanup pointer before making the claim permanent. A failed final
      // confirmation (including a process crash) remains a pending, expirable join.
      const staged: JoinRecord = { ...record, ...(rejoin ? { rejoin: true } : {}), label: name, agentUserId: userId };
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
      if (approvedUsername !== undefined) {
        const approval = await safeRead(deps.store, rejoinApprovalKey(identityId));
        if (approval.kind !== 'record' || !validRejoinApproval(approval.record.value)
          || approval.record.value.revoked || approval.record.value.ownerId !== principal.ownerId) return unavailable();
      }
      const next: JoinRecord = { ...record, ...(rejoinIdentity(record) ? { rejoinApproval: { ownerLabel: username, generation: issuedGeneration } } : {}), label: name, ownerId: principal.ownerId, state: 'confirmed', agentUserId: credentials.userId,
        sealedCredentials: sealCredentials(deps.sealSecret, joinId, credentials) };
      const result = await deps.joins.replace(joinId, revision, next, 'confirm');
      if (result.kind === 'applied') {
        await indexOwnerAgent(deps.store, principal.ownerId, userId);
        if (!await rememberApproval(next, username, issuedGeneration, approvedUsername !== undefined)) return unavailable();
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
  async function rememberApproval(record: JoinRecord, ownerLabel: string, generation: number, repairOnly = false): Promise<boolean> {
    const identity = rejoinIdentity(record);
    if (!identity || !record.ownerId) return true;
    const key = rejoinApprovalKey(identity);
    const read = await safeRead(deps.store, key);
    if (read.kind === 'unavailable') return false;
    if (read.kind === 'record' && (!validRejoinApproval(read.record.value) || read.record.value.ownerId !== record.ownerId)) return false;
    // A confirmed retry repairs an absent grant; it never reverses a later revocation.
    if (read.kind === 'record' && (repairOnly || (read.record.value as RejoinApproval).generation > generation)) return true;
    const value: RejoinApproval = { v: 1, ownerId: record.ownerId as OwnerId, ownerLabel, generation };
    const result = await writeAndResolve(deps.store, { key, expectedRevision: read.kind === 'record' ? read.record.revision : null,
      operationId: `rejoin.${record.joinId}`, next: { value, expiresAt: null } });
    return result.kind === 'applied' || result.kind === 'conflict' && validRejoinApproval(result.current?.value)
      && result.current.value.ownerId === record.ownerId && !result.current.value.revoked && result.current.value.generation >= generation;
  }
  /** Internal only: this is wired to agent creation, never exposed as a human route. */
  async function autoConfirm(joinId: string): Promise<boolean> {
    const read = await deps.joins.read(joinId);
    if (read.kind !== 'found') throw Error('unavailable');
    const identity = rejoinIdentity(read.record);
    if (!identity) return true;
    const approval = await safeRead(deps.store, rejoinApprovalKey(identity));
    if (approval.kind === 'absent') return true;
    if (approval.kind !== 'record' || !validRejoinApproval(approval.record.value)) throw Error('unavailable');
    const grant = approval.record.value;
    if (grant.revoked) return true;
    const removals = await readRoomRemovals(deps.store, read.record.roomId as RoomId);
    if (removals === 'unavailable') throw Error('unavailable');
    const removal = removals?.owners[grant.ownerId];
    if (removal && (!removal.complete || removal.generation > grant.generation)) return true;
    const response = await confirm(joinId, { ownerId: grant.ownerId, verifiedEmail: '' }, grant.ownerLabel);
    // Losing membership never reuses approval; the ordinary human flow can authorize anew.
    if (response.status === 403) {
      const result = await writeAndResolve(deps.store, { key: rejoinApprovalKey(identity), expectedRevision: approval.record.revision,
        operationId: `rejoin.revoke.${joinId}`, next: { value: { ...grant, revoked: true }, expiresAt: null } });
      return result.kind === 'applied' || result.kind === 'conflict';
    }
    return response.ok;
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
        // The name it will join as: its default, numbered when someone in this channel holds it.
        const names = await deps.roomMemberNames(principal.ownerId, read.record.roomId as RoomId);
        view.label = freeAgentName(username, read.record.harness, names ?? []);
      }
      return json(200, view);
    } catch { return unavailable(); }
  };
  return { view: handler(false), confirm: handler(true), status: handler(false), autoConfirm };
}
