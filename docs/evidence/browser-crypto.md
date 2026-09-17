# KHA-141 browser crypto observations

Observed 2026-09-17 on Linux7.1.4-arch1-1 x86_64, Node24.18.0, pnpm10.34.5, Chromium150.0.7871.128. Candidate matrix-js-sdk42.4.0, upstream tag v42.4.0 commit `bbffce963f7218ad72e23f972703794a05161e8a`; Vite7.1.12, Playwright1.55.1, TypeScript5.9.3. Isolated lock SHA256: `68aa66a433dbd4a7b66da3f5c2140b4012f1f62fce557f7901114b32a2958e02`.

| Scenario | Verdict | Evidence |
| --- | --- | --- |
| Frozen install and production bundle | pass | README commands; 7.83MB WASM asset, large JS bundle warning |
| Full browser process restart with same profile/identity | pass | persistence.test.mjs; distinct CDP browser PIDs and equal public keys |
| Second tab cooperative writer rejected before DB access | pass | persistence.test.mjs, Web Locks |
| Actual crypto DB loss with retained identity marker refused | pass | persistence.test.mjs |
| Trusted independent browser peer's exact old event survives restart | pass | live.test.mjs, real Synapse and two Chromium profiles |
| Fingerprint mismatch refused; correct fingerprint locally verified; trust survives restart | pass | live.test.mjs |
| Cleared actual IndexedDB cannot decrypt prior peer event | pass | live.test.mjs; sender stopped before deletion to prevent new sharing masking loss |
| Lost-response local transaction reconciliation | pass, local projection | seams.test.mjs |
| Restrictive deployed CSP, other browsers, full profile-loss recovery | not-tested | not inferred from Chromium |

Commands: `pnpm --dir experiments/browser-crypto install --frozen-lockfile`, `build`, `test`, `test:live` (same --dir). Offline tests: 3 pass. Live test: 1 pass, no skips (initial core lifecycle run 52.99 seconds). Live tests use backend/check.ts's isolated random Docker project with digest-pinned Synapse1.161.0/Postgres16.15, ephemeral accounts, keys and volumes; teardown runs in finally. The browser experiment owns both peer endpoints.

The browser's peer trust is an explicit out-of-band public fingerprint comparison followed by SDK `setDeviceVerified`; it is not an exercised SAS/QR ceremony or cross-signing recovery. The SDK has `globalBlacklistUnverifiedDevices=true`. The companion headless proof exercises rejection of key sharing before local verification. Database loss changes SDK public keys; the unguarded disposable live peer observes failure to decrypt the old event, while the lifecycle wrapper prevents reopening a changed identity as the old trusted device.

UI seams: `RoomEvent.Timeline` and `LocalEchoUpdated` feed an owned projection; `getId`/`getTxnId` reconcile local echo and acknowledgement, `scrollback` paginates, listener removal disposes the observer. Real live assertions exercise acknowledgement, pagination and no publication after disposal; seams.test.mjs separately covers ambiguous send response and undecryptable indication. Styling remains application-owned and no dashboard is selected.

Initial Vite development prebundling failed WASM MIME resolution; production bundle loading succeeds and is what tests serve. Serve WASM as application/wasm; restrictive CSP must explicitly permit WASM compilation and service connections, but no production CSP was tested. Chromium initially hit resource errors when host /tmp writes returned user quota exhaustion; the harness now uses disposable home-filesystem profiles/scratch directories and cleans them up.

Verdict: the bounded browser identity, peer-history persistence, lost-key and UI seams are demonstrated. No recovery promise follows: deletion of the entire profile also deletes the independent marker. Matrix remains a candidate, not a selected product substrate. No production token, private key or message body is included in evidence.

Review correction: observed events subscribe to MatrixEventEvent.Decrypted, update their existing row after asynchronous recipient decryption, and detach those listeners on disposal. The delayed-decryption regression first failed with an undefined body, then passed after the fix; the live recipient projection also asserts decrypted content.
