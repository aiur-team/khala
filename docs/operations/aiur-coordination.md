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
