# Spike MH-U20: OpenCode open questions

- Ticket: aiur-team/khala#1113 (plan unit U20, plan commit `6e573947`).
- Run: 2026-10-05 by the Executor (Claude Code), on Linux (Arch, kernel 7.1.4).
- **OpenCode version: `1.15.6`** (`opencode --version`; `@opencode-ai/plugin` and `@opencode-ai/sdk` 1.15.6).
- Model: `deepseek/deepseek-flash` (DeepSeek V4.1 Flash), 6 user prompts and 4 plugin-injected messages in total.
- Scratch plugin: [`experiments/opencode-spike/`](../../../../experiments/opencode-spike/) (`index.js` plugin, `mcp-server.mjs` dependency-free stdio MCP server). Delete it before U37.

## Results

| # | Criterion | Result | One-line evidence |
|---|-----------|--------|-------------------|
| a | Plugin `config` hook setting `cfg.mcp.khala` makes `opencode mcp list` show `khala` connected | **PASS** | `✓ khala connected`, with no `mcp` key in `opencode.json` |
| b | `khala_session` stamped in `tool.execute.before` reaches the MCP server when the schema declares it optional | **PASS** | the server logged `arguments: {note: "hi", khala_session: "ses_ef07…"}` |
| c | `session.idle` then `client.session.promptAsync` without `noReply` starts a turn that renders in the TUI | **PASS** | the wake prompt and the `WAKE-ACK` reply rendered in the idle TUI |
| d | (1) `promptAsync` while busy queues and runs after the turn; (2) `noReply: true` mid-loop is consumed at the next step | **FAIL** (d1 FAIL, d2 PASS) | d1: the message joined the running loop at its next step, and the user's own final instruction was dropped. d2: the model's next step said "PELICAN" |
| e | Record whether an unpinned npm plugin re-resolves on restart | **PASS** (recorded: it does **not** re-resolve) | the cache stayed on a stale 0.10.0 although 0.11.0 is `latest` |
| f | `chat.message` fires for the plugin's own `promptAsync` text; how a `synthetic: true` part renders | **PASS** | `chat.message` fired for all 4 injected messages. Synthetic parts are **hidden** in the TUI but **sent to the model** |
| g | Plugin spec `file:<packed tarball>` loads | **PASS** | `plugin: ["file:/…/khala-opencode-spike-0.0.1.tgz"]` loaded, and a re-packed tarball at the same path was re-extracted on restart |

No result opens a KD5/KTD18 hard blocker. d1 failed, but OpenCode's wake rung (c) still works: the plugin waits for `session.idle`, which the plan already specifies.

## Setup (isolation)

- Isolated config, data, cache and state: `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` and `XDG_STATE_HOME` all pointed under `/tmp/claude-1000/s1113/`. The operator's `~/.local/share/opencode/auth.json` (DeepSeek API key) was **copied** into the isolated data dir. No real config file was written.
- Isolated `opencode.json`: the operator's `deepseek` provider block, `permission.bash: allow`, and `plugin: ["file:/tmp/claude-1000/s1113/pack/khala-opencode-spike-0.0.1.tgz"]`. It has **no `mcp` key**.
- The TUI ran in a private detached tmux server: `tmux -L spike-1113 new-session -d -x 200 -y 50 … opencode --model deepseek/deepseek-flash`. It was driven with `send-keys` and read with `capture-pane`, and the server was killed afterwards.
- Packing: `experiments/` is not in `pnpm-workspace.yaml`, so `pnpm --filter` cannot select the scratch package. It was packed with `pnpm --dir experiments/opencode-spike pack --pack-destination /tmp/claude-1000/s1113/pack`, which gives `khala-opencode-spike-0.0.1.tgz` (`package/index.js`, `package/mcp-server.mjs`, `package/package.json`). `khala-opencode` (U22) does not exist yet.
- Control: the plugin logs every hook to `$SPIKE_LOG` (JSONL). Its one-shot experiments are triggered by files in `$SPIKE_DIR`: `inject` = `noreply|async` injects on the next `bash` `tool.execute.before`, and `wake` = `1|synth-only` wakes on the next `session.idle`.

## Evidence

### a. `config` hook registers the MCP server: PASS

The plugin's `config` hook:

```js
config: async (cfg) => {
  cfg.mcp = { ...(cfg.mcp ?? {}), khala: { type: "local", command: ["node", join(here, "mcp-server.mjs")],
    environment: { SPIKE_LOG: process.env.SPIKE_LOG ?? "" }, enabled: true } };
}
```

```
$ env -C /tmp/claude-1000/s1113/proj opencode mcp list
┌  MCP Servers
●  ✓ khala connected
│      node /tmp/claude-1000/s1113/cache/opencode/packages/file:/tmp/claude-1000/s1113/pack/khala-opencode-spike-0.0.1.tgz/node_modules/khala-opencode-spike/mcp-server.mjs
└  1 server(s)
```

Plugin log, in order: `plugin.init`, then `hook.config {mcpKeys:["khala"]}`, then `mcp.start {ppid: <opencode pid>}`. `MCP.state` initializes after the plugin's `config` hook. The TUI status bar showed `⊙ 1 MCP`, and the model could call `khala_probe` in the TUI session (see b).

### b. Stamped `khala_session` reaches the MCP server: PASS

The MCP `probe` tool declares `khala_session` as an optional string property. The plugin sets `output.args.khala_session = input.sessionID` for tools whose name starts with `khala_`. Prompt: `Call the khala_probe tool with note "hi". …`

```
plugin  hook.tool.before   tool=khala_probe sessionID=ses_ef07cb7c8ffeghyCANnRQojZ4G args={"note":"hi"}
plugin  stamp.khala_session
mcp     mcp.tools.call     name=probe arguments={"note":"hi","khala_session":"ses_ef07cb7c8ffeghyCANnRQojZ4G"}
```

Side effect: the TUI shows the stamped arg in the tool header, `⚙ khala_probe [note=hi, khala_session=ses_ef07cb7c8ffeghyCANnRQojZ4G]`. The session id is visible to the user. It is not secret, but it is noise.

### c. Idle wake via `promptAsync` renders in the TUI: PASS

The wake file was set, and the prompt was `Reply with exactly TURN3-OK.`. On the `session.idle` that followed, the plugin called `client.session.promptAsync({path:{id}, body:{parts:[visible text, synthetic text]}})` without `noReply`.

```
04:41:04.386 event session.idle
04:41:04.392 hook.chat.message parts=[{text:"WAKE-VISIBLE-4410: reply with exactly WAKE-ACK …"},{text:"WAKE-SYNTH-4410 (synthetic part)",synthetic:true}]
04:41:04.397 wake.promptAsync status=204
04:41:06.843 event session.idle      <- the woken turn finished
```

TUI (`capture-pane`), with the TUI idle and its prompt empty when the wake fired:

```
  ┃  Reply with exactly TURN3-OK.
     TURN3-OK
     ▣  Build · DeepSeek V4.1 Flash · 1.1s
  ┃  WAKE-VISIBLE-4410: reply with exactly WAKE-ACK and nothing else.
     WAKE-ACK
     ▣  Build · DeepSeek V4.1 Flash · 2.4s
```

The turn started and rendered with no keystrokes and no focus change. This is KD1-clean.

### d. Busy behavior: FAIL (d1), PASS (d2)

**d2, `noReply: true` mid-loop: PASS.** Prompt: `Call the khala_probe tool … Then run the bash command: sleep 6; echo slept. Then reply with one short line.`. In the `bash` `tool.execute.before`, while the session was busy, the plugin sent `promptAsync({noReply:true, parts:[{text:"NOREPLY-7731: in your next reply, include the codeword PELICAN."}]})`, which returned 204. The loop picked it up at its next step:

```
  ┃  $ sleep 6; echo slept
  ┃  slept
  ┃  NOREPLY-7731: in your next reply, include the codeword PELICAN.
     Probe okay, slept 6s — PELICAN.
```

There was a single `session.idle` and no extra turn.

**d1, `promptAsync` without `noReply` while busy: FAIL as worded.** Prompt: `Run the bash command: sleep 6; echo slept2. Then reply with exactly TURN2-DONE.`. During the bash tool, the plugin sent `promptAsync({parts:[{text:"QUEUED-5512: reply with exactly QUEUED-ACK and nothing else."}]})`, which returned 204.

```
04:40:42.601 hook.chat.message  QUEUED-5512 …        (stored immediately, mid-turn)
04:40:48.618 hook.tool.after bash
04:40:50.521 session.idle                             (ONE idle; no second turn)
TUI:
  ┃  slept2
  ┃  QUEUED-5512: reply with exactly QUEUED-ACK and nothing else.
     QUEUED-ACK
```

The message did not queue behind the turn. It was appended to the running loop and answered at the next step, just like `noReply`. The user's own final instruction (`TURN2-DONE`) was never followed. Nothing was lost from the injection itself, but it hijacks the end of the user's turn. `session.idle` fired only once, so a plugin that waits for a second idle would wait for nothing.

### e. Unpinned npm plugin on restart: does NOT re-resolve

Separate isolated config with `plugin: ["opencode-goal-plugin"]`. That is a real npm package: `latest` is 0.11.0, and 0.10.0 also exists.

1. First start (`opencode mcp list`): OpenCode installed it into `$XDG_CACHE_HOME/opencode/packages/opencode-goal-plugin@latest/`, with `package.json` = `{"dependencies":{"opencode-goal-plugin":"0.11.0"}}` (an exact version). The log shows `loading plugin` 886 ms after start, which is the network install.
2. A stale cache was simulated by installing 0.10.0 into that directory: `npm --prefix <dir> install opencode-goal-plugin@0.10.0`.
3. Restart: the cache was unchanged (still 0.10.0), and OpenCode loaded the stale copy. The proof is in the compat warning, which quotes 0.10.0's `engines.opencode` (`>=1.17.15 <2`), not 0.11.0's (`>=1.17.15`):

```
first start: WARN service=plugin path=opencode-goal-plugin error=Plugin requires opencode >=1.17.15 but running 1.15.6 plugin incompatible
restart:     WARN service=plugin path=opencode-goal-plugin error=Plugin requires opencode >=1.17.15 <2 but running 1.15.6 plugin incompatible   (+5ms, no network)
```

The operator's real machine agrees: `~/.cache/opencode/packages/opencode-goal-plugin/` still holds 0.7.0 (installed 2026-08-03), and OpenCode has been used since with that unpinned spec, although 0.8.0 to 0.11.0 have been published. An unpinned spec resolves once per cache key and then stays put until the cache is cleared.

Extra finding: OpenCode 1.15.6 enforces a plugin's `package.json` `engines.opencode` range and refuses to load an incompatible plugin, with a log WARN only. `khala-opencode` must declare a range that covers the OpenCode versions it supports, or omit the field.

### f. `chat.message` for the plugin's own text; synthetic rendering: PASS

- `chat.message` fired for every plugin-injected message: the `noReply` one (d2), the busy `promptAsync` (d1), the mixed wake (c) and the all-synthetic wake (below). For example: `hook.chat.message parts=[{"text":"WAKE-SYNTHONLY-9902: …","synthetic":true}]`. Injected messages have no `messageID` in the hook input; typed ones do. The `synthetic` flag is visible in `output.parts`, so U22 can verify the nonce in `chat.message`.
- **Rendering:** a `synthetic: true` text part is **not shown** in the TUI. In c, only `WAKE-VISIBLE-4410` appeared, and `WAKE-SYNTH-4410` is absent from the screen. It is still stored (`opencode export` shows `{text:"WAKE-SYNTH-4410 (synthetic part)", synthetic:true}`) and still **sent to the model**. An all-synthetic wake (`wake=synth-only`, a single part `{text:"WAKE-SYNTHONLY-9902: reply with exactly SYNTHONLY-ACK …", synthetic:true}`) started a turn. The model obeyed it, and the TUI showed **no user bubble at all**, only the reply:

```
     TURN4-OK
     ▣  Build · DeepSeek V4.1 Flash · 1.4s
     SYNTHONLY-ACK
     ▣  Build · DeepSeek V4.1 Flash · 1.1s
```

This replaces `opencode-verified.md` Q2's "INFERRED" note: synthetic parts are model-visible and user-invisible.

### g. `file:` tarball plugin spec: PASS

`plugin: ["file:/tmp/claude-1000/s1113/pack/khala-opencode-spike-0.0.1.tgz"]` loaded in every run above. It is installed to `$XDG_CACHE_HOME/opencode/packages/file:<abs path>/node_modules/<pkg name>/`. A re-packed tarball at the same path, with the same version and the log tag changed to `plugin.init.v2`, was re-extracted on the next start (`"type":"plugin.init.v2"` was logged). Unlike the npm cache in e, a `file:` spec is refreshed on restart, so U36 can iterate without bumping versions.

## Consequences for dependent units

- **U21 #1139 (adapter and installer):**
  - a PASS: the installer does not need to write `mcp.khala`, because the plugin registers it in its `config` hook. The installer writes only the `plugin` entry.
  - b PASS: add the optional `khala_session` arg to `packages/agent/src/mcp/tools.ts`, with `meta` as the first session source.
  - e: pin `khala-opencode@<exact version>` as planned. An unpinned spec would never update, and `khala upgrade` must rewrite the pin.
  - g PASS: `KHALA_OPENCODE_PLUGIN_SPEC=file:/…/khala-opencode-<v>.tgz` works as planned.
- **U22 #1147 (plugin):**
  - c PASS: keep native idle wake on rung 1. OpenCode stays `default` in the wake ladder, and U20(c) does not move it to the terminal rung.
  - d1 FAIL: take the "On failure" branch. **Skip while busy and wait for `session.idle`.** Never `promptAsync` without `noReply` while the session is busy: it hijacks the user's turn and produces no extra idle. The plan's "busy sessions are skipped" rule is required, not just a race guard.
  - d2 PASS: a `noReply: true` message is consumed at the next loop step. This is optional for Sync delivery mid-turn, but it shows the injected text to the user as a user bubble. Prefer Steer (`tool.execute.after`) for mid-turn delivery.
  - f PASS: verify the nonce in `chat.message`.
  - **Synthetic rendering, a design note for U22:** the plan's `parts: [{type:'text', text, synthetic:true}]` delivers the frame or wake to the model with **no visible user message** in the TUI. The user sees only the agent's reply. If the plan wants the user to see that a Khala message arrived, send a short visible (non-synthetic) part such as the U11 wake line, with the frame as a synthetic part. Otherwise the plan as written works.
  - b side effect: the stamped `khala_session` shows in the TUI tool header. This is cosmetic. Keep it, or shorten what the tool renders if that is a concern.
  - Declare or omit `engines.opencode` (see e).
- **U38 #1118, U41 #1152:** not affected. c passed, so OpenCode needs no terminal or editor-terminal rung, and HB1 gets no OpenCode cells from this spike.
- **U36 #1158:** g confirms that the `file:` tarball path works for the live matrix before publication, and that it re-extracts on restart.
- **U37 #1159:** delete `experiments/opencode-spike/` before release.

## Commands (reproduce)

```
pnpm --dir experiments/opencode-spike pack --pack-destination $S/pack
export XDG_CONFIG_HOME=$S/cfg XDG_DATA_HOME=$S/data XDG_CACHE_HOME=$S/cache XDG_STATE_HOME=$S/state SPIKE_DIR=$S SPIKE_LOG=$S/spike.jsonl
env -C $S/proj opencode mcp list                                       # a, g
tmux -L spike-1113 new-session -d -s oc -x 200 -y 50 -c $S/proj "… opencode --model deepseek/deepseek-flash"
echo noreply > $S/inject; tmux -L spike-1113 send-keys -t oc -l '<prompt>'; tmux -L spike-1113 send-keys -t oc Enter   # b, d2
echo async   > $S/inject; …                                            # d1
touch $S/wake; …                                                       # c, f
echo synth-only > $S/wake; …                                           # f (all-synthetic)
tmux -L spike-1113 capture-pane -t oc -p -S -200
opencode export <sessionID>                                            # f (stored parts)
tmux -L spike-1113 kill-server
```
