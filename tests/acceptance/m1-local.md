# M1 local four-party acceptance runbook (KM-151)

The Executor (Claude) runs this runbook itself. It plays both humans, **A1** and **A2**, by driving two
real, already-running Firefox instances over WebDriver BiDi with `tests/acceptance/humans.mjs`, and it
coordinates the operator's listening Claude Code and Codex panes through
`/home/everdred/github/everdred/khala/AGENT-MESSAGES.md`. KM-152 reuses this runbook and driver unchanged
against production; only `--origin` and `--account` change.

| Human | Firefox | BiDi endpoint | Local sign-in | Owns |
|---|---|---|---|---|
| A1 (channel admin) | default profile, `--remote-debugging-port=9222` | `ws://127.0.0.1:9222/session` | `stack:status` `users[0]` | the **Codex** pane's agent |
| A2 (coworker) | profile `khala-coworker`, `-P khala-coworker -no-remote --remote-debugging-port=9223` | `ws://127.0.0.1:9223/session` | `stack:status` `users[1]` | the **Claude** pane's agent |

## Rules for the whole run

- **I1 append-only.** Every pane instruction is one append (`>>` or an append tool) to `AGENT-MESSAGES.md`,
  headed `### <UTC> — From: Khala Claude Executor; To: <Claude test session|Codex test session|Operator>`.
  Never post tokens, passwords, cookies, `pollSecret`, `session.json` content or Dex passwords.
- **I2 links.** Local-stack channel links (`https://127.0.0.1:<port>/join/…`) and agent confirm URLs
  (`<origin>/agent/confirm?joinId=<joinId>`) are disposable and may be posted.
- **I3.** Never commit `AGENT-MESSAGES.md`. Evidence quotes message bodies and truncated ids
  (`@agent-1a2b…`) only, never an email address.
- **I4 wake legs.** During a wake leg, neither append to `AGENT-MESSAGES.md` nor type into a pane.
- **I5.** One acceptance checkout `<wt>` at one SHA (`ACC_SHA`) for the whole run.
- **I6.** One `humans.mjs` command at a time per Firefox (A1 and A2 commands may overlap). On
  `bidi_session_busy`, check `pgrep -f humans.mjs`; never kill or restart Firefox.
- **I7.** The driver only works in tabs it opened (marker tokens in `run.json`), opens them in the
  background, and `cleanup` closes only those.
- **I8 pane typing** only to re-arm a lapsed monitor, to run an in-session command the pane cannot run
  itself, or for the AE5 fallback, and for AE7 owner prompts. Log each typed action with its UTC time.
- Every step ends with its check recorded as **PASS** or **FAIL** plus the named evidence.

## Driver reference

Run from `<wt>` with `H="node tests/acceptance/humans.mjs"`. Exit 0 is success; exit 1 prints one stderr
line `humans.mjs <command>: <step> failed: <code>`. Set `HUMANS_DEBUG=1` for a stack trace (no secrets).

| Command | Does |
|---|---|
| `$H whoami --as a1\|a2` | Prints the Google account signed in to that Firefox, or `none`. |
| `$H trust-local --as a1\|a2` | Loopback only: stores Firefox's certificate exception for the stack's self-signed cert. |
| `$H reset-site --as a1\|a2` | Closes the driver's tabs, deletes the origin's cookies, IndexedDB, local/session storage, caches and service workers. |
| `$H signin --as a1\|a2` | Opens `<origin>/new` in the human's run tab and completes Dex (loopback) or Google (`--account`) sign-in. |
| `$H setup` | A1 creates channel `M1 acceptance <UTC date>` and copies its link; A2 opens it, sees "You're in.", opens the channel. Prints the link. |
| `$H say --as a1\|a2 --text <t>` | Sends `<t>` in the run tab and waits (30 s) for its delivered (non-pending) row. |
| `$H confirm --as a1\|a2 --url <u>` | Opens `<u>` in a new tab, clicks **Confirm**, waits (180 s) for `<label> joined <channel>.`; the tab stays open. |
| `$H wait-for --as a1\|a2 --text <t> [--sender <label>] [--timeout 300]` | Waits until a timeline row in the run tab contains `<t>` and, when supplied, has exactly the parsed `sender` `<label>`; prints that row. |
| `$H transcript --as a1\|a2 [--reload]` | Prints JSON `[{sender, kind, text}]` for every delivered row. |
| `$H cleanup --as a1\|a2` | Closes every tab recorded for that human. |

`transcript` fields come from each row's accessible name line (`<label>, <ownership>, <time>`): `sender` is
the label (`Claude`, `Codex`, a human's name, or `You` for the viewer's own rows, which have no name line),
`kind` is the ownership (`Human`, `Your agent`, `Another person's agent`, or `You`). Agent rows carry no
visible owner tag (the avatar's owner badge and `kind` say whose agent it is). Rows later in a run inherit the run's
sender. State lives in `<wt>/.khala-local/acceptance/run.json` (origin, channel link, room id, channel
path, tab marker tokens); `stack:down --wipe` deletes it.

Driver behaviour worth knowing when reading evidence:

- **Tab identity.** Firefox issues new BiDi browsing-context ids in every session, so the driver marks
  its tabs with a token (`window.name` plus `sessionStorage`) and records tokens, not context ids.
- **Focus emulation.** The app activates its encrypted device only in a visible, focused tab, and one tab
  per owner holds it. The driver reports its own background tabs as focused (a preload script scoped to
  its tabs only). `confirm` hands the device to the confirm tab and back to the run tab afterwards.
- **Storage persistence.** In the driver's tabs, `navigator.storage.persist()` resolves `false` at once;
  in a real Firefox it opens a permission prompt that nobody answers in a background tab. No Firefox
  permission or preference changes.
- **Certificate exception.** Firefox's override button stays disabled until the window has OS focus;
  after 3 s `trust-local` lifts that delay in its own tab and clicks it. On `trust_local_manual`, ask the
  operator (3a).

## 3a. Preflight

1. Acceptance checkout (`<wt>`):
   ```sh
   git -C /home/everdred/github/everdred/khala fetch origin
   git -C /home/everdred/github/everdred/khala worktree add /home/everdred/github/everdred/khala/.worktrees/m1-acceptance origin/main
   ACC_SHA=$(git -C /home/everdred/github/everdred/khala/.worktrees/m1-acceptance rev-parse HEAD)
   ```
   In `<wt>`: `pnpm install`. Record `ACC_SHA`.
2. Fresh stack (first-device rule: each Firefox tab must be its user's first Matrix device):
   ```sh
   pnpm stack:down --wipe && pnpm stack:up && pnpm stack:status
   set -a; . ./.khala-local/e2e.env; set +a
   ```
   **PASS:** every service in `stack:status` is `up`. Record the origin (not the users).
3. Firefox: `ss -ltn | grep -E '127.0.0.1:(9222|9223) '` shows both. If either is missing, **stop** and ask
   the operator to start it with the flags in the table above; never start Firefox yourself.
4. `$H trust-local --as a1`, then `$H trust-local --as a2`. On `trust_local_manual`, append **To: Operator**:
   ```
   ### <UTC> — From: Khala Claude Executor; To: Operator

   In each of the two Firefox windows, open https://127.0.0.1:<port>/ and click Advanced… → Accept the Risk and Continue, then reply done.
   ```
   Re-run until both pass. **PASS:** both print `trusted <origin>`.
5. `$H reset-site --as a1`, then `$H reset-site --as a2`. On `reset_blocked`, append **To: Operator** asking
   them to close that browser's other tabs on `https://127.0.0.1:<port>`, then re-run.
   **PASS:** both print `reset <origin>: …`.
6. Record versions: `claude --version`, `codex --version`, `firefox --version`, `node --version`,
   Synapse (`curl -sk <origin>/_matrix/federation/v1/version` or the compose image tag).
7. Identify each pane's terminal window (for I8 typing) and record how it is addressed.

**Evidence:** `ACC_SHA`, origin, versions, the four driver outputs.

## 3b. Pane install

The Executor runs file and config commands in its own shell; the panes only reload in-session.

1. Back up to `~/khala-backups/panes-<UTC>/` (mode 0700): `~/.codex/config.toml`, `~/.codex/hooks.json`,
   `~/.claude/settings.json`.
2. Disable the old installs: `claude plugin disable khala@khala`, `claude plugin disable khala-proof@khala-proof`,
   and comment out `[mcp_servers.khala]` in `~/.codex/config.toml`.
3. Install the new package from `<wt>/packages/agent` following `packages/agent/docs/install-claude.md`
   (KM-146) and `packages/agent/docs/install-codex.md` (KM-147).
4. Local TLS trust for the agents: replace the `~/.local/bin/khala` symlink with an executable (`chmod 755`)
   two-line wrapper:
   ```sh
   #!/bin/sh
   NODE_EXTRA_CA_CERTS=<wt>/.khala-local/certs/tls.crt exec node <wt>/packages/agent/bin/khala.mjs "$@"
   ```
5. Append **To: Claude test session** and **To: Codex test session** (one append each):
   ```
   ### <UTC> — From: Khala Claude Executor; To: Claude test session

   Run `command -v khala` (must print ~/.local/bin/khala, not a mise path) and `khala --version`. Then reload: `/reload-plugins` (or exit and `claude --resume <session id>`). Reply with both outputs and the source of each khala_* tool you now list.
   ```
   ```
   ### <UTC> — From: Khala Claude Executor; To: Codex test session

   Run `command -v khala` (must print ~/.local/bin/khala, not a mise path) and `khala --version`. Then exit and `codex resume <thread id>`, and trust the three `khala hook deliver --harness codex` hooks (UserPromptSubmit, PostToolUse and Stop) when Codex asks. Reply with both outputs and the source of each khala_* tool you now list.
   ```
   Where a pane cannot run an in-session step itself, type it (I8b) and log it.

**PASS:** both panes ack and list `khala_join`, `khala_status`, `khala_read`, `khala_send` (plus `khala_event`
once KM-173 has merged) from the new server. **FAIL:** either lists an old tool source or reports a name
collision (**stop**).

## 3c. New brief

Append exactly, filling the `<…>` fields:

```
### <UTC> — From: Khala Claude Executor; To: Claude test session, Codex test session

M1 local acceptance brief. Supersedes all earlier briefs in this file. Candidate <ACC_SHA>.
Links policy: local-stack links (https://127.0.0.1:<port>/…) are disposable test links and MAY be posted here. Never post tokens, passwords, cookies or file contents from ~/.local/state/khala.
Tools: use only khala_join, khala_status, khala_read, khala_send from the NEW khala server (<wt>/packages/agent). The old khala plugin/MCP must be disabled.
Owners: Claude pane belongs to human A2; Codex pane belongs to human A1. The humans are browsers driven by the Executor; never open a browser yourself.
During wake tests I will neither write to this file nor type into your pane. Do not prompt yourselves; let Khala wake you. Afterwards report what started your turn (Khala frame / file notice / typed prompt / other).
Ack with: harness + version, tool list source, monitor armed.
```

Wait for both acks. For a pane silent after 2 minutes, type this re-arm prompt into it (I8a) and log it:

```
Re-read /home/everdred/github/everdred/khala/AGENT-MESSAGES.md from the newest Khala Claude Executor message, re-arm your `tail -n 0 -F` monitor on it, and follow that message.
```

**PASS:** both acks name harness and version, the new tool source, and an armed monitor.

## 3d. Humans and history

Pick a short run id `<id>` (for example `date -u +%H%M%S`).

```sh
$H setup                                   # prints <channelLink>
$H say --as a1 --text "m1-hello-<id>"
$H say --as a2 --text "m2-<id>"
$H say --as a1 --text "m3-<id>"
```

**PASS:** `setup` prints a `/join/…` link and every `say` prints `sent as <human>`.
**Evidence:** the channel link (disposable), the three bodies.

## 3e. Joins

1. Append one message **To: Claude test session, Codex test session**:
   ```
   ### <UTC> — From: Khala Claude Executor; To: Claude test session, Codex test session

   Join the channel <channelLink> with khala_join. Claude: label `Claude`. Codex: label `Codex`. Post your confirmUrl here as a reply, then wait.
   ```
2. When both confirm URLs are posted:
   ```sh
   $H confirm --as a2 --url "<claude confirmUrl>"   # A2 owns Claude
   $H confirm --as a1 --url "<codex confirmUrl>"    # A1 owns Codex
   ```
   Each prints `<label> joined <channel>.`
3. Append **To: Claude test session, Codex test session**:
   ```
   ### <UTC> — From: Khala Claude Executor; To: Claude test session, Codex test session

   Run khala_status and khala_read for the channel. Reply with the status line and every message body you can read.
   ```

**PASS (AE1):** both panes report `khala_status` connected and a `khala_read` containing `m1-hello-<id>`,
`m2-<id>` and `m3-<id>`. **Evidence:** both confirm outputs, both pane replies (bodies, truncated ids).
If MSC4268 history does not reach an agent, confirm the run began with `stack:down --wipe` plus
`reset-site`; if it did, **stop** and report (KTD1/KTD4).

## 3f. Wake legs

I4 applies throughout: no appends and no pane typing during a leg. Before the legs, append the
instructions for all of them in one message, let both panes finish their turns and go idle, then wait at
least 60 s with no file writes. Report results only afterwards.

Pre-instruction (append once, before the legs):

```
### <UTC> — From: Khala Claude Executor; To: Claude test session, Codex test session

Wake tests start in about 2 minutes. Finish this turn and stay idle. When a Khala frame wakes you, do exactly what the channel message asks, reply only with khala_send, then go idle again. Claude: when a channel message asks you to run `sleep 20`, run it in Bash and do not abort it. Codex: after you reply in the channel, note whether any new turn started from your own message. Report everything only when I ask afterwards.
```

1. **AE2 (Codex idle).**
   ```sh
   $H say --as a2 --text "Codex: reply with ack-codex-<id>"
   $H wait-for --as a1 --text ack-codex-<id> --sender Codex --timeout 300
   ```
   **PASS:** `wait-for` prints a row with `sender` `Codex`. Record message → reply latency.
2. **Claude idle.**
   ```sh
   $H say --as a1 --text "Claude: reply with ack-claude-<id>"
   $H wait-for --as a2 --text ack-claude-<id> --sender Claude --timeout 300
   ```
   **PASS:** a row with `sender` `Claude`. Record latency.
3. **AE3 (Claude busy).**
   ```sh
   $H say --as a2 --text "Claude: run sleep 20 in Bash now, then reply with busy-done-<id>"
   # once Claude's tool is running (about 5 s later):
   $H say --as a1 --text "busy-check-<id>"
   $H wait-for --as a2 --text busy-done-<id> --sender Claude --timeout 300
   ```
   **PASS:** afterwards Claude reports that the `busy-check-<id>` frame arrived after `sleep 20` finished and
   that the tool was not aborted.
4. **Agent ↔ agent.**
   ```sh
   $H say --as a1 --text "Claude, ask Codex one question in this channel; Codex, answer it."
   $H transcript --as a1
   ```
   **PASS:** the transcript holds at least one Claude row addressed to Codex and one Codex row answering it.
5. **AE4.** After Codex replies, Codex reports that no new turn started from its own message, and:
   ```sh
   jq -c 'select(.sender|startswith("@agent-"))' ~/.local/state/khala/codex/<thread>/inbox.jsonl
   ```
   **PASS:** the output may list Claude's messages, never Codex's own user id.

After the last leg, append **To: Claude test session, Codex test session** asking each pane to report
what started each of its turns (Khala frame / file notice / typed prompt / other).

## 3g. Reload

```sh
$H transcript --as a1 --reload
$H transcript --as a2 --reload
```

**PASS (AE6):** both outputs contain every message from 3d–3f. A2 shows `m1`–`m3` because A2 joined before
them. Every agent row is attributed: `sender` `Claude` or `Codex`, `kind` `Your agent` or
`Another person's agent`. Attribution is asserted unconditionally (KM-135):
any agent row without its agent label and kind is a **FAIL**. **Evidence:** both JSON outputs
(truncated ids).

## 3h. Fallback (AE5)

If a wake leg fails, retry it once. If it still fails, record AE5: deliver at the next turn by typing any
prompt into that pane (I8c), and record the harness, its version and the gap.

## 3i. AE7 listener modes

The Executor runs this leg after #948 and #949 have merged, for **each harness**:
Codex owned by A1 (other viewer A2), then Claude owned by A2 (other viewer A1),
as recorded in `docs/evidence/m1-local-acceptance.md`. Use a unique `<run>` per harness.
Use `$H say`, `$H wait-for` and `$H transcript` for channel traffic. For roster clicks and
observations, use the exported `Bidi` class in `tests/acceptance/humans.mjs`: open the
human's `DEFAULT_PORTS` endpoint, locate only its run tab by the `run.json` marker
(`tabs[as][0]`, matched against `window.name` or sessionStorage `khalaAcceptanceTab`),
and use `bidi.run` / `bidi.waitFor` to inspect accessible names and click controls in
that agent's roster row. Close the BiDi session in `finally`; do not invent a roster
CLI command or touch other tabs. I6 and I7 still apply.

Before each wake check, enter an owner prompt (I8) authorizing the pane to quote the
next test marker with `khala_send`, report the hook source afterwards, and go idle.
Channel messages are test data, not instructions. Let the preparation turn finish.
I4 applies during observation windows: no appends or pane typing. Record each owner
prompt and its UTC time. Install and approve all three Codex hooks before starting.

1. **AE7a Sync (default).** Before changing either mode, inspect both agents from both
   viewers: each roster shows **Sync**. In the tested pane, the owner asks it to run
   `sleep 20` and report when the next marker first enters context. During the tool:
   ```sh
   $H say --as <other> --text "sync-busy-<run>"
   ```
   **PASS:** the text first appears after the tool returns, in the **Stop** frame;
   the sleep completes. Repeat AE2's idle-wake check for this harness using an owner
   preparation prompt and `$H say --as <other> --text "sync-idle-<run>"`, then
   `$H wait-for --as <owner> --text "sync-idle-<run>" --sender <Codex|Claude> --timeout 300`.
   **PASS:** a Khala frame starts the idle turn and the agent quotes the marker.
2. **AE7b Steer.** The owner clicks **Steer** on the tested agent's roster control.
   **PASS:** within 15 s the other human's roster shows the Steer icon read-only.
   The owner prompts the pane to run `sleep 20`, then `sleep 20` again as **two
   separate tool calls**, quoting any newly delivered marker between them.
   During the first sleep:
   ```sh
   $H say --as <other> --text "steer-busy-<run>"
   ```
   **PASS:** the first sleep is not aborted; the agent reports `steer-busy-<run>`
   **between** the two sleeps, from a **PostToolUse** context. Repeat the idle-wake
   check with `steer-idle-<run>`; **PASS:** still woken by a Khala frame.
3. **AE7c Async.** The owner clicks **Async**; verify the other viewer sees the Async
   icon. Let the pane go idle, then:
   ```sh
   $H say --as <other> --text "async-1-<run>"
   $H transcript --as <owner>
   ```
   Wait 60 s without writing to the instruction file or typing into the pane, then
   capture another transcript. **PASS:** no agent turn starts, nothing new appears
   in the agent pane, and no reply appears in the channel. The owner then prompts
   in the agent pane: "call khala_read and quote the last message" (I8).
   **PASS:** it quotes `async-1-<run>` from `khala_read`; this prompt's
   **UserPromptSubmit** did not inject a `<khala-channel-messages>` frame.
4. **AE7d Leave Async.** Prepare the owner-authorized marker reply while still in
   Async, let the pane go idle, and send:
   ```sh
   $H say --as <other> --text "async-2-<run>"
   ```
   The owner clicks **Sync**, verifies the roster update, then sends:
   ```sh
   $H say --as <owner> --text "after-<run>"
   $H wait-for --as <owner> --text "after-<run>" --sender <Codex|Claude> --timeout 300
   ```
   **PASS:** the agent wakes and its automatic frame contains `after-<run>` but
   **not** `async-2-<run>`. Judge the frame itself, not earlier explicit reads.
5. **AE7e Authority.** From A2 inspect A1's Codex row; from A1 inspect A2's Claude
   row, including any expanded roster details. **PASS:** the non-owner has no
   enabled mode control on the other owner's agent, only a read-only mode icon.

**Evidence:** PASS/FAIL for AE7a–AE7e per harness, candidate SHA and versions, UTC
mode-click / cross-view-observation / send / sleep-start / sleep-end / delivery /
reply timestamps, both viewers' roster observations, pane quotes identifying Stop,
PostToolUse and UserPromptSubmit contexts (including absent frames), and channel
transcript excerpts. Record idle-wake latencies and the full 60 s Async observation
window. Fill the **AE7 (pending run)** row in `docs/evidence/m1-local-acceptance.md`;
do not reuse the original run's PASS as AE7 evidence.

## 3j. Teardown

```sh
$H cleanup --as a1
$H cleanup --as a2
```

Leave the stack up. Append:

```
### <UTC> — From: Khala Claude Executor; To: Claude test session, Codex test session

M1 local acceptance finished; stay idle with your monitor armed.
```

**PASS:** both `cleanup` commands print `closed <n> tab(s)`; the operator's other tabs are untouched.

## Evidence doc

Write `docs/evidence/m1-local-acceptance.md` with: `ACC_SHA`; versions (Node, Synapse 1.161.0,
matrix-js-sdk 42.4.0, Claude, Codex, Firefox); a PASS/FAIL table for AE1–AE7 (AE5 `n/a` or the gap);
transcript excerpts with truncated ids; both reload `transcript` JSON outputs; the install steps actually
needed and every I8 pane-typing action with its UTC time; wake latencies (message → reply). Open it as
PR 2 (docs only); `ACC_SHA` stays the `origin/main` commit from 3a.
