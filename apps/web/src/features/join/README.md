# `join` (KHA-124)

OAuth entry and chat admission for a coworker opening a shared invite link. The
ordinary path asks for OAuth sign-in and chat admission only — no Matrix
credentials, homeserver selection or device-key setup screens.

## Shape

- `location.ts` — `RouteCodec`, `parseJoinLocation` (the synthetic/default
  codec used by tests and until `KHA-132` injects the real production route
  mapping), and `buildReturnPath` for the same-origin OAuth return path.
- `model.ts` — `JoinPhase`, `JoinView`, and the pure mappings from
  `InviteState` / `AdmissionRejection` / `DeviceReason` to a `JoinPhase`. Every
  mapping traces back to a canonical port result; `wrong_account` is never
  inferred from a display-email comparison.
- `ports.ts` — `JoinPorts`: the injected `IdentityPort`, `DevicePort`,
  `AdmissionPort`, `RouteCodec` and a `navigate` callback standing in for the
  host's navigation capability (the identity adapter never navigates itself).
- `controller.ts` — `createJoinController(ports)`. Re-inspects admission on
  every `start()`/`retry()` (there is no identity-change subscription —
  `IdentityPort` exposes none), fences every async step's response with a
  lifecycle generation so a superseded attempt cannot mount stale state, and
  creates the `admit` operation ID once per attempt, reusing it across retries
  so a retry after `outcome_unknown` resolves the same attempt rather than
  issuing a second claim.
- `JoinScreen.tsx` / `join.css` — presentational only. It renders exactly
  `view: JoinView` plus `onSignIn` / `onRetry` callbacks; it never imports a
  port and never navigates. Wiring `createJoinController` to this component
  (subscribing to view changes, calling `start`/`signIn`/`retry`) is a
  composition concern owned by the consumer (`KHA-132`).
- `browser-harness/` — a synthetic Vite app used only by
  `join.browser.spec.ts`. It composes the real `createJoinController` and
  `JoinScreen` with in-memory ports and routes OAuth through a same-origin
  `?page=oauth-mock` step so back/forward navigation is real, not simulated.

## Sign-in never loops

The controller only reaches the `sign_in` phase; it never calls
`beginSignIn`/navigates on its own. Navigation happens only from the explicit
`controller.signIn()` call a "Sign in" button click triggers. Returning from a
cancelled or replayed OAuth attempt always lands back on an explicit prompt,
not another automatic redirect.

## Testing

- `location.test.ts`, `controller.test.ts`, `JoinScreen.test.tsx` — unit
  tests using synthetic ports and `react-dom/server` static rendering (this
  repo's convention; see `apps/web/src/shell` for the same pattern).
- `join.browser.spec.ts` — a Playwright-driven Node test-runner spec (named
  `*.browser.spec.ts`, not `*.test.ts`, matching `shell.browser.spec.ts`, so
  Vitest's `**/*.test.{ts,tsx}` include glob does not try to collect it).
  Run it with `pnpm --filter @khala/web test:browser -- src/features/join/join.browser.spec.ts`.
  It proves: browser back from the synthetic OAuth step does not re-enter a
  redirect loop; a long verified email does not overflow at 390px portrait or
  landscape; the raw invite reference never reaches console output; expired,
  revoked and wrong-account outcomes render distinct copy with no retry
  action; and a revoked callback never exposes room content.

None of this proves real OAuth, real admission or real key exchange — that
proof belongs to `KHA-132`, which composes this feature's ports with live
adapters. Live composition can replace every port here (`JoinPorts`) without
changing the journey.

## Known gaps intentionally left to dependency owners

- The queued-introduction preview happens on the room route reached *after*
  `joined` (the plan's journey diagram places it there, not on this screen);
  this ticket owns only the join screen, so `JoinView` carries `roomId` and
  nothing else room-shaped — no `RoomPort`, no title, no body.
- Production route parsing, the real OAuth callback and cross-origin/open-
  redirect handling belong to `KHA-110` / `KHA-131`, tested end-to-end at
  `KHA-132`.
