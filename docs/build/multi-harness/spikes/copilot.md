# Spike U23 (MH-U23, #1114): Copilot extension wake and VS Code hooks

Run 2026-10-05 by the Executor on Linux (Arch, kernel 7.1.4). Plan unit U23 of
`docs/plans/2026-10-05-001-feat-multi-harness-parity-plan.md` (plan commit `6e573947`).

- **Copilot CLI:** `GitHub Copilot CLI 1.0.92` (the research used 1.0.91). Model `gpt-5-mini`.
- **VS Code / Cursor:** not installed on this machine. No GUI was opened.
- **Isolation:** every run used `COPILOT_HOME=/tmp/claude-1000/spike-1114/home` (documented in `copilot help environment`: "override the directory where configuration and state files are stored; defaults to `$HOME/.copilot`"). Auth came from the existing keyring login. The real `~/.copilot/` was only read. `~/.copilot/config.json` had sha256 `5f3c895a…c955c` before and after the run.
- **TUI:** ran in a private detached tmux server (`tmux -L spike-1114`, 200x50), driven only by `send-keys`, then killed.

## Results

| # | Criterion | Result |
|---|---|---|
| 1 | With experimental on, an extension in `<COPILOT_HOME>/extensions/khala-spike/` calls `session.send({prompt, mode:'enqueue'})` while the TUI is idle. A turn starts within 5 s with no keypress, and `userPromptSubmitted` sees the text | **PASS**. The turn started 0.13 s after `send`, and the hook saw the nonce 0.04 s after `send` |
| 2 | Do VS Code Agent Host Copilot sessions load CLI extensions? | **UNTESTED**: VS Code is not installed |
| 3 | Does VS Code Local fire hook files that use camelCase event names? | **UNTESTED**: VS Code is not installed |
| 4 | Which env var or payload shape tells Copilot CLI and VS Code hook calls apart? | **Partial (CLI side only)**. Copilot CLI sets `COPILOT_CLI=1` in every hook's environment. The VS Code side is **UNTESTED** |
| 5 | Does Copilot CLI also run `~/.copilot/hooks/khala-vscode.json` with PascalCase names? | **Recorded: YES**. Every event was delivered twice, once per file |
| 6 | What does experimental mode change besides extensions? | **Recorded**. See the list below. **Correction:** the flag is stored in `settings.json`, not `config.json` |
| 7 | What is the lowest VS Code version with `vscode.lm.registerMcpServerDefinitionProvider`, and what is Cursor's VS Code base? | **Recorded**. VS Code **1.101.0**. Cursor's base is **1.128.0** (secondary source, not checked locally) |

Criteria 2 and 3 and the VS Code half of 4 stay open until the operator runs them (see the last section).

## Evidence

### C1: idle wake through the CLI extension (PASS)

Setup, all under the isolated `COPILOT_HOME`:
- `experiments/copilot-spike/extension.mjs` was installed as `extensions/khala-spike/extension.mjs`. It calls `joinSession({})`, then polls a trigger file. When the file appears, it calls `session.send({ prompt, mode: "enqueue" })` and logs the session events.
- Hook files: `hooks/khala.json` (camelCase: `sessionStart`, `userPromptSubmitted`, `agentStop`) and `hooks/khala-vscode.json` (PascalCase: `SessionStart`, `UserPromptSubmit`, `Stop`). Both run `hooklog.sh`, which logs stdin and the `COPILOT*`/`VSCODE*`/`TERM_PROGRAM` env vars.

**Baseline without experimental.** The launch was `copilot --model gpt-5-mini --log-level all` in the tmux pane. The extension process never started: no `extension.ndjson` was written. Extensions are gated on the `EXTENSIONS` feature flag, which only experimental mode unlocks.

**With experimental.** The flag was set with `COPILOT_HOME=… copilot config experimental true`, which printed `Set experimental to true in settings.json.`

```
# extension.ndjson (epoch seconds)
1791261557.215 extension process started  (env: COPILOT_EXTENSION_PARENT_PID, COPILOT_SDK_PATH, …)
1791261557.237 joined sessionId=fd6ec07b-…
   … TUI idle at an empty ❯ prompt for ~14 s, no keys sent …
1791261571.054 trigger file written (shell)
1791261571.098 send start  NONCE-7f3a91
1791261571.100 send admitted messageId=88838858-…
1791261571.177 event user.message "Khala spike NONCE-7f3a91: reply with the single word OK …"
1791261571.233 event assistant.turn_start          # +0.135 s after send
1791261584.245 event assistant.message "OK"
1791261584.248 event assistant.turn_end
1791261584.295 event session.idle
```

```
# hooks.ndjson: userPromptSubmitted, khala.json (+0.042 s after send)
{"sessionId":"fd6ec07b-…","timestamp":1791261571133,"cwd":"/tmp/claude-1000/spike-1114/work",
 "prompt":"Khala spike NONCE-7f3a91: reply with the single word OK and do nothing else."}
```

The TUI pane rendered the prompt as a normal user turn (`❯ Khala spike NONCE-7f3a91: …` then `● OK`). The footer then showed `Session: 0.42 AIC used`, so even a `gpt-5-mini` wake turn costs AI credits. U25's consent text must say so (KTD8).

Other observations for U24 and U25:
- `sessionStart` does not fire when the TUI starts. It fires lazily on the first prompt (`source:"new"`, `initialPrompt` set), after `userPromptSubmitted`. A wake on a fresh session therefore produces `userPromptSubmitted` first and `sessionStart` second.
- The CLI strips sensitive env vars, such as `GITHUB_TOKEN`, from extension processes unless the extension lists them in `requestedEnvironmentVariables`, which prompts the user. The Khala extension must not ask for any.
- The extension subprocess env has `COPILOT_EXTENSION_PARENT_PID` and `COPILOT_SDK_PATH`. `session.on` delivers `session.idle`, which the extension can use as its idle gate.
- User extensions load from `$COPILOT_HOME/extensions/`. Folder trust only gates project extensions (`.github/extensions/`).

### C4: hook discriminator, CLI side

Each hook call made by Copilot CLI 1.0.92, under both camelCase and PascalCase files, had this env:

```
COPILOT_CLI=1
COPILOT_CLI_BINARY_VERSION=1.0.92
COPILOT_HOME=/tmp/claude-1000/spike-1114/home
COPILOT_LOADER_PID=1632020
COPILOT_PROJECT_DIR=/tmp/claude-1000/spike-1114/work
```

Payload shapes:
- camelCase file: camelCase keys (`sessionId`, `timestamp` in epoch ms, `transcriptPath`, `stopReason`) and **no `hook_event_name`**.
- PascalCase file: `hook_event_name` plus snake_case keys (`session_id`, ISO `timestamp`, `transcript_path`, `stop_reason`, `initial_prompt`).

So `COPILOT_CLI=1` reliably marks a Copilot CLI call. Whether VS Code (Local or Agent Host) sets it, or sets something else such as `VSCODE_*`, is untested.

### C5: PascalCase file is run by the CLI (YES, duplicate delivery)

Every event in the one turn fired in both files, with the same `sessionId`:

```
khala.json         userPromptSubmitted  1791261571.140
khala-vscode.json  UserPromptSubmit     1791261571.162
khala.json         sessionStart         1791261571.192
khala-vscode.json  SessionStart         1791261571.215
khala.json         agentStop            1791261584.25x  stopReason=end_turn
khala-vscode.json  Stop                 1791261584.25x  stop_reason=end_turn
```

The CLI log reported the load as `loadDeferredRepoHooks(...): loaded repo hooks (hookCount=6)`.

### C6: what experimental mode enables in 1.0.92 (U25 consent text)

Output of `/experimental show` in the isolated TUI, trimmed:

```
Slash Commands:
  /after [delay] [prompt...]    - Schedule a one-shot prompt …
  /every, /loop [interval] …    - Schedule a recurring prompt …
  /extensions, /extension       - Manage CLI extensions
  /sandbox …                    - Manage sandbox settings …
  /search, /find [query]        - Search the conversation timeline
Feature Flags:
  CLI_CLOUD_SESSIONS  - Enable the CLI startup flow for cloud sandbox sessions
  EVERY_AND_AFTER     - Enable /every and /after slash commands …
  EXTENSIONS          - Enable extensions — programmatic tools and hooks via @github/copilot-sdk …
  MCP_TASKS           - Enable MCP Tasks support … run as background subagents …
  HYDRAFUSION         - Enable HydraFusion models
  MCP_APPS            - Enable MCP Apps (SEP-1865) UI extension passthrough …
  TOOL_SEARCH         - Enable tool search with deferred loading for MCP and external tools
  DIFF_V2             - Tools-based /diff …
  AUTOPILOT_NO_PROGRESS_STOP - Stop autopilot early when it makes no tool progress …
  INLINE_IMAGES       - Enable native inline image rendering … Kitty graphics protocol
  AUTO_APPROVAL       - Enable LLM safety-judged auto approval via /allow-all auto
  SANDBOX             - Enable shell command sandboxing …
These features are not stable, may have bugs, and may be removed in the future.
```

Experimental mode also shows `/experimental` in the startup banner, and the footer gains a reasoning-effort label (`GPT-5 mini · Medium`).

**Correction for U25.** In 1.0.92, `~/.copilot/config.json` begins with `// User settings belong in settings.json. // This file is managed automatically.`, and `copilot config experimental true` writes `{"experimental": true}` to **`$COPILOT_HOME/settings.json`**. U25 should set the flag with `copilot config experimental true`, or by merging into `settings.json`. It should not hand-edit `config.json`, which the CLI rewrites, and it should respect `COPILOT_HOME`.

### C7: VS Code API floor and Cursor base

The VS Code floor was measured by packing each `@types/vscode` version and counting `registerMcpServerDefinitionProvider` in `index.d.ts`:

```
@types/vscode@1.99.0   0
@types/vscode@1.100.0  0
@types/vscode@1.101.0  3
@types/vscode@1.102.0  3
```

The lowest VS Code version with the API is **1.101.0**.

Cursor's base is **1.128.0**. Cursor 3.19.7 (build 2026-09-02) reports VS Code Extension API 1.128.0, rebased from 1.105.1 ([cluesmith/codev#1608](https://github.com/cluesmith/codev/issues/1608), checked against a real install's About panel on 2026-09-04). Cursor is not installed here, so this number was not checked locally.

## Consequences for dependent units

- **U25 (#1148) Copilot CLI extension wake: proceed.** The idle send starts a turn, so the fallback that drops U25 does not apply. Copilot CLI's primary wake rung 1 is confirmed for 1.0.92. Required changes:
  - Write `experimental` to `settings.json` (via `copilot config` or a JSON merge), not to `config.json`, and honour `COPILOT_HOME`.
  - The consent text lists the C6 features and states that each wake spends AI credits (0.42 AIC on `gpt-5-mini` here).
  - Expect `userPromptSubmitted` before `sessionStart` on a fresh session.
- **U24 (#1140) Copilot CLI adapter:** discriminate on `COPILOT_CLI=1`. camelCase payloads have no `hook_event_name`, so the adapter maps the event from the file and argv (`--event`), not from the payload.
- **U26 (#1150) VS Code Copilot adapter:** the PascalCase branch is triggered, because Copilot CLI runs `khala-vscode.json`. U26 must **not** write `khala-vscode.json`. One shared `~/.copilot/hooks/khala.json` routes each call by `COPILOT_CLI=1` (CLI), then by payload casing (`hook_event_name` present means VS Code-style). Until criteria 2 to 4 close on the VS Code side, Agent Host sessions identify as `copilot` (the ticket's fallback).
- **U17 (#1136) companion `engines.vscode`:** a single floor works. VS Code 1.101 is below Cursor's 1.128, so `^1.101.0` satisfies both, and `^1.128.0` also costs no Cursor users. U26 does not need a runtime existence check for `registerMcpServerDefinitionProvider` on Cursor ≥ 1.128.
- **U38 (#1118), U41 (#1152), HB1:** nothing new to add for Copilot CLI. Rung 1 covers it in any terminal, because the extension wake does not depend on the terminal.
- **U37 (#1159):** delete `experiments/copilot-spike/` before U37, as the ticket says.
- **Hard blockers:** none. No R1 or R2 gap was found. Criteria 2 and 3 are untested, not failed.

## Operator steps to finish the untested criteria (2, 3 and the VS Code half of 4)

1. Install VS Code ≥ 1.101 with GitHub Copilot Chat, and sign in to Copilot.
2. Copy `experiments/copilot-spike/hooks-khala.json` and `hooks-khala-vscode.json` to `~/.copilot/hooks/`, and `hooklog.sh` to the path they reference. Back up `~/.copilot` first.
3. **Local session (C3, C4):** in a VS Code chat with the Local target, send one prompt. Check `hooks.ndjson` for camelCase `khala.json` records (C3), and for the env and payload of each record (C4: is `COPILOT_CLI` absent? which `VSCODE_*` vars are set?).
4. **Agent Host session (C2, C4):** with `experimental: true` in `~/.copilot/settings.json` and the spike extension in `~/.copilot/extensions/khala-spike/`, start a chat with the Copilot (Agent Host) target. Check for an `extension.ndjson` "joined" line (C2), then write `/tmp/claude-1000/spike-1114/trigger` to test the idle send there too. Record the hook env (C4).
5. Optionally, read `vscodeVersion` from Cursor's `product.json` to confirm the 1.128.0 base.
6. Restore `~/.copilot`.
