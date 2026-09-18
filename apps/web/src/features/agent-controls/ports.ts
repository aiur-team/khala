import type {
  BindingId, DeliveryReceipt, HarnessCapabilities, PolicyAck, PolicySetCommand, SessionBinding,
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

export type AgentControlsSnapshot = Readonly<{
  binding: SessionBinding;
  capabilities: HarnessCapabilities | null;
  policy: PolicySnapshot;
  connection: 'connected' | 'offline' | 'unknown';
  latestReceipt: DeliveryReceipt | null;
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
}

export interface AgentControlsPorts {
  readonly agentControls: AgentControlsUiPort;
}
