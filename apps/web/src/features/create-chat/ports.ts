import type { AdmissionPort, DevicePort, IdentityPort, RoomPort } from '@khala/contracts/messaging';

/**
 * Ports the screen depends on. KHA132 supplies production implementations; screen
 * tests inject fakes. The controller only uses `room` and `admission` — `identity`
 * and `device` gate the screen's readiness, never the operation journal.
 */
export interface CreateChatPorts {
  readonly identity: IdentityPort;
  readonly device: DevicePort;
  readonly room: RoomPort;
  readonly admission: AdmissionPort;
}
