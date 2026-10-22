# Confirm and join (stream B), 2026-10-22

Sources: `confirm-link-bugs.md`, `invite-ux-research.md`, Khala findings F-A, F-F and Aiur #5.

## PR 1: the confirm link works in any tab or browser (F-F)

1. **Per-flow login cookie** (`apps/control/src/auth/callback.ts`). The login cookie is named `__Host-khala_login-<16 hex of hash(state)>`. The callback reads the cookie named from its own `state`. A second sign-in (another tab, a double tap, an iOS link preview) no longer overwrites the first one's binding. A callback with no cookie for its state clears nothing.
2. **No raw 400** (`composition/human/handlers.ts`). `login_expired`, `login_replayed` and `state_mismatch` redirect `303 /?sign_in=expired`. Other rejections redirect to `/?sign_in=error`. Each rejection code is logged through the existing callback diagnostics hook.
3. **Retry keeps `joinId`.** `beginSignIn` stores the return path in `sessionStorage` (`sign-in-return.ts`). The landing page shows "Sign-in expired. Try again", and the link signs in again to that path. Decision: this is client-side because the server has no return path once the login record is gone.
4. **The server invites the agent** (`agent-join/agent-routes.ts` `/ready`, `matrix.ts` `inviteAgentAsOwner`). It invites as the owner through `controlLogin(ownerId)` before it marks the join ready. If the invite fails, the route returns 503 and the join stays `claimed`. Done in `/ready` rather than in the human status poll, so the human can close the tab.
5. **A light `/agent/confirm` entry** (`composition/human/confirm-page.tsx`, `main.tsx`). It reads identity, sends signed-out visitors to sign-in, runs the username gate, then runs the confirm controller. It has no Matrix client, device lock or tab handoff. The in-app route now only links to a full load. This deletes the dead browser invite (`inviteWithHistory`, the `invite` port and `invite_failed`) and the confirm special cases in `mount.tsx`.

**Trade-off (accepted):** the browser invite carried the MSC4268 encrypted-history bundle. A server invite cannot carry it. Agents added this way see earlier messages as undecryptable placeholders. Only a human's first, cross-signed device could share history anyway (contracts C13), so cold Safari already lost it. This is documented in `docs/user-guide.md`.

## PR 2: join in any order (F-A)

- `JoinRecord.sealedInvite`: the invite ref the agent used, sealed with AES-GCM under `invitationHmacSecret`. The key label is distinct and the AAD is the joinId. It is never returned to a client.
- View GET: when the viewer is not a member, `admission.inspect` runs. The results map as follows: `eligible` adds `access: 'join'`; `identity_mismatch` gives 403 `wrong_account`; `expired` or `revoked` gives 410 `invite_unavailable`. A legacy record without the field keeps `not_member`.
- Confirm POST: when the viewer is not a member and the record has `sealedInvite`, run `admission.admit` with a deterministic operation id (`agent-join.<joinId>.<owner hash>`). The device id is synthetic, so no browser device is needed. Then the existing `confirm()` runs. `autoConfirm` never admits.
- Web: the button reads "Join <channel> and add <agent>". The page adds copy for wrong-account and invite-gone. The HTTP error code is read from the body.
- Copy: `JoinScreen.tsx` "join here first", `docs/settings.md`, `docs/user-guide.md` and `AGENTS.md`.

## PR 3: `khala_status` after confirm (Aiur #5)

- While the confirmed agent waits for its invite and history, `khala_status` reports `state: "joining"` with a detail that explains the step, inside the existing status contract. Update the AGENTS.md tool table.

## Verification

Targeted vitest runs for the touched files, typecheck for `apps/web`, `apps/control` and the agent package, and the agent-confirm and landing browser specs. No deploy.
