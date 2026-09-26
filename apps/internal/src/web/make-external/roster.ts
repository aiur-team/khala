import type { MakeExternalRosterAgent } from '@khala/contracts/messaging/make-external';
import type { InternalStoreHandle } from '../../store/open';

// What the human reviews before confirming: the channel title and every joined agent
// with the exact session it is bound through now. The conversion snapshots the same
// facts when it starts and re-verifies them against the live session.

export type ChannelRoster = Readonly<{ title: string | null; agents: readonly MakeExternalRosterAgent[] }>;

export type RosterRead = ChannelRoster | 'not_found' | 'forbidden';

/** Only a human of the owner that created the channel may see or convert it. */
export function readRoster(handle: InternalStoreHandle, owner: Readonly<{ ownerId: string; participantId: string }>, channelId: string): RosterRead {
  return handle.read(db => {
    const channel = db.prepare(`
      SELECT c.title, p.owner_id FROM channels c JOIN participants p ON p.participant_id = c.creator_participant_id WHERE c.channel_id = ?
    `).get(channelId) as { title: string | null; owner_id: string } | undefined;
    if (!channel) return 'not_found';
    const actor = db.prepare('SELECT owner_id, kind FROM participants WHERE participant_id = ?')
      .get(owner.participantId) as { owner_id: string; kind: string } | undefined;
    if (channel.owner_id !== owner.ownerId || actor?.owner_id !== owner.ownerId || actor.kind !== 'human') return 'forbidden';
    const rows = db.prepare(`
      SELECT p.participant_id, p.display_name, b.harness, b.session_id, b.generation
      FROM memberships m
      JOIN participants p ON p.participant_id = m.participant_id
      JOIN bindings b ON b.participant_id = p.participant_id AND b.status = 'active'
        AND b.generation = (SELECT MAX(generation) FROM bindings x WHERE x.participant_id = p.participant_id AND x.status = 'active')
      WHERE m.channel_id = ? AND m.membership = 'joined' AND p.kind = 'agent'
      ORDER BY p.participant_id
    `).all(channelId) as unknown as Array<{ participant_id: string; display_name: string; harness: string; session_id: string; generation: number }>;
    return {
      title: channel.title,
      agents: rows.map(row => ({
        participantId: row.participant_id, displayName: row.display_name, harness: row.harness, sessionId: row.session_id,
        generation: Number(row.generation),
      })),
    };
  });
}

/** Display names for participants a conversion snapshotted, even if they left the channel since. */
export function displayNames(handle: InternalStoreHandle, participantIds: readonly string[]): ReadonlyMap<string, string> {
  return handle.read(db => {
    const names = new Map<string, string>();
    const statement = db.prepare('SELECT display_name FROM participants WHERE participant_id = ?');
    for (const id of participantIds) {
      const row = statement.get(id) as { display_name: string } | undefined;
      if (row) names.set(id, row.display_name);
    }
    return names;
  });
}
