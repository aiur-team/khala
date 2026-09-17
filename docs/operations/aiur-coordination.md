# Aiur executor coordination

Recorded 2026-09-16 from explicit operator messages. Recheck live state before launch.

- Khala workspace: `/home/everdred/github/everdred/khala`.
- Shared Aiur development checkout: `/home/everdred/github/everdred/aiur`.
- Peer executor reply thread: `01a0ab56-2ff8-75f2-be6f-00f4fd78147c`. The earlier all-zero placeholder must never be used.
- Authorized communication: `codex queue --thread 01a0ab56-2ff8-75f2-be6f-00f4fd78147c --message '...'` for defect reports and launch/build/restart coordination.
- Peer reports its daemon at localhost:4000 and tailnet endpoint `https://orangekid.tailee0e71.ts.net:4001`, fleet ceiling 16, global pause lifted. These are reported state, not authority to change that fleet.
- Intended Khala dashboard: localhost:4002. Observed unbound during coordination; recheck before launch. This is not yet a configured or running service.
- Observed shared release stamp: source SHA `1f618cddf601a0b6d79bc1197579746b7584a64c`, `dirty=yes`, built `2026-09-16T15:34:29Z`. Source checkout HEAD matched at inspection. Dirty stamp means SHA alone does not fully identify built contents.
- Notify the peer of intended port and actual stamped build before launch. Coordinate any shared-release rebuild or restart before running a shim action that could rebuild it automatically.
- Keep instance, config, state and port separate. Do not edit Aiur's repo-local `.aiur/config`. Never stop processes by name; target only verified Khala instance handles.

## Authorized defect reporting

File discovered Aiur bugs in `aiur-team/aiur` with `agent:todo` included in the issue creation request. Include symptom, exact command, expected and observed behaviour, Aiur source/build identity, affected repository, sanitized evidence/log paths, and severity/impact. Send the issue number and concise impact/evidence to the actual peer thread immediately after creation. Never include secrets in a ticket, command or queue message.

The peer will prioritize, allocate independent lanes, review/land fixes, and report the build and restart timing. Do not assume a fixed build exists before that report and verification.

## Launch boundary

Khala is currently in research/product planning. Ticket scope and the subsequent local aiurdev Executor role are authorized; per-ticket brainstorm/plan work is underway. Coordination does not itself mean that implementation tickets are approved or that a daemon has launched.

## Peer incident update — 2026-09-16

Reported by the Aiur executor; these are leads to verify against current issues/builds before taking action:

- Aiur issue #2649: Add Agent confirmation blocks LiveView during synchronous tracker writes; Applied-labels modal remains open; retries with no label change are disabled. Priority isolated worker assigned by peer.
- Issue #2648: initial agent-authored ticket dispatch rejected when dashboard bot applied todo without prior operator triage. Peer reports todo reapplied through `its-everdred` and worker running. Do not imitate that identity or bypass triage; report matching failures to peer.
- Prewarm reported ready/fresh, not frozen. Do not diagnose a prewarm freeze from a stale status or idle display.
- Draft PR #2642 addresses stale `--todo` refresh, countdown and idle backoff; independent review reported in progress. Not evidence of a landed or installed fix.
- Keep daemon gate intact. Send matching symptoms, sanitized evidence and relevant ticket IDs directly to the authorised reply thread. Coordinate rebuild/restart only after fix/build identity is confirmed.

## Subsequent peer update and conflict check — 2026-09-16

Peer reports #2648 running; PR #2652 (Add Agent freeze/admission retry), PR #2651 (warm materialization embedded-repo), and revised PR #2642 reviewed, with CI underway. Peer plans only its checkout-keyed rebuild/restart after green merges. These remain reported pending changes, not installed fixes.

Rechecked locally: no Khala config/state directory, no listener on intended port 4002, and no Khala daemon launched by this session. Observed BEAM process working directories belong to Aiur and private-multisig-everdred, not Khala. Sent a no-conflict notification to the authorised peer thread; queue receipt `01a0ab79-62f7-78f2-a4c2-dca6a971798a`. No launch/rebuild/restart performed. Recheck release provenance before a future Khala launch.

## Planning-to-execution coordination

User authorized deep planning and push to research followed by local aiurdev execution. Sent port 4002 intent and observed shared stamp to peer; queue receipt `01a0ab8a-892c-7b32-aed1-403d6812c60e`. Await current shared-release coordination before any automatically rebuilding launch. No Khala daemon started during planning.

Read-only `AIUR_SKIP_BUILD=1 ../aiur/scripts/aiurdev __identity` resolved Khala instance key `95978a6838`, node `aiur-everdred-95978a6838@127.0.0.1`, project root Khala, shared local dev release. This command did not launch or rebuild. The skip-build option is available for a coordinated launch on the already stamped release; revalidate stamp completeness first. Do not set `AIUR_REPO_ROOT` to the source checkout when targeting Khala, since the engine uses it for instance identity.

## Launched Khala — 2026-09-16 19:22 UTC

Planning/reviews pushed at `82002248db1715ec8b122fdd27c024e0f9274353`. Khala daemon launched with `AIUR_SKIP_BUILD=1` on localhost4002, verified key95978a6838 and owner `orangekid-95978a6838`. Listener reports26bindings; current Codex thread `01a0ab55-86a3-73d2-955d-d0e2139d0f53` has a host-local notification relay plus durable Executor consumption. No shared rebuild or peer-config mutation occurred.

GitHub materialization: root1, epics2–9, leaves10–53; native hierarchy/dependencies re-read. Six initial admitted leaves:10,11,12,13,50,51. Remaining38 carry paused overlay until dependency/readiness gates resolve. Session cap6 fits measured capacity; peer dashboard read showed0running at19:15 UTC. Recheck actual fleet before changing capacity.

Local setup fixes: Khala origin now uses HTTPS plus gh credential helper after SSH auth failed; the owned config records existing publishing bot `its-applekid` and App identity `aiur-daemon[bot]`. CI readiness remains unfulfilled in the empty repo, to be established by101 before merge. Safe CODEOWNERS fallback is explicit; no admission gate was disabled.

Aiur defect #2659: root view renders only8 direct epics and omits44 executable grandchildren/dependencies. Filed with agent:todo and required sanitized evidence; immediately notified peer, queue receipt `01a0abaa-c2e5-7911-a02f-bf85d19d0c77`. Full planning-pack dashboard rendering remains incomplete; native per-leaf gates were independently verified.

## Worker-start verification — 2026-09-16 19:29 UTC

All six initial workers10,11,12,13,50,51 observed actively working. Startup correction: configure `agent.codex.approval_policy: never` and `agent.codex.thread_sandbox: workspace-write`; the bundled example's root-level codex block was silently ignored. First10/11 retries were cleared through authoritative labels/queue after correction; latest API showed running and no current error. Aiur #2660 records the stale example/schema diagnostic issue and was immediately sent to the peer.

The real consumer journal is `khala.executor.wakes.ndjson`, whereas the skill recipe hardcodes `aiur.executor.wakes.ndjson`. Local relay now follows the verified existing Khala path with unbuffered reads and queues notifications to the verified current thread; durable `executor-wait --json` remains the sole acknowledgment path. Aiur #2661 records the recipe defect and was immediately sent to the peer. All three Aiur defects2659–2661 were recorded through the findings CLI. Root/epic containers have explicit parked markers and remain undispatched.

Worker-start verification is not product completion. Existing product gates, required CI/review and full descendant dashboard verification remain. Query the live board and tracker for subsequent state.

## Build Order setup correction

The earlier #2659 classification was incorrect: Aiur v1 explicitly reads direct root children. The Executor had inserted eight intermediate epic issues, so the dashboard correctly treated those as members. Corrected membership puts all44 executable tickets directly under root1; epic issues remain parked planning references. Native dependency edges and lifecycle labels are unchanged. Published `docs/product/build-order.json` matches the local runtime pack. Nested expansion is optional enhancement work, not a Khala requirement; peer notified and issue corrected.

Verification after correction: authenticated browser rendered all44 stable ticket IDs. Live `build-orders 1 --json` reports ready,44 members and118 edges; member IDs and every dependency pair exactly match the published JSON. No executable lifecycle labels changed.
