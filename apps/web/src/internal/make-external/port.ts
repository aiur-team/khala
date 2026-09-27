// The browser's view of the loopback Make-external routes. The server holds the
// journey; the port only reads its view and submits one action at a time. The
// composition supplies the HTTP implementation, which decodes every response strictly.

import type { MakeExternalAction, MakeExternalJourneyView, MakeExternalRejection } from '@khala/contracts/messaging/make-external';

export type MakeExternalRead =
  | Readonly<{ kind: 'ok'; view: MakeExternalJourneyView }>
  /** No journey here: the launch was not composed with a hosted service, or this is not the owner's channel. */
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'session_ended' }>
  | Readonly<{ kind: 'unavailable' }>;

export type MakeExternalWrite =
  | Readonly<{ kind: 'ok'; view: MakeExternalJourneyView; rejection: MakeExternalRejection | null }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'session_ended' }>
  /** The action may or may not have taken effect; retry it with the same operation ID. */
  | Readonly<{ kind: 'outcome_unknown' }>;

export interface MakeExternalPort {
  view(channelId: string): Promise<MakeExternalRead>;
  act(channelId: string, action: MakeExternalAction): Promise<MakeExternalWrite>;
}
