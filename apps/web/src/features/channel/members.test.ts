import { describe, expect, it } from 'vitest';
import type { OwnerId, ParticipantId } from '@khala/contracts/messaging/ids';
import { resolvedColor } from '../../ui/khala/human-colors';
import { participantHue } from '../../ui/khala/identity';
import type { ChannelAgentView } from './controller';
import { resolveMembers } from './members';

const agent: ChannelAgentView = { participantId: 'agent_theo' as ParticipantId, ownerId: 'owner_theo' as OwnerId, displayName: 'Codex',
  ownerDisplayName: 'Theo', connection: 'unknown', routeLabel: 'Channel agent', acknowledgement: 'unknown', lastReceipt: null,
  installCommand: null, installCommandError: false };
const input = {
  viewer: { participantId: 'p_mira', ownerId: 'owner_mira', name: 'Mira' },
  humans: [{ participantId: 'p_theo', ownerId: 'owner_theo', displayName: 'Theo Park' }],
  agents: [agent],
};

describe('resolveMembers colours', () => {
  it('takes human hues and agent owner hues from colorFor', () => {
    const colors = new Map([['owner_mira', resolvedColor('lime', 0)], ['owner_theo', resolvedColor('indigo', 1)]]);
    const members = resolveMembers({ ...input, colorFor: ownerId => colors.get(ownerId)! });
    expect(members.viewer).toMatchObject({ hue: 84, color: colors.get('owner_mira') });
    expect(members.humans[0]).toMatchObject({ hue: 244, color: colors.get('owner_theo') });
    expect(members.agents[0]).toMatchObject({ ownerHue: 244, ownerColor: colors.get('owner_theo') });
  });

  it('keeps the hashed hues without colorFor', () => {
    const members = resolveMembers(input);
    expect(members.viewer).toMatchObject({ hue: 214, color: null });
    expect(members.humans[0]).toMatchObject({ hue: participantHue({ kind: 'human', ownerId: 'owner_theo' }), color: null });
    expect(members.agents[0]?.ownerColor).toBeNull();
  });
});
