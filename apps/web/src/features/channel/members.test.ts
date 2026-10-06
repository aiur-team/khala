import { describe, expect, it } from 'vitest';
import type { Participant } from '@khala/contracts/m1/participants';
import type { OwnerId, ParticipantId } from '@khala/contracts/messaging/ids';
import { resolvedColor } from '../../ui/khala/human-colors';
import { participantHue } from '../../ui/khala/identity';
import type { ChannelAgentView } from './controller';
import { resolveMembers, type MemberInput } from './members';
const mira = 'owner_mira' as OwnerId;
const kai = 'owner_kai' as OwnerId;
const agent = (participantId: string, ownerId: OwnerId, ownerDisplayName: string): ChannelAgentView => ({
  participantId: participantId as ParticipantId, ownerId, displayName: 'Scout', ownerDisplayName,
  connection: 'unknown', routeLabel: 'Channel agent', acknowledgement: 'unknown', lastReceipt: null,
  installCommand: null, installCommandError: false,
});
const kaiHuman = (initials?: string): Participant => ({
  kind: 'human', matrixUserId: '@kai:khala', participantId: 'p_kai', ownerId: kai, displayName: 'Kai Watanabe', ...(initials ? { initials } : {}),
});

function resolve({ kaiInitials, viewerInitials, kaiAgentOwnerInitials }: Readonly<{
  kaiInitials?: string; viewerInitials?: string | null | undefined; kaiAgentOwnerInitials?: string;
}> = {}) {
  const details = new Map<string, Participant>([['p_kai', kaiHuman(kaiInitials)]]);
  if (kaiAgentOwnerInitials) details.set('agent_kai', { kind: 'agent', matrixUserId: '@scout:khala', participantId: 'agent_kai', ownerId: kai,
    displayName: 'Scout', ownerLabel: 'Kai', harness: 'claude', ownerInitials: kaiAgentOwnerInitials });
  const input: MemberInput = {
    viewer: { participantId: 'p_mira', ownerId: mira, name: 'Mira', ...(viewerInitials === undefined ? {} : { initials: viewerInitials }) },
    humans: [{ participantId: 'p_kai', ownerId: kai, displayName: 'Kai Watanabe' }],
    agents: [agent('agent_kai', kai, 'Kai'), agent('agent_mira', mira, 'Mira')],
    describeParticipant: participantId => details.get(participantId),
  };
  const members = resolveMembers(input);
  const byAgent = (participantId: string) => members.agents.find(item => item.participantId === participantId)!;
  return { kai: members.humans[0]!, viewer: members.viewer, kaisAgent: byAgent('agent_kai'), mirasAgent: byAgent('agent_mira') };
}

describe('resolveMembers initials', () => {
  it('shows a human\'s chosen initials on them and on their agent\'s owner badge', () => {
    const { kai, kaisAgent } = resolve({ kaiInitials: 'ZZ' });
    expect(kai.initials).toBe('ZZ');
    expect(kaisAgent.ownerInitials).toBe('ZZ');
  });

  it('prefers the agent participant\'s own `ownerInitials`', () => {
    expect(resolve({ kaiAgentOwnerInitials: 'QQ' }).kaisAgent.ownerInitials).toBe('QQ');
  });

  it('keeps derived initials without a choice', () => {
    const { kai, kaisAgent } = resolve();
    expect(kai.initials).toBe('KW');
    expect(kaisAgent.ownerInitials).toBe('KW');
  });

  it('derives own-agent initials until the viewer chooses', () => {
    for (const viewerInitials of [undefined, null]) {
      const { viewer, mirasAgent } = resolve({ viewerInitials });
      expect(viewer.initials).toBe('YO');
      expect(mirasAgent.ownerInitials).toBe('SC');
    }
    const { viewer, mirasAgent } = resolve({ viewerInitials: 'MZ' });
    expect(viewer.initials).toBe('MZ');
    expect(mirasAgent.ownerInitials).toBe('MZ');
  });
});

const theoAgent: ChannelAgentView = { participantId: 'agent_theo' as ParticipantId, ownerId: 'owner_theo' as OwnerId, displayName: 'Codex',
  ownerDisplayName: 'Theo', connection: 'unknown', routeLabel: 'Channel agent', acknowledgement: 'unknown', lastReceipt: null,
  installCommand: null, installCommandError: false };
const colorInput = {
  viewer: { participantId: 'p_mira', ownerId: 'owner_mira', name: 'Mira' },
  humans: [{ participantId: 'p_theo', ownerId: 'owner_theo', displayName: 'Theo Park' }],
  agents: [theoAgent],
};

describe('resolveMembers colours', () => {
  it('takes human hues and agent owner hues from colorFor', () => {
    const colors = new Map([['owner_mira', resolvedColor('lime', 0)], ['owner_theo', resolvedColor('indigo', 1)]]);
    const members = resolveMembers({ ...colorInput, colorFor: ownerId => colors.get(ownerId)! });
    expect(members.viewer).toMatchObject({ hue: 84, color: colors.get('owner_mira') });
    expect(members.humans[0]).toMatchObject({ hue: 244, color: colors.get('owner_theo') });
    // An agent wears its owner's resolved colour: its own hue is the owner's (operator request 2026-10-04).
    expect(members.agents[0]).toMatchObject({ hue: 244, ownerHue: 244, ownerColor: colors.get('owner_theo') });
  });

  it('keeps the hashed hues without colorFor', () => {
    const members = resolveMembers(colorInput);
    expect(members.viewer).toMatchObject({ hue: 214, color: null });
    expect(members.humans[0]).toMatchObject({ hue: participantHue({ kind: 'human', ownerId: 'owner_theo' }), color: null });
    expect(members.agents[0]?.ownerColor).toBeNull();
    expect(members.agents[0]?.hue).toBe(members.humans[0]?.hue);
  });
});
