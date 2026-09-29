# create-channel

`CreateChannelScreen` creates an optionally named channel, then prepares a share
link in shared mode. The owner writes messages in the ordinary channel timeline
after creation. Private mode opens the channel directly and never calls the
admission port.

The create screen asks only for an optional title. Its default share link
admits members from admission forward. The channel page has one action to copy
a share link. Full-history admission still requires verified key transfer and
is not offered.

## Operation identity

The controller keeps one channel creation operation ID and one share operation
ID. An unknown or unavailable create result retries the same operation, and a
share failure retains the confirmed channel ID. The selected policy is frozen
for the share operation, so a retry cannot silently change access. Rejected
creation permits editing and starts a fresh operation. No introduction batch is
sent as part of creation.

## Tests

`controller.test.ts` verifies validation, idempotent create and share retries,
and private mode. `CreateChannelScreen.test.tsx` checks accessible names and
error states. `create-channel.browser.spec.ts` checks the create, share and copy
flow at narrow viewports with fabricated ports; it does not prove Matrix
admission or historical key delivery.
