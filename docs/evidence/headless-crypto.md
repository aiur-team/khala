# KHA-142 headless crypto observations

Observed 2026-09-17 on Linux7.1.4-arch1-1 x86_64 GNU. Offline and real live interoperability tests passed on both Node22.23.2 and Node24.18.0. matrix-bot-sdk0.8.0 (npm gitHead `2af2415240b27edd3b61ace7de1c175d1f2358ae`) resolves @matrix-org/matrix-sdk-crypto-nodejs0.4.0. The independent browser peer pins matrix-js-sdk42.4.0/Playwright1.55.1/Vite7.1.12. Lock SHA256: `f31297bf3249b3f461d1eb57d7e44b9dbc40a2a2ce71ae343d7d16a29d77718a`.

Native installer fetched matrix-sdk-crypto.linux-x64-gnu.node from upstream GitHub v0.4.0. Observed binary SHA256: `7078d4dd987128f79afd192c4f621f64adece37e43f2a8756f1d0a9f034de718`. npm wrapper integrity does not authenticate the separate downloaded binary. Other platforms/libcs and missing-library environments remain untested.

| Scenario | Verdict | Evidence |
| --- | --- | --- |
| Frozen install, TypeScript check, native import | pass | README commands |
| SQLite identity/exact prior encrypted self-event after process exit | pass | restart.test.mjs, different PID/equal public keys |
| Duplicate cooperative writer, corrupted SQLite, missing identity | pass, fail closed | restart.test.mjs |
| SIGKILL with explicit stale-lock recovery | pass | restart.test.mjs and interoperability.test.mjs |
| Actual native/browser encrypted exchange in both directions | pass | interoperability.test.mjs, server event type asserted encrypted |
| Browser blocks room-key sharing to unverified native device | pass | native cannot decrypt pre-verification event; new session after verification decrypts |
| Wrong fingerprint refused; correct native fingerprint locally verified in browser | pass | interoperability.test.mjs |
| Browser trust and exact old native event survive browser restart | pass | interoperability.test.mjs |
| Native old peer event and offline peer event decrypt after SIGKILL/reconnect | pass | interoperability.test.mjs |
| First real native sync request uses persisted since token | pass | ObservedClient records actual doSync token against persisted token |
| Native verified-only sharing policy through supported public API | unsupported in tested wrapper | runtime CryptoClient.setDeviceVerified absent; installed public declarations expose no verification API |
| SAS/QR ceremony and cross-signing recovery | not-tested | local fingerprint verification is narrower |

Commands: `pnpm --dir experiments/headless-crypto install --frozen-lockfile`, `build`, `test`, `test:live` (same --dir). Offline: 3 pass. Live: 1 pass, no skips, 46.86 seconds on final strengthened run. Node22.23.2 live run also passed (46.21 seconds): from the experiment directory run `/home/everdred/.local/share/mise/installs/node/22.23.2/bin/node --import tsx --test tests/interoperability.test.mjs`. Native child processes inherit that same Node22 executable.

Live proof owns an independent browser peer under peer/, uses backend/check.ts only for random disposable Synapse/Postgres provisioning, and never imports KHA141 code. Separate native processes communicate via private IPC; credentials never enter command arguments or logs. Synapse receives ciphertext events, checked before decryption. Containers, volumes, profiles and stores are removed in finally. Public keys/event IDs are compared in-process, not published.

Concrete limitation: browser verifies native by an explicit out-of-band fingerprint comparison. The reverse direction uses the bot SDK's observed default sharing to an unverified browser. There is no exposed symmetric verification setter in the tested public CryptoClient/native0.4 API. Therefore successful bidirectional decryption does NOT establish symmetric verified-only sharing. Reject this exact wrapper as a production verified-only sharing implementation unless a maintained supported verification interface is selected and exercised. Do not patch private SDK state or create custom crypto to bypass this result.

Source/runtime corrections: bot type-level RustSdkCryptoStoreType has no usable runtime named export, so the harness resolves the actual transitive native StoreType; getEvent transparently decrypts, therefore ciphertext checks use getRawEvent. Initial live failure from checking getEvent as ciphertext was corrected and rerun. Native custody is owner-local with empty passphrase pattern and mode0700 directories; this is not meaningful at-rest secrecy against the same OS user. Cooperative writer lock remains after SIGKILL and is removed only after process exit is observed.

Verdict: native durable identity, encrypted peer history and reconnect work on the tested platform. The verified-only sharing limitation is a negative candidate result, not a skipped live test or a product substrate decision. No production token, private key or message body appears in evidence.

Review correction: missing-key retry now fetches and asserts ciphertext outside its catch, and recognizes only the actual native0.4 GenericFailure/missing-room-key error shape. HTTP failures, plaintext responses and arbitrary SDK errors propagate unchanged. Dedicated regression tests cover these false-positive cases; the real key-withholding/interoperability proof was rerun successfully (46.86 seconds).
