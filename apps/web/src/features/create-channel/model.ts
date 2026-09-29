import type { RoomId } from '@khala/contracts/messaging/index';

export type AdmissionPolicyChoice = 'link_no_history' | 'named_no_history' | 'link_full_history';

export type CreateChannelPhase =
  | 'editing'
  | 'creating'
  | 'resolving'
  | 'sharing'
  | 'ready'
  | 'failed';

/** @deprecated Use `CreateChannelPhase`. Kept through the first tagged release containing #163. */
export type CreateChatPhase = CreateChannelPhase;

export type CreateChannelView = Readonly<{
  phase: CreateChannelPhase;
  title: string;
  /** Local validation code for the title field, distinct from `errorCode`. */
  titleError: string | null;
  admissionPolicy: AdmissionPolicyChoice;
  namedEmail: string;
  namedEmailError: string | null;
  roomId: RoomId | null;
  shareUrl: string | null;
  errorCode: string | null;
}>;

/** @deprecated Use `CreateChannelView`. Kept through the first tagged release containing #163. */
export type CreateChatView = CreateChannelView;

export const INITIAL_VIEW: CreateChannelView = {
  phase: 'editing',
  title: '',
  titleError: null,
  admissionPolicy: 'link_no_history',
  namedEmail: '',
  namedEmailError: null,
  roomId: null,
  shareUrl: null,
  errorCode: null,
};
