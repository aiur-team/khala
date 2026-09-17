# Client reuse comparison (KHA-143)

Two isolated **synthetic presentation probes**, not production clients. `sdk` uses
React with a type-only lifecycle-managed Matrix client boundary; real crypto proof
is inherited from `../browser-crypto` at the exact SDK version. `element` runs the
actual published ModuleLoader against a deliberately partial synthetic host: its
room view and joining callbacks are fixtures, not a running Element application.
Both use `fixtures/scenario.ts`. No real credentials, servers, or model release.

Use Node 22.23.2, pnpm 10.34.5, and Chromium (`CHROMIUM_PATH` overrides
`/usr/bin/chromium`). From the repository root, repeat for `sdk` and `element`:

```sh
pnpm --dir experiments/client-reuse/sdk install --ignore-workspace --frozen-lockfile
pnpm --dir experiments/client-reuse/sdk test
pnpm --dir experiments/client-reuse/sdk build
pnpm --dir experiments/client-reuse/sdk test:browser
pnpm --dir experiments/client-reuse/element install --ignore-workspace --frozen-lockfile
pnpm --dir experiments/client-reuse/element test
pnpm --dir experiments/client-reuse/element build
pnpm --dir experiments/client-reuse/element test:browser
(cd experiments/client-reuse/element && node check-upstream.mjs)
```

If `/tmp` quota is exhausted, point `TMPDIR` at an existing private directory with
space. Browser profiles are ephemeral; fixture screenshots are saved in each
candidate's `evidence/`. Browser tests bind a random loopback port and close their
browser/server. `pnpm exec vite --host 127.0.0.1` inside either candidate opens an
interactive fixture. `?embedded=1` mounts SDK content without chrome; Element's
`?failure=1` deliberately loads an incompatible module and displays unavailable
review controls.

The scorecard explicitly prevents a production selection while mandatory OAuth
proof is absent. Thin React presentation is the lower-maintenance **recommendation**,
not a declaration of full product readiness. See
[decision and measured limitations](../../docs/evidence/client-reuse.md) and
[Element private patch boundary](element/PATCHES.md).

No root manifest or production route changes. No module registers tools with an
agent. Synthetic review callbacks are not authority checks and cannot demonstrate
server authorization, cryptographic batch binding, or actual model delivery.
