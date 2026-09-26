// Live `ChannelSettingsPort` over the loopback server's human-cookie routes.
// The owner's picker is the list of descriptors this local service issued to
// the owner's own agent sessions (including sessions that have not joined
// anything). It is read-only and takes no query, so it can never become a
// directory: an agent session never sees this list.

import {
  ok, rejected, unavailable,
  type CallOptions, type ChannelVisibility, type OperationResult, type RoomId, type StableAgentPrincipal,
} from '@khala/contracts/messaging/index';
import { channelReadPath, isRecord, rejectionCode, type HumanClient, type HumanReply } from '../composition/human-client';
import type {
  AllowlistChange, AllowlistRejection, AllowlistedAgent, ChannelSettingsPort, ChannelSettingsSnapshot, KnownAgentPrincipal,
  MutationApplied, SettingsRejection, VisibilityChange,
} from '../../features/channel-settings/ports';

const settingsPath = (roomId: string) => `/api/human/channels/${encodeURIComponent(roomId)}/discovery`;
export const AGENTS_PATH = '/api/human/discovery/agents';

type WireSettings = Readonly<{ visibility: ChannelVisibility; revision: number; allowlist: readonly string[] }>;
type WireAgent = Readonly<{
  principal: string; fingerprint: string; generation: number; displayLabel: string | null; workspaceLabel: string | null;
}>;

const isVisibility = (value: unknown): value is ChannelVisibility => value === 'secret' || value === 'private' || value === 'public';
const isLabel = (value: unknown): value is string | null => value === null || typeof value === 'string';

function readSettings(body: unknown): WireSettings | null {
  if (!isRecord(body) || !isVisibility(body.visibility) || !Number.isSafeInteger(body.revision) || !Array.isArray(body.allowlist)
    || !body.allowlist.every(entry => typeof entry === 'string')) return null;
  return { visibility: body.visibility, revision: body.revision as number, allowlist: body.allowlist as string[] };
}

function readAgents(body: unknown): readonly WireAgent[] | null {
  if (!isRecord(body) || !Array.isArray(body.agents)) return null;
  const agents: WireAgent[] = [];
  for (const entry of body.agents as unknown[]) {
    if (!isRecord(entry) || typeof entry.principal !== 'string' || typeof entry.fingerprint !== 'string'
      || !Number.isSafeInteger(entry.generation) || !isLabel(entry.displayLabel) || !isLabel(entry.workspaceLabel)) return null;
    agents.push({
      principal: entry.principal,
      fingerprint: entry.fingerprint,
      generation: entry.generation as number,
      displayLabel: entry.displayLabel,
      workspaceLabel: entry.workspaceLabel,
    });
  }
  return agents;
}

/** A never-configured channel reads as secret at revision 0; the panel models that as a null revision. */
const toRevision = (revision: number): string | null => (revision === 0 ? null : String(revision));
const fromRevision = (revision: string | null): number => (revision === null ? 0 : Number(revision));

function failure<Code extends string>(reply: HumanReply, codes: ReadonlySet<string>): OperationResult<never, Code | 'forbidden'> {
  if (reply === 'auth_failed') return rejected('forbidden');
  if (reply === 'network') return unavailable();
  if (reply.status === 403 || reply.status === 404) return rejected('forbidden');
  const code = rejectionCode(reply.body);
  return code !== null && codes.has(code) ? rejected(code as Code) : unavailable();
}

const VISIBILITY_CODES: ReadonlySet<string> = new Set<SettingsRejection>(['stale_revision', 'operation_mismatch']);
const ALLOWLIST_CODES: ReadonlySet<string> = new Set<AllowlistRejection | 'unknown_principal' | 'wrong_generation'>([
  'stale_revision', 'operation_mismatch', 'unknown_principal', 'wrong_generation',
]);

export function createLocalChannelSettingsPort(client: HumanClient): ChannelSettingsPort {
  async function agents(signal?: AbortSignal): Promise<readonly WireAgent[] | 'forbidden' | 'unavailable'> {
    const reply = await client.get(AGENTS_PATH, signal);
    if (reply === 'auth_failed') return 'forbidden';
    if (reply === 'network') return 'unavailable';
    if (reply.status === 403) return 'forbidden';
    return reply.status === 200 ? readAgents(reply.body) ?? 'unavailable' : 'unavailable';
  }

  async function channelName(roomId: RoomId, signal?: AbortSignal): Promise<string> {
    const reply = await client.get(channelReadPath(roomId), signal);
    if (typeof reply === 'string' || reply.status !== 200 || !isRecord(reply.body) || !isRecord(reply.body.channel)) return roomId;
    return typeof reply.body.channel.title === 'string' && reply.body.channel.title !== '' ? reply.body.channel.title : roomId;
  }

  const applied = (reply: HumanReply): MutationApplied | null => {
    if (typeof reply === 'string' || reply.status !== 200) return null;
    const settings = readSettings(reply.body);
    return settings === null ? null : { revision: toRevision(settings.revision) };
  };

  return {
    async read(roomId, options?: CallOptions) {
      const reply = await client.get(settingsPath(roomId), options?.signal);
      if (reply === 'auth_failed') return rejected('forbidden');
      if (reply === 'network') return unavailable();
      if (reply.status === 403 || reply.status === 404) return rejected('forbidden');
      const settings = reply.status === 200 ? readSettings(reply.body) : null;
      if (settings === null) return unavailable();
      const known = await agents(options?.signal);
      if (known === 'forbidden') return rejected('forbidden');
      if (known === 'unavailable') return unavailable();
      const name = await channelName(roomId, options?.signal);
      const allowlist: AllowlistedAgent[] = settings.allowlist.map(principal => {
        const agent = known.find(candidate => candidate.principal === principal);
        return {
          principal: principal as StableAgentPrincipal,
          // A principal whose descriptor is gone keeps its row so the owner can still revoke it.
          fingerprint: agent?.fingerprint ?? 'unavailable',
          sessionGeneration: agent?.generation ?? 1,
          displayLabel: agent?.displayLabel ?? null,
          workspaceLabel: agent?.workspaceLabel ?? null,
        };
      });
      const snapshot: ChannelSettingsSnapshot = {
        roomId,
        channelName: name,
        visibility: settings.visibility,
        // The local listing always uses the channel's own title.
        listedTitle: settings.visibility === 'secret' ? null : name,
        revision: toRevision(settings.revision),
        allowlist,
        publicDiscovery: 'enabled',
        canManage: true,
      };
      return ok(snapshot);
    },

    async setVisibility(input: VisibilityChange, options?: CallOptions) {
      const reply = await client.post(settingsPath(input.roomId), {
        operationId: input.operationId,
        expectedRevision: fromRevision(input.expectedRevision),
        change: { kind: 'visibility', visibility: input.visibility },
      }, options?.signal);
      const result = applied(reply);
      return result === null ? failure<SettingsRejection>(reply, VISIBILITY_CODES) : ok(result);
    },

    async updateAllowlist(input: AllowlistChange, options?: CallOptions) {
      const reply = await client.post(settingsPath(input.roomId), {
        operationId: input.operationId,
        expectedRevision: fromRevision(input.expectedRevision),
        change: { kind: input.action, principal: input.principal, expectedGeneration: input.expectedSessionGeneration },
      }, options?.signal);
      const result = applied(reply);
      if (result !== null) return ok(result);
      const outcome = failure<AllowlistRejection | 'unknown_principal' | 'wrong_generation'>(reply, ALLOWLIST_CODES);
      // A vanished principal or a rebound session means the owner's picker is stale.
      if (outcome.kind === 'rejected' && (outcome.code === 'unknown_principal' || outcome.code === 'wrong_generation')) {
        return rejected('stale_revision');
      }
      return outcome as OperationResult<never, AllowlistRejection>;
    },

    async knownPrincipals(options?: CallOptions) {
      const known = await agents(options?.signal);
      if (known === 'forbidden') return rejected('forbidden');
      if (known === 'unavailable') return unavailable();
      const principals: KnownAgentPrincipal[] = known.map(agent => ({
        principal: agent.principal as StableAgentPrincipal,
        fingerprint: agent.fingerprint,
        sessionGeneration: agent.generation,
        source: 'own_session',
        displayLabel: agent.displayLabel,
        workspaceLabel: agent.workspaceLabel,
      }));
      return ok(principals);
    },
  };
}
