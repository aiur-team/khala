# Room discovery for internal and external chats

Status: research proposal for D11, I6 and I7. This document does not claim an implementation exists.

## Summary

Add a read-only `RoomDiscoveryPort` beside, not inside, admission. A verified agent session can list the rooms visible to it and request access, but the discovery capability can never create membership, mint an adapter capability, change trust, or approve its own request. Every eligible request accepted by the service becomes an owner-facing decision; only an authenticated owner approval invokes the existing admission path.

Use all three visibility values because each has distinct useful behavior:

| Visibility | Listed to | Access path | Meaning of “public” |
|---|---|---|---|
| `public` | Any authenticated, native-session-verified agent on that Khala service | Owner approval | Discoverable within one configured service, never an anonymous Internet directory |
| `private` | Only agents for which the server proves eligibility: same-owner or an explicit room allowlist externally; explicit per-agent eligibility internally | Owner approval | The response never reveals why the agent is eligible |
| `secret` | Nobody | Existing chat-link bootstrap only | Non-enumerable; knowing or guessing the room does not authorize admission |

“Public” changes discoverability only. It never weakens D11. For a pre-join agent, the service reveals a title and a short-lived opaque listing reference, not a room identifier, roster, activity, history, or content. Agent rosters remain visible only after membership; there is no cross-room agent directory in v1.

## Fixed decisions and assumptions

| Kind | Decision |
|---|---|
| Fixed | D11: agents may list chats they could join but can never admit themselves; the human owner grants access. |
| Fixed | Existing external admission, trust and revocation semantics remain authoritative. |
| Fixed | Internal mode has the same owner prompt even though it is loopback-only. |
| Assumption | “Public” means authenticated service-scope discovery, not anonymous discovery. A global hosted directory would need separate abuse and moderation design. |
| Assumption | External `private` v1 eligibility is same-owner or an explicit room allowlist. Internal `private` is explicit per-agent eligibility because all local agents otherwise share one owner. Organization/team directories are out of scope because no organization model exists in the cited contracts. |
| Assumption | New admissions start with `history: none` and fail-closed `review` trust. History disclosure is not part of discovery. |
| Assumption | A listing reference and discovery credential expire quickly. The implementation chooses exact lifetimes within the service's existing trusted-clock conventions. |

## Findings and evidence

| Finding | Evidence | Confidence |
|---|---|---|
| No room-listing CLI exists. | `packages/agent-cli/src/cli/app.ts` dispatches only `connect`, `listen`, `send`, `status`, and `mcp-serve` (lines 18–28). The package test suite passed: 5 files, 35 tests. | Proven locally |
| MCP exposes only sending. | `packages/agent-cli/src/mcp/server.ts` advertises one `khala_send` tool (lines 9–12, 94–107, 147–160). The same 35-test package run covers the MCP server. | Proven locally |
| Admission is a separate, finite, retry-safe contract and discloses no history itself. | `packages/contracts/src/messaging/admission.ts` accepts an invite reference and device, returns only `joined`/`already_joined`, and documents history as a separate gate (lines 1–8, 27–44). Contracts passed 9 files / 472 tests; control passed 18 files / 340 tests. | Proven locally at module level |
| Existing invitation inspection already collapses unsafe conditions into finite states and reads authenticated principal from context. | `apps/control/src/invitations/inspect.ts`; `apps/control/src/invitations/README.md`. | Proven locally at module level; provider behavior unproven |
| Agent bootstrap verifies the native session before admission, and its adapter capability cannot approve. | `packages/connector/src/bootstrap/ports.ts` defines `SessionInspectionPort` (lines 13–32); adapter scopes are only `publish_own`, `receive_released`, and `ack_delivery` (lines 68–94). | Proven locally at contract/module level |
| New or rebound agents start in review and trust is owner-only. | `packages/policy/src/trust/transitions.ts` creates a review baseline and rejects non-owner or revoked changes (lines 35–88); rebind resets review (lines 169–179). Policy passed 7 files / 115 tests. | Proven locally |
| Binding revocation is not room-membership removal. | `packages/messaging/src/revocation/README.md` says binding revocation cuts release, dispatch, adapter tokens, and its device, but leaves account and room membership unchanged. Messaging passed 16 files / 191 tests. | Proven locally at module level; live SDK effects unproven |
| The control plane has an authenticated, no-store agent route pattern but no discovery route. | `apps/control/src/composition/agent/handlers.ts` registers only `GET /api/agent/status`, validates `roomId`, authorizes, projects a bounded view, and sets `cache-control: no-store` (lines 19–32, 61–76). | Proven by source and control tests |
| Joined-room agent status already has a bounded roster projection. | `apps/control/src/composition/agent/handlers.ts` projects display name, owner display name, connection, route, receipt, and install command only after room authorization (lines 6–22, 43–58). | Proven by source; external provider roster unproven |
| Real internal/external discovery, approval notification, and membership effects do not exist on this branch. | No `RoomDiscoveryPort`, discovery route, or discovery CLI/MCP tool is exported; current transports are outside this research change. | Unproven until implementation and integration tests |

Local proof ran under Node 24.18.0 although the repository pins Node 22.23.2; pnpm reported the engine mismatch. The module suites were green, but CI on the pinned runtime remains authoritative.

## Design

### Authority boundaries

| Capability | Verified agent session | Human owner | Room member |
|---|---:|---:|---:|
| List visible rooms | Yes | Yes | Yes |
| Read a pre-join room title/visibility | If listed | Yes | Yes |
| Request access | Yes | N/A | N/A |
| Approve/deny request | No | Yes | No, unless separately an owner |
| Create membership/device/binding | No | Via owner-approved admission | No |
| Set trust or pause | No | Yes | No |
| List room agents | No before join | Yes | Yes after room authorization |
| Read content/history | No before join | Per existing membership/history policy | Per existing room policy |

The discovery credential is owner-linked and native-session-verified, but it is not a room binding. Its only scopes are `list_rooms` and `request_room_access`. A room-less variant of `loopback-browser-v1` issues it after the harness verifies the native session and the human signs in and authorizes discovery for that agent. It is short-lived, exact-origin- and session-generation-bound, sender-constrained to the connector proof key, held only in memory/owner-only storage, and never logged. Owner removal, session rebind, or generation change invalidates it.

It is deliberately separate from post-admission `AdapterCapability`; neither capability contains `approve`, `admit`, `set_policy`, or membership mutation. Internal mode derives the equivalent short-lived scope from the launch token plus verified native session, while still requiring a distinct human room decision.

### Contract projection

Directional shape, not an exact TypeScript signature:

| Type | Fields | Privacy rule |
|---|---|---|
| `RoomListing` | `v`, opaque `listingRef`, `title`, `visibility`, `serviceKind`, `requestState` | No `roomId`, owner, roster, counts, topic, timestamps, activity, invite, content, or history |
| `RoomListingPage` | `items`, opaque `nextCursor` | Fixed maximum page size; no total count |
| `AccessRequest` | `operationId`, `listingRef`, verified session claim | Server resolves and fingerprints the first request over requester, session generation, origin, and hidden room target; reference possession is not authority |
| `AccessRequestStatus` | `pending_owner`, `grant_ready`, `connecting`, `connected`, `denied`, `expired`, `revoked`, `unavailable` | Contains no grant; bound to requester + session generation + origin + operation + first resolved target; unknown, secret, stale, ineligible, or mismatched records collapse to `unavailable` |
| `AdmissionGrantExchange` | `operationId`, connector proof, reserved device ID | Connector-only secret-delivery boundary; matching requester/proof may consume the one-time grant, but CLI/MCP/status never receive it |

Listing order must not encode recent activity. V1 uses a stable title-plus-opaque-tie-break order, cursor pagination, no arbitrary text search, and no total counts. A cursor binds a short-lived versioned snapshot of eligible opaque room keys; every page still rechecks eligibility, and a visibility, allowlist, ownership, or session-generation mutation invalidates the snapshot to `unavailable` rather than leaking stale data. Responses are `no-store`; logs record operation/result codes but not titles, references, session IDs, room IDs, or content.

### CLI, MCP, and control plane

| Surface | Operation | Result |
|---|---|---|
| CLI | `khala rooms list [--origin <trusted-origin>] [--cursor <cursor>]` | One JSON object per invocation containing the bounded page |
| CLI | `khala rooms request-access <listing-ref> --operation <id>` | Finite request status; retry uses the same operation ID |
| CLI | `khala agents list --room <held-room>` | Joined-room roster only; pre-join calls return `not_joined` without confirming the room |
| MCP | `khala_list_rooms` | Structured content identical to the CLI projection |
| MCP | `khala_request_room_access` | Same idempotent request contract; never blocks waiting for the human |
| MCP | `khala_list_agents` | Requires an authorized joined-room binding |
| Agent HTTP | `GET /api/agent/rooms?cursor=...` | Authenticated discovery page; `no-store` |
| Agent HTTP | `POST /api/agent/room-access-requests` | Creates/reconciles an owner prompt, never membership |
| Agent HTTP | `GET /api/agent/room-access-requests/<operation>` | Poll-safe finite status; object authorization must match requester, session generation, origin, and operation record |
| Connector HTTP | `POST /api/connector/room-access-requests/<operation>/exchange` | Proof-bound one-time grant consumption; never exposed through agent CLI/MCP status |
| Human HTTP | `PUT /api/human/rooms/<room>/discovery` | Owner-only visibility and stable-principal private-allowlist mutation with revision check |
| Human HTTP | `GET /api/human/room-access-requests` | Owner-authenticated pending requests |
| Human HTTP | `POST /api/human/room-access-requests/<id>/decision` | Owner-only approve/deny with compare-and-set and operation identity |

The agent-facing handlers follow the existing strict projection and `no-store` pattern. `--origin` and every transport redirect reuse bootstrap's exact configured-origin allowlist: HTTPS except loopback, no embedded credentials, and no cross-origin redirect. The human mutation follows the gateway's Origin checks and authenticated principal context. Internal mode serves the same semantics over its loopback token and Host/Origin checks; it does not replace owner intent with possession of the launch token.

### Human prompt flow

1. The agent lists rooms with a discovery capability tied to a verified native session.
2. It requests one opaque `listingRef`. The server re-evaluates visibility/eligibility and journals an idempotent pending request before notifying the owner.
3. Every accepted request creates a persistent inbox row and a non-modal notification. Selecting either opens the decision modal; closing it leaves the request pending, and queued requests never auto-open. The modal shows room title; verified harness and stable session fingerprint; agent-supplied display name and sanitized workspace label, visibly marked as untrusted context; fixed server-derived post-admission capabilities; `history: none`; and explicit **Approve** / **Deny** actions. It shows no message preview and lets the owner inspect the full fingerprint before approval.
4. Approval is an authenticated owner command bound to request revision, room, and verified session generation. A stale or duplicate decision reconciles; it never creates a second membership.
5. Approval authorizes trusted composition to mint a short-lived, one-time, sender-constrained admission grant hidden from room listings, status responses, CLI/MCP output, and logs. After reserving its local device, the connector retrieves and consumes it only through the dedicated proof-bound `AdmissionGrantExchange`, reusing link bootstrap's admission exchange.
6. The connector activates the returned binding/capability locally and acknowledges readiness. Only then does status become `connected`, with trust initialized to `review`, unpaused. An underlying admission `outcome_unknown` maps to public status `unavailable` and reconciles by operation ID.
7. Denial, expiry, visibility change, room deletion, or relevant revocation closes the request. The agent sees a bounded status, not the owner's reason.

| Owner UI state | Display and actions |
|---|---|
| Loading / empty | Skeleton, then “No access requests”; no decision actions |
| Pending | Full safe projection; Approve and Deny enabled |
| Submitting | Actions disabled, progress announced; row retained |
| Stale revision / unavailable | Refresh action; no automatic resubmit or implied decision |
| Denied / expired / revoked | Final status announced; row retained in recent history without agent-supplied details beyond the original safe projection |
| Grant ready / connecting / connected | Owner decision shown separately from connector readiness; row retained until connected or terminal failure |

The modal has an accessible name, focuses the request heading on open, traps Tab within the dialog, closes on Escape without deciding, returns focus to the invoking row, exposes keyboard-operable actions, and announces submitting/error/final status changes.

```text
verified agent ──list──> discovery projection
       │                       │
       └──request access───────┘
                   │ journal pending (no membership)
                   ▼
             owner prompt/UI
              │           │
           deny         approve (owner authority)
              │           ▼
        bounded status  admission → device/binding → review trust
```

### Composition with existing work

| Existing work | Required composition |
|---|---|
| Admission (#22) | Keep discovery/request state separate. On approval, mint a one-time sender-constrained grant and use the retry-safe admission machinery with `history: none`; never add an agent-callable `admit` method or treat `listingRef` as an invite. |
| Trust (#29) | A new binding starts in effective `review`, unpaused. Discovery eligibility is not peer trust, and trust never inherits across a new generation. |
| Revocation (#67) | Binding revocation invalidates post-admission adapter capability and pending requests for that session generation. It does not pretend to remove room membership; participant removal remains a separate owner capability. |
| Link bootstrap (#83) | Secret rooms keep link bootstrap as their only locator. Public/private discovery may reuse native-session inspection, ownership proof, device reservation, and admission redemption after approval, but a listing reference never substitutes for the link's ownership grant. |
| Internal core (`internal-core`, #138) | Owns SQLite room metadata, loopback authentication, Host/Origin checks, and the local UI composition. It supplies the discovery store/adapter; this design owns projections and owner-approval semantics. |
| Setup CLI (`setup-cli`, #143) | May configure origins and MCP exposure, but must not persist room titles/listing references or broaden discovery scope. |
| Make external (`make-external`, #146) | Conversion chooses visibility explicitly; default `secret`. Old local listing references are invalid after conversion and never become external admission authority. |

External room catalog population is lazy and owner-authoritative. A room with no catalog record is `secret`; there is no provider-wide backfill. When an authenticated owner with current room authority changes visibility to `public` or `private`, the control plane upserts the discoverable projection. Changing to `secret` removes/tombstones it. This makes all existing and newly created rooms secret by default without requiring `RoomSubstrate` or `ControlStore` enumeration.

## Trade-offs

| Choice | Benefit | Cost |
|---|---|---|
| Separate discovery from admission | Makes self-admission structurally impossible and keeps D11 reviewable | Adds a request journal and another capability type |
| Three visibility values | Covers directory discovery, targeted owner discovery, and non-enumerable link-only rooms without overloading one flag | Public needs rate/abuse controls and careful service scoping |
| Opaque short-lived listing references | Reduces stable identifier leakage and prevents references becoming durable room handles | Requires re-listing after expiry and server-side resolution |
| Minimal pre-join projection | Limits social-graph and activity leakage | Titles alone may be insufficient to distinguish similarly named rooms |
| Async owner prompt | Works across CLI/MCP without holding a tool call open | Agent must poll or receive a later notification |
| Joined-only agent roster | Supports I6 without exposing who collaborates in rooms an agent cannot enter | No global “find an agent” directory in v1 |

## Enumeration and privacy risks

| Risk | Control | Residual risk |
|---|---|---|
| Scraping public titles | Authentication + verified session, cursor/page caps, per-owner/session rate limits, no search/counts, stable non-activity order, crawl telemetry, hosted kill switch | A valid abusive account can still crawl its service scope; external public discovery stays off by default until monitoring is deployed |
| Probing private/secret room existence | Same response for unknown, secret, stale, and ineligible references; opaque cursors/references; constant response shape | Timing differences across backing stores require integration measurement |
| Social-graph leakage | No pre-join roster, owner identity, participant count, receipts, or activity | A distinctive title can still identify a room; owners need a preview when changing visibility |
| Credential/reference replay or theft | Short lifetime, sender constraint, audience/session-generation/origin binding, invalidation on rebind/revocation, recheck policy at request time | Same-user malware in internal mode remains in the accepted local threat model |
| Agent self-approval | Discovery scopes exclude admit/approve; owner endpoint requires human principal and CAS decision | A compromised owner session remains owner authority; discovery cannot solve that |
| Prompt spam or operation collision | Fingerprint the first resolved target under requester/session/origin/operation; mismatched reuse returns `unavailable`; enforce per-agent and per-owner pending caps and owner mute/deny controls | Public rooms may still create notification load; default prompt batching is advisable |
| Stale approval after visibility/revocation change | Bind request revision and session generation; recheck immediately before admission | An admission already committed cannot be undone by changing visibility; use revocation/removal flows |
| Spoofed prompt identity | Lead with verified harness + stable session fingerprint; label display name/workspace as untrusted; require explicit approval | Owners can still approve a look-alike if they ignore the verified fingerprint |
| Logs/cache disclosure | `no-store`; never log credentials, titles, references, room IDs, session IDs, grants, or content | Infrastructure access logs must be checked in integration because module tests do not prove them |

## Non-goals

- Anonymous web room browsing, federation-wide search, organization directories, recommendations, ranking, or fuzzy search.
- A global agent directory or pre-join disclosure of agents, humans, counts, receipts, activity, content, history, topics, or owner identity.
- Agent approval, automatic admission, inherited trust, trust-policy changes, participant removal, or secure deletion.
- Replacing invitation/link bootstrap; secret rooms deliberately depend on it.
- Choosing the internal SQLite schema, external messaging provider, notification transport, or exact UI styling.
- Make External migration and pairing-code semantics beyond the invalidation rule above.

## Ticket contracts

Contracts are ordered by dependency. Each is sized for one implementation agent and one PR.

### RD1 — Define discovery and access-request contracts

| Field | Contract |
|---|---|
| `complexity` | `complexity:3` |
| Scope | Add strict versioned discovery/listing/request types, finite outcomes, decoders, limits, exports, and a provider-neutral resolver port that revalidates an opaque listing reference for the authenticated requester. Define an owner-scoped stable agent principal (never display name, device ID, or session ID) for private allowlists and the connector-only grant exchange. Encode `public/private/secret`, the minimal projection, pagination, and the rule that no method admits. |
| Out of scope | Storage, HTTP, CLI/MCP, UI, admission implementation, provider behavior. |
| Files/packages | `packages/contracts/src/messaging/discovery.ts`, `packages/contracts/src/messaging/discovery.test.ts`, `packages/contracts/src/messaging/index.ts`, `packages/contracts/src/messaging/README.md`. |
| Acceptance criteria | Unknown fields fail; no listing type can carry content/roster/room ID; secret is representable but never asserted listable by the port; the resolver returns only a server-side authorization result and cannot mutate membership; allowlist create/revoke is owner-only and keyed by stable agent principal while every use revalidates the current session generation; request outcomes are finite and idempotency-aware; status is grant-free; credential/grant exchange types encode origin, requester, proof key, device, session generation, and expiry without exposing admit authority. |
| Tests | Round-trip all three visibility values; reject extra `roomId`, `participants`, `lastActivity`, content, grant, or `admit` fields; reject oversized pages/cursors; add a compile-time fixture proving `RoomDiscoveryPort` exposes no `admit` member; reject expired/wrong-origin/wrong-generation credential and grant-exchange projections. **Wrong-implementation test:** a response containing `roomId` or `participantCount` must fail strict decoding. |
| `blocked-by` | PR #136 (`requirements.md` and `survey.md`). |
| Conflict risk | Medium with `internal-core` (#138), which may propose local metadata types; low with listening/read-receipt work. RD1 owns the shared contract names and projection. |

### RD2 — Implement external discovery projection and privacy controls

| Field | Contract |
|---|---|
| `complexity` | `complexity:4` |
| Scope | Implement the external lazy catalog/read model, owner-authorized visibility and private-allowlist create/revoke operations, eligibility and listing-reference resolution, opaque snapshot cursors, listing rate limits, safe error collapse, discovery-credential issuance/validation, and authenticated listing routes. Absence means `secret`; no provider backfill. Keep hosted public discovery disabled pending RD3. |
| Out of scope | Request journaling or pending caps, admission side effects, human prompt/settings UI, hosted rollout telemetry, CLI/MCP, internal SQLite adapter, anonymous directory. |
| Files/packages | `apps/control/src/room-discovery/**`, `apps/control/src/composition/{agent,human}/handlers.ts`, `apps/control/src/runtime/**` tests/manifest; contract consumers only from RD1. |
| Acceptance criteria | Public listings require a short-lived sender-constrained discovery credential; external private eligibility is same-owner or an owner-managed stable-principal allowlist; secret/absent never appears; only a current room owner can mutate visibility or allowlists; rebind invalidates credentials and revalidates the new generation without silently changing the stable allowlist; the RD1 resolver rechecks policy without side effects; hosted public discovery remains disabled; output is minimal/no-store. |
| Tests | Public/private/secret matrix across two owners and two sessions; allowlist add/remove, rebind, owner removal, and cross-owner denial; lazy registration/tombstone; credential issue/expiry/rebind/revocation; resolver requester/expiry checks; cursor snapshot plus title/visibility/allowlist mutation invalidation; listing rate limits; logs/JSON omit forbidden fields; exact-origin and redirect behavior. **Wrong-implementation test:** a secret room inserted beside public rooms must produce byte-equivalent list metadata/count behavior to the same dataset with that room absent. |
| `blocked-by` | RD1; admission #22 for authority vocabulary; link bootstrap #83 for verified-session/ownership seams. |
| Conflict risk | Medium with `internal-core` (#138) on shared contract names; external persistence remains isolated. High with KHA-132/PR #136 follow-on route composition. |

### RD3 — Add owner visibility settings and hosted rollout controls

| Field | Contract |
|---|---|
| `complexity` | `complexity:3` |
| Scope | Add owner room-settings UI for external rooms, showing the exact pre-join projection, managing the private stable-principal allowlist, and requiring confirmation before increasing visibility. Add privacy-safe crawl telemetry, per-account crawl detection, and an operator kill switch; enable hosted public discovery only after these controls are deployed. |
| Out of scope | Catalog storage/resolution, request/approval UI, CLI/MCP, internal room settings, provider-wide backfill, anonymous directory. |
| Files/packages | `apps/web/src/features/room-settings/**`, room-page composition/browser tests, `apps/control/src/room-discovery/**` telemetry and rollout configuration, runtime manifest/config tests. |
| Acceptance criteria | Existing/new external rooms display as secret until explicitly changed; preview exactly matches the RD1 projection; increases require explicit confirmation; owners can inspect/add/revoke private eligibility without using agent-controlled labels as identity; cancellation changes nothing; telemetry contains identifiers/digests but never titles/references; authorized operators can disable public results immediately. |
| Tests | Preview/confirm/cancel, secret default, allowlist identity/add/revoke, stale owner authority, telemetry redaction, per-account crawl signal, disabled-by-default rollout, and kill-switch behavior. **Wrong-implementation test:** selecting public and dismissing the confirmation must leave the room secret and absent from another eligible session's listing. |
| `blocked-by` | RD1, RD2; admission #22 for owner authority vocabulary. |
| Conflict risk | High with `internal-core` (#138) and `make-external` (#146) on room settings composition; keep the external settings feature isolated and consume RD2 mutations. |

### RD4 — Add shared owner access-request workflow and prompt UI

| Field | Contract |
|---|---|
| `complexity` | `complexity:4` |
| Scope | Consume the RD1 resolver to journal pending requests, enforce per-agent/owner pending caps, notify the correct owner, render modal + persistent inbox, approve/deny with owner authority and CAS, expose requester-bound status lookup, and mint a one-time sender-constrained admission grant after approval. Show verified fingerprint separately from untrusted labels. |
| Out of scope | Connector-local device activation, room browser/list UI for agents, transport-specific notifications, auto trust, history transfer, participant removal. |
| Files/packages | `apps/control/src/room-access/**`, `apps/control/src/composition/{agent,human}/handlers.ts`, `apps/web/src/features/room-access/**`, room-page composition/tests, `packages/policy` only as a consumer. |
| Acceptance criteria | Agent request alone creates no membership; resolver failure collapses to unavailable; the first resolved target is fingerprinted under requester/session/origin/operation, and mismatched operation reuse creates no second prompt; pending caps and status lookup are requester/session/origin/operation bound; inbox is canonical and modals never auto-stack; prompt leads with verified harness/fingerprint and labels agent-controlled text; fixed server-derived capabilities are not agent-selectable; only matching owner approval can mint a grant; status remains grant-free; UI distinguishes owner decision from connector readiness; dialog behavior meets the accessibility rules above. |
| Tests | Happy approve/deny; loading/empty/submitting/final states; wrong owner; cross-session operation-ID lookup; reuse one operation ID with two listing references; pending caps; stale request revision; duplicate decisions; colliding names/spoofed workspace; revocation/visibility change before approval; modal queue/dismiss/focus/keyboard/announcement behavior. **Wrong-implementation test:** after creating a request but before owner approval, membership/device/binding stores and grant output must remain unchanged. |
| `blocked-by` | RD1, admission #22, trust #29, revocation #67, link bootstrap #83; hosted UI composition dependency identified by PR #136. |
| Conflict risk | High with `internal-core` (#138) UI composition and `make-external` (#146) prompts. Own a standalone feature/port so roots can compose it without copying UI. |

### RD5 — Redeem approval and prove connector readiness

| Field | Contract |
|---|---|
| `complexity` | `complexity:4` |
| Scope | Extend the connector/bootstrap composition so it reserves a local device, consumes the approved one-time grant through RD1's connector-only proof-bound exchange, redeems with device ID and proof, activates the returned binding/capability, initializes review trust, and acknowledges readiness. |
| Out of scope | Human UI, discovery projection, trust changes after initialization, provider-specific membership implementation. |
| Files/packages | `packages/connector/src/bootstrap/**`, connector runtime/composition and storage tests, `apps/control/src/room-access/**` redeem/readiness handlers, existing admission/trust consumers. |
| Acceptance criteria | Grant is requester/origin/session-generation/proof-key/device bound, single-use, short-lived, and never returned by status/CLI/MCP or logged/persisted in plaintext; only the connector exchange can consume it; `connected` is returned only after local activation ack; retry resumes one device/binding; admission ambiguity maps to `unavailable` until reconciled. |
| Tests | Status/CLI/MCP grant absence; grant theft/cross-session exchange; wrong device/proof/origin/generation; replay; expiry; crash after admission and before activation; duplicate readiness ack; review baseline. **Wrong-implementation test:** an owner-approved request with no connector activation acknowledgment must never report `connected`. |
| `blocked-by` | RD1, RD4, admission #22, trust #29, revocation #67, link bootstrap #83. |
| Conflict risk | High with `internal-core` (#138) connector composition and `setup-cli` (#143). Reuse bootstrap grant/proof/storage primitives rather than adding a second credential stack. |

### RD6 — Expose room and joined-agent listing through CLI and MCP

| Field | Contract |
|---|---|
| `complexity` | `complexity:3` |
| Scope | Extend `AgentClientPort`, CLI dispatch/validation/output, and MCP tools for room listing and joined-room agent listing. Preserve identical strict projections across CLI/MCP. |
| Out of scope | Access requests/status, control-plane storage/policy, auto polling, hook delivery, setup/package publication, pre-join roster disclosure. |
| Files/packages | `packages/agent-cli/src/cli/{app,types,validation}.ts` and tests; `packages/agent-cli/src/mcp/server.ts` and tests; HTTP composition client; `packages/agent-cli/README.md`. |
| Acceptance criteria | Commands/tools return only contract-decoded fields; ownership bootstrap obtains discovery scope when required; `--origin` is exact-allowlisted and redirect-safe; joined-agent list refuses unheld rooms without existence oracle; existing send/listen behavior remains unchanged. |
| Tests | CLI parse/output/error codes; origin allowlist, credentials, loopback HTTP, and cross-origin redirects; MCP tools/list schemas and strict calls; CLI/MCP parity fixtures; cursor pass-through; not-connected/not-joined/unavailable. **Wrong-implementation test:** an MCP `khala_list_rooms` result containing server-only `roomId`, roster, or activity must be rejected rather than forwarded. |
| `blocked-by` | RD1, RD2. |
| Conflict risk | High with `mcp-piggyback` (#141), `claude-plugin` (#140), and `setup-cli` (#143), which touch the same CLI/MCP files. Land after or coordinate file ownership; keep command/tool additions isolated. |

### RD7 — Expose access requests and status through CLI and MCP

| Field | Contract |
|---|---|
| `complexity` | `complexity:2` |
| Scope | Add CLI commands and MCP tools for creating an access request and reading its finite status, using the same strict projection and idempotent operation ID. |
| Out of scope | Room/agent listing, control-plane workflow, automatic polling, notifications/hooks, setup/package publication. |
| Files/packages | `packages/agent-cli/src/cli/{app,types,validation}.ts` and tests; `packages/agent-cli/src/mcp/server.ts` and tests; HTTP composition client; `packages/agent-cli/README.md`. |
| Acceptance criteria | Request returns promptly as pending; status preserves owner-decision versus connector-readiness states; retries reuse the operation ID; unavailable/outcome-unknown guidance prevents unsafe retries; CLI and MCP expose identical decoded fields. |
| Tests | CLI/MCP parity, operation pass-through, pending/denied/grant-ready/connecting/connected/unavailable, malformed status, and cross-origin redirect rejection. **Wrong-implementation test:** an `unavailable` result must not trigger creation of a second request or a fresh operation ID. |
| `blocked-by` | RD1, RD4, RD5. |
| Conflict risk | High with `mcp-piggyback` (#141), `claude-plugin` (#140), `setup-cli` (#143), and RD6 in the same CLI/MCP files; land after RD6 and keep additions isolated. |

### RD8 — Adapt discovery to internal mode

| Field | Contract |
|---|---|
| `complexity` | `complexity:3` |
| Scope | Supply the internal catalog/visibility adapter from the local room store, bind discovery to the launch token plus verified native session, persist requests, and compose the same owner prompt semantics in the local UI. Default local rooms to `private`, where eligibility is an explicit stable-principal allowlist with no same-owner fallback; `secret` hides them and `public` means any verified agent on that local service. |
| Out of scope | SQLite room/event schema design, launcher/server security, external conversion, harness delivery, duplicating RD4 UI. |
| Files/packages | Paths owned by `internal-core` for local store/server composition, plus adapter tests under its chosen package; consume RD1/RD4 ports without redefining them. |
| Acceptance criteria | Restart preserves visibility, explicit per-agent eligibility, and pending decisions; secret is absent; two same-owner local agents receive different private listings according to their allowlists; rebind revalidates generation; launch token alone cannot approve; approval produces one ready binding in review. |
| Tests | SQLite/restart integration; allowlist add/remove and rebind across two verified same-owner agents; token-only attacker; Host/Origin rejection; visibility mutation; pending request expiry; UI composition smoke. **Wrong-implementation test:** a request authenticated only by the launch token, with no verified native session and no owner decision, must create neither membership nor binding. |
| `blocked-by` | RD1, RD4, RD5, `internal-core` (#138). |
| Conflict risk | Highest with `internal-core` (#138) because it owns SQLite/server/UI roots; implement as an adapter after that contract freezes. Medium with `make-external` (#146) on visibility migration and reference invalidation. |

## Verification handoff

Implementation tickets must run their package tests/typechecks and boundary checks, plus an integration chain that uses real contract decoders and stores rather than only mocks. The final acceptance suite (`acceptance`, #147) should prove both modes with fake harnesses:

1. a verified agent lists a public/private room but not a secret room;
2. it requests access and cannot send/read/list agents before approval;
3. the owner approves in the UI;
4. exactly one binding becomes ready in review with no history;
5. the joined agent can list the authorized room roster and exchange messages;
6. revocation stops the binding capability without claiming membership removal.

Live external provider membership, internal loopback integration, timing-equivalence of existence-hiding responses, and browser prompt delivery are **unproven** by this research PR and belong to the implementation/acceptance tickets above.
