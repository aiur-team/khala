import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OwnerId, ParticipantId } from '@khala/contracts/messaging/ids';
import { ChannelRoster, MemberAvatar, RenameAgent, submitRename, type RenameAgentHandler, type RenameAgentResult } from './AgentPresencePanel';
import type { ChannelAgentView } from './controller';
import { resolveMembers } from './members';

const mira = 'owner_mira' as OwnerId;
const scout: ChannelAgentView = {
  participantId: 'agent_scout' as ParticipantId, ownerId: mira, displayName: 'Scout', ownerDisplayName: 'Mira',
  connection: 'unknown', routeLabel: 'Channel agent', acknowledgement: 'unknown', lastReceipt: null,
  installCommand: null, installCommandError: false,
};
const members = (agents: readonly ChannelAgentView[]) => resolveMembers({ viewer: { participantId: 'p_mira', ownerId: mira, name: 'Mira' },
  humans: [], agents });

describe('ChannelRoster', () => {
  it.each(['antigravity', 'muse'])('renders initials for registered %s without a logo', harness => {
    const agent = members([scout]).agents[0]!;
    const html = renderToStaticMarkup(<MemberAvatar member={{ ...agent, harness }} />);
    expect(html).toContain('<span class="kh-ini">SC</span>');
    expect(html).not.toContain('<img');
  });
  it.each([['vscode', 'Copilot (VS Code)'], ['claude-code', 'MCP agent (claude-code)']])('renders %s identity', (harness, label) => {
    const resolved = members([scout]);
    const agents = resolved.agents.map(agent => ({ ...agent, harness }));
    const html = renderToStaticMarkup(<ChannelRoster phase="ready" onOpen={() => {}} members={{ ...resolved, agents,
      groups: resolved.groups.map(group => ({ ...group, agents: group.agents.map(agent => ({ ...agent, harness })) })) }} />);
    expect(html).toContain(label);
    expect(html).not.toContain('undefined');
    if (harness === 'claude-code') expect(html).not.toContain('Claude Code');
  });
  it('badges names that collide across owners with the thread owner suffix', () => {
    const theosScout = { ...scout, participantId: 'agent_other' as ParticipantId, ownerId: 'owner_theo' as OwnerId };
    const html = renderToStaticMarkup(<ChannelRoster phase="ready" onOpen={() => {}} members={members([scout, theosScout])} />);
    expect(html).toContain('Scout<span class="kh-id" style="--h:');
    expect(html).toContain('>#mira</span>');
    expect(html).toContain('>#theo</span>');
    expect(html).toContain('aria-label="Listening mode for Scout #mira"');
  });

  it('does not badge same-named agents of one owner, as the thread does not', () => {
    const html = renderToStaticMarkup(<ChannelRoster phase="ready" onOpen={() => {}}
      members={members([scout, { ...scout, participantId: 'agent_other' as ParticipantId }])} />);
    expect(html).not.toContain('kh-id');
  });

  it('counts the agents on each human row', () => {
    const one = renderToStaticMarkup(<ChannelRoster phase="ready" onOpen={() => {}} members={members([scout])} />);
    expect(one).toContain('</span><i>1 agent</i></button>');
    const two = renderToStaticMarkup(<ChannelRoster phase="ready" onOpen={() => {}}
      members={members([scout, { ...scout, participantId: 'agent_other' as ParticipantId }])} />);
    expect(two).toContain('<i>2 agents</i>');
    expect(renderToStaticMarkup(<ChannelRoster phase="ready" onOpen={() => {}} members={members([])} />)).not.toContain('<i>');
  });

  it('announces loading and failed presence reads distinctly', () => {
    expect(renderToStaticMarkup(<ChannelRoster phase="loading" onOpen={() => {}} members={members([])} />)).toContain('Checking participants…');
    expect(renderToStaticMarkup(<ChannelRoster phase="unavailable" onOpen={() => {}} members={members([])} />))
      .toContain('Agent presence is unavailable right now.');
  });

  it('shows no connection diagnostics', () => {
    const html = renderToStaticMarkup(<ChannelRoster phase="ready" onOpen={() => {}} members={members([{ ...scout, connection: 'offline' }])} />);
    for (const diagnostic of ['Connected', 'Unavailable', 'Channel agent', 'install']) expect(html).not.toContain(diagnostic);
  });
});

describe('ChannelRoster rename', () => {
  const theosBuilder = { ...scout, participantId: 'agent_builder' as ParticipantId, ownerId: 'owner_theo' as OwnerId, displayName: 'Builder' };

  it('offers Rename on the viewer’s own agents only, before the mode controls', () => {
    const html = renderToStaticMarkup(<ChannelRoster phase="ready" onOpen={() => {}} onRename={() => {}}
      members={members([scout, theosBuilder])} />);
    expect(html).toContain('aria-label="Rename Scout" data-tip="Rename"');
    expect(html).not.toContain('Rename Builder');
    expect(html.indexOf('aria-label="Rename Scout"')).toBeLessThan(html.indexOf('aria-label="Listening mode for Scout"'));
  });

  it('offers no Rename without a rename handler', () => {
    expect(renderToStaticMarkup(<ChannelRoster phase="ready" onOpen={() => {}} members={members([scout])} />)).not.toContain('Rename');
  });
});

describe('RenameAgent', () => {
  it('renders the handle-rule field prefilled with the current name', () => {
    const html = renderToStaticMarkup(<RenameAgent participantId={scout.participantId} name="Scout"
      renameAgent={async (_participantId, name) => ({ kind: 'ok', name })} />);
    expect(html).toContain('aria-label="Name for Scout"');
    expect(html).toContain('maxLength="40" autoCapitalize="none" autoComplete="off" spellCheck="false" value="Scout"');
    expect(html).not.toContain('letters, numbers');
    expect(html).not.toContain('aria-describedby');
    expect(html).not.toContain('aria-invalid');
    expect(html).not.toContain('role="alert"');
    expect(html).toContain('class="kh-btn pri">Rename</button>');
  });

  it('links the rule to the field only while the name is invalid', () => {
    const html = renderToStaticMarkup(<RenameAgent participantId={scout.participantId} name="a"
      renameAgent={async (_participantId, name) => ({ kind: 'ok', name })} />);
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain(`<p class="kh-d-rename-err" id="${describedBy}" role="alert">At least 2 characters.</p>`);
    expect(html).toContain('disabled="">Rename</button>');
  });
});

describe('submitRename', () => {
  const agentX = 'agent_x' as ParticipantId;
  const recorder = (result: RenameAgentResult) => {
    const calls: [ParticipantId, string][] = [];
    const handler: RenameAgentHandler = async (participantId, name) => { calls.push([participantId, name]); return result; };
    return { calls, handler };
  };

  it('rejects a short name without calling the API', async () => {
    const { calls, handler } = recorder({ kind: 'ok', name: 'a' });
    expect(await submitRename(agentX, 'Kevin-Claude', 'a', handler)).toEqual({ kind: 'error', message: 'At least 2 characters.' });
    expect(calls).toEqual([]);
  });

  it('shows the handle-rule messages', async () => {
    const { calls, handler } = recorder({ kind: 'ok', name: 'x' });
    expect(await submitRename(agentX, 'Kevin-Claude', 'x'.repeat(41), handler)).toEqual({ kind: 'error', message: 'At most 40 characters.' });
    expect(await submitRename(agentX, 'Kevin-Claude', 'two words', handler)).toEqual({ kind: 'error',
      message: 'Use letters, numbers, . _ or -, starting and ending with a letter or number.' });
    expect(await submitRename(agentX, 'Kevin-Claude', 'Kevin-Claude', handler)).toEqual({ kind: 'error', message: 'This agent already has that name.' });
    expect(calls).toEqual([]);
  });

  it('passes the abort signal to the rename handler', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const { signal } = new AbortController();
    await submitRename(agentX, 'Kevin-Claude', 'Reviewer', async (_participantId, name, received) => {
      signals.push(received);
      return { kind: 'ok', name };
    }, signal);
    expect(signals).toEqual([signal]);
  });

  it('renames with the checked name and returns the server’s name', async () => {
    const { calls, handler } = recorder({ kind: 'ok', name: 'Reviewer' });
    expect(await submitRename(agentX, 'Kevin-Claude', 'Reviewer', handler)).toEqual({ kind: 'ok', name: 'Reviewer' });
    expect(calls).toEqual([['agent_x', 'Reviewer']]);
  });

  it('maps API errors to messages', async () => {
    const cases: [RenameAgentResult, string][] = [
      [{ kind: 'error', code: 'name_taken' }, 'That name is taken.'],
      [{ kind: 'error', code: 'not_owner' }, 'You can only rename your own agents.'],
      [{ kind: 'error', code: 'invalid_name', reason: 'reserved' }, 'Choose a name that does not imply an official role.'],
      [{ kind: 'error', code: 'unavailable' }, 'Couldn’t rename. Try again.'],
      [{ kind: 'error', code: 'signed_out' }, 'Couldn’t rename. Try again.'],
    ];
    for (const [result, message] of cases) {
      expect(await submitRename(agentX, 'Kevin-Claude', 'Reviewer', recorder(result).handler)).toEqual({ kind: 'error', message });
    }
    expect(await submitRename(agentX, 'Kevin-Claude', 'Reviewer', async () => { throw new Error('offline'); }))
      .toEqual({ kind: 'error', message: 'Couldn’t rename. Try again.' });
  });
});


describe('channel creator authority', () => {
  it('shows OWNER to every viewer and removal only to the creator', () => {
    const roster = resolveMembers({viewer:{ownerId:mira, name:'Mira'}, humans:[{participantId:'p_theo',ownerId:'owner_theo',displayName:'Theo'}],agents:[]});
    const render = (creatorOwnerId: string) => renderToStaticMarkup(<ChannelRoster members={roster} phase="ready" onOpen={() => {}} creatorOwnerId={creatorOwnerId} onRemoveHuman={async () => 'removed'} />);
    expect(render(mira)).toContain('OWNER');
    expect(render(mira)).toContain('aria-label="Remove Theo"');
    expect(render(mira)).not.toContain('aria-label="Remove Mira"');
    expect(render('owner_theo')).toContain('OWNER');
    expect(render('owner_theo')).not.toContain('aria-label="Remove Theo"');
  });
});
