import type { AdmissionPort, ContentLimits, DevicePort, IdentityPort, RoomPort } from '@khala/contracts/messaging/index';

/**
 * Ports the screen depends on. KHA132 supplies production implementations; screen
 * tests inject fakes. The controller uses `room`, `admission` and `limits` —
 * `identity` and `device` gate the screen's readiness, never the operation journal.
 *
 * `limits` must already be decoded through `decodeContentLimits` before injection,
 * so a forged or malformed capability record never reaches local validation; the
 * host is responsible for sourcing the substrate's live record.
 */
export interface CreateChatPorts {
  readonly identity: IdentityPort;
  readonly device: DevicePort;
  readonly room: RoomPort;
  readonly admission: AdmissionPort;
  readonly limits: ContentLimits;
}
