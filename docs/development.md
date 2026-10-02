# Development

Use Node **22.23.2** (also recorded in `.node-version`) and **pnpm 10.34.5** (the root `packageManager` pin). Install that Node release with your preferred version manager, then enable Corepack or install the exact pnpm release. Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Local stack and live tests

Install the prerequisites in [infra/local/README.md](../infra/local/README.md). `pnpm stack:logs` shows all logs; add a service name such as `synapse` to select one. `pnpm stack:down` stops services and retains data. The stack persists across test runs; `pnpm stack:down --wipe` deletes its local data and secrets.

```sh
pnpm stack:up
pnpm stack:status
pnpm exec playwright install chromium
source .khala-local/e2e.env
KHALA_E2E_LIVE=1 pnpm test:integration tests/integration/human/create-share-chat.spec.ts
pnpm --filter @khala/agent test:live
```

Live agent tests use the stack and are excluded from default unit tests. Follow [four-party acceptance](../tests/acceptance/m1-local.md) for harness setup and manual verification; [local acceptance evidence](evidence/m1-local-acceptance.md) records versions, results and known gaps. Keep local state and credentials private; never point these tests at production.

## Packages

| Package or app | Path | Responsibility |
| --- | --- | --- |
| `@khala/contracts` | `packages/contracts` | Wire and record types at `@khala/contracts/m1/<module>` |
| `@khala/web` | `apps/web` | Browser app |
| `@khala/control` | `apps/control` | Netlify functions |
| `@khala/agent` | `packages/agent` | MCP server, hooks, wakers, plugin and config; bin `khala`, TypeScript via `tsx` |
| `@khala/messaging` | `packages/messaging` | Browser Matrix helpers |

Tests live beside their owners. Run `pnpm --filter @khala/web test` or the corresponding package's test script for focused validation. `pnpm check:boundaries` checks imports; browser code must not reach Node builtins or server implementations. Experiments have isolated manifests and lockfiles and are excluded from workspace installation and production builds.

The Executor owns shared manifests, the root lockfile, compiler/test configuration and CI. Propose dependency changes to that owner. Use isolated issue worktrees and review contract changes with producers and consumers.
