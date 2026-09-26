// `@aiur/khala/opencode`: the OpenCode plugin entry (`OPENCODE_PLUGIN_SPECIFIER`). The
// default export is an OpenCode v1 plugin module (`{ id, server }`), so OpenCode loads
// only `server` and ignores the named exports: the delivery contract, the session
// bridge and its composition, which setup and live composition build against.
//
// `server` composes the live internal-mode dependencies when OpenCode loads it, from the
// same `$XDG_STATE_HOME/khala` the `khala` CLI uses: each OpenCode session is served
// through its own grant, and nothing is bound until that session joins a channel.

import { internalOpenCodeDependencies, khalaStateDirectory } from '../composition/opencode-internal';
import { type KhalaOpenCodeServer, createKhalaOpenCodeServer } from './plugin';

export {
  type OpenCodeInboxHint, type OpenCodeRouteEvidenceKey,
  OPENCODE_HARNESS, OPENCODE_HINT_KIND, OPENCODE_HINT_MAX_BYTES, OPENCODE_HINT_REASONS,
  OPENCODE_PLUGIN_ADAPTER_VERSION, OPENCODE_PLUGIN_ROUTE_LABEL, OPENCODE_PLUGIN_SPECIFIER, OPENCODE_ROUTE_EVIDENCE,
  OPENCODE_TESTED_VERSIONS,
  decodeOpenCodeInboxHint, encodeOpenCodeInboxHint, openCodePluginCapabilities,
} from '@khala/contracts/delivery/index';
export {
  type OpenCodeDeliveryEvent, type OpenCodeDeliveryState, type OpenCodeDeliveryTransition,
  OPENCODE_DELIVERY_EVENTS, OPENCODE_DELIVERY_STATES, maySubmitOpenCodeBatch, nextOpenCodeDeliveryState,
} from './delivery-contract';
export {
  type OpenCodeBatchPort, type OpenCodeBridgeReport, type OpenCodeBridgeStatus, type OpenCodeControlPort,
  type OpenCodeControls, type OpenCodeRuntime, type OpenCodeSessionPort, type OpenCodeSessionStatus,
  KHALA_READ_TOOL, KHALA_SEND_TOOL, OpenCodeSessionBridge,
} from './bridge';
export {
  OPENCODE_BATCH_READ_BYTES, OPENCODE_ENVELOPE_MAX_BYTES, encodeOpenCodeEnvelope, parseOpenCodeEnvelope,
} from './envelope';
export {
  type KhalaOpenCodeDependencies, type KhalaOpenCodeHooks, type KhalaOpenCodeServer, type OpenCodePluginClient,
  createKhalaOpenCodeServer, createOpenCodeSessionPort, openCodeVersionFromExecPath, parseOpenCodeVersion,
  unavailableOpenCodeDependencies,
} from './plugin';
export {
  type OpenCodeBoundSession, type OpenCodeBridgeState, type OpenCodeBridgeStore, type OpenCodeDegradedReason,
  memoryOpenCodeBridgeStore, openOpenCodeBridgeStore,
} from './store';

export { internalOpenCodeDependencies } from '../composition/opencode-internal';

const server: KhalaOpenCodeServer = input => createKhalaOpenCodeServer(
  internalOpenCodeDependencies({ stateDirectory: khalaStateDirectory(process.env) }),
)(input);

export default { id: 'khala', server };
