# Disposable Matrix connector proof

The opt-in `live.proof.ts` drives the production connector substrate against a pinned
Synapse/Postgres Docker Compose fixture and a second, independent Chromium Matrix
client. It uses random project names, owner-local temporary profiles, and automatic
cleanup of only its own Docker project. No provider model call or real account is used.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm -C experiments/browser-crypto install --frozen-lockfile
pnpm -C experiments/browser-crypto build
pnpm -C apps/connector exec vite build --config vite.matrix.config.mjs
pnpm exec tsx --test apps/connector/src/substrate/browser-harness/live.proof.ts
```

The proof asserts that an unverified recipient has no decryptable Megolm key;
wrong fingerprint trust is denied; a post-verification encrypted event decrypts
with the sender's verified Matrix device ID; Synapse stores ciphertext; a second
writer cannot open the same profile; an independent Chromium restart preserves
fingerprint and cursor replay; Synapse outage reports unavailable and recovers;
and deleted crypto profile refuses startup. The experiment peer rotates its
outbound session with the SDK's public `forceDiscardSession` after trust so an
older pre-verification session cannot silently continue without sharing a key.

The production bootstrap must supply a durable credential for the same Matrix
user/device and call `trustPeer` only with an authenticated, owner-approved
fingerprint attestation. The substrate itself does not issue credentials or
infer trust from the Matrix device list.
