# Owner-local headless verified-sharing proof

This experiment investigates the verified-only sharing limitation found in the older native bot wrapper, without changing those earlier experiments or patching SDK internals.

Two candidates are distinguished:

* Native `@matrix-org/matrix-sdk-crypto-nodejs`0.6.6 exposes `OnlyTrustedDevices` and verification inspection, but no public local trust setter for independent users' devices. It requires Node24 or newer. Its capability test reports that bounded limitation.
* A TypeScript supervisor runs the supported browser `matrix-js-sdk`42.4.0 Rust/WASM implementation in owner-local headless Chromium. Real IndexedDB persists keys/trust. Public `setDeviceVerified` and `globalBlacklistUnverifiedDevices` implement the sharing policy. This adds a browser process dependency; it is not pure-Node native crypto.

```sh
pnpm --dir experiments/headless-verification install --frozen-lockfile
pnpm --dir experiments/headless-verification build
pnpm --dir experiments/headless-verification test
pnpm --dir experiments/headless-verification test:live
```

Use Node24 for the native0.6.6 capability test. The browser-supervisor live proof also passes on Node22.23.2; that path does not import the newer native package. The live test requires local Docker, `/usr/bin/chromium` (override `CHROMIUM_PATH`), and sufficient home-filesystem space. Build before running live tests. The browser runtime is served only on loopback for this experiment; all homeserver credentials pass through private process IPC and browser evaluation, never CLI arguments or logs.

The live test launches two separate TypeScript worker processes with persistent Chromium profiles and distinct disposable users. It observes missing room keys before verification, rejects a wrong fingerprint, locally verifies both devices using compared public fingerprints, then decrypts peer events in both directions. After full supervisor/browser exit, a new process retains device keys, trust and the exact prior peer event. Revocation plus a new outbound session withholds keys again. Only SDK missing-key failure codes can satisfy withholding; transport errors, plaintext responses and unrelated decryption failures throw.

The backend fixture creates a random Docker project with disposable Synapse/Postgres accounts and volumes. Profiles/stores/scratch directories and containers are removed in finally. Parent IPC disconnect closes the browser. Chromium's profile ownership supplies process exclusivity; production supervision, sandbox packaging, secret provisioning and host hardening are not implemented here.

Local fingerprint verification is not an exercised SAS/QR ceremony or cross-signing recovery. Revocation prevents future key sharing after session rotation; it cannot retract previously shared keys. Keys remain readable to the owner OS user. No fake IndexedDB, private SDK patches, custom protocol or custom crypto is used.
