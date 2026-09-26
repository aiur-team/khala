import type {
  CallOptions,
  ChannelAccessDecisionCommand,
  ChannelAccessDecisionRejection,
  ChannelAccessMuteCommand,
  ChannelAccessMuteResult,
  Disposer,
  OperationResult,
} from '@khala/contracts/messaging/index';

export type InboxRejection = 'forbidden';
export type MuteRejection = 'forbidden' | 'not_found' | 'stale_revision' | 'operation_mismatch';

/**
 * The signed-in owner's side of the `channel-access-journal`
 * `ChannelAccessDecisionPort`, already bound to the authenticated human by the
 * host composition. The live implementation wraps the human-cookie routes, so
 * a binding or discovery capability, or a principal that no longer owns the
 * target, comes back `forbidden`.
 *
 * Results are `unknown` on purpose: the controller decodes every projection
 * and notification through the contract decoders before rendering any of it.
 */
export interface ChannelAccessInboxPort {
  inbox(options?: CallOptions): Promise<OperationResult<readonly unknown[], InboxRejection>>;
  decide(input: ChannelAccessDecisionCommand, options?: CallOptions): Promise<OperationResult<unknown, ChannelAccessDecisionRejection>>;
  setMute(input: ChannelAccessMuteCommand, options?: CallOptions): Promise<OperationResult<ChannelAccessMuteResult, MuteRejection>>;
  /**
   * Minimal, revisioned `ChannelAccessNotification` upserts for this owner.
   * They only prompt a refresh; the inbox stays authoritative.
   */
  subscribe(listener: (notification: unknown) => void): Disposer;
}

export interface ChannelAccessPorts {
  readonly requests: ChannelAccessInboxPort;
}
