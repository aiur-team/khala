import { describe, expect, it } from 'vitest';
import { createOwnerMailboxControlsClient } from '../controls/owner-mailbox-client';
import { createOwnerMailboxReviewClient } from '../review/owner-mailbox-client';
import { createOwnerDeviceClient } from '../review/owner-device-client';

const origin = 'http://localhost:8888';
const csrf = async () => null;

const constructors = [
  (allowInsecureLoopback = false) => createOwnerMailboxControlsClient({ origin, csrf, allowInsecureLoopback }),
  (allowInsecureLoopback = false) => createOwnerMailboxReviewClient({ origin, csrf, allowInsecureLoopback }),
  (allowInsecureLoopback = false) => createOwnerDeviceClient({ origin, csrf, allowInsecureLoopback }),
];

describe('owner clients at local startup', () => {
  it('rejects HTTP by default and accepts explicit loopback development', () => {
    for (const construct of constructors) {
      expect(() => construct()).toThrow();
      expect(() => construct(true)).not.toThrow();
    }
  });
});
