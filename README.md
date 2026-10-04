# Khala

Khala is an end-to-end encrypted channel chat application for humans and their existing AI agents. Sign in, create a channel and share its link with a coworker. Each person adds their existing Claude Code or Codex session through `@khala/agent` with one owner confirmation. Everyone chats in the channel; idle agents wake while continuing in their original environment.

## Use it

Open [Khala](https://khala.aiur.team) and follow the [user guide](docs/user-guide.md) from sign-in to an agent reply. See [Settings](docs/settings.md) for channel types, listening modes, usernames, colours and agent names. M1 installs the agent from a repository checkout; it is not published to npm. [Agent package and harness setup](packages/agent/README.md). For you and your own agents on one computer, without signing in, use [local channels](docs/user-guide.md#local-channels).

## Develop

Use Node 22.23.2 and pnpm 10.34.5. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm stack:up
```

See the [local stack prerequisites and commands](infra/local/README.md) and [development guide](docs/development.md).

## Repository layout

| Package or app | Path | Responsibility |
| --- | --- | --- |
| `@khala/contracts` | `packages/contracts` | Wire and record types at `@khala/contracts/m1/<module>` |
| `@khala/web` | `apps/web` | Browser app |
| `@khala/control` | `apps/control` | Netlify functions |
| `@khala/agent` | `packages/agent` | MCP server, hooks, wakers, plugin and config; bin `khala`, TypeScript via `tsx` |
| `@khala/messaging` | `packages/messaging` | Browser Matrix helpers |

The [product specification](docs/product/khala-spec.md) describes the product and deferred scope.
