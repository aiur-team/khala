import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { OwnerId, ParticipantId } from '@khala/contracts/messaging/ids';
import type { AdapterCapability } from '@khala/connector/bootstrap/index';
import type { ProofSigner } from '@khala/connector/bootstrap/proof';
import { readBounded } from '@khala/connector/bootstrap/discovery';

export type ResolvedAgentParticipant = Readonly<{ participantId: ParticipantId; ownerId: OwnerId;
  kind: 'human' | 'agent'; initialName: string }>;

const PATH = '/api/agent/messaging/participants';

/** Fetches only identities for the current admitted binding's encrypted room. */
export function createAgentParticipantLookup(input: Readonly<{
  appOrigin: string; binding: SessionBinding; roomId: string; signer: ProofSigner;
  capability(): Promise<AdapterCapability | null>;
  fetch?: typeof fetch;
}>) {
  const url = `${input.appOrigin}${PATH}`;
  const transport = input.fetch ?? fetch;
  return async (userIds: readonly string[], targetParticipantIds: readonly string[] = []): Promise<ReadonlyMap<string, ResolvedAgentParticipant> | null> => {
    if (userIds.length > 100 || new Set(userIds).size !== userIds.length
      || targetParticipantIds.length > 100 || new Set(targetParticipantIds).size !== targetParticipantIds.length) return null;
    const capability = await input.capability();
    if (!capability || capability.bindingId !== input.binding.bindingId
      || capability.generation !== input.binding.generation) return null;
    let response: Response;
    try {
      response = await transport(url, { method: 'POST', redirect: 'error', credentials: 'omit',
        headers: { accept: 'application/json', 'content-type': 'application/json', origin: input.appOrigin,
          authorization: `DPoP ${capability.token}`, dpop: input.signer.proof('POST', url, capability.token) },
        body: JSON.stringify({ roomId: input.roomId, userIds, targetParticipantIds }), signal: AbortSignal.timeout(10_000) });
    } catch { return null; }
    if (response.status !== 200 || (response.headers.get('content-type') ?? '').split(';')[0]?.trim() !== 'application/json') {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const bytes = await readBounded(response, 64 * 1024);
    if (!bytes) return null;
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)) as unknown; }
    catch { return null; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const envelope = value as Record<string, unknown>;
    if (Object.keys(envelope).join(',') !== 'participants' || !Array.isArray(envelope.participants)) return null;
    const participants = new Map<string, ResolvedAgentParticipant>();
    for (const raw of envelope.participants) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const item = raw as Record<string, unknown>;
      if (typeof item.matrixUserId !== 'string' || !userIds.includes(item.matrixUserId)
          && !targetParticipantIds.includes(item.participantId as string)
        || participants.has(item.matrixUserId) || typeof item.participantId !== 'string'
        || typeof item.ownerId !== 'string' || typeof item.displayName !== 'string'
        || item.displayName.length > 256 || item.kind !== undefined && item.kind !== 'human' && item.kind !== 'agent') return null;
      participants.set(item.matrixUserId, { participantId: item.participantId as ParticipantId,
        ownerId: item.ownerId as OwnerId, kind: item.kind === 'agent' ? 'agent' : 'human', initialName: item.displayName });
    }
    return userIds.every(id => participants.has(id))
      && targetParticipantIds.every(id => [...participants.values()].some(item => item.participantId === id))
      ? participants : null;
  };
}
