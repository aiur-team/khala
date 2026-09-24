# Channel discovery for internal and external channels

Status: research proposal for D11, I6 and I7. This document does not claim an implementation exists.

## Summary

Add a read-only `ChannelDiscoveryPort` beside, not inside, admission. A verified agent session can list the channels visible to it and request access, but the discovery capability can never create membership, mint an adapter capability, change trust, or approve its own request. Every eligible request accepted by the service becomes an owner-facing decision; only an authenticated owner approval invokes the existing admission path.

Use all three visibility values because each has distinct useful behavior:

| Visibility | Listed to | Access path | Meaning of “public” |
|---|---|---|---|
| `public` | Any authenticated, native-session-verified agent on that Khala service | Owner approval | Discoverable within one configured service, never an anonymous Internet directory |
| `private` | Only agents for which the server proves eligibility: same-owner or an explicit channel allowlist externally; explicit per-agent eligibility internally | Owner approval | The response never reveals why the agent is eligible |
| `secret` | Nobody | Existing link bootstrap only | Non-enumerable; knowing or guessing the channel does not authorize admission |

“Public” changes discoverability only. It never weakens D11. For a pre-join agent, the service reveals a title and a short-lived opaque listing reference, not a channel identifier, roster, activity, history, or content. Agent rosters remain visible only after membership; there is no cross-channel agent directory in v1.

## Fixed decisions and assumptions

| Kind | Decision |
|---|---|
| Fixed | D11: agents may list channels they could join but can never admit themselves; the human owner grants access. |
| Fixed | Existing external admission, trust and revocation semantics remain authoritative. |
| Fixed | Internal mode has the same owner prompt even though it is loopback-only. |
| Fixed | Internal approve/deny requires the authenticated human-cookie role. Binding and discovery capabilities can never decide, and v1 does not add a second launcher/OS presence proof. |
| Assumption | “Public” means authenticated service-scope discovery, not anonymous discovery. A global hosted directory would need separate abuse and moderation design. |
| Assumption | External `private` v1 eligibility is same-owner or an explicit channel allowlist. Internal `private` is explicit per-agent eligibility because all local agents otherwise share one owner. Organization/team directories are out of scope because no organization model exists in the cited contracts. |
| Assumption | New admissions start with `history: none` and fail-closed `review` trust. History disclosure is not part of discovery. |
| Assumption | A listing reference and discovery credential expire quickly. The implementation chooses exact lifetimes within the service's existing trusted-clock conventions. |
| Assumption | Same-uid theft of `launch.json` or another binding's descriptor is the known internal-mode v1 limit recorded by `internal-core`; capabilities provide API attribution, not process isolation. |

## Findings and evidence

| Finding | Evidence | Confidence |
|---|---|---|
| No channel-listing CLI exists. | `packages/agent-cli/src/cli/app.ts` dispatches only `connect`, `listen`, `send`, `status`, and `mcp-serve` (lines 18–28). The package test suite passed: 5 files, 35 tests. | Proven locally |
| MCP exposes only sending. | `packages/agent-cli/src/mcp/server.ts` advertises one `khala_send` tool (lines 9–12, 94–107, 147–160). The same 35-test package run covers the MCP server. | Proven locally |
| Admission is a separate, finite, retry-safe contract and discloses no history itself. | `packages/contracts/src/messaging/admission.ts` accepts an invite reference and device, returns only `joined`/`already_joined`, and documents history as a separate gate (lines 1–8, 27–44). Contracts passed 9 files / 472 tests; control passed 18 files / 340 tests. | Proven locally at module level |
| Existing invitation inspection already collapses unsafe conditions into finite states and reads authenticated principal from context. | `apps/control/src/invitations/inspect.ts`; `apps/control/src/invitations/README.md`. | Proven locally at module level; provider behavior unproven |
| Agent bootstrap verifies the native session before admission, and its adapter capability cannot approve. | `packages/connector/src/bootstrap/ports.ts` defines `SessionInspectionPort` (lines 13–32); adapter scopes are only `publish_own`, `receive_released`, and `ack_delivery` (lines 68–94). | Proven locally at contract/module level |
| New or rebound agents start in review and trust is owner-only. | `packages/policy/src/trust/transitions.ts` creates a review baseline and rejects non-owner or revoked changes (lines 35–88); rebind resets review (lines 169–179). Policy passed 7 files / 115 tests. | Proven locally |
| Binding revocation is not channel-membership removal. | `packages/messaging/src/revocation/README.md` says binding revocation cuts release, dispatch, adapter tokens, and its device, but leaves account and Matrix room membership unchanged. Messaging passed 16 files / 191 tests. | Proven locally at module level; live SDK effects unproven |
| The control plane has an authenticated, no-store agent route pattern but no discovery route. | `apps/control/src/composition/agent/handlers.ts` registers only `GET /api/agent/status`, validates `roomId`, authorizes, projects a bounded view, and sets `cache-control: no-store` (lines 19–32, 61–76). | Proven by source and control tests |
| Joined-channel agent status already has a bounded roster projection. | `apps/control/src/composition/agent/handlers.ts` projects display name, owner display name, connection, route, receipt, and install command only after authorization of its existing Matrix `roomId` (lines 6–22, 43–58). | Proven by source; external provider roster unproven |
| Real internal/external discovery, approval notification, and membership effects do not exist on this branch. | No `ChannelDiscoveryPort`, discovery route, or discovery CLI/MCP tool is exported; current transports are outside this research change. | Unproven until implementation and integration tests |

Local proof ran under Node 24.18.0 although the repository pins Node 22.23.2; pnpm reported the engine mismatch. The module suites were green, but CI on the pinned runtime remains authoritative.

## Design

### Authority boundaries

| Capability | Verified agent session | Human owner | Channel member |
|---|---:|---:|---:|
| List visible channels | Yes | Yes | Yes |
| Read a pre-join channel title/visibility | If listed | Yes | Yes |
| Request access | Yes | N/A | N/A |
| Approve/deny request | No | Yes | No, unless separately an owner |
| Create membership/device/binding | No | Via owner-approved admission | No |
| Set trust or pause | No | Yes | No |
| List channel agents | No before join | Yes | Yes after channel authorization |
| Read content/history | No before join | Per existing membership/history policy | Per existing channel policy |

The discovery credential is owner-linked and native-session-verified, but it is not a channel binding. Its only scopes are `list_channels` and `request_channel_access`. A channel-less variant of `loopback-browser-v1` issues it after the harness verifies the native session and the human signs in and authorizes discovery for that agent. It is short-lived, exact-origin- and session-generation-bound, sender-constrained to the connector proof key, held only in memory/owner-only storage, and never logged. Owner removal, session rebind, or generation change invalidates it.

It is deliberately separate from post-admission `AdapterCapability`; neither capability contains `approve`, `admit`, `set_policy`, or membership mutation. Internal mode instead has `khala internal` issue an owner-only 0600 discovery descriptor for an unjoined agent. Its durable role authorizes exactly `list_channels` and `request_channel_access`—never send, receive, approve, deny, admit, or mint grants—and each opaque listing reference is usable only with that same descriptor/session to request access. The human cookie role alone authorizes approve/deny; a binding capability, discovery descriptor, or stolen launch token can never decide. Same-uid descriptor theft remains the explicit v1 boundary rather than being papered over with an unproven presence mechanism.

### Contract projection

Directional shape, not an exact TypeScript signature:

| Type | Fields | Privacy rule |
|---|---|---|
| `ChannelListing` | `v`, opaque `listingRef`, bounded untrusted `title`, `visibility`, `serviceKind`, `requestState` | No Matrix `roomId`, owner, roster, counts, topic, timestamps, activity, invite, content, or history |
| `ChannelListingPage` | `items`, opaque `nextCursor` | Fixed maximum page size; no total count |
| `ChannelAccessRequest` | `operationId`, `listingRef`, verified session claim | Server resolves and fingerprints the first request over requester, session generation, origin, and hidden channel target; reference possession is not authority |
| `AccessRequestStatus` | `pending_owner`, `approved`, `connecting`, `connected`, `repair_required`, `denied`, `expired`, `revoked`, `unavailable` | `approved` records durable owner authorization, not a minted grant; `repair_required` is a known post-approval connector failure, while privacy-sensitive unknown/stale/ineligible/mismatched records collapse to `unavailable` |
| `AdmissionGrantExchange` | `operationId`, connector proof, reserved device ID, connector X25519 encryption public key | Connector-only secret-delivery boundary; the first matching exchange binds the encryption-key thumbprint to the authenticated Ed25519 proof-key thumbprint and operation/device, then consumes the one-time grant into an X25519/HKDF-SHA-256/ChaCha20-Poly1305 encrypted durable result. Retries for the same tuple return that envelope without repeating admission; CLI/MCP/status never receive either secret |

Listing order must not encode recent activity. V1 uses a stable title-plus-opaque-tie-break order, cursor pagination, no arbitrary text search, and no total counts. Titles are owner-controlled untrusted data: contracts cap their decoded length, normalize control characters, and keep CLI output JSON/MCP output structured so titles are never rendered as instructions or raw terminal control. A cursor binds a short-lived versioned snapshot of eligible opaque channel keys; every page still rechecks eligibility, and a visibility, allowlist, ownership, or session-generation mutation invalidates the snapshot to `unavailable` rather than leaking stale data. Responses are `no-store`; logs record operation/result codes but not titles, references, session IDs, Matrix room IDs, or content.

### CLI, MCP, and control plane

| Surface | Operation | Result |
|---|---|---|
| CLI | `khala channels list [--origin <trusted-origin>] [--cursor <cursor>]` | One JSON object per invocation containing the bounded page |
| CLI | `khala channels request-access <listing-ref> --operation <id>` | Finite request status; retry uses the same operation ID |
| CLI | `khala agents list --channel <held-channel>` | Joined-channel roster only; pre-join calls return `not_joined` without confirming the channel |
| MCP | `khala_list_channels` | Structured content identical to the CLI projection |
| MCP | `khala_request_channel_access` | Same idempotent request contract; never blocks waiting for the human |
| MCP | `khala_list_agents` | Requires an authorized joined-channel binding |
| Agent HTTP | `GET /api/agent/channels?cursor=...` | Authenticated discovery page; `no-store` |
| Agent HTTP | `POST /api/agent/channel-access-requests` | Creates/reconciles an owner prompt, never membership |
| Agent HTTP | `GET /api/agent/channel-access-requests/<operation>` | Poll-safe finite status; object authorization must match requester, session generation, origin, and operation record |
| Connector HTTP | `POST /api/connector/channel-access-requests/<operation>/exchange` | Proof-bound one-time grant consumption; never exposed through agent CLI/MCP status |
| Human HTTP | `PUT /api/human/channels/<channel>/discovery` | Owner-only visibility and stable-principal private-allowlist mutation with revision check |
| Human HTTP | `GET /api/human/channel-access-requests` | Human-cookie-authenticated pending requests |
| Human HTTP | `POST /api/human/channel-access-requests/<id>/decision` | Human-cookie-only approve/deny with compare-and-set and operation identity |

The agent-facing handlers follow the existing strict projection and `no-store` pattern. `--origin` and every transport redirect reuse bootstrap's exact configured-origin allowlist: HTTPS except loopback, no embedded credentials, and no cross-origin redirect. The human mutation follows the gateway's Origin checks and authenticated principal context. In internal mode, exact Host/Origin plus the host-only HttpOnly human cookie authorize approve/deny; launch tokens, binding capabilities, and discovery descriptors do not.

### Human prompt flow

1. The agent lists channels with a discovery capability tied to a verified native session.
2. It requests one opaque `listingRef`. The server re-evaluates visibility/eligibility and journals an idempotent pending request before notifying the owner.
3. Every accepted request creates a persistent inbox row and a non-modal notification. Selecting either opens the decision modal; closing it leaves the request pending, and queued requests never auto-open. The modal shows channel title; verified harness and stable session fingerprint; agent-supplied display name and sanitized workspace label, visibly marked as untrusted context; fixed server-derived post-admission capabilities; `history: none`; and explicit **Approve** / **Deny** actions. It shows no message preview and lets the owner inspect the full fingerprint before approval.
4. Approval is an authenticated owner command bound to request revision, channel, and verified session generation. Internal approve/deny additionally requires the human-cookie role. A stale or duplicate decision reconciles; it never creates a second membership.
5. Approval records durable authorization until the request's seven-day deadline; it does not mint a grant while the connector is offline. After reserving its local device, the connector presents the bound operation/proof/device tuple through `AdmissionGrantExchange`; trusted composition rechecks authority, then mints and consumes the short-lived one-time grant in that exchange. The grant stays hidden from channel listings, status responses, CLI/MCP output, storage, and logs.
6. The connector activates the returned binding/capability locally and acknowledges readiness. Only then does status become `connected`, with trust initialized to `review`, unpaused. A deterministic local activation failure becomes `repair_required`; repair resumes the same operation and reserved device without another owner prompt. An underlying admission `outcome_unknown` remains `unavailable` and reconciles by operation ID.
7. Denial, expiry, visibility change, channel deletion, or relevant revocation closes the request. The agent sees a bounded status, not the owner's reason.

| Owner UI state | Display and actions |
|---|---|
| Loading / empty | Skeleton, then “No access requests”; no decision actions |
| Pending | Full safe projection; Approve and Deny enabled |
| Submitting | Actions disabled, progress announced; row retained |
| Stale revision / unavailable | Refresh action; no automatic resubmit or implied decision |
| Denied / expired / revoked | Final status announced; row retained in recent history without agent-supplied details beyond the original safe projection |
| Approved / connecting / connected | Owner decision shown separately from connector readiness; row retained until connected or terminal failure |
| Repair required | Owner approval remains visible; show the connector repair action without creating a new request or implying denial |

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
| Admission (#22) | Keep discovery/request state separate. Owner approval authorizes a just-in-time one-time sender-constrained grant at connector exchange, then uses the retry-safe admission machinery with `history: none`; never add an agent-callable `admit` method or treat `listingRef` as an invite. |
| Trust (#29) | A new binding starts in effective `review`, unpaused. Discovery eligibility is not peer trust, and trust never inherits across a new generation. |
| Revocation (#67) | Binding revocation invalidates post-admission adapter capability and pending requests for that session generation. It does not pretend to remove Matrix room membership; participant removal remains a separate owner capability. |
| Link bootstrap (#83) | Secret channels keep link bootstrap as their only locator. Public/private discovery may reuse native-session inspection, ownership proof, device reservation, and admission redemption after approval, but a listing reference never substitutes for the link's ownership grant. |
| Internal core (`internal-core`, #138) | Owns SQLite channel metadata (implemented over its Matrix-neutral `RoomSubstrate`), loopback authentication, Host/Origin checks, human-cookie role, descriptor issuance, and local UI composition. It supplies the discovery store/adapter; this design owns projections and owner-approval semantics. |
| Setup CLI (`setup-cli`, #143) | May configure origins and MCP exposure, but must not persist channel titles/listing references or broaden discovery scope. |
| Make external (`make-external`, #146) | Conversion chooses visibility explicitly; default `secret`. Old local listing references are invalid after conversion and never become external admission authority. |
| Channel terminology (`channel-terminology`, #163) | Owns the existing-code rename. Every new surface in this design starts with channel-facing names while preserving Matrix-internal `roomId`/`RoomSubstrate` types until that ticket supplies their approved seams. |

External channel catalog population is lazy and owner-authoritative. A channel with no catalog record is `secret`; there is no provider-wide backfill. When an authenticated owner with current channel authority changes visibility to `public` or `private`, the control plane upserts the discoverable projection. Changing to `secret` removes/tombstones it. This makes all existing and newly created channels secret by default without requiring Matrix/internal `RoomSubstrate` or `ControlStore` enumeration.

## Trade-offs

| Choice | Benefit | Cost |
|---|---|---|
| Separate discovery from admission | Makes self-admission structurally impossible and keeps D11 reviewable | Adds a request journal and another capability type |
| Three visibility values | Covers directory discovery, targeted owner discovery, and non-enumerable link-only channels without overloading one flag | Public needs rate/abuse controls and careful service scoping |
| Opaque short-lived listing references | Reduces stable identifier leakage and prevents references becoming durable channel handles | Requires re-listing after expiry and server-side resolution |
| Minimal pre-join projection | Limits social-graph and activity leakage | Titles alone may be insufficient to distinguish similarly named channels |
| Async owner prompt | Works across CLI/MCP without holding a tool call open | Agent must poll or receive a later notification |
| Joined-only agent roster | Supports I6 without exposing who collaborates in channels an agent cannot enter | No global “find an agent” directory in v1 |

## Enumeration and privacy risks

| Risk | Control | Residual risk |
|---|---|---|
| Scraping public titles | Authentication + verified session, cursor/page caps, per-owner/session rate limits, no search/counts, stable non-activity order, crawl telemetry, hosted kill switch | A valid abusive account can still crawl its service scope; external public discovery stays off by default until monitoring is deployed |
| Probing private/secret channel existence | Same response for unknown, secret, stale, and ineligible references; opaque cursors/references; constant response shape | Timing differences across backing stores require integration measurement |
| Social-graph leakage | No pre-join roster, owner identity, participant count, receipts, or activity | A distinctive title can still identify a channel; owners need a preview when changing visibility |
| Credential/reference replay or theft | Short lifetime, sender constraint, audience/session-generation/origin binding, invalidation on rebind/revocation, recheck policy at request time | Same-user malware in internal mode remains in the accepted local threat model |
| Agent self-approval | Discovery scopes exclude admit/approve; owner endpoint requires human principal and CAS decision | A compromised owner session remains owner authority; discovery cannot solve that |
| Prompt spam or operation collision | Fingerprint the first resolved target under requester/session/origin/operation; mismatched reuse returns `unavailable`; enforce per-agent and per-owner pending caps, a five-minute requester/channel creation cooldown, and durable owner mutes | Public channels may still create notification load; default prompt batching is advisable |
| Stale approval after visibility/revocation change | Bind request revision and session generation; recheck immediately before admission | An admission already committed cannot be undone by changing visibility; use revocation/removal flows |
| Spoofed prompt identity | Lead with verified harness + stable session fingerprint; label display name/workspace as untrusted; require explicit approval | Owners can still approve a look-alike if they ignore the verified fingerprint |
| Retained request social graph | Purge terminal request fingerprints, hidden targets, and untrusted labels after 30 days; pending records retain only the minimum journal fields | Backups and infrastructure copies require their own retention enforcement |
| Logs/cache disclosure | `no-store`; never log credentials, titles, references, Matrix room IDs, session IDs, grants, or content | Infrastructure access logs must be checked in integration because module tests do not prove them |

## Non-goals

- Anonymous web channel browsing, federation-wide search, organization directories, recommendations, ranking, or fuzzy search.
- A global agent directory or pre-join disclosure of agents, humans, counts, receipts, activity, content, history, topics, or owner identity.
- Agent self-approval, automatic admission, inherited trust, trust-policy changes, participant removal, or secure deletion.
- Replacing invitation/link bootstrap; secret channels deliberately depend on it.
- Choosing the internal SQLite schema, external messaging provider, notification transport, or exact UI styling.
- Make External migration and pairing-code semantics beyond the invalidation rule above.

## Ticket contracts

Contracts are ordered by dependency. Each is sized for one implementation agent and one PR.

### RD1 — Define discovery and access-request contracts

| Field | Contract |
|---|---|
| Title | Define channel discovery and access-request contracts |
| Slug | `channel-discovery-contract` |
| `complexity` | `complexity:3` |
| Scope | Add strict versioned discovery/listing/request types, finite outcomes, decoders, limits, exports, and a provider-neutral resolver port that revalidates an opaque listing reference for the authenticated requester. Define an owner-scoped stable agent principal (never display name, device ID, or session ID) for private allowlists and the connector-only grant exchange. Encode `public/private/secret`, the minimal projection, pagination, and the rule that no method admits. |
| Out of scope | Storage, HTTP, CLI/MCP, UI, admission implementation, provider behavior. |
| Files/packages | `packages/contracts/src/messaging/discovery.ts`, `packages/contracts/src/messaging/discovery.test.ts`, `packages/contracts/src/messaging/index.ts`, `packages/contracts/src/messaging/README.md`. |
| Acceptance criteria | Unknown fields fail; no listing type can carry content/roster/Matrix room ID; titles are bounded and treated as untrusted data; secret is representable but never asserted listable by the port; the resolver returns only a server-side authorization result and cannot mutate membership; allowlist create/revoke is owner-only and keyed by stable agent principal while every use revalidates the current session generation; request outcomes include distinct `repair_required` and privacy-safe `unavailable` states; status is grant-free; credential/grant exchange types encode origin, requester, Ed25519 proof key, distinct X25519 encryption key, device, session generation, and expiry without exposing admit authority. |
| Tests | Round-trip all three visibility values and every finite status; reject extra `roomId`, `participants`, `lastActivity`, content, grant, or `admit` fields; reject oversized titles/pages/cursors and normalize control characters; add a compile-time fixture proving `ChannelDiscoveryPort` exposes no `admit` member; reject expired/wrong-origin/wrong-generation credential and grant-exchange projections; reject encryption-key reuse with a different proof-key thumbprint or operation/device tuple. **Wrong-implementation test:** a response containing Matrix `roomId` or `participantCount` must fail strict decoding. |
| `blocked-by` | None; the approved requirements and survey are inputs, not implementation dependencies. |
| Conflict risk | Medium with `internal-core` (#138), which may propose local metadata types; low with listening/read-receipt work. RD1 owns the shared contract names and projection. |

### RD2A — Authorize external channel discovery credentials

| Field | Contract |
|---|---|
| Title | Authorize external channel discovery credentials |
| Slug | `external-channel-discovery-bootstrap` |
| `complexity` | `complexity:3` |
| Scope | Add the channel-less `loopback-browser-v1` consent flow that verifies the native agent session, authenticates the human owner, binds a connector proof key and exact trusted origin, issues only `list_channels` and `request_channel_access`, and refreshes or invalidates the short-lived in-memory/owner-only credential. Define the control-plane authorize/token routes and connector-side loopback/PKCE composition without creating a channel binding. |
| Out of scope | Channel catalog/list routes, visibility policy, membership, adapter capability issuance, access-request journaling, CLI/MCP presentation, internal descriptor issuance. |
| Files/packages | `packages/connector/src/bootstrap/**`, connector composition/storage tests, `apps/control/src/channel-discovery/bootstrap/**`, minimal bootstrap route registration, and RD1 contract consumers. |
| Acceptance criteria | Native-session verification and explicit signed-in owner consent precede issuance; the credential is proof-key, owner, origin, audience, and session-generation bound; scopes are exactly listing and request creation; no durable plaintext credential or channel binding is created; refresh revalidates owner/session and rotation invalidates the prior credential; denial, expiry, rebind, owner removal, hostile origin, or proof mismatch fails closed. |
| Tests | Consent/deny/cancel; PKCE and loopback callback binding; wrong owner/origin/audience/proof; expiry/refresh rotation; rebind and owner removal; restart leaves no reusable plaintext credential; scope rejection for send/receive/approve/admit. **Wrong-implementation test:** completing the flow must not create membership, a device, or an `AdapterCapability`. |
| `blocked-by` | `channel-discovery-contract`; `agent-link-bootstrap` (#83) for native-session, owner-consent, loopback, and proof-key seams. |
| Conflict risk | High with `agent-link-bootstrap` (#83), `setup-cli` (#143), and `internal-core` (#138) on bootstrap composition. Extend the existing flow behind a channel-less adapter rather than adding a second auth stack. |

### RD2B — Implement external discovery projection and privacy controls

| Field | Contract |
|---|---|
| Title | Implement external channel discovery and privacy controls |
| Slug | `external-channel-discovery` |
| `complexity` | `complexity:4` |
| Scope | Implement the external lazy catalog/read model, owner-authorized visibility and private-allowlist create/revoke operations, eligibility and listing-reference resolution, opaque snapshot cursors, listing rate limits, safe error collapse, RD2A discovery-credential validation, and authenticated listing routes. Absence means `secret`; no provider backfill. Keep hosted public discovery disabled pending RD3. |
| Out of scope | Request journaling or pending caps, admission side effects, human prompt/settings UI, hosted rollout telemetry, CLI/MCP, internal SQLite adapter, anonymous directory. |
| Files/packages | `apps/control/src/channel-discovery/**`, small route registrations in `apps/control/src/composition/{agent,human}/handlers.ts`, `apps/control/src/runtime/**` tests/manifest; contract consumers only from RD1. |
| Acceptance criteria | Public listings require a short-lived sender-constrained discovery credential; external private eligibility is same-owner or an owner-managed stable-principal allowlist; secret/absent never appears; only a current channel owner can mutate visibility or allowlists; rebind invalidates credentials and revalidates the new generation without silently changing the stable allowlist; the RD1 resolver rechecks policy without side effects; hosted public discovery remains disabled; output is minimal/no-store. |
| Tests | Public/private/secret matrix across two owners and two sessions; allowlist add/remove, rebind, owner removal, and cross-owner denial; lazy registration/tombstone; RD2A credential expiry/rebind/revocation validation; resolver requester/expiry checks; cursor snapshot plus title/visibility/allowlist mutation invalidation; listing rate limits; logs/JSON omit forbidden fields; exact-origin and redirect behavior. **Wrong-implementation test:** a secret channel inserted beside public channels must produce byte-equivalent list metadata/count behavior to the same dataset with that channel absent. |
| `blocked-by` | `channel-discovery-contract`, `external-channel-discovery-bootstrap`; `invitation-admission` (#22) for authority vocabulary; `agent-link-bootstrap` (#83) for verified-session/ownership seams. |
| Conflict risk | Medium with `internal-core` (#138) on shared contract names; external persistence remains isolated. High with `external-channel-composition` (#41 / PR #120) on hosted route composition. |

### RD3 — Add owner visibility settings and hosted rollout controls

| Field | Contract |
|---|---|
| Title | Add owner channel visibility settings and rollout controls |
| Slug | `channel-visibility-settings` |
| `complexity` | `complexity:3` |
| Scope | Add owner channel-settings UI for external channels, showing the exact pre-join projection, managing the private stable-principal allowlist, and requiring confirmation before increasing visibility. Add privacy-safe crawl telemetry, per-account crawl detection, an operator alert route, and a kill switch; enable hosted public discovery only after an operations drill proves the crawl signal, rate limits, alert delivery, and kill-switch response. |
| Out of scope | Catalog storage/resolution, request/approval UI, CLI/MCP, internal channel settings, provider-wide backfill, anonymous directory. |
| Files/packages | `apps/web/src/features/channel-settings/**`, channel-page composition/browser tests, `apps/control/src/channel-discovery/**` telemetry and rollout configuration, runtime manifest/config tests. |
| Acceptance criteria | Existing/new external channels display as secret until explicitly changed; preview exactly matches the RD1 projection; increases require explicit confirmation; owners can inspect/add/revoke private eligibility without using agent-controlled labels as identity; cancellation changes nothing; submitting disables controls and announces progress/success; stale revision refreshes before retry, authority loss returns to read-only, and retryable failure preserves the pending edit without implying success; all states remain keyboard operable with live status announcements; telemetry contains identifiers/digests but never titles/references; public discovery stays disabled until a scripted crawl is constrained by rate limits, triggers the configured operations alert, and an operator removes public results with the kill switch within five minutes. |
| Tests | Loading/editing/preview/confirm/cancel/submitting/success/failure, keyboard and live announcements, secret default, allowlist identity/add/revoke, stale revision refresh, owner-authority loss, telemetry redaction, per-account scripted crawl/rate-limit/alert exercise, disabled-by-default rollout, and measured kill-switch propagation under five minutes. **Wrong-implementation test:** selecting public and dismissing the confirmation must leave the channel secret and absent from another eligible session's listing. |
| `blocked-by` | `channel-discovery-contract`, `external-channel-discovery`; `invitation-admission` (#22) for owner authority vocabulary. |
| Conflict risk | High with `internal-core` (#138) and `make-external` (#146) on channel settings composition; keep the external settings feature isolated and consume RD2 mutations. |

### RD4A — Add the channel-access request journal and grant workflow

| Field | Contract |
|---|---|
| Title | Add the channel-access request journal and grant workflow |
| Slug | `channel-access-journal` |
| `complexity` | `complexity:4` |
| Scope | Consume the RD1 resolver to journal pending requests with a persisted seven-day deadline, enforce per-agent/owner pending caps plus a five-minute requester/channel creation cooldown, persist owner mutes, notify the correct owner, authenticate approve/deny against the owner principal (human-cookie role internally), apply CAS decisions, expose requester-bound status lookup, and record durable approval authorization until that deadline. Every mute/unmute authenticates the human principal, verifies current ownership of the exact channel, and applies a revision-checked update. The connector exchange mints the one-time sender-constrained admission grant just in time after approval and final recheck. Before provider work it durably records a stable admission operation ID and exchange phase; every resume reconciles that same provider idempotency key before returning an encrypted committed result or `unavailable`, and never mints a second grant or starts a second admission. The result is encrypted to a distinct connector X25519 key whose thumbprint is bound to the authenticated Ed25519 proof key and operation/device tuple. Alongside the server-side operation, requester/session/origin, hidden target, revision, owner, and status metadata required by the journal, persist only the verified fingerprint plus bounded untrusted labels as human-facing identity context. Delete the recovery envelope on readiness acknowledgement or seven days after admission commitment, whichever comes first. After 30 days, reduce terminal requester/session/origin/owner linkage to an unlinkable idempotency tombstone and purge fingerprints, hidden targets, and untrusted labels. |
| Out of scope | Web inbox/modal, connector-local device activation, channel browser/list UI for agents, transport-specific notifications, auto trust, history transfer, participant removal. |
| Files/packages | `apps/control/src/channel-access/**`, minimal route registration in `apps/control/src/composition/{agent,human}/handlers.ts`, control tests, `packages/policy` only as a consumer. |
| Acceptance criteria | Agent request alone creates no membership; resolver failure collapses to `unavailable`; the first resolved target is fingerprinted under requester/session/origin/operation, and mismatched operation reuse creates no second prompt; pending caps and status lookup are requester/session/origin/operation bound; cooldown-limited or owner-muted attempts return the same bounded unavailable result without a pending row or notification; status is grant-free; only matching owner authority can decide or mutate that channel's mute; internal human-cookie authority is required while binding/discovery capabilities are rejected; stale/duplicate decisions and mute revisions reconcile; at the persisted seven-day deadline, pending or approved-but-unconsumed work atomically becomes `expired`, releases cap capacity, suppresses later decisions/notifications, and cannot mint a grant; revocation or visibility loss closes pending work; recovery and terminal sensitive context obey their purge deadlines; only approval can authorize one connector-only grant; exchange reconciliation commits one recoverable operation result, never a second membership. |
| Tests | Happy approve/deny; wrong/stale owner plus binding/discovery capability denial for decisions and mute/unmute; cross-session operation-ID lookup; reuse one operation ID with two listing references; pending caps; cooldown and durable revision-checked mute across restart; persisted seven-day expiry across restart, cap release, and late-decision suppression; stale request revision; duplicate decisions; revocation/visibility change before approval; recovery-envelope deletion and 30-day unlinkable terminal tombstone across restart; grant redaction, just-in-time one-time exchange, provider-operation reconciliation, and same-operation/proof/device recovery after response loss. **Wrong-implementation test:** after creating a request but before owner approval, membership/device/binding stores and grant output must remain unchanged. |
| `blocked-by` | `channel-discovery-contract`; `invitation-admission` (#22), `trust-transitions` (#29), `device-agent-revocation` (#67), and `agent-link-bootstrap` (#83). |
| Conflict risk | High with `internal-core` (#138) and `make-external` (#146) on approval composition. Keep the journal, routes, and grant workflow behind dedicated ports. |

### RD4B — Add the shared channel-access inbox and approval prompt

| Field | Contract |
|---|---|
| Title | Add the shared channel-access inbox and approval prompt |
| Slug | `channel-access-inbox` |
| `complexity` | `complexity:3` |
| Scope | Render the persistent owner inbox, a persistent owner-visible “Access requests” navigation entry with a bounded pending indicator, non-modal notifications, accessible approve/deny dialog, and requester/channel mute action from the RD4A safe projection. Build the decision-dialog shell as a shared component that `make-external`'s pairing approval UI reuses; channel-specific and pairing-specific adapters supply their own verified facts and untrusted labels. |
| Out of scope | Request storage, grant minting, connector activation, channel listing/settings, conversion orchestration, or embedding agent-controlled actions/body markup. |
| Files/packages | `apps/web/src/features/channel-access/**`; shared dialog primitives under `apps/web/src/features/approval-decision/**`; minimal channel-page composition/browser tests. `make-external` pairing approval consumes the shared primitive rather than copying it. |
| Acceptance criteria | Inbox is canonical and queued requests never auto-open; hosted and internal compositions keep its navigation entry visible, with a capped `99+` indicator, and notification selection or direct navigation reaches the same row; prompt leads with verified harness/fingerprint, marks agent-supplied display/workspace labels as untrusted, shows fixed server-derived capabilities and `history: none`, and separates owner decision from connector readiness; an authenticated current owner can mute/unmute the requester for that exact channel through a revision-checked action, while stale/wrong owners and binding/discovery capabilities are rejected; dismissing a notification or dialog leaves the pending row reachable; stale status refreshes without resubmit; terminal sensitive context disappears after the 30-day retention limit; pairing and channel-access adapters share one keyboard/focus/status implementation; agent text cannot create controls or active content. |
| Tests | Loading/empty/submitting/final states; persistent navigation and `0`/bounded/`99+` indicator; notification/direct-navigation parity; colliding names and spoofed workspace; mute/unmute, wrong/stale owner and non-human-role denial, and expiry; 30-day recent-history purge; modal queue/dismiss/focus return/Escape/Tab; live announcements; stale revision; approved/connecting/connected/repair-required display; pairing fixture through the same shared shell. **Wrong-implementation test:** enqueue two requests and assert the second never auto-opens or steals focus when the first closes. |
| `blocked-by` | `channel-access-journal`; `external-channel-composition` (#41 / PR #120). |
| Conflict risk | High with `internal-core` (#138) local UI composition and `make-external` (#146) pairing approval. The shared shell owns behavior; each area owns only its projection adapter. |

### RD5 — Redeem approval and prove connector readiness

| Field | Contract |
|---|---|
| Title | Redeem channel approval and prove connector readiness |
| Slug | `channel-access-activation` |
| `complexity` | `complexity:4` |
| Scope | Extend the connector/bootstrap composition so each submitted request journals its operation ID locally, resumes after restart, and uses bounded-backoff status polling (or an equivalent authenticated wake signal) until terminal. On `approved`, reserve a local device, generate a distinct X25519 recovery keypair, and durably retain its private key plus the operation/proof/device tuple in owner-only storage before calling RD1's connector-only exchange. The server binds both key thumbprints, records a stable admission operation ID before provider invocation, and atomically rechecks the request deadline with the other authority facts. It then mints and consumes the short-lived grant just in time and encrypts the committed result with X25519/HKDF-SHA-256/ChaCha20-Poly1305. A retry reconciles that same provider idempotency key and returns the same envelope or `unavailable` without a second grant/admission. Rotation before consumption supersedes the prior encryption key; after consumption, a missing/mismatched private key yields `repair_required` rather than reminting. Activate the returned binding/capability, initialize review trust, acknowledge readiness, and delete the recovery envelope. |
| Out of scope | Human UI, discovery projection, trust changes after initialization, provider-specific membership implementation. |
| Files/packages | `packages/connector/src/bootstrap/**`, connector runtime/composition and storage tests, `apps/control/src/channel-access/**` redeem/readiness handlers, existing admission/trust consumers. |
| Acceptance criteria | Grant is requester/origin/session-generation/proof-key/device bound, single-use, short-lived, and never returned by status/CLI/MCP or logged/persisted in plaintext; the recovery envelope is authenticated and decryptable only by the separately persisted X25519 private key; only the connector exchange can consume the grant; immediately before mint/consumption/admission, the exchange atomically rechecks the persisted seven-day deadline, request revision, current owner authority, channel visibility/existence, and relevant session revocation, returning `expired` at or after the deadline and otherwise closing without membership on failure; a lost response or restart retries the same durable tuple, reconciles the same admission operation, and recovers the encrypted result without new membership, grant, or prompt; polling is bounded/jittered and the durable operation resumes after restart; `connected` is returned only after local activation ack; deterministic activation failure or lost recovery key is `repair_required` and never remints membership; unresolved admission ambiguity remains `unavailable`; the encrypted recovery result is deleted on readiness acknowledgement or seven days after admission commitment. |
| Tests | Status/CLI/MCP grant absence; grant theft/cross-session exchange; wrong device/proof/origin/generation; encryption/proof-key thumbprint mismatch; X25519 rotation before consumption and rejection after it; lost private key; replay; request-deadline boundary race; owner loss, visibility/deletion, request revision, and revocation races immediately before exchange; approval while connector is offline; restart from pending/approved; bounded polling; crash before provider invocation, between invocation and reconciliation, and after admission before activation; recovery-envelope deletion; repair-required recovery; duplicate readiness ack; review baseline. **Wrong-implementation test:** an owner-approved request with no connector activation acknowledgment must never report `connected`. |
| `blocked-by` | `channel-discovery-contract`, `channel-access-journal`, `multi-agent-bindings` (#152 contract 3), `invitation-admission` (#22), `trust-transitions` (#29), `device-agent-revocation` (#67), and `agent-link-bootstrap` (#83). |
| Conflict risk | High with `internal-core` (#138) connector composition and `setup-cli` (#143). Reuse bootstrap grant/proof/storage primitives rather than adding a second credential stack. |

### RD6 — Expose channel and joined-agent listing through CLI and MCP

| Field | Contract |
|---|---|
| Title | Expose channel and joined-agent listing through CLI and MCP |
| Slug | `channel-agent-listing` |
| `complexity` | `complexity:3` |
| Scope | Extend `AgentClientPort`, CLI dispatch/validation/output, and MCP tools for `khala channels list`, `khala agents list --channel`, `khala_list_channels`, and joined-channel `khala_list_agents`. Preserve identical strict projections across CLI/MCP. |
| Out of scope | Access requests/status, control-plane storage/policy, auto polling, hook delivery, setup/package publication, pre-join roster disclosure. |
| Files/packages | New command modules under `packages/agent-cli/src/cli/channels/**` and tool modules under `packages/agent-cli/src/mcp/channels/**`, with minimal registration-only diffs in `cli/app.ts` and `mcp/server.ts`; module tests; HTTP composition client; `packages/agent-cli/README.md`. |
| Acceptance criteria | Commands/tools return only contract-decoded fields; ownership bootstrap obtains discovery scope when required; `--origin` is exact-allowlisted and redirect-safe; joined-agent list refuses unheld channels without an existence oracle; existing send/listen behavior remains unchanged; shared entry files only register the new modules. |
| Tests | CLI parse/output/error codes; origin allowlist, credentials, loopback HTTP, and cross-origin redirects; MCP tools/list schemas and strict calls; CLI/MCP parity fixtures; cursor pass-through; not-connected/not-joined/unavailable. **Wrong-implementation test:** an MCP `khala_list_channels` result containing server-only Matrix `roomId`, roster, or activity must be rejected rather than forwarded. |
| `blocked-by` | `channel-discovery-contract`, `external-channel-discovery-bootstrap`, `external-channel-discovery`. |
| Conflict risk | High with `mcp-result-piggyback` (#141), `claude-code-plugin` (#140), and `setup-cli` (#143), which touch the same CLI/MCP files. Land after or coordinate file ownership; keep command/tool additions isolated. |

### RD7 — Expose access requests and status through CLI and MCP

| Field | Contract |
|---|---|
| Title | Expose channel-access requests and status through CLI and MCP |
| Slug | `channel-access-cli-mcp` |
| `complexity` | `complexity:2` |
| Scope | Add `khala channels request-access`, `khala_request_channel_access`, and finite status reads using the same strict projection and idempotent operation ID. |
| Out of scope | Channel/agent listing, control-plane workflow, automatic polling, notifications/hooks, setup/package publication. |
| Files/packages | New modules under `packages/agent-cli/src/cli/channels/**` and `packages/agent-cli/src/mcp/channels/**`, with minimal registration-only diffs in `cli/app.ts` and `mcp/server.ts`; module tests; HTTP composition client; `packages/agent-cli/README.md`. |
| Acceptance criteria | Request returns promptly as pending and exposes the operation state supplied by RD5 without implementing a second lifecycle; status preserves owner-decision versus connector-readiness states; retries reuse the operation ID; `repair_required` gives a connector repair action while `unavailable` prevents unsafe retries; CLI and MCP expose identical decoded fields and treat titles as untrusted structured data. |
| Tests | CLI/MCP parity, operation pass-through, pending/approved/denied/connecting/connected/repair-required/unavailable, malformed status, prompt-like and terminal-control titles, and cross-origin redirect rejection. **Wrong-implementation test:** an `unavailable` result must not trigger creation of a second request or a fresh operation ID. |
| `blocked-by` | `channel-discovery-contract`, `channel-access-journal`, `channel-access-activation`, and `channel-agent-listing` (RD6). |
| Conflict risk | High with `mcp-result-piggyback` (#141), `claude-code-plugin` (#140), `setup-cli` (#143), and `channel-agent-listing` in the same CLI/MCP files; land after those registrations and keep additions isolated. |

### RD8 — Adapt discovery to internal mode

| Field | Contract |
|---|---|
| Title | Adapt channel discovery to internal mode |
| Slug | `internal-channel-discovery` |
| `complexity` | `complexity:3` |
| Scope | Supply the internal catalog/visibility adapter from the local SQLite store, persist requests, compose the shared owner prompt and channel visibility/allowlist settings in the local UI, and have `khala internal` issue an unjoined agent a separate 0600 discovery descriptor. Its durable capability authorizes exactly `list_channels` and `request_channel_access`, with no send, receive, approve, deny, admission, or grant-minting authority; a listing reference remains bound to that descriptor/session when requesting access. Default local channels to `private`, where eligibility is an explicit stable-principal allowlist with no same-owner fallback; `secret` hides them and `public` means any verified agent on that local service. Human-cookie authority alone decides requests and mutates settings. |
| Out of scope | SQLite event-schema design, inventing a launcher/OS presence proof, external conversion, harness delivery, process isolation against same-uid descriptor theft, or duplicating the RD4B shared UI. |
| Files/packages | `apps/internal/src/store/**` for the adapter, `apps/internal/src/server/**` for role-checked routes, `apps/internal/src/composition/**` for ports, `apps/web/src/internal/**` for local composition, and `packages/agent-cli/src/cli/internal*.ts` plus `packages/agent-cli/src/composition/**` for descriptor issuance/selection; consume RD1/RD4A/RD4B ports without redefining them. |
| Acceptance criteria | Restart preserves visibility, explicit per-agent eligibility, and pending decisions; the human-cookie-authorized settings UI can inspect and mutate visibility plus add/revoke stable-principal eligibility; secret is absent; two same-owner local agents receive different private listings according to their allowlists; rebind revalidates generation; a discovery descriptor can list and create an owner-decided access request but cannot send, receive, approve, deny, mint a grant, or impersonate another binding; only the human-cookie role decides or changes settings; exact Host/Origin checks still apply; approval produces one ready binding in review; same-uid descriptor theft is documented as the v1 limit rather than claimed solved. |
| Tests | SQLite/restart integration; settings preview/visibility and allowlist add/remove across two verified same-owner agents; rebind; descriptor issuance/rotation/mode; discovery-route allowlist; access request creation; send/receive/decision denial; human-cookie approve/deny/settings mutation; binding/discovery capability settings denial; hostile Host/Origin rejection; pending request expiry; shared UI composition smoke. **Wrong-implementation test:** launch an unjoined agent with only its discovery descriptor and assert it can list eligible channels and create a pending owner request but cannot send, receive, approve, deny, change visibility, edit the allowlist, or mint a grant. |
| `blocked-by` | `channel-discovery-contract`, `channel-access-journal`, `channel-access-inbox`, `channel-access-activation`, `local-sqlite-room-store`, `authenticated-loopback-server`, `local-web-entry`, and `internal-core-launcher` (#138). |
| Conflict risk | Highest with `internal-core` (#138) because it owns SQLite/server/UI roots; implement as an adapter after that contract freezes. Medium with `make-external` (#146) on visibility migration and reference invalidation. |

## Verification handoff

Implementation tickets must run their package tests/typechecks and boundary checks, plus an integration chain that uses real contract decoders and stores rather than only mocks. The final acceptance suite (`acceptance`, #147) should prove both modes with fake harnesses:

1. a verified agent lists a public/private channel but not a secret channel;
2. it requests access and cannot send/read/list agents before approval;
3. the owner approves in the UI;
4. exactly one binding becomes ready in review with no history;
5. the joined agent can list the authorized channel roster and exchange messages;
6. revocation stops the binding capability without claiming membership removal.

Live external provider membership, internal loopback integration, timing-equivalence of existence-hiding responses, and browser prompt delivery are **unproven** by this research PR and belong to the implementation/acceptance tickets above.
