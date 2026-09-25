---
title: "External Channel Discovery Bootstrap - Plan"
type: feat
date: 2026-09-24
topic: external-channel-discovery-bootstrap
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: docs/product/internal-mode/room-discovery.md
execution: code
deepened: 2026-09-24
---

# External Channel Discovery Bootstrap - Plan

## Goal Capsule

- **Objective:** Authorize an already-running, native-session-verified agent to discover and request external channels through a short-lived, sender-constrained credential without creating a channel, membership, device, binding, or adapter capability.
- **Authority:** The RD2A contract in `docs/product/internal-mode/room-discovery.md`, then `docs/product/internal-mode/executor-decisions.md` items 1–40, then the landed discovery contract and existing bootstrap security guarantees.
- **Execution profile:** Add a sibling channel-less loopback/PKCE client, a control-plane consent and token service with atomic credential rotation, minimal route registration, focused tests, and module documentation.
- **Stop conditions:** Do not route through admission, persist plaintext credentials, trust caller-supplied owner/session identity, add discovery/listing behavior, or widen the three fixed scopes.
- **Tail ownership:** The implementing agent owns focused tests, the wrong-implementation mutation proof, package validation, self-review, draft PR delivery, and CI handoff against `main`.

---

## Product Contract

### Summary

Add a channel-less `loopback-browser-v1` consent flow for external channel discovery.
The connector verifies the native session before opening the browser, the signed-in owner explicitly consents, and the control plane issues a credential bound to the owner, stable requester, exact origin, discovery audience, session generation, and connector proof key.

### Problem Frame

The existing bootstrap flow cannot be reused as an orchestrator because it reserves a connector device, redeems admission, creates a session binding, and returns an `AdapterCapability`.
RD2A needs only authorization to list channels and submit human-gated access or create requests, so it must reuse the proven loopback, PKCE, origin, and DPoP primitives without invoking admission state.

### Requirements

**Consent and issuance**

- R1. Verify the connector's native session before opening the owner browser, then revalidate the authenticated owner and current server-side session authority before issuing a one-time code or credential.
- R2. Use an external browser, an ephemeral IP-literal loopback callback, strict state/path handling, PKCE S256, exact trusted HTTPS origin, and a fresh DPoP proof for the token request.
- R3. Issue a strict `DiscoveryCredential` whose audience is `khala-channel-discovery` and whose scopes are exactly `list_channels`, `request_channel_access`, and `request_channel_create` in contract order.
- R4. Bind the credential to authenticated owner authority, a stable agent principal, exact origin, current session generation, and the Ed25519 public key proven by DPoP.

**Custody, refresh, and invalidation**

- R5. Keep credential plaintext only in connector memory and control responses; durable control state stores only purpose-separated hashes and fixed-size metadata with a five-minute logical lifetime, while connector persistence retains only the pre-existing proof key.
- R6. Refresh through the same token route using the current sender-constrained credential, recheck native session and server authority, rotate the credential atomically, and invalidate the prior value immediately.
- R7. Fail closed on denial, local cancellation, callback mismatch, expiry, wrong owner, wrong origin, wrong audience, proof mismatch, owner removal, or session generation change.
- R8. Expose a bootstrap-owned credential authorizer for later discovery routes that rechecks expiry, scope, proof possession, current rotation, owner activity, and session generation on every use.

**Scope boundary**

- R9. Completing authorization creates no channel, membership, participant, device, binding, admission grant, `AdapterCapability`, visibility record, listing, or access/create journal entry.
- R10. Keep catalog/list routes, visibility policy, request journaling, CLI/MCP output, internal descriptors, and channel creation outside this ticket.

### Acceptance Examples

- AE1. Given a verified native session and a signed-in owner who allows discovery, the connector receives one live credential with the exact fixed audience, scopes, origin, stable principal, proof key, generation, and expiry.
- AE2. Given denial, browser timeout, cancellation before token exchange begins, a forged/duplicate callback parameter, or a failed PKCE/proof check, no credential is issued and no forbidden side-effect store changes. Once token exchange begins, the connector finishes the bounded request; a lost response is an outcome-unknown issuance and requires fresh consent rather than claiming cancellation or reusing authority.
- AE3. Given one live credential, refresh atomically returns a replacement and the prior value fails authorization; two concurrent refreshes produce one winner.
- AE4. Given owner removal or a session rebind before consent, token exchange, refresh, or credential use, the request fails closed without silently accepting the prior owner or generation.
- AE5. Given process restart, the durable connector proof key remains usable for a new consent flow but no prior discovery credential can be recovered from connector storage.
- AE6. Completing the full happy path leaves channel, membership, device, binding, admission, and adapter-capability state unchanged.

### Scope Boundaries

This change owns discovery credential bootstrap under `packages/connector/src/bootstrap/`, `apps/control/src/channel-discovery/bootstrap/`, and minimal control composition registration.
It does not expose channel listings or request endpoints and does not add operator configuration, CLI flags, environment variables, or a new UI surface.

### Sources

- `docs/product/internal-mode/room-discovery.md`, RD2A and the shared authority-boundary design.
- `docs/product/internal-mode/executor-decisions.md`, especially decisions 9, 24, 33–37.
- `packages/contracts/src/messaging/discovery.ts` for the exact credential, requester, audience, scope, and validation contract.
- `packages/connector/src/bootstrap/loopback.ts` and `apps/control/src/agent-bootstrap/handler.ts` for the landed loopback-browser, PKCE, DPoP, consent, and finite-failure patterns.
- RFC 8252 for external-browser loopback redirects and PKCE, RFC 9449 for DPoP on authorization-code and refresh token requests, and RFC 9700 for public-client credential rotation and replay detection.

---

## Planning Contract

### Key Technical Decisions

- KTD1. Build a sibling discovery bootstrap rather than adding a no-op admission mode to `bootstrapAgent` or `createAgentBootstrapHandlers`. The new dependency types omit channel, device, admission, binding, and adapter-capability ports, making the forbidden effects structurally unavailable.
- KTD2. Add a side-effect-free server session-authority port that maps authenticated owner plus native-session coordinates to one stable agent principal and current generation. Recheck it on consent submission, code exchange, refresh, and credential authorization; caller claims never establish owner or stable identity.
- KTD3. Represent each control-side credential as one stable random slot whose record contains the owner, stable principal, origin, audience, generation, verified proof public key/thumbprint, exact scopes, expiry, and only the digest of the current opaque credential value. Authorization codes live for 60 seconds; issued and refreshed credentials live for five minutes. Refresh compare-and-set replaces the digest and expiry in that one slot, so the old value is invalidated atomically without a cross-key revoke step.
- KTD4. Use the existing DPoP verifier and replay store, extending its successful result only as needed to expose the already-verified Ed25519 public key. Never accept a separately posted public key as proof identity.
- KTD5. The connector owns a process-local credential holder with `authorize`, `refresh`, `current`, and `invalidate` behavior. It re-inspects the native session before browser launch and refresh, clears local state on explicit invalidation or authoritative rejection, and never writes the credential into the bootstrap operation ledger or SQLite.
- KTD6. The authorize route supports read-only GET plus CSRF/origin-protected allow/deny POST, and the single token route distinguishes authorization-code exchange from refresh. Cancellation is honored only before token exchange starts; after that commit boundary the bounded request runs to completion and response loss is reported as outcome unknown. Deny, timeout, malformed callback, and response-loss states remain finite and secret-free.
- KTD7. Require an injected, multi-instance-capable bootstrap attempt limiter. It reserves a trusted-source plus code/credential bucket before token work, consumes invalid attempts, releases successful attempts, and fails closed with `429 rate_limited` or `503 feature_unavailable`; consent issuance also uses a bounded per-owner bucket.
- KTD8. Default composition registers immutable `503 feature_unavailable` placeholders for the two exact routes until the later external composition ticket injects live dependencies, matching the existing pairing composition pattern.

### Pinned Wire Contract

| Surface | Exact shape |
|---|---|
| Human authorize | `GET /api/human/channel-discovery/bootstrap/authorize` with exactly one each of `redirect_uri`, `state`, `code_challenge`, `code_challenge_method=S256`, `origin`, `harness`, `session_id`, `generation`, and `proof_jkt`. Signed-out requests redirect through the existing sign-in return path; signed-in requests render a no-store, frame-denied, no-referrer consent page. |
| Human decision | `POST /api/human/channel-discovery/bootstrap/authorize` with the same bound fields, `decision=allow|deny`, and `csrf_token`. The server requires exact Origin and authenticated owner, then redirects only to the validated IP-literal loopback URI with exactly `state` plus either `code` or `error=access_denied`. |
| Code exchange | `POST /api/agent/channel-discovery/bootstrap/token` JSON `{grant_type:"authorization_code", code, code_verifier, redirect_uri, harness, session_id, generation}` plus a fresh `DPoP` header whose `htu` is the exact token URL. |
| Refresh | The same token route with JSON `{grant_type:"refresh_token", harness, session_id, generation}`, `Authorization: DPoP <credentialRef>`, and a fresh `DPoP` header containing `ath` for the current credential reference. |
| Success | JSON `{credential}` where `credential` strictly decodes as the contract `DiscoveryCredential`; no parallel bearer token, refresh token, owner claim, or caller-provided proof key is accepted. |
| Finite errors | JSON `{error}` with `400 invalid_request`, `401 invalid_grant|invalid_proof`, `403 access_denied`, `409 refresh_conflict`, `429 rate_limited`, or `503 feature_unavailable`. Responses are no-store and never reveal whether an owner/session/credential candidate exists. |

### Browser Interaction Contract

| State | Required owner and connector outcome |
|---|---|
| Signed out or session expires before decision | Redirect through the existing sign-in return path to a fresh, inert consent page. Never replay or infer an allow decision; the owner must authorize again. |
| Consent page | Identify the verified requesting native session, name channel discovery, enumerate the list/request-access/request-create-intent authority in plain language, and state that authorization neither joins nor creates a channel. Present unambiguous `Authorize` and `Cancel` actions without channel-admission terminology. |
| Authorize | Redirect the exact one-time code and state to the loopback listener. The listener shows a discovery-specific completion page, closes, performs the bounded exchange, and reports a live credential only after strict validation. |
| Cancel/deny | Redirect `error=access_denied` and state. The listener shows a discovery-specific cancellation page, closes without token exchange, and returns a distinct denied result. |
| Local abort or timeout | Before token exchange, close the listener and return distinct finite `cancelled` or `timed_out` results. A late browser submission cannot revive that flow; retry starts with fresh state, verifier, and consent. |
| Malformed, wrong-path, or wrong-state callback | Return a secret-free local error without settling the valid pending flow. Duplicate parameters or mixed `code` plus `error` are malformed and never reach token exchange. |
| Token response lost | Report issuance outcome unknown, clear local authority, close the listener, and require fresh consent. Do not label the flow cancelled or reuse the submitted code/current credential. |

### High-Level Technical Design

```mermaid
sequenceDiagram
  participant C as Connector
  participant S as Native session inspector
  participant B as Owner browser
  participant H as Human authorize route
  participant T as Agent token route
  participant A as Server session authority
  C->>S: Verify existing session and generation
  C->>B: Open exact-origin authorize URL with state, PKCE, and proof thumbprint
  B->>H: Signed-in GET, then CSRF-protected allow or deny
  H->>A: Resolve owner plus session to stable principal
  H-->>C: One-time code through loopback callback
  C->>T: Code, verifier, session, and DPoP proof
  T->>A: Revalidate owner, stable principal, and generation
  T-->>C: Strict proof-bound discovery credential
  C->>T: Refresh with current credential and DPoP ath
  T->>A: Revalidate authority
  T-->>C: Atomic replacement credential; prior value invalid
```

### System-Wide Impact and Risks

- The stable-principal resolver is the only new authority seam. It must be side-effect free and distinguish removal/rebind from infrastructure unavailability so failure never becomes authorization.
- `ControlStore` is atomic per key and has no delete; a stable slot with a rotating digest is required for immediate old-token invalidation and a single concurrent refresh winner.
- `ControlStore` guarantees logical expiry but not physical deletion. Every code and credential record therefore carries its exact 60-second or five-minute expiry; physical garbage collection remains a store-provider responsibility and implementation must not describe logical expiry as proof of byte deletion.
- A lost refresh response intentionally loses the new plaintext credential. The safe recovery is fresh owner consent, not durable plaintext or reuse of the prior token.
- Extracting shared loopback helpers can regress the existing admission bootstrap, so its current loopback and storage suites remain in the focused gate.
- DPoP limits stolen-token replay but does not replace HTTPS; production origins remain exact HTTPS and only the local callback uses HTTP on an IP-literal loopback interface.
- No website documentation is required because no operator-set config, CLI command/flag, environment variable, or user-facing page changes.

---

## Implementation Units

### U1. Add control-plane discovery credential authority

- **Goal:** Implement owner consent, code exchange, atomic credential rotation, and reusable credential authorization without any admission dependency.
- **Requirements:** R1, R3–R4, R6–R9; AE1–AE4 and AE6; KTD1–KTD4 and KTD6–KTD7.
- **Dependencies:** The merged `channel-discovery-contract` on `main`.
- **Files:** `apps/control/src/channel-discovery/bootstrap/handler.ts`, `apps/control/src/channel-discovery/bootstrap/store.ts`, adjacent tests and README, plus the narrow verified-key result in `apps/control/src/agent-bootstrap/proof.ts` if required.
- **Approach:** Implement the pinned wire contract, 60-second codes, five-minute credential slots, and fail-closed limiter reservations. Burn codes before verifier/session/proof checks, settle all CAS writes, derive the credential proof key from the verified DPoP header, and expose an authorizer that checks current slot digest, scope, DPoP replay, expiry, and live session authority.
- **Patterns to follow:** `apps/control/src/agent-bootstrap/handler.ts`, `apps/control/src/auth/store.ts`, `packages/contracts/src/messaging/control-store.ts`, and `packages/contracts/src/messaging/discovery.ts`.
- **Test scenarios:** informed discovery-specific consent copy/actions; signed-out return requires a fresh decision; consent/deny completion; exact Origin and CSRF; duplicate/hostile authorize parameters; PKCE/state/redirect binding; wrong owner/origin/audience/proof/generation; proof replay; exact 60-second/five-minute expiry boundaries; limiter consume/release/unavailable behavior; owner removal and rebind races; refresh rotation and concurrency; lost refresh response; exact scope checks; no plaintext in store; forbidden effect state unchanged.
- **Verification:** The focused control bootstrap suite proves finite routes, authority rechecks, current-token authorization, and the no-side-effects acceptance guard.

### U2. Add the memory-only connector discovery client

- **Goal:** Run channel-less loopback consent and refresh for an already-running verified session while retaining the credential only in process memory.
- **Requirements:** R1–R7, R9–R10; AE1–AE5; KTD1 and KTD5–KTD7.
- **Dependencies:** U1's pinned wire routes and response shapes.
- **Files:** `packages/connector/src/bootstrap/channel-discovery.ts`, adjacent tests, `packages/connector/src/bootstrap/loopback.ts`, `packages/connector/src/bootstrap/index.ts`, and `packages/connector/src/bootstrap/README.md`.
- **Approach:** Extract or reuse bounded loopback callback and POST helpers without changing existing admission behavior. Select the bootstrap origin from the connector's injected trusted-origin set and reject syntactically acceptable but unconfigured HTTPS origins before browser launch. Inspect the native session before browser launch and refresh, build the pinned endpoints and fields from that exact trusted origin, honor abort only before starting token exchange, strictly decode and validate the returned credential, replace local state only after successful refresh, and expose explicit invalidation.
- **Patterns to follow:** `packages/connector/src/bootstrap/loopback.ts`, `packages/connector/src/bootstrap/discovery.ts`, `packages/connector/src/bootstrap/proof.ts`, and the strict contract decoder/validator.
- **Test scenarios:** inspection precedes browser; acceptable-but-unconfigured HTTPS origin is rejected before browser launch; exact trusted origin and fixed endpoints; callback path/state and duplicate parameter rejection without settling the valid flow; discovery-specific allow/deny pages; timeout/local abort close the listener and reject late callbacks; PKCE S256; strict response audience/scope/origin/proof/generation/expiry; refresh reinspection and replacement; generation change clears authority; restart starts empty; existing admission loopback behavior remains green.
- **Verification:** Focused connector tests prove in-memory custody and strict flow behavior; the existing bootstrap storage suite proves no new persisted credential material.

### U3. Register the unavailable-by-default route surface

- **Goal:** Reserve the exact human authorize and agent token routes without coupling build-time route discovery to unfinished production composition.
- **Requirements:** R7, R9–R10; KTD8.
- **Dependencies:** U1.
- **Files:** `apps/control/src/composition/agent/handlers.ts`, `apps/control/src/composition/human/handlers.ts`, their tests, `apps/control/src/runtime/discover.test.ts`, and `apps/control/package.json`.
- **Approach:** Add optional discovery-bootstrap registration factories parallel to pairing, provide immutable no-store `503 feature_unavailable` fallbacks, export the new control module, and update the pinned route manifest.
- **Patterns to follow:** Existing pairing registration factories and unavailable routes in the two composition handlers.
- **Test scenarios:** default routes are exact, frozen, finite, and no-store; live factories substitute only their owned routes; route discovery exposes no extra path; package export resolves the bootstrap module.
- **Verification:** Composition, runtime discovery, boundary, typecheck, and package build gates pass.

---

## Verification Contract

| Gate | Command | Done signal |
|---|---|---|
| Control bootstrap behavior | `mise exec -- pnpm --filter @khala/control test -- src/channel-discovery/bootstrap/handler.test.ts src/channel-discovery/bootstrap/store.test.ts` | Consent, issuance, use, rotation, invalidation, concurrency, secret-custody, and forbidden-effect scenarios pass. |
| Connector bootstrap behavior | `mise exec -- pnpm --filter @khala/connector test -- src/bootstrap/channel-discovery.test.ts src/bootstrap/loopback.test.ts src/storage/bootstrap.test.ts` | Native inspection, loopback/PKCE, strict credential validation, refresh, restart, and existing admission behavior pass. |
| Route composition | `mise exec -- pnpm --filter @khala/control test -- src/composition/agent/handlers.test.ts src/composition/human/handlers.test.ts src/runtime/discover.test.ts` | Exact unavailable/live route registration and the pinned manifest pass. |
| Wrong-implementation mutation | `mise exec -- pnpm --filter @khala/control test -- src/channel-discovery/bootstrap/handler.test.ts -t "completes discovery authorization without creating channel authority"` | Passes normally; fails for the intended forbidden-state assertion when the isolated wrong-implementation side effect is inserted at credential issuance, then passes after restoration. |
| Package tests | `mise exec -- pnpm --filter @khala/connector --filter @khala/control test` | All connector and control package tests pass. |
| Static contract | `mise exec -- pnpm --filter @khala/connector --filter @khala/control typecheck` | New ports, strict wire handling, and registration compile without errors. |
| Package build | `mise exec -- pnpm --filter @khala/connector --filter @khala/control build` | Both packages build successfully. |
| Repository policy | `mise exec -- pnpm exec eslint . && mise exec -- pnpm check:boundaries && mise exec -- pnpm check:terminology` | Lint, import boundaries, and channel terminology pass. |
| Base and deletion guards | `aiur guard-pr-deletions main` plus current-base ancestry check | No unrelated deletion drift and current `origin/main` is an ancestor of the PR head. |

Record the exact mutation-test command, the inserted wrong-implementation line, and the observed failure in the Agent Workpad and PR handoff.

---

## Definition of Done

- Native-session verification and explicit signed-in owner consent precede discovery credential issuance.
- The credential is owner, stable-principal, origin, audience, generation, and Ed25519 proof-key bound with exactly the three discovery scopes.
- Refresh atomically rotates authority, invalidates the prior value, and revalidates owner/session state; denial, expiry, removal, rebind, hostile origin, and proof mismatch fail closed.
- Connector restart cannot recover credential plaintext, and control persistence contains only purpose-separated digests plus bounded authority metadata.
- Full authorization creates no channel, membership, participant, device, binding, admission grant, adapter capability, listing, or request journal entry.
- Focused tests, the isolated wrong-implementation mutation, package tests, typechecks, builds, and repository policy gates pass with exact commands recorded.
- The control and connector READMEs match the shipped protocol and clearly distinguish discovery authority from admission authority.
- No abandoned protocol experiments, temporary secrets, debug output, or unrelated changes remain in the final diff.
