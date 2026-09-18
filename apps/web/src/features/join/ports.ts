// Injected dependencies for the join feature. Live composition (`132`)
// supplies real adapters; tests supply synthetic ones. This file imports no
// SDK, storage or network code.

import type { AdmissionPort, DevicePort, IdentityPort } from '@khala/contracts/messaging/index';
import type { RouteCodec } from './location';

export interface JoinPorts {
  identity: IdentityPort;
  device: DevicePort;
  admission: AdmissionPort;
  codec: RouteCodec;
  /** The host's navigation capability. The identity adapter never navigates itself. */
  navigate: (url: string) => void;
}
