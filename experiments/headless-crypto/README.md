# Headless native crypto feasibility harness

This isolated experiment uses `matrix-bot-sdk`'s actual transitive Rust native binding and its `RustSdkCryptoStorageProvider`, plus an independent browser peer. It uses existing SDK crypto throughout.

```sh
pnpm --dir experiments/headless-crypto install --frozen-lockfile
pnpm --dir experiments/headless-crypto build
pnpm --dir experiments/headless-crypto test
pnpm --dir experiments/headless-crypto test:live
```

The binding's installer downloads a platform artifact from its upstream GitHub release. The lockfile pins the npm wrapper; the evidence records the observed native binary hash separately. Only Linux x64 GNU was tested. Node22.23.2 and Node24.18.0 ran the real native-store test successfully.

Offline tests use fresh ignored `stores/` directories, encrypt a local self-event, terminate the process, and decrypt the same event after reopening SQLite. They also exercise duplicate writers, SIGKILL, corruption and missing identity.

`test:live` requires local Docker and uses backend/check.ts to provision a random disposable Synapse/Postgres project. The experiment-owned browser peer and a separate native process exchange real encrypted events in both directions. The browser rejects an incorrect fingerprint and withholds keys from an unverified native device, then permits sharing after correct local verification. Browser trust/history survive restart; native identity, old peer history and offline events survive SIGKILL and reconnect with the persisted sync token. Profiles, stores, containers and volumes are cleaned up. Credentials travel only in browser evaluation or private process IPC, not command arguments/logs.

Important negative result: the tested native wrapper has no public device-verification API, and its default sharing reaches the unverified browser. Bidirectional decryptability does not prove symmetric verified-only sharing. This exact wrapper is unsuitable for that production policy until a supported verification interface is selected and tested. See the evidence for this bounded candidate result; no private SDK mutation or custom crypto bypass is introduced.

Store custody is local. The SDK is initialized with the bot provider's empty passphrase pattern; do not infer meaningful at-rest secrecy. Initial directories use mode0700 and fixture/identity/lock files use0600, but the same OS user can read them. The lock is cooperative and deliberately requires an explicit stale-lock recovery step after SIGKILL; it is not a distributed lock. Never point this disposable harness at a real account store.
