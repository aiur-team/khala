import type {
  BindingId, DeliveryReceiptTransport, HarnessCapabilities, ListeningModeCommand, ListeningModeResult, ListeningModeView,
  ModeSupport, OwnerRouteGrantCommand, PolicyAck, PolicySetCommand, SessionBinding,
} from '@khala/contracts/delivery/index';
import type { Disposer } from '@khala/contracts/messaging/index';

import type { PolicyMode } from './model';

/**
 * Authoritative mode/pause state for one binding generation. `PolicyAck` alone
 * (see `packages/contracts/src/delivery/commands.ts`) confirms a command's
 * version/connector outcome, not the policy's current mode or paused flag — the
 * host composition layer must source this from its own canonical read, never
 * infer it from the last ack the browser happened to see.
 */
export type PolicySnapshot = Readonly<{
  bindingId: BindingId;
  generation: number;
  effectiveVersion: number | null;
  effectiveMode: PolicyMode | null;
  paused: boolean | null;
}>;

export const BINDING_STATUSES = ['active', 'revoked'] as const;
export type BindingStatus = (typeof BINDING_STATUSES)[number];

/** Who wrote the current listening-mode version (decision 42: last change wins). */
export type ListeningModeLastChange = Readonly<{
  actor: 'owner' | 'agent';
  version: number;
  changedAt: string;
}>;

/**
 * Listening-mode state for the exact binding generation in the enclosing
 * snapshot. `view` is the store's current-capability projection
 * (`packages/policy/src/listening-mode/store.ts`); its `support` map holds
 * primary interactive-session evidence only. Secondary hosted evidence stays on
 * `HarnessCapabilities.evidenceRef` and is never read as mode support.
 */
export type ListeningModeSnapshot = Readonly<{
  view: ListeningModeView;
  /** `null` when no actor was recorded for the current version. */
  lastChange: ListeningModeLastChange | null;
  /**
   * Every other active binding the viewer can see. The session label's short
   * identifier widens until it is unique among these.
   */
  siblingBindingIds: readonly BindingId[];
  /**
   * Hard-cancel support for this binding's `steer` route. `null` means not
   * inventoried and is gated exactly like `unknown`.
   */
  hardCancel: ModeSupport | null;
  /**
   * Whether an idle interactive session is proven to receive a release before
   * its next turn (decisions 34 and 37). Until it is, the panel says so.
   */
  idleDelivery: 'proven' | 'unproven';
}>;

/** Outcome of an owner-only grant or revoke. The panel re-reads the snapshot for state. */
export type RouteGrantAck = Readonly<{
  commandId: OwnerRouteGrantCommand['commandId'];
  outcome: 'applied' | 'conflict' | 'refused';
  reason: string | null;
}>;

export type AgentControlsSnapshot = Readonly<{
  binding: SessionBinding;
  /**
   * A revoked binding must never leave an enabled control: the human revoked
   * the connection precisely to stop it from receiving further commands, so
   * this is checked independently of connectivity or capability state.
   */
  bindingStatus: BindingStatus;
  capabilities: HarnessCapabilities | null;
  policy: PolicySnapshot;
  connection: 'connected' | 'offline' | 'unknown';
  latestReceipt: DeliveryReceiptTransport | null;
  /** `null` until the listening-mode store has answered for this binding generation. */
  listening: ListeningModeSnapshot | null;
}>;

/**
 * Browser facade for one binding's trust/status controls. Trusted composition
 * (135) constructs `OwnerAuthority` and attaches it to `submitPolicy` under the
 * current human session outside the browser — this port never accepts or
 * exports `OwnerAuthority`, so it cannot be used as a general agent tool.
 */
export interface AgentControlsUiPort {
  readSnapshot(bindingId: BindingId): Promise<AgentControlsSnapshot>;
  subscribe(bindingId: BindingId, listener: (snapshot: AgentControlsSnapshot) => void): Disposer;
  submitPolicy(command: PolicySetCommand): Promise<PolicyAck>;
  /**
   * The same versioned mode command the bound agent uses. Composition attaches
   * `OwnerAuthority`; the owner-only policy port is never the agent's boundary.
   */
  submitListeningMode(command: ListeningModeCommand): Promise<ListeningModeResult>;
  /**
   * Owner-only experimental-route and hard-cancel grant and revoke commands.
   * Composition attaches `OwnerAuthority` behind the browser CSRF boundary.
   */
  submitRouteGrant(command: OwnerRouteGrantCommand): Promise<RouteGrantAck>;
}

export interface AgentControlsPorts {
  readonly agentControls: AgentControlsUiPort;
}
