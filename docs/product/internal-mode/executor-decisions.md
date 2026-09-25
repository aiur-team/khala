# E09 Executor decisions

Binding decisions for the internal-mode and agent-integration work (epic #137). Later decisions override earlier ones. Every E09 ticket must follow them; the research docs in this directory are the contracts.

**Executor decisions for E09 (binding on every area).**

1. **One inbox batch API.** `mcp-inbox-batch` (#153) owns it. It's a bounded, durable peek that returns a **batch token**; acknowledgement is **on Khala's side**, and the agent's next Khala call acknowledges through the token. Every other area uses it. There's no second batch or lease API.
2. **One pull operation.** `khala_read` (MCP) and `khala read` (CLI) are owned by `listening-mode-pull` (#155), built on (1).
   - Drop `khala_check` (#153).
   - #154 (OpenCode) and #161 (the Claude `/khala read` slash command) call the same operation.
   - MCP piggyback (#153) appends the same batch format.
3. **Restart without duplicates** is achieved by Khala-side acknowledgement through the batch token. The receiving host (Codex, Claude, OpenCode) never has to deduplicate. Rewrite any proof criterion that needed that.
4. **Listening-mode persistence.**
   - `listening-modes` owns a `listening-mode-store` **port**, plus the hosted adapter on the existing policy state.
   - `internal-core` (#156) owns the **SQLite adapter** for that port, which lives in `local-sqlite-room-store` or its own slug.
   - `listening-modes` also owns the local automation limits and the pause/wake contract that `local-automation-fence` enforces.
5. **`steer` in v1 is non-abort,** delivered at the next safe boundary (D2).
   - Claude: `steer` means after-tool injection and `sync` means end-of-turn delivery.
   - Codex: `sync` means `thread/queue/add`, and `steer` means `turn/steer` (spike, unproven).
   - OpenCode: the non-abort route, per #154's proof.
   - Hard abort (Claude `interrupt()`, OpenCode abort-then-prompt) is a separate opt-in **hard-cancel** capability behind a spike, and never the default `steer`.
6. **Capability data** has one owner: `HarnessCapabilities`, from `listening-mode-contract`. Anything without passing evidence is `unproven`, including MCP-only `async` until `mcp-piggyback-evidence` passes.
7. **Dependencies use ticket slugs, never area names.** To break the #155↔#156 cycle, block `local-automation-fence` on `listening-mode-contract`, and block `listening-mode-dispatch` on `local-sqlite-room-store`.
8. **Shared files:** new modules registered from `agent-cli` `cli/app.ts` and `mcp/server.ts`, with a minimal diff to those files. `mcp-result-piggyback` lands first in `mcp/`.
9. **Terminology:** "channel", never "room" or "chat", in agent- and user-facing text. Matrix-internal fields are exempt.
**More E09 Executor decisions (binding, and in addition to the earlier shared list).**

10. **Owners of the two acceptance runs.** The `acceptance` area owns both Acceptance 1 (the CI end-to-end test with fakes) and Acceptance 2 (the live runs). internal-core keeps only a launcher smoke test. opencode-bridge contract 4 is dropped; opencode-bridge supplies the harness pieces that acceptance consumes.
11. **Acceptance stays lightweight, per the operator's definition.** A **test script** creates test tickets that Aiur agents work. Success means the agents exchange messages, and the Executor confirms it from the logs.
    - Test tickets go in aiur-team/khala with an `acceptance` label and model pins. They instruct the agent to join a channel and exchange messages, not to change code or open a PR. The script closes them afterwards.
    - No separate acceptance Executor, no sandbox repo, no signed-evidence envelope, and **no new reply-to field** on `khala send`.
    - Verification reads the chat store and the agent logs. Drop the Aiur-repo tickets.
12. **Stop semantics.**
    - The UI **Stop** ends the agent sessions. The local server keeps running, and the channel stays viewable and resumable from the browser while the server is up.
    - Closing the launcher stops the server, after which `khala internal --resume <channel-id>` resumes it.
    - internal-core owns a `stop-control` ticket covering the UI control and the server endpoint.
13. **D9 browser open.** A dedicated spike ticket (`browser-handoff-spike`) proves that the token never appears in argv. The fallback prints the local URL for the user to open. Launching must not block on the spike.
14. **D11 in internal mode.** The launcher never binds agents silently. Every agent joins through the room-discovery request and the human grant (RD4b/RD8), and internal-core hands off to those slugs.
15. **Descriptor and discovery.**
    - internal-core owns the descriptor format and files, and declares its package: `apps/internal/` for the server and `apps/web/src/internal/` for the UI.
    - Installed MCP and plugin entries read the port (4870 or the next free one) and the token from the 0600 descriptor at runtime, never embedding them.
    - setup-cli blocks on `authenticated-loopback-server`.
16. **OpenCode mode semantics.**
    - `steer` is `promptAsync`, delivered at the next tool boundary without abort, per #154.
    - `sync`, if unsupported, is shown honestly as unsupported. The binding then defaults to `async` and the UI states why.
    - Hard abort is a separate opt-in. opencode-bridge owns the OpenCode routes, and #155's `opencode-listening-routes` is dropped in favour of it.
    - opencode-bridge also owns the OpenCode server-auth proof.
17. **Codex setup.** Codex needs no plugin. `setup-cli-codex` installs the MCP entry and the Khala skill only.
18. **Merge order in the `agent-cli` hotspot:**
    `mcp-inbox-batch` → `mcp-result-piggyback` → `listening-mode-pull` → `setup-cli-plan` → everything else.
    Each area adds its own modules and makes a minimal edit to `cli/app.ts`, `cli/main.ts`, `cli/types.ts` and `mcp/server.ts`.
19. **Receipts.** read-receipts RR4 and RR5 own the Claude and OpenCode read receipts, so fix the blocked-by entries.
20. **Every contract** declares a slug and a title, and cites other areas' contracts by slug only.

21. **npm package:** `@aiur/khala` (`npx @aiur/khala setup`). **Acceptance 2:** an OpenCode + DeepSeek agent chats with a Claude agent.

22. **setup-cli:** the AGENT runs `npx @aiur/khala setup`, with the person confirming the plan; the person never installs anything by hand.

23. **OPERATOR SCOPE:** the target is the user's OWN interactive CLI (Codex CLI, Claude CLI, OpenCode TUI). All three modes must work there, by native routes or by fallback (`khala run <cli>` PTY wrapper). Khala-hosted processes are secondary. Desktop and browser apps (Cursor, Claude desktop/web) are a secondary target.

24. **OPERATOR:** Khala never launches or hosts an agent. The user starts their own CLI session and points the agent at a channel URL, or asks the agent to create a channel from the CLI (a new `khala channels create` / `khala_create_channel`, human-confirmed; room-discovery owns it). Modes are delivered into the user-started session. A `khala run` wrapper is not approved by default; it needs an operator decision.
**E09 Executor decisions 25–30 (binding).**
25. **No restricted-profile gate on delivery.** Channel text reaches the user's normal interactive Claude session in every mode. It's framed as untrusted content (keep that framing), plus an **optional** hardening check that `setup` can report. Delivery never depends on a special profile.
26. **The Claude hook runtime** (`PostToolUse` → `steer`, `Stop` → `sync`, async wake) is owned by **claude-plugin (#161)**. listening-modes (#155) keeps only the capability evidence and the I10 channel-push spike. `claude-interactive-listening-route` in #155 is dropped, or reduced to evidence only.
27. **One Claude install layout:** a single user-scope plugin that contains the skill, the hooks and the MCP entry, installed by `setup-cli-claude`. There's no separate `/khala` skill beside it.
28. **The canonical SQLite slug is `local-sqlite-channel-store`,** which replaces `local-sqlite-room-store` everywhere.
29. **Acknowledgement capability:** `listening-mode-contract` (#155) adds `acknowledgement: unknown | unsupported | batch_token_next_call` to `HarnessCapabilities`.
30. **Receipts and delivery target the user's own CLI session** (decision 23). Hosted app-server routes are secondary. `/khala join` takes a channel URL and goes through the access request and grant (`channel-access-journal`, `channel-access-inbox`).
**E09 Executor decisions 31–35 (from the interactive-CLI proofs).**
31. **Codex delivers through native hooks** (PreToolUse/PostToolUse → `steer`, Stop/UserPromptSubmit → `sync`). This **amends decision 17**: `setup-cli-codex` installs the Khala hooks plus the MCP entry and skill. It also **amends decision 5**'s Codex mapping, so `turn/steer` and `thread/queue/add` become hosted-only and secondary.
32. **OpenCode `steer`** is the plugin route (`tool.execute.after` → the next `messages.transform`), and **`sync`** is `session.idle` → a session-addressed `promptAsync`. This amends decision 16. Ownership stays with opencode-bridge (#154) slugs; don't create parallel slugs.
33. **Every proof must run with normal trust settings.** No `--dangerously-bypass-hook-trust`, `--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`, isolated `--setting-sources`, or unauthenticated `--port`. Approving hooks and plugins once, the way setup would, is allowed and must be recorded. Record the exact launch command, the CLI version, and the session ID on every event. Don't call a session "user-started" unless a human started it; say "agent-launched with default settings".
34. **Delivery to an idle agent is required for `steer` and `sync`**, because the usual chat case is a message arriving while the agent sits idle. Each CLI gets a proof-gated route:
    - Codex: `codex-idle-wake`, a fixed-text `codex queue` wake with no message bytes;
    - Claude: the committed content-free `asyncRewake` run live, plus a strategy beyond the 40-second window;
    - OpenCode: a plugin idle watcher that calls `promptAsync`.

    Until an idle route is proven, the UI and capabilities must say that idle agents receive messages only at their next turn.
35. **Evidence fixes:**
    - raw arrival and tool-start timestamps;
    - acknowledgement through the agent's next Khala call;
    - a live restart trial with a fresh token;
    - OpenCode `steer` on a built-in tool, plus a check that the transformed context persists beyond one model call.
**E09 Executor decisions 36–40 (promotion).**
36. **What Stop does.** Stop **revokes the agent's binding and stops all delivery**. The user's CLI process keeps running (decision 24 beats the earlier "ends sessions" wording in decision 12). Acceptance tests assert that no further delivery happens, that the binding is revoked, and that the channel stays viewable. They never assert that the process exits.
37. **Idle delivery is required, not optional** (decision 34). `codex-idle-wake` is a required ticket. `listening-mode-contract` and `listening-mode-ui` must carry an honest per-harness claim, "idle agents receive messages only at their next turn", until that harness's idle route is proven.
38. **Missing spikes get tickets:** `hard-cancel-claude-spike`, `hard-cancel-opencode-spike` and `claude-channel-push-spike` (I10). Each is complexity 2, experiment-only, and gates any hard-cancel or channel-push capability claim.
39. **`external-channel-composition` is #41 (KHA-132).** `trust-transitions` is #29 (KHA-120), already merged.
40. **`setup-cli-package`** is blocked on `listening-mode-pull`, to keep the `agent-cli` hotspot serialized.
41. **Grant recovery uses libsodium sealed boxes, not HPKE.** Pin the maintained
    `libsodium-wrappers` or `sodium-native` binding and use `crypto_box_seal`
    (X25519 + XSalsa20-Poly1305). The versioned envelope names that algorithm,
    recipient-key thumbprint, and ciphertext; authenticated request context lives
    inside the sealed plaintext. Prove the binding on Node 22 with libsodium's
    published known-answer tests and reject tampered ciphertext. Take no HPKE
    dependency and do not implement cryptographic primitives locally.
42. **Listening-mode control: last change wins.** Operator decision, 2026-09-25.
    The owner (from the UI) and the bound agent may both change the agent's
    listening mode. Each write carries `expectedVersion`, so a simultaneous
    change is refused as a conflict instead of silently overwriting. There is no
    owner lock and no owner-only mode. This is the behaviour of the merged
    `listening-mode-store` (#271). `listening-mode-ui` must show who made the
    last change, and must handle a version conflict by reloading.
43. **The Executor runs the human-verification pass.** Operator decision,
    2026-09-25. The Executor runs the end-to-end acceptance tickets
    (agent-launched, normal trust settings, decision 33) and the operator reviews
    the evidence. `opencode-interactive-cli-proof` (#236), which requires a
    person-started TUI, stays parked unless the operator later runs it.
44. **Serialize merges, not starts, on shared files (amends 8, 18 and 40).**
    Executor, 2026-09-25, at the operator's request to parallelize the build. A ticket
    that only shares files with another ticket (for example the four `agent-cli` registration files, the skill
    doc, or the plugin package) is no longer blocked by it. Both start at once, and
    the Executor merges them in the order that decisions 8 and 18 give, rebasing
    between merges. #297 (`setup-cli-contract`) moves `agent-cli` command and tool
    registration to registries, so later tickets add one file plus one registry line.
    Interface-only dependencies are cut by landing the interface first: #297 (setup
    types), #299 (`claude-plugin-scaffold`) and #300 (`externalization-journal-contract`).
    #298 carries the hosted inbox mount, so #209 no longer waits on #41. File
    ownership: #189 owns the internal descriptor (decision 15) and the bundle-directory
    constant; #221 owns `externalization/{journal,service}.ts` and #223 owns
    `history-export.ts`. Every HARD dependency is kept, and the integration and
    acceptance tickets (#233, #237, #238, #240, #241, #262) stay the real gates.
