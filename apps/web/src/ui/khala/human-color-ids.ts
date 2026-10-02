// PROVISIONAL (#970): stand-in for `@khala/contracts/m1/colors` until per-human
// colours 1/3 merges. Same ids, order and default rule as that contract; this
// file becomes a re-export of it when #970 lands, and the field readers below
// become plain typed property reads.

import { fnv1a } from './identity';

export const HUMAN_COLOR_IDS = ['red', 'orange', 'amber', 'lime', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink'] as const;
export type HumanColorId = typeof HUMAN_COLOR_IDS[number];

/** The colour of a human who has not chosen one. */
export function defaultHumanColor(ownerId: string): HumanColorId {
  return HUMAN_COLOR_IDS[fnv1a(ownerId) % HUMAN_COLOR_IDS.length]!;
}

export function isHumanColorId(value: unknown): value is HumanColorId {
  return typeof value === 'string' && (HUMAN_COLOR_IDS as readonly string[]).includes(value);
}

const field = (value: object | null | undefined, key: string): HumanColorId | undefined => {
  const color = value ? (value as Readonly<Record<string, unknown>>)[key] : undefined;
  return isHumanColorId(color) ? color : undefined;
};

/** A human participant's chosen colour (#970 `Participant.color`). */
export const participantColor = (detail: Readonly<{ kind: string }> | undefined): HumanColorId | undefined =>
  detail?.kind === 'human' ? field(detail, 'color') : undefined;

/** An agent participant's owner's colour (#970 `Participant.ownerColor`). */
export const participantOwnerColor = (detail: Readonly<{ kind: string }> | undefined): HumanColorId | undefined =>
  detail?.kind === 'agent' ? field(detail, 'ownerColor') : undefined;

/** The signed-in human's colour (#970 `useProfile().color`), `null` while loading or errored. */
export const profileColor = (profile: object): HumanColorId | null => field(profile, 'color') ?? null;
