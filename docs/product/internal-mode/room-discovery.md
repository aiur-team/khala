# Channel discovery for internal and external channels

Status: research proposal for D11, I6 and I7. This document does not claim an implementation exists.

## Summary

Add a read-only `ChannelDiscoveryPort` beside, not inside, admission. A verified agent session can list visible channels, request access by listing reference or channel URL, and submit an intent to create a channel, but no agent capability can create membership, mint an adapter capability, change trust, approve its own request, or create the channel itself. Every accepted access or creation intent becomes an owner-facing decision; only authenticated human approval invokes channel creation or admission.

Use all three visibility values because each has distinct useful behavior:

| Visibility | Listed to | Access path | Meaning of “public” |
|---|---|---|---|
| `public` | Any authenticated, native-session-verified agent on that Khala service | Owner approval | Discoverable within one configured service, never an anonymous Internet directory |
| `private` | Only agents for which the server proves eligibility: same-owner or an explicit channel allowlist externally; explicit per-agent eligibility internally | Owner approval | The response never reveals why the agent is eligible |
| `secret` | Nobody | A channel URL locates the same owner-approved access flow | Non-enumerable; knowing or guessing the channel does not authorize admission |

“Public” changes discoverability only. It never weakens D11. For a pre-join agent, the service reveals a title and a short-lived opaque listing reference, not a channel identifier, roster, activity, history, or content. Agent rosters remain visible only after membership; there is no cross-channel agent directory in v1.

## Fixed decisions and assumptions

| Kind | Decision |
|---|---|
| Fixed | D11: agents may list channels they could join but can never admit themselves; the human owner grants access. |
| Fixed | Existing external admission, trust and revocation semantics remain authoritative. |
| Fixed | Internal mode has the same owner prompt even though it is loopback-only. |
| Fixed | Internal approve/deny requires the authenticated human-cookie role. Binding and discovery capabilities can never decide, and v1 does not add a second launcher/OS presence proof. |
| Fixed | The only agent process is the user's own interactive Codex, Claude, or OpenCode CLI session. Khala neither launches nor hosts it; a `khala run <cli>` wrapper is not a default product path. |
| Fixed | The user may point that session at a Khala/channel URL or ask it to create a channel. `khala channels create` / `khala_create_channel` submits an intent, and the human confirms before one secret channel and the requesting agent's grant are created. Other agents still require their own humans' approval. |
| Assumption | “Public” means authenticated service-scope discovery, not anonymous discovery. A global hosted directory would need separate abuse and moderation design. |
| Assumption | External `private` v1 eligibility is same-owner or an explicit channel allowlist. Internal `private` is explicit per-agent eligibility because all local agents otherwise share one owner. Organization/team directories are out of scope because no organization model exists in the cited contracts. |
| Assumption | Visibility eligibility gates enumeration and listing-reference requests. A canonical channel URL is a non-enumerating locator for otherwise unknown agents: private or secret URL requests may reach the owner prompt without listing eligibility, but never bypass owner approval or disclose whether an invalid/ineligible URL exists. |
| Assumption | New admissions start with `history: none` and fail-closed `review` trust. History disclosure is not part of discovery. |
| Assumption | A listing reference and discovery credential expire quickly. The implementation chooses exact lifetimes within the service's existing trusted-clock conventions. |
| Assumption | V1 hard abuse ceilings are 25 listings per page, 10 listing requests per verified session per minute, five pending requests per agent, and 50 pending requests per owner. Owner notifications are batched above 10 new requests per minute. Operators may configure lower values, never higher ones, without a later policy change. |
| Assumption | Same-uid theft of `launch.json` or another binding's descriptor is the known internal-mode v1 limit recorded by `authenticated-loopback-server` and `internal-launcher`; capabilities provide API attribution, not process isolation. |

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
| Request a new channel | Yes, as a pending intent | N/A | N/A |
| Approve/deny request | No | Yes | No, unless separately an owner |
| Create channel/membership/device/binding | No | Via owner-approved composition | No |
| Set trust or pause | No | Yes | No |
| List channel agents | No before join | Yes | Yes after channel authorization |
| Read content/history | No before join | Per existing membership/history policy | Per existing channel policy |

The discovery credential is owner-linked and native-session-verified, but it is not a channel binding. Its only scopes are `list_channels`, `request_channel_access`, and `request_channel_create`; the two request scopes can only journal a human decision and cannot mutate channels or membership. A channel-less variant of `loopback-browser-v1` issues it after the harness verifies the native session and the human signs in and authorizes discovery for that agent. It is short-lived, exact-origin- and session-generation-bound, sender-constrained to the connector proof key, held only in memory/owner-only storage, and never logged. Owner removal, session rebind, or generation change invalidates it.

It is deliberately separate from post-admission `AdapterCapability`; neither capability contains `approve`, `create_channel`, `admit`, `set_policy`, or membership mutation. Internal mode instead has `khala internal` issue an owner-only 0600 discovery descriptor for an unjoined agent. Its durable role authorizes exactly `list_channels`, `request_channel_access`, and `request_channel_create`—never send, receive, approve, deny, create, admit, or mint grants—and references/intents remain bound to that descriptor/session. The human cookie role alone authorizes approve/deny/create; a binding capability, discovery descriptor, or stolen launch token can never decide. Same-uid descriptor theft remains the explicit v1 boundary rather than being papered over with an unproven presence mechanism.

Private allowlists use an owner-only verified-agent picker, never an agent-facing directory or free-text identity field. Externally it offers stable principals already known through the owner's sessions, completed pairing, or prior approved access; internally it offers descriptors/sessions issued by `internal-launcher`, including an unjoined newly issued discovery session. Each row leads with a server-verified fingerprint and treats display/workspace labels as untrusted. An empty picker explains how to issue a descriptor or complete pairing without launching an agent from Khala; a canonical channel URL remains the route for an otherwise unknown agent.

### Contract projection

Directional shape, not an exact TypeScript signature:

| Type | Fields | Privacy rule |
|---|---|---|
| `ChannelListing` | `v`, opaque `listingRef`, bounded untrusted `title`, `visibility`, `serviceKind`, `requestState` | No Matrix `roomId`, owner, roster, counts, topic, timestamps, activity, invite, content, or history |
| `ChannelListingPage` | `items`, opaque `nextCursor` | Fixed maximum page size; no total count |
| `ChannelAccessRequest` | `operationId`, `listingRef`, verified session claim | Server resolves and fingerprints the first request over requester, session generation, origin, and hidden channel target; reference possession is not authority |
| `ChannelUrlAccessRequest` | `operationId`, canonical channel URL, verified session claim | URL is a locator only; the server resolves it without returning an identifier or bypassing the owner prompt |
| `ChannelCreateIntent` | `operationId`, trusted service origin, bounded untrusted proposed title, verified session claim | Journals an owner prompt only; it contains no create/admit authority and creates no channel before approval |
| `AccessRequestStatus` | `pending_owner`, `approved`, `connecting`, `connected`, `repair_required`, `denied`, `expired`, `revoked`, `unavailable` | `approved` records durable owner authorization, not a minted grant; `repair_required` is a known post-approval connector failure, while privacy-sensitive unknown/stale/ineligible/mismatched records collapse to `unavailable` |
| `AdmissionGrantExchange` | `operationId`, connector proof, reserved device ID, connector X25519 encryption public key | Connector-only secret-delivery boundary; the first matching exchange binds the encryption-key thumbprint to the authenticated Ed25519 proof-key thumbprint and operation/device, then consumes the one-time grant into a versioned libsodium sealed box using `crypto_box_seal` (X25519 + XSalsa20-Poly1305). The envelope carries the algorithm identifier, recipient-key thumbprint, and ciphertext; the sealed plaintext binds version, operation, requester, origin, session generation, device, both key thumbprints, expiry, and the grant. Retries return the byte-identical stored envelope without repeating admission or sealing; CLI/MCP/status never receive either secret. |

Grant sealing uses libsodium's audited standard sealed-box construction rather than a bespoke KEM/KDF/AEAD composition. Existing bootstrap redemption is retained for initial online bootstrap, but is insufficient here because an admission may commit while the connector loses the response; exposing the grant through status would break the secret boundary. `channel-discovery-contract` pins the maintained `libsodium-wrappers` binding and proves its published Curve25519 known-answer key vector plus sealed-box open, wrong-key, truncation, and tamper rejection on Node 22 before freezing the wire schema.

Listing order must not encode recent activity. V1 uses a stable title-plus-opaque-tie-break order, cursor pagination, no arbitrary text search, and no total counts. Titles are owner-controlled untrusted data: contracts cap their decoded length, normalize control characters, and keep CLI output JSON/MCP output structured so titles are never rendered as instructions or raw terminal control. A cursor binds a short-lived versioned snapshot of eligible opaque channel keys; every page still rechecks eligibility, and a visibility, allowlist, ownership, or session-generation mutation invalidates the snapshot to `unavailable` rather than leaking stale data. Responses are `no-store`; logs and telemetry record operation/result codes but not titles, listing references, canonical channel URLs or URL-derived locators, session IDs, Matrix room IDs, or content. The journal retains only the resolved hidden-target fingerprint, never the submitted URL.

### CLI, MCP, and control plane

| Surface | Operation | Result |
|---|---|---|
| CLI | `khala channels list [--origin <trusted-origin>] [--cursor <cursor>]` | One JSON object per invocation containing the bounded page |
| CLI | `khala channels request-access <channel-url-or-listing-ref> --operation <id>` | Finite request status; `/khala join <channel-url>` delegates here and retry uses the same operation ID |
| CLI | `khala channels create --title <untrusted-title> --operation <id>` | Submits a human-confirmed creation intent from the user's running session; never creates synchronously |
| CLI | `khala agents list --channel <held-channel>` | Joined-channel roster only; pre-join calls return `not_joined` without confirming the channel |
| MCP | `khala_list_channels` | Structured content identical to the CLI projection |
| MCP | `khala_request_channel_access` | Same idempotent URL-or-reference request contract; never blocks waiting for the human |
| MCP | `khala_create_channel` | Same human-confirmed creation intent as the CLI; returns only finite operation status |
| MCP | `khala_list_agents` | Requires an authorized joined-channel binding |
| Agent HTTP | `GET /api/agent/channels?cursor=...` | Authenticated discovery page; `no-store` |
| Agent HTTP | `POST /api/agent/channel-access-requests` | Creates/reconciles an owner prompt, never membership |
| Agent HTTP | `POST /api/agent/channel-create-requests` | Creates/reconciles a proposed creation prompt, never a channel |
| Agent HTTP | `GET /api/agent/channel-access-requests/<operation>` | Poll-safe finite status; object authorization must match requester, session generation, origin, and operation record |
| Agent HTTP | `GET /api/agent/channel-create-requests/<operation>` | The same requester-bound finite status for creation; never returns a channel identifier before readiness |
| Connector HTTP | `POST /api/connector/channel-access-requests/<operation>/exchange` | Proof-bound one-time grant consumption; never exposed through agent CLI/MCP status |
| Human HTTP | `PUT /api/human/channels/<channel>/discovery` | Owner-only visibility and stable-principal private-allowlist mutation with revision check |
| Human HTTP | `GET /api/human/channel-requests` | Human-cookie-authenticated access and creation requests |
| Human HTTP | `POST /api/human/channel-access-requests/<id>/decision` | Human-cookie-only approve/deny with compare-and-set and operation identity |
| Human HTTP | `POST /api/human/channel-create-requests/<id>/decision` | Human-cookie-only confirmation; approval creates one secret channel and authorizes only the requesting session's grant |

The agent-facing handlers follow the existing strict projection and `no-store` pattern. `--origin` and every transport redirect reuse bootstrap's exact configured-origin allowlist: HTTPS except loopback, no embedded credentials, and no cross-origin redirect. The human mutation follows the gateway's Origin checks and authenticated principal context. In internal mode, exact Host/Origin plus the host-only HttpOnly human cookie authorize approve/deny; launch tokens, binding capabilities, and discovery descriptors do not.

### Human prompt flow

1. The agent obtains a discovery/request capability tied to a verified native session. It may list visible channels or proceed directly with a canonical channel URL.
2. It requests one opaque `listingRef` from a listing or submits the URL directly. A listing-reference request revalidates visibility/eligibility. A URL request resolves privately without requiring listing eligibility; unknown, malformed, or non-requestable targets collapse to `unavailable`. An accepted target is journaled idempotently before the owner is notified.
3. Every accepted request creates a persistent inbox row and a non-modal notification. Selecting either opens the decision modal; closing it leaves the request pending, and queued requests never auto-open. The modal shows channel title; verified harness and stable session fingerprint; agent-supplied display name and sanitized workspace label, visibly marked as untrusted context; fixed server-derived post-admission capabilities; `history: none`; and explicit **Approve** / **Deny** actions. It shows no message preview and lets the owner inspect the full fingerprint before approval.
4. Approval is an authenticated owner command bound to request revision, channel, and verified session generation. Internal approve/deny additionally requires the human-cookie role. A stale or duplicate decision reconciles; it never creates a second membership.
5. Approval records durable authorization until the request's seven-day deadline; it does not mint a grant while the connector is offline. After reserving its local device, the connector presents the bound operation/proof/device tuple through `AdmissionGrantExchange`; trusted composition rechecks authority, then mints and consumes the short-lived one-time grant in that exchange. The grant stays hidden from channel listings, status responses, CLI/MCP output, storage, and logs.
6. The connector activates the returned binding/capability locally and acknowledges readiness. Only then does status become `connected`, with trust initialized to `review`, unpaused. A deterministic local activation failure becomes `repair_required`; repair resumes the same operation and reserved device without another owner prompt. An underlying admission `outcome_unknown` remains `unavailable` and reconciles by operation ID.
7. Denial, expiry, visibility change, channel deletion, or relevant revocation closes the request. The agent sees a bounded status, not the owner's reason.

Channel creation uses the same journal, inbox, verified-session projection, limits, and decision shell with a distinct operation kind. The proposed title is visibly untrusted. Denial or expiry creates nothing. Approval first idempotently creates one `secret` channel for the authenticated owner, then authorizes `channel-access-activation` for the requesting user-started session; response loss reconciles the same channel and admission operation. No other participant is admitted by that confirmation.

| Owner UI state | Display and actions |
|---|---|
| Loading / empty | Skeleton, then “No channel requests”; no decision actions |
| Pending | Full safe projection; Approve and Deny enabled |
| Submitting | Actions disabled, progress announced; row retained |
| Retryable submission error | Preserve the row, dialog, and safe projection; announce failure; refresh status/revision before re-enabling valid actions; retry the same idempotent decision operation |
| Stale revision / unavailable | Refresh action; no automatic resubmit or implied decision |
| Denied / expired / revoked | Final status announced; row retained in recent history without agent-supplied details beyond the original safe projection |
| Approved / connecting / connected | Owner decision shown separately from connector readiness; row retained until connected or terminal failure |
| Repair required | Owner approval remains visible; show the connector repair action without creating a new request or implying denial |

The modal has an accessible name, focuses the request heading on open, traps Tab within the dialog, closes on Escape without deciding, returns focus to the invoking row, exposes keyboard-operable actions, and announces submitting/error/final status changes. At narrow viewports the navigation entry remains reachable from the collapsed menu, the request list becomes a single-column list, the dialog fits the viewport with a scrollable fingerprint/details region and sticky decision actions, and every action has at least a 44-by-44 CSS-pixel touch target.

```text
verified agent ──list──────────────> discovery projection
       │                                      │
       ├──request access by ref/URL───────────┘
       └──submit create intent (no channel)
                         │ journal pending
                         ▼
                   owner prompt/UI
                    │           │
                 deny         approve
                    │           ├──access target─────────────┐
                    │           └──create one secret channel─┤
                    ▼                                        ▼
              bounded status      requester-only grant exchange
                                                  │
                                                  ▼
                                    device/binding → review trust
```

### Composition with existing work

| Existing contract | Required composition |
|---|---|
| `invitation-admission` | Keep discovery/request state separate. Owner approval authorizes a just-in-time one-time sender-constrained grant at connector exchange, then uses the retry-safe admission machinery with `history: none`; never add an agent-callable `admit` method or treat `listingRef` as an invite. |
| `trust-transitions` | A new binding starts in effective `review`, unpaused. Discovery eligibility is not peer trust, and trust never inherits across a new generation. |
| `device-agent-revocation` | Binding revocation invalidates post-admission adapter capability and pending requests for that session generation. It does not pretend to remove Matrix room membership; participant removal remains a separate owner capability. |
| `agent-link-bootstrap` | Channel URLs are locators, including for secret channels. `/khala join` routes them through `channel-access-journal` and `channel-access-inbox`; URL possession never substitutes for owner approval. Discovery may reuse native-session inspection, device reservation, and admission redemption after approval. |
| `local-sqlite-channel-store`, `authenticated-loopback-server`, `local-web-entry`, `internal-launcher` | Own SQLite channel metadata (implemented over the Matrix-neutral `RoomSubstrate`), loopback authentication, Host/Origin checks, human-cookie role, descriptor issuance, and local UI composition. They supply the discovery store/adapter; this design owns projections and owner-approval semantics. |
| `setup-cli-plan`, `setup-cli-codex`, `setup-cli-claude`, `setup-cli-opencode` | May configure origins, descriptors, plugins, skills, and MCP exposure for the user's own CLI session, but must not persist channel titles/listing references, embed descriptor credentials, launch an agent process, or broaden discovery scope. |
| `start-fresh-conversion`, `imported-history-contract`, `history-transfer`, `make-external-journey` | Conversion chooses visibility explicitly; default `secret`. Old local listing references are invalid after conversion and never become external admission authority. |
| `channel-terminology` | Owns the existing-code rename. Every new surface in this design starts with channel-facing names while preserving Matrix-internal `roomId`/`RoomSubstrate` types until that contract supplies their approved seams. |

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
| Libsodium sealed boxes for recoverable grant results | Audited construction, published vectors, and no status-visible secret after response loss | Adds a pinned dependency and requires the authenticated context to live inside the sealed plaintext because `crypto_box_seal` has no separate associated-data input |

## Enumeration and privacy risks

| Risk | Control | Residual risk |
|---|---|---|
| Scraping public titles | Authentication + verified session, hard 25-item pages and 10-list-requests/session/minute ceiling, no search/counts, stable non-activity order, crawl telemetry, hosted kill switch | A valid abusive account can still crawl its service scope across accounts; external public discovery stays off by default until monitoring is deployed |
| Probing private/secret channel existence | Same response for unknown, secret, stale, and ineligible references; opaque cursors/references; constant response shape | Timing differences across backing stores require integration measurement |
| Social-graph leakage | No pre-join roster, owner identity, participant count, receipts, or activity | A distinctive title can still identify a channel; owners need a preview when changing visibility |
| Credential/reference replay or theft | Short lifetime, sender constraint, audience/session-generation/origin binding, invalidation on rebind/revocation, recheck policy at request time | Same-user malware in internal mode remains in the accepted local threat model |
| Agent self-approval | Discovery scopes exclude admit/approve; owner endpoint requires human principal and CAS decision | A compromised owner session remains owner authority; discovery cannot solve that |
| Prompt spam or operation collision | Fingerprint the first resolved target under requester/session/origin/operation; mismatched reuse returns `unavailable`; hard-cap pending work at five per agent and 50 per owner, enforce a five-minute requester/channel creation cooldown (lifted once the owner has admitted and then ended the earlier request) and durable owner mutes, and batch owner notifications above 10 new requests/minute | Public channels may still create notification load, especially from distributed accounts |
| Stale approval after visibility/revocation change | Bind request revision and session generation; recheck immediately before admission | An admission already committed cannot be undone by changing visibility; use revocation/removal flows |
| Spoofed prompt identity | Lead with verified harness + stable session fingerprint; label display name/workspace as untrusted; require explicit approval | Owners can still approve a look-alike if they ignore the verified fingerprint |
| Retained request social graph | Purge terminal request fingerprints, hidden targets, and untrusted labels after 30 days; pending records retain only the minimum journal fields | Backups and infrastructure copies require their own retention enforcement |
| Logs/cache disclosure | `no-store`; never log credentials, titles, listing references, canonical channel URLs or derived locators, Matrix room IDs, session IDs, grants, or content | Infrastructure access logs must be checked in integration because module tests do not prove them |

## Non-goals

- Anonymous web channel browsing, federation-wide search, organization directories, recommendations, ranking, or fuzzy search.
- A global agent directory or pre-join disclosure of agents, humans, counts, receipts, activity, content, history, topics, or owner identity.
- Agent self-approval, automatic admission, inherited trust, trust-policy changes, participant removal, or secure deletion.
- Replacing invitation/link bootstrap; secret channels deliberately depend on it.
- Choosing the internal SQLite schema, external messaging provider, notification transport, or exact UI styling.
- Make External migration and pairing-code semantics beyond the invalidation rule above.
- Khala-launched or Khala-hosted Codex, Claude, or OpenCode processes; SDK/app-server sessions as the primary product path; or a default `khala run <cli>` wrapper.

## Ticket contracts

Contracts are ordered by dependency. Each is sized for one implementation agent and one PR.

### RD1 — Define discovery and access-request contracts

| Field | Contract |
|---|---|
| Title | Define channel discovery and access-request contracts |
| Slug | `channel-discovery-contract` |
| `complexity` | `complexity:3` |
| Scope | Add strict versioned discovery/listing/URL-access/create-intent types, finite outcomes, decoders, limits, exports, and provider-neutral ports that revalidate an opaque listing reference or canonical channel URL for the authenticated requester. Define a separate human-workflow-only `ChannelCreateAdapterPort` with an idempotent operation key and reconciliation outcome; it is never reachable from `ChannelDiscoveryPort`. Define an owner-scoped stable agent principal (never display name, device ID, or session ID) for private allowlists and the connector-only grant exchange. Encode `public/private/secret`, the minimal projection, pagination, and the rule that no agent-callable method creates a channel or admits. |
| Out of scope | Storage, HTTP, CLI/MCP, UI, admission implementation, provider behavior. |
| Files/packages | `packages/contracts/src/messaging/discovery.ts`, `packages/contracts/src/messaging/discovery.test.ts`, `packages/contracts/src/messaging/index.ts`, `packages/contracts/src/messaging/README.md`. |
| Acceptance criteria | Unknown fields fail; no listing type can carry content/roster/Matrix room ID; titles are bounded and treated as untrusted data; secret is representable but never asserted listable by the port; listing-reference resolution revalidates enumeration eligibility, while canonical URL resolution may privately identify a requestable private/secret target for an unknown agent but never discloses that target or bypasses owner approval; both return only server-side authorization results and cannot mutate membership; a create intent contains only bounded untrusted proposal data and cannot create a channel; `ChannelCreateAdapterPort` requires a human-authorized workflow context and idempotency key and exposes reconciliation without appearing on any agent-facing port; allowlist create/revoke is owner-only and keyed by stable agent principal while every use revalidates the current session generation; request outcomes include distinct `repair_required` and privacy-safe `unavailable` states; status is grant-free; credential/grant exchange types encode origin, requester, Ed25519 proof key, distinct X25519 encryption key, device, session generation, and expiry without exposing create/admit authority. |
| Tests | Round-trip all three visibility values and every finite status; reject extra `roomId`, `participants`, `lastActivity`, content, grant, `create`, or `admit` fields; reject oversized titles/pages/cursors and normalize control characters; prove private/secret URL requests from an unknown agent can produce only a pending owner request while the same agent remains ineligible for enumeration, and make invalid/ineligible URL outcomes indistinguishable; add a compile-time fixture proving `ChannelDiscoveryPort` exposes no `create`/`admit` member and an adapter fixture requiring human-workflow context plus an idempotency key; prove pinned `libsodium-wrappers` on Node 22 with libsodium's published Curve25519 known-answer key vector and sealed-box integrity checks before freezing the envelope schema; reject malformed/cross-origin channel URLs, expired/wrong-origin/wrong-generation credential and grant-exchange projections; reject encryption-key reuse with a different proof-key thumbprint or operation/device tuple. **Wrong-implementation tests:** a response containing Matrix `roomId` or `participantCount` must fail strict decoding, and a tampered sealed-box ciphertext must fail to open. |
| `blocked-by` | None; the approved requirements and survey are inputs, not implementation dependencies. |
| Conflict risk | Medium with `local-sqlite-channel-store`, which owns local metadata types; low with listening/read-receipt contracts. This contract owns the shared discovery names and projection. |

### RD2A — Authorize external channel discovery credentials

| Field | Contract |
|---|---|
| Title | Authorize external channel discovery credentials |
| Slug | `external-channel-discovery-bootstrap` |
| `complexity` | `complexity:3` |
| Scope | Add the channel-less `loopback-browser-v1` consent flow that verifies the native agent session, authenticates the human owner, binds a connector proof key and exact trusted origin, issues only `list_channels`, `request_channel_access`, and request-only `request_channel_create`, and refreshes or invalidates the short-lived in-memory/owner-only credential. Define the control-plane authorize/token routes and connector-side loopback/PKCE composition without creating a channel or binding. |
| Out of scope | Channel catalog/list routes, visibility policy, membership, adapter capability issuance, access-request journaling, CLI/MCP presentation, internal descriptor issuance. |
| Files/packages | `packages/connector/src/bootstrap/**`, connector composition/storage tests, `apps/control/src/channel-discovery/bootstrap/**`, minimal bootstrap route registration, and `channel-discovery-contract` consumers. |
| Acceptance criteria | Native-session verification and explicit signed-in owner consent precede issuance; the credential is proof-key, owner, origin, audience, and session-generation bound; scopes are exactly listing, access-request creation, and channel-create-intent creation; no agent call can create a channel/binding and no durable plaintext credential is created; refresh revalidates owner/session and rotation invalidates the prior credential; denial, expiry, rebind, owner removal, hostile origin, or proof mismatch fails closed. |
| Tests | Consent/deny/cancel; PKCE and loopback callback binding; wrong owner/origin/audience/proof; expiry/refresh rotation; rebind and owner removal; restart leaves no reusable plaintext credential; scope rejection for send/receive/approve/admit. **Wrong-implementation test:** completing the flow must not create membership, a device, or an `AdapterCapability`. |
| `blocked-by` | `channel-discovery-contract`, `agent-link-bootstrap`. |
| Conflict risk | High with `agent-link-bootstrap`, `setup-cli-plan`, and `authenticated-loopback-server` on bootstrap composition. Extend the existing flow behind a channel-less adapter rather than adding a second auth stack. |

### RD2B — Implement external discovery projection and privacy controls

| Field | Contract |
|---|---|
| Title | Implement external channel discovery and privacy controls |
| Slug | `external-channel-discovery` |
| `complexity` | `complexity:4` |
| Scope | Implement the external lazy catalog/read model, owner-authorized visibility and private-allowlist create/revoke operations, eligibility and listing-reference resolution, opaque snapshot cursors, listing rate limits, safe error collapse, `external-channel-discovery-bootstrap` credential validation, and authenticated listing routes. Absence means `secret`; no provider backfill. Keep hosted public discovery disabled pending `hosted-channel-discovery-rollout`. |
| Out of scope | Request journaling or pending caps, admission side effects, human prompt/settings UI, hosted rollout telemetry, CLI/MCP, internal SQLite adapter, anonymous directory. |
| Files/packages | `apps/control/src/channel-discovery/**`, small route registrations in `apps/control/src/composition/{agent,human}/handlers.ts`, `apps/control/src/runtime/**` tests/manifest; consume only `channel-discovery-contract` types. |
| Acceptance criteria | Public listings require a short-lived sender-constrained discovery credential; external private eligibility is same-owner or an owner-managed stable-principal allowlist; secret/absent never appears; only a current channel owner can mutate visibility or allowlists; rebind invalidates credentials and revalidates the new generation without silently changing the stable allowlist; the `channel-discovery-contract` resolver rechecks policy without side effects; hosted public discovery remains disabled; output is minimal/no-store. |
| Tests | Public/private/secret matrix across two owners and two sessions; allowlist add/remove, rebind, owner removal, and cross-owner denial; lazy registration/tombstone; discovery-credential expiry/rebind/revocation validation; resolver requester/expiry checks; cursor snapshot plus title/visibility/allowlist mutation invalidation; listing rate limits; logs/JSON omit forbidden fields; exact-origin and redirect behavior. **Wrong-implementation test:** a secret channel inserted beside public channels must produce byte-equivalent list metadata/count behavior to the same dataset with that channel absent. |
| `blocked-by` | `channel-discovery-contract`, `external-channel-discovery-bootstrap`, `invitation-admission`, `agent-link-bootstrap`. |
| Conflict risk | Medium with `local-sqlite-channel-store` on shared contract names; external persistence remains isolated. High with `human-flow-composition` on hosted route composition. |

### RD3A — Add owner visibility settings

| Field | Contract |
|---|---|
| Title | Add owner channel visibility settings |
| Slug | `channel-visibility-settings` |
| `complexity` | `complexity:3` |
| Scope | Add owner channel-settings UI for external channels, showing the exact pre-join projection, managing the private stable-principal allowlist through the owner-only verified-agent picker, and requiring confirmation before increasing visibility. |
| Out of scope | Catalog storage/resolution, request/approval UI, CLI/MCP, internal channel settings, provider-wide backfill, anonymous directory, hosted telemetry or rollout enablement. |
| Files/packages | `apps/web/src/features/channel-settings/**`, owner verified-agent picker composition, channel-page composition/browser tests. |
| Acceptance criteria | Existing/new external channels display as secret until explicitly changed; preview exactly matches the `channel-discovery-contract` projection; increases require explicit confirmation; owners can select known stable principals from same-owner sessions, completed pairing, or prior approved access and inspect/add/revoke private eligibility without using agent-controlled labels as identity; the picker exposes verified fingerprints, marks display/workspace labels untrusted, provides a useful empty state, and has no global/free-text agent search; cancellation changes nothing; submitting disables controls and announces progress/success; stale revision refreshes before retry, authority loss returns to read-only, and retryable failure preserves the pending edit without implying success; all states remain keyboard operable with live status announcements. |
| Tests | Loading/editing/preview/confirm/cancel/submitting/success/failure, keyboard and live announcements, secret default, known-principal sources, empty picker, no global/free-text search, allowlist identity/add/revoke, stale revision refresh, and owner-authority loss. **Wrong-implementation test:** selecting public and dismissing the confirmation must leave the channel secret and absent from another eligible session's listing. |
| `blocked-by` | `channel-discovery-contract`, `external-channel-discovery`, `invitation-admission`. |
| Conflict risk | High with `local-web-entry`, `pairing-approval-ui`, and `make-external-journey` on channel settings composition; keep the external settings feature isolated and consume `external-channel-discovery` mutations. |

### RD3B — Add hosted discovery rollout controls

| Field | Contract |
|---|---|
| Title | Add hosted channel-discovery rollout controls |
| Slug | `hosted-channel-discovery-rollout` |
| `complexity` | `complexity:3` |
| Scope | Add privacy-safe crawl telemetry, per-account crawl detection, an operator alert route, and a public-discovery kill switch. Enable hosted public discovery only after an operations drill proves the hard crawl limits, alert delivery, and kill-switch response. |
| Out of scope | Visibility/settings UI, catalog semantics, private/secret discovery, agent CLI/MCP, anonymous discovery, provider-wide backfill. |
| Files/packages | `apps/control/src/channel-discovery/**` telemetry and rollout configuration, operator alert/runtime manifest wiring, focused control tests, and the hosted drill harness. |
| Acceptance criteria | Telemetry contains identifiers/digests but never titles, listing references, canonical channel URLs or derived locators; public discovery is disabled by default; a scripted crawl is constrained by the hard limits, triggers the configured operator alert, and an operator can remove public results with the kill switch within five minutes; private/secret access and owner settings remain available while public listing is disabled. |
| Tests | Telemetry redaction, per-account scripted crawl, exact limiter boundaries, alert delivery, disabled-by-default rollout, private/secret non-regression, and measured kill-switch propagation under five minutes. **Wrong-implementation test:** with the kill switch active, an otherwise valid public-list request must return no public results while private eligible results remain correctly projected. |
| `blocked-by` | `external-channel-discovery`, `channel-visibility-settings`. |
| Conflict risk | High with hosted runtime/alert composition in `human-flow-composition` and `make-external-journey`; keep the kill-switch and telemetry registration isolated from catalog policy. |

### RD4A — Add the channel-access request journal and decision workflow

| Field | Contract |
|---|---|
| Title | Add the channel-access request journal and decision workflow |
| Slug | `channel-access-journal` |
| `complexity` | `complexity:4` |
| Scope | Consume `channel-discovery-contract` resolution and operation-kind ports to journal pending access or creation requests with a persisted seven-day deadline, enforce per-agent/owner pending caps plus a five-minute requester/target creation cooldown, persist owner mutes, notify the correct owner, authenticate approve/deny against the owner principal (human-cookie role internally), apply CAS decisions, expose requester-bound status lookup, and record durable approval authorization until that deadline. Mutes are operation-specific: access uses requester/channel scope and verifies current ownership of that channel; creation uses requester/owner scope because no channel exists yet. Every mute/unmute authenticates the human principal and applies a revision-checked update. An approved operation is exposed through a typed fulfillment port: access is consumed by `channel-access-grant-exchange`, while the later `channel-create-workflow` consumer resolves creation to one target before using that same exchange. The journal does not implement either consumer, mint or exchange grants, invoke a provider, or own connector recovery. Alongside operation, requester/session/origin, hidden target or proposal digest, revision, owner, and status metadata, persist only the verified fingerprint plus bounded untrusted labels as human-facing identity context. After 30 days, reduce terminal requester/session/origin/owner linkage to an unlinkable idempotency tombstone and purge fingerprints, hidden targets/proposals, and untrusted labels. |
| Out of scope | Web inbox/modal, connector-local device activation, channel browser/list UI for agents, transport-specific notifications, auto trust, history transfer, participant removal. |
| Files/packages | Transport-neutral request-journal, safe-projection, decision, and fulfillment interfaces in `packages/contracts/src/messaging/channel-access.ts` plus exports/tests; hosted persistence under `apps/control/src/channel-access/**`; minimal route registration in `apps/control/src/composition/{agent,human}/handlers.ts`; control tests; `packages/policy` only as a consumer. |
| Acceptance criteria | Agent request alone creates no membership; resolver failure collapses to `unavailable`; the first resolved target is fingerprinted under requester/session/origin/operation and the submitted URL is discarded, while mismatched operation reuse creates no second prompt; pending and notification ceilings are hard maxima and status lookup is requester/session/origin/operation bound; cooldown-limited or owner-muted attempts return the same bounded unavailable result without a pending row or notification; status is grant-free; only matching owner authority can decide; access mutes require current target-channel ownership, while creation mutes are requester/owner-scoped and cannot affect another owner; internal human-cookie authority is required while binding/discovery capabilities are rejected; stale/duplicate decisions and mute revisions reconcile; at the persisted seven-day deadline, pending or approved-but-unconsumed work atomically becomes `expired`, releases cap capacity, suppresses later decisions/notifications, and cannot be fulfilled; revocation or visibility loss closes pending work; terminal sensitive context obeys its purge deadline; approval exposes one durable, typed authorization to the correct downstream consumer without itself creating a channel, membership, device, binding, grant, or provider operation. |
| Tests | Happy approve/deny; wrong/stale owner plus binding/discovery capability denial for decisions and mute/unmute; access requester/channel mute ownership; creation requester/owner mute isolation; cross-session operation-ID lookup; reuse one operation ID with two listing references; exact pending/notification hard-ceiling boundaries and lower-only configuration; notification batching; cooldown and durable revision-checked mutes across restart; persisted seven-day expiry across restart, cap release, and late-decision suppression; stale request revision; duplicate decisions; revocation/visibility change before approval; 30-day unlinkable terminal tombstone across restart; application/infrastructure logs and telemetry omit canonical URLs and derived locators; access-versus-create fulfillment routing; assert no grant/provider/connector call occurs in this contract. **Wrong-implementation test:** after approving a request but before the typed downstream consumer runs, channel/membership/device/binding stores and grant output must remain unchanged. |
| `blocked-by` | `channel-discovery-contract`, `invitation-admission`, `trust-transitions`, `device-agent-revocation`, `agent-link-bootstrap`. |
| Conflict risk | High with `authenticated-loopback-server`, `pairing-approval-ui`, and `start-fresh-conversion` on approval composition. Keep the journal, routes, and grant workflow behind dedicated ports. |

### RD4B — Add the shared channel-access inbox and approval prompt

| Field | Contract |
|---|---|
| Title | Add the shared channel-access inbox and approval prompt |
| Slug | `channel-access-inbox` |
| `complexity` | `complexity:3` |
| Scope | Render the persistent owner inbox, a persistent owner-visible “Channel requests” navigation entry with a bounded pending indicator, non-modal notifications, accessible approve/deny dialog, and operation-specific mute action from the `channel-access-journal` safe projection. Access offers requester/channel mute; creation offers requester/owner mute. The operation adapter labels access versus creation, and creation approval explicitly states that it creates one secret channel and authorizes admission only for the requesting session. Build the decision-dialog shell as a shared component that `pairing-approval-ui` reuses; channel-specific, creation, and pairing adapters supply their own verified facts and untrusted labels. |
| Out of scope | Request storage, grant minting, connector activation, channel listing/settings, conversion orchestration, or embedding agent-controlled actions/body markup. |
| Files/packages | `apps/web/src/features/channel-access/**`; shared dialog primitives under `apps/web/src/features/approval-decision/**`; minimal channel-page composition/browser tests. `pairing-approval-ui` consumes the shared primitive rather than copying it. |
| Acceptance criteria | Inbox is canonical and queued requests never auto-open; hosted and internal compositions keep its navigation entry visible, with an exact count capped at the hard owner maximum of 50, and notification selection or direct navigation reaches the same row; prompt leads with verified harness/fingerprint, marks agent-supplied display/workspace labels as untrusted, shows fixed server-derived capabilities and `history: none`, and separates owner decision from connector readiness; an authenticated current owner can apply the correct revision-checked access or creation mute scope, while stale/wrong owners and binding/discovery capabilities are rejected; dismissing a notification or dialog leaves the pending row reachable; a retryable decision failure preserves the dialog and safe projection, announces failure, refreshes status/revision, and retries the same idempotent decision; terminal sensitive context disappears after the 30-day retention limit; narrow layouts retain collapsed-menu access, single-column rows, scrollable details, sticky actions, and 44-by-44 CSS-pixel targets; pairing and channel-access adapters share one keyboard/focus/status implementation; agent text cannot create controls or active content. |
| Tests | Loading/empty/submitting/retryable-error/final states; same-operation decision retry after revision refresh; persistent navigation and exact `0` through `50` indicator; notification/direct-navigation parity; colliding names and spoofed workspace; access and creation mute scopes, wrong/stale owner and non-human-role denial, and expiry; 30-day recent-history purge; modal queue/dismiss/focus return/Escape/Tab; narrow viewport, scroll/sticky actions and touch targets; live announcements; approved/connecting/connected/repair-required display; pairing fixture through the same shared shell. **Wrong-implementation test:** enqueue two requests and assert the second never auto-opens or steals focus when the first closes. |
| `blocked-by` | `channel-access-journal`, `human-flow-composition`. |
| Conflict risk | High with `local-web-entry` and `pairing-approval-ui` on local and hosted approval composition. The shared shell owns behavior; each contract owns only its projection adapter. |

### RD5A — Exchange an approved request for a sealed grant result

| Field | Contract |
|---|---|
| Title | Exchange an approved channel request for a sealed grant result |
| Slug | `channel-access-grant-exchange` |
| `complexity` | `complexity:4` |
| Scope | Implement a transport-neutral connector-only exchange service with hosted and internal adapter ports. Bind proof/encryption key thumbprints and the reserved device, record one stable provider operation before invocation, atomically recheck approval authority, mint and consume the short-lived one-time grant, reconcile adapter ambiguity, and return one versioned sealed result. Store the byte-identical envelope for bounded recovery; do not activate the connector or claim readiness. |
| Out of scope | Human UI, discovery projection, connector polling/private-key storage/local activation, trust changes after initialization, provider-specific membership implementation. |
| Files/packages | Transport-neutral service/ports under `packages/messaging/src/channel-access/exchange/**`; hosted adapter and minimal connector-route registration under `apps/control/src/channel-access/exchange/**`; admission/trust consumers, messaging/control tests, and `channel-discovery-contract` envelope types. |
| Acceptance criteria | Grant is requester/origin/session-generation/proof-key/device bound, single-use, short-lived, and never returned by status/CLI/MCP or logged/persisted in plaintext; the v1 envelope uses libsodium `crypto_box_seal` with the algorithm identifier `crypto_box_seal_x25519_xsalsa20poly1305`, authenticates the canonical context named in `AdmissionGrantExchange` inside the sealed plaintext, and is decryptable only by the separately held X25519 private key; implementation uses the pinned audited libsodium binding rather than local primitives; only the connector exchange can consume the grant; immediately before mint/consumption/admission, the exchange atomically rechecks the persisted seven-day deadline, request revision, current owner authority, channel visibility/existence, and relevant session revocation, returning `expired` at or after the deadline and otherwise closing without membership on failure; a retry reconciles the same provider operation and returns the byte-identical stored envelope without new membership, sealing, grant, or prompt; unresolved admission ambiguity remains `unavailable`; the envelope has a seven-day hard recovery expiry and no exchange response can claim `connected`. |
| Tests | Libsodium published Curve25519 known-answer key vector and sealed-box integrity checks on the pinned Node runtime; status/CLI/MCP grant absence; grant theft/cross-session exchange; wrong device/proof/origin/generation; envelope version/algorithm/context vectors; ciphertext and sealed-context-field tampering; cross-operation substitution; byte-identical retry after response loss; encryption/proof-key thumbprint mismatch; replay; request-deadline boundary race; owner loss, visibility/deletion, request revision, and revocation races immediately before exchange; crash before provider invocation and between invocation and reconciliation; hard envelope expiry. **Wrong-implementation test:** retrying after a committed provider result must return the stored envelope without a second provider call or fresh sealing. |
| `blocked-by` | `channel-discovery-contract`, `channel-access-journal`, `multi-agent-bindings`, `invitation-admission`, `trust-transitions`, `device-agent-revocation`, `agent-link-bootstrap`. |
| Conflict risk | High with `human-flow-composition` and `start-fresh-conversion` on provider/admission composition. Keep the route and state machine under a dedicated exchange module. |

### RD5B — Recover the grant result and prove connector readiness

| Field | Contract |
|---|---|
| Title | Recover the channel grant result and prove connector readiness |
| Slug | `channel-access-activation` |
| `complexity` | `complexity:3` |
| Scope | Extend connector/bootstrap composition so each request journals its operation ID locally, resumes after restart, and uses bounded-backoff status polling or an equivalent authenticated wake. On approval, reserve a local device, generate a distinct X25519 recovery keypair, durably retain its private key plus operation/proof/device tuple before calling `channel-access-grant-exchange`, decrypt and validate the sealed result, activate the binding/capability, initialize review trust, acknowledge readiness, and trigger envelope cleanup. Rotation before exchange supersedes the prior key; after consumption, a missing or mismatched private key becomes `repair_required` without reminting. |
| Out of scope | Owner decision UI, server authority policy, provider admission invocation/reconciliation, discovery projection, trust changes after initialization. |
| Files/packages | `packages/connector/src/bootstrap/**`, connector runtime/composition and owner-only storage, focused connector tests, and the readiness/cleanup client for `apps/control/src/channel-access/exchange/**`. |
| Acceptance criteria | Private key material is owner-only and never logged; polling is bounded/jittered and the durable tuple resumes after restart; envelope version, algorithm, sealed context, and both thumbprints are verified after opening and before activation; a lost response re-fetches the same stored envelope; `connected` appears only after local activation acknowledgement; deterministic activation failure or lost recovery key is `repair_required` and never remints membership; the server envelope is deleted on readiness acknowledgement or its hard expiry; Khala does not launch or terminate the user's agent process. |
| Tests | Approval while connector is offline; restart from pending/approved; bounded polling; X25519 rotation before exchange and rejection after consumption; lost/mismatched private key; envelope tamper/sealed-context mismatch; response loss and identical recovery; crash after admission before activation; recovery-envelope deletion; repair-required recovery; duplicate readiness acknowledgement; review baseline. **Wrong-implementation test:** an owner-approved request with no connector activation acknowledgment must never report `connected`. |
| `blocked-by` | `channel-access-grant-exchange`, `channel-access-journal`, `agent-link-bootstrap`. |
| Conflict risk | High with `authenticated-loopback-server`, `internal-launcher`, and `setup-cli-plan` in connector bootstrap/storage. Reuse their proof/device storage seams rather than adding a second credential stack. |

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
| `blocked-by` | `channel-discovery-contract`, `external-channel-discovery-bootstrap`, `external-channel-discovery`, `setup-cli-plan`. |
| Conflict risk | High with `mcp-result-piggyback`, `claude-plugin`, and `setup-cli-plan`, which touch the same CLI/MCP files. Land after or coordinate file ownership; keep command/tool additions isolated. |

### RD7 — Expose access requests and status through CLI and MCP

| Field | Contract |
|---|---|
| Title | Expose channel-access requests and status through CLI and MCP |
| Slug | `channel-access-cli-mcp` |
| `complexity` | `complexity:2` |
| Scope | Add `khala channels request-access <channel-url-or-listing-ref>`, `khala_request_channel_access`, and finite status reads using the same strict projection and idempotent operation ID. Expose the channel-URL operation consumed by `/khala join`; do not add a second join/admission path. |
| Out of scope | Channel/agent listing, control-plane workflow, automatic polling, notifications/hooks, setup/package publication. |
| Files/packages | New modules under `packages/agent-cli/src/cli/channels/**` and `packages/agent-cli/src/mcp/channels/**`, with minimal registration-only diffs in `cli/app.ts` and `mcp/server.ts`; module tests; HTTP composition client; `packages/agent-cli/README.md`. |
| Acceptance criteria | Request returns promptly as pending and exposes the operation state supplied by `channel-access-activation` without implementing a second lifecycle; status preserves owner-decision versus connector-readiness states; retries reuse the operation ID; `repair_required` gives a connector repair action while `unavailable` prevents unsafe retries; CLI and MCP expose identical decoded fields and treat titles as untrusted structured data. |
| Tests | CLI/MCP parity, listing-reference and canonical channel-URL pass-through, operation pass-through, pending/approved/denied/connecting/connected/repair-required/unavailable, malformed status, prompt-like and terminal-control titles, and cross-origin redirect rejection. **Wrong-implementation test:** an `unavailable` result must not trigger creation of a second request or a fresh operation ID. |
| `blocked-by` | `channel-discovery-contract`, `channel-access-journal`, `channel-access-activation`, `channel-agent-listing`, `setup-cli-plan`. |
| Conflict risk | High with `mcp-result-piggyback`, `claude-plugin`, `setup-cli-plan`, and `channel-agent-listing` in the same CLI/MCP files; land after those registrations and keep additions isolated. |

### RD8A — Adapt discovery to the internal backend

| Field | Contract |
|---|---|
| Title | Adapt channel discovery to the internal backend |
| Slug | `internal-channel-discovery` |
| `complexity` | `complexity:4` |
| Scope | Supply the internal catalog/visibility, local admission/binding, and human-workflow-only channel-create adapters from the local SQLite store; compose the shared grant-exchange service behind a connector-only internal route; persist request projections; add role-checked human/agent routes; and have `khala internal` issue an unjoined agent a separate 0600 discovery descriptor. Its durable capability authorizes exactly `list_channels`, `request_channel_access`, and request-only `request_channel_create`, with no send, receive, approve, deny, channel mutation, admission, or grant-minting authority; references/intents remain bound to that descriptor/session. Default local channels to `private`, where eligibility is an explicit stable-principal allowlist with no same-owner fallback; `secret` hides them and `public` means any verified agent on that local service. Human-cookie authority alone decides requests and mutates settings. |
| Out of scope | Internal settings/inbox UI, SQLite event-schema design, inventing a launcher/OS presence proof, external conversion, harness delivery, or process isolation against same-uid descriptor theft. |
| Files/packages | `apps/internal/src/store/**` for catalog/create/admission/binding adapters, `apps/internal/src/server/**` for role-checked and connector-exchange routes, `apps/internal/src/composition/**` for shared-service composition, and `packages/agent-cli/src/cli/internal*.ts` plus `packages/agent-cli/src/composition/**` for descriptor issuance/selection; consume transport-neutral contract/journal/exchange ports without redefining them. |
| Acceptance criteria | Restart preserves visibility, explicit per-agent eligibility, pending decisions, idempotent create-adapter reconciliation, and exchange recovery; secret is absent; two same-owner local agents receive different private listings according to their allowlists; rebind revalidates generation; a discovery descriptor can list and create owner-decided access/create requests but cannot send, receive, approve, deny, create a channel, mint a grant, or impersonate another binding; only the proof-bound connector route can exchange an approved operation, and only human-cookie routes decide or change settings; exact Host/Origin checks still apply; the human-workflow-only local adapter creates or reconciles one secret channel but does not create a binding or claim readiness; the local admission/binding adapter is idempotent and the shared exchange returns the same sealed result after response loss; same-uid descriptor theft is documented as the v1 limit rather than claimed solved. |
| Tests | SQLite/restart integration; visibility and allowlist behavior across two verified same-owner agents; rebind; descriptor issuance/rotation/mode; discovery-route allowlist; access and create-intent request creation; proof-bound internal exchange and wrong-role denial; local admission/binding idempotency; exchange response-loss recovery; send/receive/decision/channel-mutation denial; human-cookie decision/settings route checks; hostile Host/Origin rejection; pending request expiry; create response-loss reconciliation. **Wrong-implementation test:** launch an unjoined agent with only its discovery descriptor and assert it can list and submit pending access/create intents but cannot send, receive, approve, deny, create a channel, change visibility, edit the allowlist, call the connector exchange, or mint a grant. |
| `blocked-by` | `channel-discovery-contract`, `channel-access-journal`, `channel-access-grant-exchange`, `channel-access-activation`, `local-sqlite-channel-store`, `authenticated-loopback-server`, `internal-launcher`. |
| Conflict risk | Highest with `local-sqlite-channel-store`, `authenticated-loopback-server`, and `internal-launcher` because they own the SQLite/server/descriptor roots; implement as adapters after those contracts freeze. Medium with `start-fresh-conversion` on visibility migration and reference invalidation. |

### RD8B — Compose the internal discovery owner UI

| Field | Contract |
|---|---|
| Title | Compose the internal channel-discovery owner UI |
| Slug | `internal-channel-discovery-ui` |
| `complexity` | `complexity:2` |
| Scope | Compose `channel-access-inbox` and local visibility/allowlist settings into the internal web app. Add the owner-only verified-agent picker backed by locally issued descriptors/sessions, including unjoined discovery sessions. |
| Out of scope | SQLite/store design, descriptor issuance, shared dialog internals, external settings, channel creation fulfillment, agent CLI/MCP. |
| Files/packages | `apps/web/src/internal/channel-settings/**`, `apps/web/src/internal/channel-requests/**`, internal navigation composition, and focused browser tests. |
| Acceptance criteria | Human-cookie owners can inspect/mutate visibility and add/revoke a verified local stable principal; the picker leads with fingerprint, marks display/workspace labels untrusted, has no free-text/global search, and explains how to issue a descriptor when empty without launching an agent; a newly issued unjoined discovery session is selectable; the shared request inbox retains its keyboard, narrow-viewport, notification, and decision-state behavior; binding/discovery capabilities cannot render authorized mutation responses. |
| Tests | Internal settings preview/edit/cancel/error; picker empty/new-session/add/revoke flows across two same-owner agents; fingerprint/untrusted-label rendering; no free-text/global directory; human-cookie versus binding/discovery roles; shared inbox composition; narrow viewport, touch targets, focus, live announcements. **Wrong-implementation test:** issuing a second discovery descriptor must make that verified principal owner-selectable without making it visible to the first agent or any agent-facing list. |
| `blocked-by` | `internal-channel-discovery`, `channel-access-inbox`, `local-web-entry`. |
| Conflict risk | Highest with `local-web-entry` and `pairing-approval-ui` in internal navigation/dialog composition; consume shared components and keep internal files composition-only. |

### RD9A — Add the human-confirmed channel creation workflow

| Field | Contract |
|---|---|
| Title | Add the human-confirmed channel creation workflow |
| Slug | `channel-create-workflow` |
| `complexity` | `complexity:4` |
| Scope | Consume `channel-discovery-contract` create intents plus the `channel-access-journal` and `channel-access-inbox` decision shell. Bind each intent to the user's verified, already-running CLI session, trusted origin, proof key, session generation, operation ID, and bounded untrusted proposed title. On authenticated human approval, call a hosted or internal adapter idempotently to create exactly one owner-controlled `secret` channel, then authorize `channel-access-grant-exchange` for only the requesting session. Reconcile ambiguous create responses before admission and expose finite status through the shared journal. |
| Out of scope | CLI/MCP parsing, launching or hosting an agent, a default PTY wrapper, admitting invited participants, public visibility by default, provider selection, Make External conversion. |
| Files/packages | `apps/control/src/channel-create/**`, `apps/web/src/features/channel-create/**`, hosted adapter composition beside `apps/control/src/channel-access/**`, and focused control/browser tests; consume the internal adapter from `internal-channel-discovery` and reuse the shared journal/inbox rather than adding a second request store or modal. |
| Acceptance criteria | Agent submission alone creates no channel, membership, device, or grant; the prompt marks title/workspace labels untrusted and names the verified requesting session; only the authenticated owner can approve; denial/expiry creates nothing; approval creates one secret channel and authorizes one requesting-session grant; lost responses/restarts reconcile the same channel and admission operation; other participants still enter through their own human-approved access requests; Khala starts no agent process. |
| Tests | Hosted and internal adapters; wrong/stale owner; binding/discovery capability denial; cancel/deny/expiry; duplicate approval and lost create response; provider `outcome_unknown`; hostile origin/session/proof/generation; secret default; only-requester admission; restart and operation conflict; untrusted title rendering. **Wrong-implementation test:** submit a valid create intent without human approval and assert channel, membership, device, binding, and grant stores remain unchanged. |
| `blocked-by` | `channel-discovery-contract`, `external-channel-discovery-bootstrap`, `channel-access-journal`, `channel-access-inbox`, `channel-access-grant-exchange`, `channel-access-activation`, `internal-channel-discovery`, `multi-agent-bindings`, `human-flow-composition`, `local-sqlite-channel-store`, `authenticated-loopback-server`, `local-web-entry`. |
| Conflict risk | High with `start-fresh-conversion` on external create reconciliation, `internal-channel-discovery` on the local adapter, and `pairing-approval-ui` on the shared decision shell. Reuse their ports and components; do not merge their workflows. |

### RD9B — Expose human-confirmed channel creation through CLI and MCP

| Field | Contract |
|---|---|
| Title | Expose human-confirmed channel creation through CLI and MCP |
| Slug | `channel-create-cli-mcp` |
| `complexity` | `complexity:2` |
| Scope | Add `khala channels create --title <title> --operation <id>` and `khala_create_channel` as strict projections over `channel-create-workflow`, plus finite status reads. The service is consumed from the user's existing interactive CLI session; `/khala create` may delegate to it, but this ticket launches no model process and adds no `khala run` path. |
| Out of scope | Creation policy/storage/UI, channel listing, access/join implementation, automatic participant invitation, setup installation, hooks/listening modes, app-server/SDK-hosted agents. |
| Files/packages | New modules under `packages/agent-cli/src/cli/channels/create/**` and `packages/agent-cli/src/mcp/channels/create/**`, HTTP/local composition clients and tests, and minimal registration-only diffs in `cli/app.ts` and `mcp/server.ts`; `packages/agent-cli/README.md`. |
| Acceptance criteria | CLI and MCP accept only bounded title, trusted configured origin/internal descriptor, and caller-supplied idempotent operation ID; they return pending/approved/connecting/connected/denied/expired/repair-required/unavailable without implying synchronous creation; titles remain untrusted structured data; the command targets the invoking user-started session and never starts or selects another agent process. |
| Tests | CLI/MCP parity; external origin and internal descriptor selection; operation retry/conflict; every finite status; hostile redirect; prompt-like/control-character titles; absence of process-launch/app-server/SDK routes; minimal shared-file registration. **Wrong-implementation test:** a successful command response before owner approval must be `pending_owner` and must not contain a channel ID, binding, grant, or claimed membership. |
| `blocked-by` | `channel-create-workflow`, `channel-access-cli-mcp`, `internal-channel-discovery`, `setup-cli-plan`. |
| Conflict risk | Highest in the shared CLI/MCP registration files with `mcp-inbox-batch`, `mcp-result-piggyback`, `listening-mode-pull`, and `setup-cli-plan`. Keep all behavior in new modules and merge after the ordered hotspot owners. |

## Verification handoff

Implementation tickets must run their package tests/typechecks and boundary checks, plus an integration chain that uses real contract decoders and stores rather than only mocks. Acceptance 1, `internal-ci-acceptance`, should prove both modes with fake harnesses:

1. a user-started verified agent submits a create intent and no channel exists before human approval;
2. approval creates exactly one secret channel and durable authorization for the requesting agent, but no binding while its connector is offline;
3. another user-started agent resolves a channel URL or lists a public/private channel but not a secret channel;
4. it requests access and cannot send/read/list agents before its own human approves;
5. connector grant exchange and readiness acknowledgement create the requesting-agent binding in review with no history;
6. the joined agents can list the authorized channel roster and exchange messages;
7. revocation stops one binding capability without claiming membership removal or ending either user's CLI process.

Acceptance 2, owned by the acceptance area, must run the same external path against the live provider: human approval, provider admission, an injected/observed ambiguous response followed by same-operation reconciliation, connector activation, message exchange, and revocation. It also covers live internal loopback and browser prompt delivery. Discovery-backed external admission remains gated off when that live run cannot pass. Timing-equivalence of existence-hiding responses remains **unproven** by this research PR and requires integration measurement before hosted public rollout.
