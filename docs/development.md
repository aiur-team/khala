# Development

Use Node **22.23.2** (also recorded in `.node-version`) and **pnpm 10.34.5** (the root `packageManager` pin). Install that Node release with your preferred version manager, then enable Corepack or install the exact pnpm release. Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

`pnpm check:boundaries` runs the import graph check directly. CI runs the same commands. New adjacent `src/**/*.test.ts` or `.test.tsx` tests are automatically discovered by each package's Vitest script. Empty package shells require no fake tests. Root Node tests cover the boundary checker. Experiments have isolated manifests and lockfiles and are excluded from workspace installation and production builds.

| Package | Responsibility |
| --- | --- |
| `@khala/web` | Browser features, shell, and browser composition |
| `@khala/control` | Request-lifetime control functions and composition |
| `@khala/connector-app` | Continuous owner runtime and composition |
| `@khala/contracts` | Separate messaging and delivery ports and opaque types |
| `@khala/messaging` | Browser messaging, channel, revocation, and recovery adapters |
| `@khala/connector` | Owner storage, subscription, dispatch, and retention |
| `@khala/harnesses` | Claude and Codex adapters |
| `@khala/policy` | Pure release and trust decisions |

Package exports reserve owned subpaths (`@khala/contracts/messaging/<module>`, for example); they do not promise a module exists. Export targets are TypeScript source for workspace consumers and bundlers. `pnpm build` first checks boundaries, typechecks packages, then emits each package's own production modules to `dist/`, excluding adjacent tests. These intermediate modules are not standalone deployment bundles. Platform integration owners provide final bundling and deployment after the frontend/runtime decisions. There are no fake production entrypoints or fixture exports.

Contracts never depend on implementations or apps, and messaging/delivery domains do not import one another. Feature and implementation modules consume contracts through injected ports. Only composition directories bind implementations. Browser imports must never reach owner storage, harnesses, control code, Node builtins, or native crypto. Policy imports remain local or contractual. The checker follows literal static/dynamic imports, re-exports, require calls, and TS path aliases. Unanalyzable dynamic imports in browser, policy, or contracts fail closed. This is an architectural check, not an audit of third-party package internals; external dependencies require review for their target environment.

The Executor owns root and package manifests, the root lockfile, shared compiler/test configuration, and CI after bootstrap, until explicitly reassigning that role. Feature workers propose exact dependency versions to that owner; only one writer updates the root lockfile. Use isolated issue worktrees for independent work. Review contract changes with both producers and consumers. Keep tests beside their owner and avoid shared barrels or importing another worker's unfinished implementation. Integration owners own the small central registration/entrypoint edits; feature workers add only their assigned registration modules.

Live Playwright suites belong under `tests/integration/**/*.spec.ts` and run with:

```sh
KHALA_E2E_LIVE=1 KHALA_E2E_DISPOSABLE_ENV=<disposable-environment-id> pnpm test:integration
```

Missing live configuration fails explicitly. Zero collected tests also fails. Bootstrap CI intentionally does not claim live integration evidence while those suites and disposable services are absent. Each future suite declares its actual service configuration and disposable identities; never point tests at production. KHA-137 owns the separate E2E and conformance runners.
