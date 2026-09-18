import type { RoomId } from '@khala/contracts/messaging/index';

/**
 * One prepared introduction, keyed by a stable local ID so drafts survive reordering.
 * `error` is a local validation code (never a raw server error) attached to this field.
 */
export type IntroDraft = Readonly<{ localId: string; body: string; error: string | null }>;

export type CreateChatPhase =
  | 'editing'
  | 'creating'
  | 'preparing_intro'
  | 'resolving'
  | 'sharing'
  | 'ready'
  | 'failed';

export type CreateChatView = Readonly<{
  phase: CreateChatPhase;
  title: string;
  /** Local validation code for the title field, distinct from `errorCode`. */
  titleError: string | null;
  intros: readonly IntroDraft[];
  roomId: RoomId | null;
  shareUrl: string | null;
  errorCode: string | null;
}>;

export const INITIAL_VIEW: CreateChatView = {
  phase: 'editing',
  title: '',
  titleError: null,
  intros: [],
  roomId: null,
  shareUrl: null,
  errorCode: null,
};
