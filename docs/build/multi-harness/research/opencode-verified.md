# OpenCode adapter: verified research (2026-10-05)
Sources: raw.githubusercontent.com/sst/opencode `dev` branch, fetched whole with curl (not summarized).
Paths are relative to the repo root; "L" is the line in that file. Labels: VERIFIED (read in source),
INFERRED (follows from source, not run), UNVERIFIED (needs a spike).
## Q1. Hook names and signatures; can Steer modify what the model sees?
- `Plugin = (input: PluginInput, options?) => Promise<Hooks>`; PluginInput = {client, project, directory,
  worktree, serverUrl: URL, $, experimental_workspace}. packages/plugin/src/index.ts L56-66, L74.
- `PluginModule = {id?, server: Plugin}`. index.ts L76-80.
- Hooks interface (index.ts L222-335):
  - `event({event})` L224; `config(input: Config)` L225; `tool` map L226; `dispose` L223.
  - `chat.message(input{sessionID,agent?,model?,messageID?,variant?}, output{message,parts})` L234-243.
  - `tool.execute.before({tool,sessionID,callID}, {args})` L266-269.
  - `tool.execute.after({tool,sessionID,callID,args}, {title,output,metadata})` L274-281.
  - `shell.env({cwd,sessionID?,callID?}, {env})` L270. This applies to the bash tool only (prompt.ts L555).
  - `experimental.chat.messages.transform({}, {messages:[{info,parts}]})` L282-290 (no sessionID in input).
  - `experimental.chat.system.transform({sessionID?,model},{system:string[]})` L291-296.
- Steer: YES, VERIFIED. Both call sites pass a mutable object to the hook and return that same object to the model.
  - Builtin tools: `output = {...result, attachments}` is built at packages/opencode/src/session/tools.ts L113-120.
    `tool.execute.after` runs at L122-126, then `return output` (L129). Mutating `output.output` changes what the
    model sees.
  - MCP tools (the khala_* tools are MCP): the hook at tools.ts L421-424 receives the RAW MCP `result`
    (`{content:[{type:"text",text}], metadata?}`) BEFORE it is flattened (L426-440 read `result.content`).
    Steer therefore needs `output.content.push({type:"text", text: frame})` for MCP tools. Appending to
    `output.output` is a no-op there. For non-Khala builtin tools (bash, read, ...), append to `output.output`.
  - The hook fires per tool, with input.tool = registry key. Steer is "after every tool call, whichever tool it was".
## Q2. Injecting turns: prompt / promptAsync / noReply
- v1 SDK (what `PluginInput.client` is, `createOpencodeClient` from "@opencode-ai/sdk", index.ts L1-3, L57):
  - `client.session.prompt({path:{id}, body})` POST /session/{id}/message, blocks until the turn ends.
    packages/sdk/js/src/gen/sdk.gen.ts L615-625.
  - `client.session.promptAsync({path:{id}, body})` POST /session/{id}/prompt_async, returns immediately, and
    starts the session if needed. sdk.gen.ts L636-649 (doc comment L636).
  - v2 flat form: `promptAsync({sessionID, directory?, workspace?, messageID?, model?:{providerID,modelID},
    agent?, noReply?, tools?, format?, system?, variant?, parts?})`. packages/sdk/js/src/v2/gen/sdk.gen.ts L4095-4150.
  - Parts: `{type:"text", text, synthetic?:boolean, ignored?:boolean, ...}`. v2/gen/types.gen.ts L2553-2558.
    Use `synthetic:true` so the TUI treats it as machine-written (INFERRED; the TUI render is not verified).
- noReply semantics, VERIFIED: packages/opencode/src/session/prompt.ts L1052-1070. `prompt()` always calls
  `createUserMessage(input)`, then `if (input.noReply === true) return message` (L1069) and skips `loop()`.
  The message is stored with no model call. Schema field: L1504.
- Without noReply: `loop()` -> `state.ensureRunning(...)` L1346; runner is per session (session/run-state.ts L14-18, L88-94).
  This looks like "join the running loop or start one"; busy behavior is INFERRED, not a spike result.
- The loop re-reads all messages at the top of each step (prompt.ts L1081-1098), and exits only if the last assistant
  message's parentID equals the latest user message (L1105-1110). A user message stored while the loop is running
  (noReply:true, or promptAsync) is therefore picked up at the next step (INFERRED; a spike should confirm).
- session.idle: status.ts L42-44 publishes `Event.Idle {sessionID}` when status is set to idle (after the loop
  exits). Plugin `event` hook delivers it (pluginidx L255-261, packages/opencode/src/plugin/index.ts), as
  `{type:"session.idle", properties:{sessionID}}`. Also in docs plugins.mdx L187. There is also `session.status`
  `{sessionID,status:{type:"busy"|"idle"|...}}` (v2/gen/types.gen.ts L6934-6940).
- Idle wake = on `session.idle` (or a poll tick while idle): `client.session.promptAsync({path:{id}, body:{parts:[...]}})`.
  Without `noReply`, that starts a real turn in the user's existing session. The user sees it in their TUI,
  because it is the same server and DB.
## Q3. Can the plugin tell the MCP server the session id?
- MCP child env = `process.env` + static `mcp.environment` from config. packages/opencode/src/mcp/index.ts L352-356.
  The MCP server is spawned once per OpenCode instance and is NOT per session. No session id is available at spawn.
  `shell.env` does not reach MCP children (bash only). The prior note's "MCP gets no session id" is CONFIRMED.
- Per-call route, INFERRED: `tool.execute.before` receives `{tool, sessionID, callID}` and a mutable `args`
  (tools.ts L403-407; the same `args` object is then passed to `execute(args, opts)` at L412). The plugin can set
  `output.args.khala_session = sessionID` for tool names starting with the khala MCP server key. The server reads that
  param. Requires the tool schema to allow the extra param; otherwise the plugin must strip or validate it. UNVERIFIED
  (spike needed: does the MCP SDK forward unknown args? Zod strict would reject them; declare it optional in the schema).
- Mapping-file route (VERIFIED feasible): the plugin runs in-process, so `process.pid` is the opencode pid. The MCP
  child's `process.ppid` is the same pid (stdio child of that process, mcp/index.ts L346-356). The plugin writes
  `~/.local/state/khala/opencode/by-pid/<pid>.json` = {activeSessionIDs, lastSessionID, directory, serverUrl},
  updated from `chat.message` and `session.created/updated` events. The MCP server resolves its session by ppid.
  Ambiguous when several sessions share one opencode process (one TUI normally shows one active session).
## Q4. Can a plugin register the MCP server through its `config` hook?
- `config(input: Config)` is called once after plugins load, with the live config object `cfg`.
  packages/opencode/src/plugin/index.ts L152 (`cfg = yield* config.get()`), L244-253. `Config.get` returns the cached
  `s.config` (config/config.ts L620-622), so a mutation is visible to later `get()` callers. MCP reads `cfg.mcp` lazily in
  `MCP.state` (mcp/index.ts L494-496).
- UNVERIFIED: whether `MCP.state` initializes before or after plugin init. If before, the mutated `mcp.khala` is never
  started. Spike: plugin `config` hook sets `cfg.mcp = {...cfg.mcp, khala:{type:"local", command:[...], environment:{...}}}`
  and then check `opencode mcp list`. The prior note's "single install" claim stays UNVERIFIED.
- Fallback (VERIFIED schema): `khala install --harness opencode` writes both entries into `~/.config/opencode/opencode.json`:
  `mcp.khala = {type:"local", command:[...], environment:{...}, enabled:true}` (docs mcp-servers.mdx L79-91, L124; the key is
  `environment`, not `env`) plus `plugin:["khala-opencode"]`.
## Q5. npm plugins
- `opencode.json` `"plugin": ["pkg", "@scope/pkg", ["pkg", {opts}]]`. docs plugins.mdx L29-40; type
  `Array<string | [string, PluginOptions]>` at plugin/src/index.ts L70-72. Options reach the 2nd arg of the plugin function (L74).
- Install: npm plugins are installed by Bun at startup into `~/.cache/opencode/node_modules/` (plugins.mdx L46-50).
  Local files: `.opencode/plugins/` and `~/.config/opencode/plugins/` (plugins.mdx L18-25). Load order is global
  config, project config, global dir, project dir (L54-61).
- A version pin `pkg@x.y.z` is parsed by `parsePluginSpecifier` (plugin/index.ts L30, L196-198). Update behavior for
  an unpinned spec (re-resolve on each start, or cached until the cache is cleared) is UNVERIFIED. Safest: the installer
  pins the exact version, and `khala upgrade` rewrites the pin.
## Q6. Can the plugin do all delivery in-process, without hooks or spawning?
- YES, VERIFIED to be possible: `event` (session.idle), `tool.execute.after` and `client.session.promptAsync` are all
  available in-process. The plugin can read `~/.local/state/khala/opencode/<session>/inbox*` directly, render the
  `<khala-channel-messages you=...>` frame, and inject it.
- Caveat: that duplicates frame rendering and cursor/ack logic in JS (drift risk against the Go/Rust CLI).
  Prefer spawning `khala hook deliver` and using its stdout as the frame.
## Proposed adapter design (`khala-opencode` npm plugin + `khala mcp --harness opencode`)
Plugin responsibilities (thin; no inbox parsing; ~150 lines of JS):
1. Session registry: track sessionID from `chat.message`, `tool.execute.*` and `session.*` events. Write the per-pid
   mapping file (Q3) and the per-session mode (steer/sync/async), which is read from Khala's existing mode file.
2. Steer: `tool.execute.after`. Spawn `khala hook deliver --harness opencode --session <id> --event post-tool` (stdin
   JSON `{session_id, tool, cwd}`). If stdout is non-empty, append it: `output.content.push({type:"text",text})` when the
   tool is MCP-shaped (`Array.isArray(output.content)`), else `output.output += "\n\n" + text`. Skip when mode != steer.
3. Sync: on `event` `session.idle` for a session in sync mode, spawn `khala hook deliver ... --event turn-end`. If it
   prints a frame, call `client.session.promptAsync({path:{id}, body:{parts:[{type:"text",text,synthetic:true}]}})`.
   This starts one new turn that carries the frame. It is one turn late, but it is the first point where OpenCode exposes
   "turn end". Optionally use `noReply:true` while a step is still running so the next loop step picks it up (spike).
4. Idle wake: the same `session.idle` handler plus a 2 s timer (`setInterval`, cleared in `dispose`) for sessions that
   have been idle with an unread inbox. The timer only delivers when `session.status` is idle for that session. The inbox
   mtime/cursor check is delegated to `khala hook deliver --event idle`. Wake uses promptAsync WITHOUT noReply (a real turn).
   Race guard: skip if `session.status` is busy; only one in-flight promptAsync per session.
5. Async: do nothing (no hook spawn).
6. MCP session binding: `tool.execute.before` stamps the session id into khala_* tool args (INFERRED route), with the
   ppid mapping file as fallback.
7. `config` hook: try to register `mcp.khala` (if the spike passes); otherwise the installer writes it.
Plugin to CLI contract: spawn `khala hook deliver --harness opencode --event <post-tool|turn-end|idle>` with stdin JSON,
stdout = rendered frame or empty. Reasons: reuses the existing frame renderer, cursor and ack code, and the mode logic.
Reading the inbox directly is a fallback only.
Open spikes before building (each is under an hour): (a) `config` hook registers MCP before MCP.state init; (b) extra args
survive the MCP call; (c) `session.idle` -> `promptAsync` on a session with a TUI attached renders in that TUI;
(d) promptAsync while busy queues (and noReply:true mid-loop is consumed at the next step); (e) unpinned plugin update behavior.
