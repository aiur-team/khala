import { expect, it } from 'vitest';
import { projectVerifiedName, type NameState } from './name-state';

it('seeds inaccessible rename history but ignores stale or conflicting snapshots once a rename is known', () => {
  let state: NameState = { names: [], seenRenames: [] };
  state = projectVerifiedName(state, { kind: 'agent_name_snapshot', participantId: 'agent-one', name: 'Scout', eventId: '$seed', sourceEventId: '$old-rename' });
  expect(state.names[0]?.name).toBe('Scout');
  state = projectVerifiedName(state, { kind: 'agent_rename', participantId: 'agent-one', name: 'Dolan', eventId: '$rename' });
  for (const sourceEventId of [null, '$old-rename', '$rename']) {
    expect(projectVerifiedName(state, { kind: 'agent_name_snapshot', participantId: 'agent-one', name: 'Fake', eventId: '$stale', sourceEventId })).toEqual(state);
  }
  const restarted = JSON.parse(JSON.stringify(state)) as NameState;
  expect(projectVerifiedName(restarted, { kind: 'agent_rename', participantId: 'agent-one', name: 'Wrong replay', eventId: '$rename' })).toEqual(state);
});
