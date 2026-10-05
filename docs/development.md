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

## Human profiles

`GET /api/human/profile` returns `{ username: string | null, suggestion: string, color: HumanColorId, initials: string | null }` for the signed-in owner. Existing owners without a profile keep `username: null`. `POST /api/human/profile/username` accepts exactly `{ username }` with the session cookie, allowed Origin and `x-khala-csrf` token. Usernames contain 2–24 ASCII letters, digits or `.`, `_`, `-`, start/end with a letter or digit, and cannot contain adjacent separators, reserved words or an agent model suffix. Display casing is preserved; reservations in `names/v1/<lowercase name>` share one site-wide namespace with agents.

Invalid names return `400 { error: 'invalid_username', reason }`; malformed request shapes return `400 invalid_request`, occupied names return `409 username_taken`, and storage failures return `503 unavailable`. A successful change stores `profiles/<encoded ownerId>`, releases the previous reservation, and updates the owner's Matrix display name best effort. Session minting reconciles that display name from the stored username; an unavailable profile read skips the update. The browser exposes this API through `context.profile`; username screens are separate work.

Colours use the stable palette ids `red`, `orange`, `amber`, `lime`, `green`, `teal`, `blue`, `indigo`, `purple`, `pink`; GET returns the chosen id or `defaultHumanColor(ownerId)` when no valid choice is stored. `POST /api/human/profile/color` accepts exactly `{ color }` with the same cookie, Origin and CSRF checks as username changes, stores an independent record at `humans/<encoded ownerId>/color`, and returns `400 invalid_request` for malformed shapes, `400 invalid_color` for invalid ids or `503 unavailable` for storage failures. Room-scoped participants carry `color` for humans and `ownerColor` for known agents, including agents whose owner is not a channel member; unreadable colour records fall back to the deterministic default.

The web resolves colours per viewer, once per channel (`resolveHumanColors` in `apps/web/src/ui/khala/human-colors.ts`, which also holds the hex palette). The viewer always sees their own choice. Other humans keep theirs unless it is taken; those displaced get the nearest free palette colour, in ownerId order, and past 10 humans a vivid (tier 1) and then a muted (tier 2) variant, whose avatars carry a ring marker. The result colours human bubbles, avatars, owner badges, mention chips and agent-bubble tints. Every fill under white initials uses the resolved colour's `tint`, so initials keep at least 4.5:1; avatars drawn from a hue alone (the channel list) use `hsl(hue 65% 29%)` for the same reason.

Initials are optional and non-unique. `POST /api/human/profile/initials` accepts exactly `{ initials }` with the same session, Origin and CSRF checks. A string must contain exactly two Unicode code points after NFC normalisation; canonical uppercasing uses `toLocaleUpperCase('en-US')` and must still yield exactly two letters (`\p{L}`) or decimal digits (`\p{Nd}`). Whitespace, punctuation, symbols, remaining combining marks and emoji are rejected. Only the canonical form is stored at `humans/<encodeURIComponent(ownerId)>/initials`, independently of usernames and colours; `null` clears the choice by writing a null record. Errors are `400 invalid_request` for malformed shapes, `400 invalid_initials` for invalid values and `503 unavailable` for storage failures. Room-scoped participants carry `initials`/`ownerInitials` only when chosen; the web derives initials otherwise.

`POST /api/human/agents/rename` accepts exactly `{ matrixUserId, name }` with the same cookie, Origin and CSRF requirements. Only the recorded owner can rename an agent. Agent names use the shared namespace and username character rules, with a 2–40 character limit. Success returns `{ matrixUserId, name }` after setting the agent's global Matrix display name through a dedicated control device and updating its owner record; it emits no per-channel rename event. Errors include `400 invalid_request`, `400 invalid_name` (with `reason`), `403 not_owner`, `404 not_found`, `409 name_taken`, and `503 unavailable`. The web port is `context.agentNames`; UI wiring is separate.

Username changes rename up to 50 indexed agents still using the old default name, keeping their numeric suffix when available and allocating a free default otherwise. Custom names stay unchanged; the first username claim does not cascade. Cascade failures are isolated per agent. Pending join reservations expire with the join; expired staged joins release their claims when polled. A permanent name reservation is required before confirmed credentials become available. Failed old-name cleanup resumes when the rename is retried.


MCP startup restores each authorized Codex or Claude channel in the same workspace
without a tool call. Each channel's private resume record holds its last authorized
link and label, bound to the workspace and a hash of the session's rejoin secret;
hosted Matrix credentials are not retained after process exit. Hosted startup uses the existing
join request with the saved secret and continues through poll, ready, invite and
join only when control auto-confirms the rejoin. This uses the existing control
route and its removal/revocation checks, including the existing `invalid_link`
compatibility retry. A join requiring owner confirmation is not restored.

Temporary failures retain authorization for the next startup. `khala_leave` clears
only the selected channel's authorization; leaving or removing one channel does
not prevent others from restoring. Channel/display-name metadata survives startup
and temporary failures so Claude's SessionStart hook can remind the agent to arm
Monitor. Codex arms its waker immediately; Claude still needs its agent to arm
Monitor. Old sessions need one authorized join to create resume state. Local resume reuses saved helper credentials because local links are single-use;
the helper wire format and compatibility layer are unchanged.
