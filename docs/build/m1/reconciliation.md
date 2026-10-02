# M1 build — reconciliation decisions (plan_version 1 → 2)

These are Executor decisions made after the first ticket-writing pass. They override anything in ticket drafts that conflicts with them. Apply them to `contracts.md`, `roster.md` and every affected `tickets/KM-*.md`.

## Contract amendments

- **A1 · C2 routes.** `joinId` is always a query parameter (already in contracts.md). The confirm page URL is `<origin>/agent/confirm?joinId=<id>`. KM-131 builds it this way and KM-134 routes it this way. There is no gateway prefix change. KM-133 stays complexity 2 because of `roomName`.
- **A2 · C3 participants.** There is no new GET route.
  - The existing `POST /api/human/messaging/participants` keeps its request shape. Each response entry gains `kind: 'human'|'agent'|'unknown'`, plus `ownerLabel` and `harness` when `kind === 'agent'`.
  - An unknown member yields `kind:'unknown'` and never fails the response.
  - KM-122 implements this; KM-135 consumes it through the existing `browser-api.ts` caller.
  - Rewrite C3 to say this.
- **A3 · Human labels.** When KM-122 mints a browser session, it sets the human's own Matrix display name to `ownerFirstName(verifiedEmail)`: read first, write only if different. Human labels everywhere come from Matrix display names.
- **A4 · C5 additions.**
  - `activity.json { state: 'idle'|'busy', updatedAt }`: hooks write it, wakers read it, and only an idle session is woken.
  - `watcher.json { nonce, armedAt }`: at most one live Claude watcher per session.
  - `status.json` gains `channelName`.
  - One session-id rule everywhere: `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`.
- **A5 · C6 envelope.** The frame text in C6 is fixed, but it is printed inside each harness's hook output envelope, not as bare stdout.
  - Claude `Stop`: `{"decision":"block","reason":<frame>}`.
  - Claude `UserPromptSubmit`: the frame on stdout, which Claude adds as context.
  - Codex: `{"hookSpecificOutput":{"hookEventName":<event>,"additionalContext":<frame>}}`, or `decision/block` for `Stop`.
  - KM-145 owns the exact envelopes and tests them.
- **A6 · C7 events.**
  - `KhalaAgentClient` gains `sendChannelEvent(content: ChannelEventContent): Promise<{ eventId: string }>`; KM-173 adds it and KM-143 owns the base client.
  - The tool list becomes 5 tools including `khala_event`; KM-144 asserts 4, and KM-173 updates that test to 5.
  - The `khala event` CLI is dropped: a separate process cannot hold the agent's in-memory crypto device. Only the `khala_event` MCP tool exists.
- **A7 · New C11, pinned agent Matrix session API.** It is owned by KM-110. KM-143, KM-173 and KM-174 consume it verbatim:

  ```ts
  // packages/agent/src/matrix/session.ts
  export type SessionMessage = { eventId: string; roomId: string; sender: string; ts: number; type: 'm.room.message' | 'com.khala.event.v1'; body: string; content: Record<string, unknown> };
  export interface AgentMatrixSession {
    readonly userId: string;
    onMessage(handler: (m: SessionMessage) => void): () => void;      // excludes own sender; includes com.khala.event.v1
    waitForInvite(roomId: string, timeoutMs: number): Promise<void>;   // resolves once the invite is seen in /sync
    join(roomId: string): Promise<void>;                               // joinRoom, accepting the MSC4268 bundle
    history(roomId: string, limit: number, before?: string): Promise<{ messages: SessionMessage[]; nextBefore?: string }>;
    send(roomId: string, text: string): Promise<{ eventId: string }>;
    sendChannelEvent(roomId: string, content: Record<string, unknown>, txnId?: string): Promise<{ eventId: string }>;
    roomName(roomId: string): string | undefined;
    stop(): Promise<void>;
  }
  export function createAgentMatrixSession(creds: AgentCredentials, opts?: { log?: (line: string) => void }): Promise<AgentMatrixSession>;
  ```

  `sendChannelEvent` may be stubbed to throw `not_implemented` in KM-110; KM-173 implements it. KM-141's `unreadCount()` returns `{ total: number; messages: number }`. Consumers use `.messages` for wake decisions and `.total` for status.
- **A8 · Package name.** The new package is `@khala/agent` permanently for M1, with the bin `khala`. Nothing is renamed: KM-124 does not rename it, and npm publishing is deferred (D7). Every command uses `pnpm --filter @khala/agent` or `--filter ./packages/agent`. The package runs from TypeScript source via `tsx` (KM-103), and so do the hook scripts.
- **A9 · C10.** `.khala-local/state.json` includes `secrets.registrationSharedSecret`, `secrets.passwordDerivationSecret` and the Dex user credentials. Live tests read them from there.
- **A10 · Live tests are not unit tests.**
  - `*.live.test.ts` files are excluded from each package's default `test` script and run only via `test:live`.
  - KM-110 sets this up for `packages/agent`.
  - KM-150 does the same for any live test it adds.

## Graph changes

- **Added `depends_on` edges:**
  - KM-103 → 104
  - KM-110 → 104
  - KM-120 → 102
  - KM-132 → 131
  - KM-134 → 120
  - KM-135 → 120, 122
  - KM-147 → 145
  - KM-173 → 171
  - KM-174 → 143
  - KM-175 → 171, 173
- **Complexity changes:** KM-133 → 2, KM-172 → 3, KM-174 → 2.
- **`serializes_with` edges:**
  - Root scripts: KM-101 ~ KM-102.
  - Lockfile: KM-102 ~ KM-103.
  - Shared panes: KM-111 ~ KM-112 ~ KM-151.
  - Browser `matrix-browser.ts`: KM-130 ~ KM-134 ~ KM-135 ~ KM-172.
  - Control `matrix.ts` and `handlers.ts`: KM-130 ~ KM-122 and KM-130 ~ KM-123.
  - Shared thread styles: KM-172 ~ KM-182.
- **Admin approval.** `deletion-guard` needs admin approval on the head SHA for any PR that deletes files: KM-102, KM-120, KM-123, KM-124, KM-125 and KM-153. Each of those tickets says so in its PR checklist; the reviewer handles it.
- **KM-120** also removes `agent-presence.ts`'s call to `/api/agent/status`.

## Late additions (integration writer)

- **KM-150** gains `depends_on` KM-135. Agent attribution in the browser is asserted unconditionally.
- **C7 error type.** C7 names the error type `KhalaClientError { code: 'invalid_link'|'link_unavailable'|'join_expired'|'not_connected'|'send_failed'|'session_unknown'|'internal_error'; message }`. KM-103 ships it.
- **A3 resolves the friendly-name gap.** KM-143 reads human labels from Matrix display names and falls back to the user id localpart.
- **Session API.** A7's C11 session API is authoritative. Where KM-143, KM-110, KM-141 or KM-142 pinned other names, rewrite them to C11 and to KM-141's `unreadCount(): {total, messages}`.
- **Gate G-PROD covers more than the wipe.** It also covers approving the production wipe, naming two real Google accounts, and the operator doing a one-time headed login (`humans.mjs login`).
- **KM-152 SHA proof.** Netlify CLI deploys report `commit_ref: null`. KM-152 proves the SHA three ways: the deploy id matches, the deploy title carries the SHA, and the served `index.html` hash matches the local build.

## Acceptance ownership (operator, 2026-10-02)

- KM-151 (local) and KM-152 (production) are **Executor-owned**, not dispatched to Aiur workers. The Executor (Claude) acts as both humans via headless browsers. It coordinates the operator's already-open, listening Claude Code and Codex terminals through `/home/everdred/github/everdred/khala/AGENT-MESSAGES.md`.
  - These tickets are promoted with label `human:todo`, not `agent:todo`, so Aiur never dispatches them.
  - Their docs are written as Executor runbooks: exact pane instructions, pass/fail checks and evidence capture.
- KM-111 and KM-112 (wake spikes) use the same panes, so the Executor coordinates their manual legs. The code parts stay Aiur-dispatchable, and the worker posts a request in `AGENT-MESSAGES.md` addressed to the Executor when it needs a pane leg.

## Round 3 (Executor)

- C12 hook entry point is `run(stdin, argv)`, and a module's return value becomes the process exit code. Accepted.
- KM-147 drops its hard dependency on KM-112. It builds from the existing 0.160 evidence (`docs/evidence/codex-0160-native-boundary.md`), and KM-112's findings are suggested-after input. Now KM-150 no longer waits on a manual pane leg. If KM-112 contradicts KM-147's behaviour, the finding returns to KM-147 as rework.

## Deferred additions

- D7: npm publishing of `@khala/agent` under a public name, with a bundled contracts dependency.
- D8: confirm the production identity provider (Google OIDC configuration) before KM-152; KM-152 checks this as a precondition.

## Round 2 rulings (plan_version 2 → 3)

Executor rulings on the second review pass. They override anything above, and any ticket text, that conflicts with them. `contracts.md`, `roster.md` and the affected `tickets/KM-*.md` are updated to match.

- **R1 · KM-103 owns `packages/agent/bin/khala.mjs` entirely (new contract C12).**
  - The bin dispatches `khala mcp` → `packages/agent/src/mcp/main.ts` (default export `main(argv)`), and `khala hook <name>` → `packages/agent/hooks/<name>.ts` (default export `run(stdin)`), via dynamic `import()` after a single tsx `register()`.
  - An unknown hook name → exit 1, never exit 2.
  - KM-144, KM-145, KM-146, KM-147 and KM-150 only create those module files. None of them edits `bin/khala.mjs`. The "writer-requested ser" Risks notes about the shared bin are removed from KM-144, KM-145 and KM-150, and every bin edit is removed from those tickets and KM-151.
  - Hook modules are therefore `.ts`: KM-145's `hooks/deliver.mjs` becomes `hooks/deliver.ts`, and KM-146's `hooks/claude-wake.mjs` becomes `hooks/claude-wake.ts`.
  - C12 pins two details the ruling leaves open: the hook entry point also receives the remaining arguments, `run(stdin, argv)`, so `--harness` reaches `deliver`; and the bin reads stdin (1 MiB cap) itself. A module's own return value passes through as the exit code, which is how `claude-wake` still exits 2 to wake Claude.
- **R2 · KM-104's `./m1/*` wildcard export covers `channel-event` and `from-aiur`.** KM-170 and KM-171 must not edit `packages/contracts/package.json` exports. There is no edge with KM-125; KM-125's writer-requested ser with KM-170/171 is removed.
- **R3 · Confirmed:** the C3 `unknown` entry shape as written.
- **R4 · C11 gains `displayName(userId: string): string | undefined`** on `AgentMatrixSession`, read from room member state. KM-110 implements it; KM-143 uses it for `senderLabel`, falling back to the user-id localpart. KM-143's "display-name gap" is closed.
- **R5 · Confirmed:**
  - `onMessage` is live-only and drops pre-join events; `history()` covers backfill.
  - `history()` omits undecryptable events.
  - There is no custom disconnect recovery; matrix-js-sdk's sync loop retries.
  - KM-110's extra exports are dropped: `session.ts` exports exactly C11.
- **R6 · Confirmed:** `KhalaClientError('internal_error', 'invalid_event')`.
- **R7 · Codex waker wiring moves to KM-150.** It is agent-dispatchable integration: KM-150 adds `src/mcp/wiring.ts` and uses it from `src/mcp/main.ts`. KM-150 therefore gains `depends_on` KM-147. KM-151's runbook only verifies the wiring, and KM-151 no longer writes to `packages/agent`.
- **R8 · C6 / A5 correction.** The envelope depends only on the hook event, the same for both harnesses. This supersedes A5's envelope list:
  - Claude and Codex `UserPromptSubmit`: `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":<frame>}}`.
  - Claude and Codex `Stop`: `{"decision":"block","reason":<frame>}`.
  - No hook ever prints the bare frame. contracts.md C6, KM-145 (invariants and tests) and KM-111 are updated; KM-112, KM-146, KM-147 and KM-174 quote the corrected form.
- **R9 · Approved:** KM-120 may drop the one `apps/connector` test import of `agent-presence` (`native-surface.test.ts:24`) and the cases that use it. It notes this in its PR.
- **R10–R12 · Confirmed as written.**

Graph change from these rulings: `depends_on` KM-150 → KM-147 (R7). Removed: the writer-requested bin serialization among KM-144, KM-145, KM-146 and KM-150 (R1), and KM-125 ~ KM-170/171 (R2).
