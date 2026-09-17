# Headless verified-only sharing follow-up

This follow-up preserves KHA-142's original negative native-wrapper result. It tests newer public OSS interfaces and an alternative runtime rather than changing earlier evidence.

Recorded 2026-09-17 on Linux7.1.4-arch1-1 x86_64 GNU, Node24.18.0, pnpm10.34.5, Chromium150.0.7871.128. Exact dependencies: matrix-js-sdk42.4.0, matrix-sdk-crypto-nodejs0.6.6, Playwright1.55.1, Vite7.1.12, TypeScript5.9.3, tsx4.20.6. Isolated lock SHA256: `aebeab3c9a46c3616c828126de915238150e4e329bf8db2a38e1b1a11b8b581c`.

Native0.6.6 tag resolves to commit `d71b99cc0b5bd06597a7dc718a73eb4e4ff6d3f1`. Installed linux-x64 GNU artifact SHA256: `aeb21029ac6bb29cd06493f67b19a5a75b3d0371a1ab452fe59f78249350f0f7`. Its separate GitHub binary download is not authenticated by the npm wrapper's lock integrity alone.

## Native interface result

Installed public declarations and actual runtime prototypes expose `EncryptionSettings.sharingStrategy=CollectStrategy.OnlyTrustedDevices`, `OlmMachine.getDevice` and `Device.isVerified`. They do not expose `Device.setLocalTrust` or `OlmMachine.setDeviceVerified`, and declaration inspection found no independent-user trust establishment interface. Secret-storage import concerns the account's own cross-signing secrets; it is not evidence of verification for an independent human/agent identity. Native0.6.6 also declares Node>=24. This exact native package remains unsuitable for the tested independent-device local-verification workflow without another maintained public interface.

Matrix JS42.4.0's installed README explicitly documents pure-Node `initRustCrypto({useIndexedDB:false})` as ephemeral and requires a fresh device after restart. No durable pure-Node store capability is inferred from WASM initialization.

## Headless Chromium result

The alternative uses TypeScript supervision plus the SDK's supported browser environment: a real owner-local headless Chromium process and real IndexedDB. Both endpoints use public Matrix JS APIs; the experiment contains no private SDK mutations or protocol/crypto implementation.

`tests/verified.test.mjs` exercises two independent disposable users on real Synapse/Postgres:

| Scenario | Result |
| --- | --- |
| Unverified recipient cannot decrypt new event | pass, explicit SDK missing-key category |
| Wrong out-of-band fingerprint | rejected |
| Correct fingerprint, locally verify both devices | pass |
| Verified encrypted peer exchange in both directions | pass |
| New supervisor/browser process, same profile | same device keys, distinct process PID |
| Persisted peer verification and exact old peer event | pass |
| Revoke trust and rotate outbound session | new event cannot decrypt at revoked recipient |

Raw server events must be `m.room.encrypted`. Only `MEGOLM_UNKNOWN_INBOUND_SESSION_ID`, `MEGOLM_KEY_WITHHELD`, or `MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE` classify withholding. Transport failures, plaintext responses and unrelated decrypt errors fail the test. This avoids treating an arbitrary timeout as a successful security check.

Observed verification: frozen install and TypeScript/production bundle pass; capability and worker-shutdown suite 4/4 pass; Node24 live suite 1/1 pass, zero skips, 37.11 seconds; Node22.23.2 live suite also 1/1 pass, zero skips, 33.56 seconds. The Node22 run executes its node binary with --import tsx --test tests/verified.test.mjs from the experiment directory, and child supervisors inherit that binary. Native0.6.6 capability import remains Node24-only by its declared engine requirement; the successful Node22 browser-supervisor path does not import it. Initial build caught an incorrect enum import; corrected to the SDK public crypto-api entry point before the successful live run.

Reproduction: use the isolated README's frozen install/build/test/test:live commands. The backend fixture provisions a random disposable Docker project; the candidate owns its own peer, process supervisor, profiles and lockfile. No imports from earlier crypto experiments are required. Tokens travel only over private IPC/browser evaluation and are excluded from logs. Tests clean up their own containers, volumes, profiles and scratch directories.

## Integration implication

A maintained public verified-only sharing path is available **with an owner-local headless browser runtime**. It carries Chromium installation, update, resource and process-supervision costs, plus real profile custody. It is not proof that the native bot wrapper supports verification, not a pure-Node persistence adapter, and not a selected production deployment.

The proof uses explicit public fingerprint comparison and local verification, not SAS/QR ceremony or cross-signing recovery. A compromised same-user host can read keys. Revocation cannot revoke already shared session keys; the test rotates sessions before checking future sharing. Production integration must supervise browser shutdown, protect profiles and provide an authenticated trust ceremony. The standalone supervisor is experiment code, not production approval.

Review correction: shutdown subscribes before requesting disconnect, recognizes already-exited/disconnected workers, escalates to SIGKILL with a bounded deadline, and runs filesystem cleanup in finally. Regression tests cover an unexpectedly exited worker and an uncooperative worker. The live verified-sharing proof was rerun after the fix.

Post-review live rerun passed 1/1, zero skips, 33.52 seconds. The first rerun exposed a peer key-delivery delay beyond the old 10-second wait; the experiment now requests a 1-second sync poll and allows 20 seconds for expected decryption, while unverified tests retain their short explicit missing-key check. This timing adjustment does not convert unrelated errors to missing-key evidence. The failed run also completed cleanup without leftover stores or fixture containers.
