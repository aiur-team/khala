// `@aiur/khala/opencode`: the OpenCode plugin entry (`OPENCODE_PLUGIN_SPECIFIER`). It
// carries the delivery contract the plugin, its notifier and setup build against; the
// plugin hooks and tools land here without moving the entry.

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
