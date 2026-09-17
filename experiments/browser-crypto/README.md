# Browser crypto feasibility harness

This isolated experiment uses the real Matrix JS SDK and Chromium IndexedDB, with disposable trusted browser peers. It is not a product client.

Run from the repository root:

```sh
CI=true pnpm --dir experiments/browser-crypto install --frozen-lockfile
pnpm --dir experiments/browser-crypto build
pnpm --dir experiments/browser-crypto test
pnpm --dir experiments/browser-crypto test:live
```

Chromium defaults to `/usr/bin/chromium`; override `CHROMIUM_PATH` for another installed executable. Temporary profiles are created under ignored `profiles/`, browser scratch directories under `~/.cache/`, then deleted. This avoids the observed host `/tmp` user quota. The test uses a full process exit, checks distinct process IDs, and compares SDK public identity keys after reopening the same profile. It deletes the actual IndexedDB stores while retaining the identity marker to exercise lost-store refusal. The Web Locks lease prevents a second cooperative writer before SDK initialization. A marker stored in the same browser profile cannot detect loss of the entire profile: new-device enrollment must handle that separately.

Tests serve the production bundle because SDK WASM resolution through Vite dependency prebundling failed during development. The emitted WASM asset must be served as `application/wasm`; a production CSP requires explicit WASM compilation allowance (`wasm-unsafe-eval`) and appropriate connect destinations. No restrictive CSP deployment has been tested.

`test:live` requires local Docker and imports the repository's isolated backend provisioning fixture. It creates two disposable accounts and browser profiles, compares device fingerprints out of band, verifies them locally, exchanges encrypted events and checks the exact old event after full process restart. Deleting the actual crypto databases makes the old event undecryptable. The same live run exercises SDK timeline subscription, local echo acknowledgement, pagination and observer disposal. SAS/QR ceremony and cross-signing recovery are not tested. No production credentials are used; the fixture removes its random containers and volumes in finally.
