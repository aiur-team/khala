export type CurrentAgentName = { participantId: string; name: string; sourceEventId: string | null; eventId: string };
export type NameState = { names: CurrentAgentName[]; seenRenames: string[] };

/** Called only after authenticated owner/agent checks; snapshots never replace known rename history. */
export function projectVerifiedName(state: NameState, event: {
  kind: 'agent_rename' | 'agent_name_snapshot'; participantId: string; name: string; eventId: string; sourceEventId?: string | null;
}): NameState {
  const previous = state.names.find(item => item.participantId === event.participantId);
  if (event.kind === 'agent_rename' && state.seenRenames.includes(event.eventId)) return state;
  if (event.kind === 'agent_name_snapshot' && previous?.sourceEventId && state.seenRenames.includes(previous.sourceEventId)) return state;
  return {
    seenRenames: event.kind === 'agent_rename' ? [...state.seenRenames, event.eventId] : state.seenRenames,
    names: [...state.names.filter(item => item.participantId !== event.participantId), {
      participantId: event.participantId, name: event.name, eventId: event.eventId,
      sourceEventId: event.kind === 'agent_rename' ? event.eventId : event.sourceEventId ?? null,
    }],
  };
}
