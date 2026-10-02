# M1 Node Matrix agent crypto evidence

KM-110 / plan U2 / AE1 (R4, R8). Live run **2026-10-02T05:40:45.225Z** (2026-10-01 Pacific), implementation commit **`877462a08a419ec66e38dc24e17511967a2cc194`**. Results were written to the git-ignored `.khala-local/results/m1-node-matrix-agent.json`; this document captures their observed values. The subsequent evidence commit adds documentation and DOM iterable type declarations, with no runtime crypto change.

## Versions and timings

| Component | Observed version |
| --- | --- |
| Node | v24.18.0 |
| matrix-js-sdk | 42.4.0 |
| Rust crypto | Rust SDK 0.19.1 (a3d573d), Vodozemac 0.11.0 |
| Synapse | 1.161.0 |
| Chromium | 150.0.7871.128 |
| Browser build / harness | vite 7.3.6 / playwright-core 1.63.0 |

| Measurement | Milliseconds |
| --- | ---: |
| Fresh `createAgentMatrixSession` to ready | 5533 |
| Invite call to first successful decrypted history page | 555 |
| Factory call to first successful decrypted history page | 6088 |
| H2-room fresh agent ready | 5278 |
| Restarted existing-user device ready | 3170 |

The first-history timings include the invite request, synced invitation, join and history query; they measure the completed page, rather than the instant a single event decrypted. Every human used a separate Chromium context and a fresh Matrix account. The agent uses an in-memory store and a new device per process.

## Scenarios 10–15

| Scenario | Expected | Observed | Outcome |
| --- | --- | --- | --- |
| 10 / AE1 | Self-signed human invites fresh self-signed agent; recover all three pre-invite messages | `one`, `two`, `three`, newest-last, `history_undecryptable=0`. A real context/messages page before `three` returned exactly `one`, `two`. | Pass |
| 11 | Browser decrypts the agent's send within 20 seconds | Browser received `agent-hello` with the agent's sender ID. | Pass |
| 12 | Own sends excluded from live intake, included in history | Live intake contained only `four`; history included `agent-hello` and the three older messages. | Pass |
| 13 | Human's post-join message reaches live intake; pre-join messages do not; synced display name available | `four` received from H1, none of `one`/`two`/`three` emitted live; `displayName(H1)` was `Maya`. | Pass |
| 14 | Unsigned inviter cannot share history, but can send live text after agent joins | `pre` omitted; `history_undecryptable=1`. `post` decrypted live. No crash. | Pass |
| 15 | Restart with new device reports unavailable existing identity; try live `five` and observe old history without throwing | `cross_signing=unavailable_existing_identity`; no live `five` after 20 seconds; history empty with `history_undecryptable=6`. No throw. | Finding |

Scenario 15 is a recorded limitation, not repaired by widening this spike. An existing account's new in-memory device has no private cross-signing keys. Under the pinned default device-isolation policy, this observed device could not decrypt either the old messages or the new `five`. Fresh account/device sessions passed AE1. No blacklist or isolation policy was changed, and no persistent crypto shim, key backup, or reconnect loop was added.

Representative session diagnostics (no credentials or product message bodies):

```text
crypto_version=Rust SDK 0.19.1 (a3d573d), Vodozemac 0.11.0
cross_signing=bootstrapped
sync_state=PREPARED
session_ready_ms=5533
history_undecryptable=0
```

Restart diagnostics:

```text
cross_signing=unavailable_existing_identity
session_ready_ms=3170
history_undecryptable=6
```

## SDK facts and integration consequences

- [matrix-js-sdk #4769](https://github.com/matrix-org/matrix-js-sdk/issues/4769) tracks the missing Node persistent crypto backend. In the installed 42.4.0 package, `lib/rust-crypto/index.js:53` calls `StoreHandle.open(null, null)` when IndexedDB is disabled. KTD1 therefore makes device lifetime equal process lifetime.
- MSC4268 history sharing needs room keys created with `history_visibility: shared`, an inviter that self-cross-signs, and recipient devices signed by their owner. Installed SDK `lib/rust-crypto/rust-crypto.js:1307–1340` checks inviter verification, bundles history and uses `CollectStrategy.identityBasedStrategy()`. `lib/client.js:2766–2777` invokes sharing automatically on invite unless visibility is `invited` or `joined`. The browser fixture sets shared visibility and encryption at creation, before sending.
- `joinRoom` needs the invitation already in synced room state to identify the inviter (`lib/client.js:1435–1465`). In live testing, `Room.myMembership` fired before a newly invited room was stored; the session also watches `ClientEvent.Room`, which follows storage, to avoid losing that invite notification.
- Bundle acceptance lasts 24 hours after joining (`lib/rust-crypto/rust-crypto.js:51,1411–1419`). Import re-queries the inviter's cross-signing identity (`:219–266`). The AE1 run confirms authenticated media upload/download works through this stack's client listener: no 401/404 occurred.
- KM-143 must report ready only after the factory resolves. KM-134 must invite only after ready, so the fresh agent's signed device exists before bundle distribution. Each M1 agent process needs a fresh account (C4); reusing an account with a new in-memory device enters `unavailable_existing_identity` and does not reproduce AE1.

## Reproduction and validation

```sh
pnpm install
pnpm --filter @khala/agent test
pnpm --filter @khala/agent typecheck
pnpm stack:up
pnpm --filter @khala/agent test:live
```

On this agent host, the measured run used `KHALA_STACK_PROJECT=khala-km110-833-preview` on both stack and test commands. Before the base branch's namespace fix, the default project failed `invalid-state-namespace`; that upstream fix is now merged into this implementation branch. Run stack startup and the live test in the same shell tool invocation on this managed host: tool shutdown terminates detached gateway/Netlify processes. Chromium uses a unique short temporary directory to stay within Unix socket path limits and a writable fixture config directory. Node uses the stack CA certificate; TLS verification stays enabled.

The default agent test command excludes `*.live.test.ts`, including with `KHALA_E2E_LIVE=1`. The opt-in live command completed four tests covering scenarios 10–15; a green exit records permitted scenario 14/15 findings rather than claiming every scenario passed. Fake-client tests cover cross-signing outcomes, first-sync readiness, invite ordering/timeouts, delayed join sync/cancellation, live eligibility/deduplication/channel events, pagination/decryption omissions, display names and cleanup.

Final local checks: all 238 agent tests, full repository typecheck, lint (including boundaries/terminology), and build passed. The broader `pnpm test` stopped at two existing CLI package-gate tests requiring `dist/khala-internal.js`, `dist/internal-web/index.html`, and the internal bundle metafile. The same gate fails when rerun serially after a successful build: the base's `packages/agent-cli/scripts/bundle.mjs` defaults `internalEntryPoint` to null while `scripts/agent-cli-package-gate.mjs` still requires those artifacts. Neither file is changed by KM-110. This is a separate base-branch packaging issue, not a green full-suite claim.
