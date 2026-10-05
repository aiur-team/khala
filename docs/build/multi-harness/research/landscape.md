# Multi-harness landscape for Khala (2026-10-04)

Scope: which agent harnesses should Khala (MCP stdio server plus optional per-harness wake/inject hooks) support. Research date 2026-10-04.
Stars and downloads were pulled live via `gh api repos/...` and `api.npmjs.org/downloads/point/last-week/...`. "UNVERIFIED" means a secondary source only, or memory only.

## 1. What "Muse" means

**Verdict: almost certainly Meta's Muse Code, a terminal coding agent whose binary is `muse`.** Confidence is high but not certain, so confirm with the operator in one line.

| Rank | Candidate | Likelihood | Evidence |
|---|---|---|---|
| 1 | **Meta Muse Code** (CLI `muse`, backed by the Muse Spark 1.2/1.3 models) | ~85% | Released in beta 2026-08-05 and GA 2026-09-01; native Windows build 2026-09-16. "Meta debuts first AI coding agent to take on Anthropic and OpenAI" ([CNBC](https://www.cnbc.com/2026/08/05/meta-debuts-muse-code-to-take-on-anthropic-and-openai-.html)); [Meta blog](https://research.meta.ai/blog/introducing-muse-code-and-muse-spark-1-2); [docs](https://dev.meta.ai/docs/muse-code/extending). It has MCP, hooks and session messaging, the same integration surface as Claude Code and Codex. |
| 2 | Meta **Muse Spark** model family (1.1 Jul, 1.2 Aug, 1.3 Sep; Muse Glimmer open weights 2026-08-10) | ~7% | [Wikipedia](https://en.wikipedia.org/wiki/Muse_Spark), [TechCrunch](https://techcrunch.com/2026/04/08/meta-debuts-the-muse-spark-model-in-a-ground-up-overhaul-of-its-ai/). This is a model, not a harness. Khala is model-agnostic, so this reading needs no work beyond Muse Code. |
| 3 | Meta AI "Muse" consumer agent app | ~3% | [Wikipedia: Muse (AI agent)](https://en.wikipedia.org/wiki/Muse_(AI_agent)), [guide](https://codersera.com/blog/meta-muse-ai-agent-app-guide-2026/). Consumer product; no developer-harness surface found. |
| 4 | muse.ai personal agent (unofficial `muse-cli`) | ~2% | [nikships/muse-cli](https://github.com/nikships/muse-cli), [MuseAI-Skills](https://github.com/win4r/MuseAI-Skills). Personal assistant, not a coding harness. |
| 5 | Sound-alikes: Coder `mux` (now `coder/xum`, 2.0k stars), Mistral Vibe | ~2% | Weak phonetic match only. |
| 6 | Microsoft Muse (WHAM gameplay world model, Feb 2025) | <1% | [Xbox Wire](https://news.xbox.com/en-us/2025/02/19/muse-ai-xbox-empowering-creators-and-players/). Generates game visuals and actions; it is not an agent. |
| 7 | Sudowrite Muse (fiction LLM) | <1% | [Sudowrite](https://sudowrite.com/blog/what-is-sudowrite-muse-a-deep-dive-into-sudowrites-custom-ai-model/). Not relevant. |

Muse Code's integration surface:
- **MCP:** declared in `~/.config/muse/settings.json` under `mcp_servers`, with stdio and streamable_http transports. The file must contain `"schema_version": 1` or startup fails ([config docs](https://dev.meta.ai/docs/muse-code/configuration)).
- **Project instructions:** `AGENTS.md`, with `CLAUDE.md` read as a fallback. Skills live under `.agents/skills/`. Plugin bundles exist.
- **Hooks:** project hooks in `.muse/hooks.json`, plus user and managed levels. Events: SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse(+Failure), Pre/PostLLMCall, Pre/PostCompact, SubagentStart/Stop, Notification, Stop, SessionEnd ([extending](https://dev.meta.ai/docs/muse-code/extending)).
  - A WebFetch summary said hooks "enforce a check, format code, or block an action". It found no `additionalContext` equivalent, and SessionEnd "cannot ... inject context".
  - **Whether any hook can inject context is UNVERIFIED.** The hooks reference page sits behind SSO.
- **Headless:** `muse exec` takes `--session-id` to resume. There is a TypeScript SDK (developer preview), which "talks to a local muse host over the Muse Session Protocol (MSP)" ([aq.dev](https://aq.dev/agents/muse-code/)).
- **Wake:** "Session messaging" sends up to 8 KB between live sessions, with steer, queue-next-turn and notify-only modes. Idle sessions wake by default.
  - It is limited to "interactive sessions for the same user account on the same macOS or Linux machine" and is "currently unavailable on Windows" ([docs](https://dev.meta.ai/docs/muse-code/session-messaging)).
  - No external-process API is documented. MSP via the SDK is the likely wake path (UNVERIFIED).
- **Not in the ACP agent registry.**

## 2. Popularity (live, 2026-10-04)

| Harness | GitHub stars | npm weekly downloads | Status notes |
|---|---|---|---|
| OpenAI Codex CLI | 127.9k | 25.5M (`@openai/codex`) | Leader by downloads |
| Claude Code | 149.4k | 14.8M | Khala's current home |
| OpenCode (anomalyco) | 211.8k | 3.2M (`opencode-ai`) | Largest open-source coding TUI |
| GitHub Copilot CLI | 11.2k | 1.7M (`@github/copilot`) | Plus VS Code agent mode (vscode 193k stars) |
| Gemini CLI | 107.2k | 459k | |
| Cursor (IDE + `agent` CLI) | 33.3k (issues repo) | n/a | Acquired Continue (Jun 2026) |
| Qwen Code | 28.3k | 101k | Gemini CLI fork |
| Cline | 69.9k | 98k (CLI) | VS Code extension plus CLI |
| Zed | 91.3k | n/a | ACP host editor |
| Warp | 65.4k (open source since 2026-04) | n/a | Agent CLI `warp` (formerly `oz`) |
| Goose | 54.9k (`aaif-goose/goose`) | n/a | Donated to the Linux Foundation AAIF, Dec 2025 |
| Aider | 49.4k | n/a | Last push 2026-05; stagnant |
| Kilo Code | 27.5k | 42k (`@kilocode/cli`) | CLI is OpenCode-based (UNVERIFIED) |
| Augment (Auggie) | 0.3k | 36k | |
| Amp | closed | 27k (`@sourcegraph/amp`) | Spun out of Sourcegraph |
| Kimi Code CLI | 7.8k (`kimi-code`) | 40k | The old `kimi-cli` (11.4k stars) is **archived** |
| Crush (Charm) | 28.5k | 7.6k | Mostly installed via brew/go |
| Factory Droid, Kiro, Junie, Muse Code | closed (issues repos 0.05k / 4.3k / 0.5k / n/a) | n/a | Junie GA June 2026 |
| **Dead or renamed** | | | Continue (EOL after the Cursor acqui-hire, final release 2026-06-19 ([rulesync#3078](https://github.com/dyoshikawa/rulesync/issues/3078))). Roo Code (archived 2026-05-15 ([repo](https://github.com/RooCodeInc/Roo-Code))). Windsurf (renamed **Devin Desktop** on 2026-06-02; Cascade was replaced by Devin Local on 2026-07-01 ([creeta](https://news.creeta.com/en/windsurf-renamed-devin-desktop-2026/))). |
| Other prominent harnesses | OpenClaw 391k; Hermes Agent (Nous) 251k; Pi 112k; OpenHands 90k | | All appear in the ACP registry. Pi has an RPC mode; OpenClaw and Hermes are personal-agent and gateway style. |

## 3. Per-harness capabilities

Abbreviations:
- **AC** = `additionalContext`-style injection.
- **Stop-block** = a Stop hook can force another turn using its own text as the prompt. This is wake-at-turn-end, not idle wake.
- **Idle wake** = an external process can start a turn in an idle session.

| Harness | MCP config | Inject at boundary | Idle wake from outside | Session id | Install / packaging | Windows |
|---|---|---|---|---|---|---|
| **Claude Code** (baseline) | `.mcp.json`, `~/.claude.json`, plugins | Hooks with AC; Stop-block | Yes: MCP channel notifications (`claude/channel`, research preview) | `session_id` in hook stdin | Plugin marketplace (Khala ships today) | Yes |
| **Codex CLI** | `~/.codex/config.toml` `[mcp_servers]` | Hooks: AC on SessionStart, SubagentStart, Pre/PostToolUse, UserPromptSubmit. Stop `decision:"block"` "tells Codex to continue" ([hooks](https://learn.chatgpt.com/docs/hooks)) | Partial: the `codex app-server` JSON-RPC method `turn/start` works for a client that owns the thread ([app-server](https://learn.chatgpt.com/docs/app-server)). Attaching to a running TUI is UNVERIFIED. | `session_id` and `turn_id` in hook stdin | npm/brew; plugins bundle `hooks/hooks.json` | Yes (`commandWindows`) |
| **Copilot CLI** | `~/.copilot/mcp-config.json` | Hooks: AC on sessionStart, postToolUse, notification. `agentStop` "'block' forces another agent turn using `reason` as the prompt" ([ref](https://docs.github.com/en/copilot/reference/hooks-reference)) | Partial: `copilot --acp`; Copilot SDK server mode (UNVERIFIED) | `sessionId` in hook input | npm `@github/copilot`, `/plugin` marketplace | Yes (`powershell` field) |
| **VS Code agent mode** | `.vscode/mcp.json` | Hooks (Preview), same format as Claude Code (`chat.useClaudeHooks`); Stop-block ([docs](https://code.visualstudio.com/docs/agent-customization/hooks)) | No external wake documented | Hook input | VS Code extension or agent plugins | Yes |
| **Cursor IDE / CLI** | `~/.cursor/mcp.json`, `.cursor/mcp.json` | `hooks.json`; the stop hook's `followup_message` "submits it as the next user message" (loop limit 5) ([docs](https://cursor.com/docs/hooks)) | Partial: hidden `cursor-agent acp`; `agent persist` sessions (Aug 2026) | `--resume <chatId>` | Installer script; IDE | Yes |
| **Gemini CLI** | `settings.json` `mcpServers` | Hooks: AfterTool, SessionStart and BeforeAgent take `hookSpecificOutput.additionalContext`; AfterAgent can retry ([ref](https://geminicli.com/docs/hooks/reference/)) | Partial: ACP mode | Hook input | npm; extensions gallery | Yes |
| **Qwen Code** | `settings.json` `mcpServers` | Hooks: PostToolUse AC; Stop decides whether to continue ([docs](https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/)) | Partial: ACP | Hook input | npm | Yes |
| **OpenCode** | `opencode.json` `mcp` | JS/TS plugins (`tool.execute.before/after`, session events) | **Yes**: `opencode serve` exposes `POST /session/:id/prompt_async` ("send a message asynchronously") and `GET /event` SSE ([server](https://opencode.ai/docs/server/)) | `sessionID` | npm, brew; plugins via npm | Yes |
| **Kilo Code** | VS Code-style JSON | Inherits OpenCode plugins in the CLI (UNVERIFIED) | Likely the same as OpenCode (UNVERIFIED) | | VS Code Marketplace; npm `@kilocode/cli` | Yes |
| **Cline** | `cline_mcp_settings.json` | Hooks in `.clinerules/hooks/`: TaskStart, UserPromptSubmit, Pre/PostToolUse, TaskComplete; `contextModification` "injects text into the conversation". Run-start injection is inert in the CLI ([docs](https://docs.cline.bot/features/hooks/real-world-examples)) | Partial: CLI ACP | Task id | VS Code Marketplace, npm `cline` | Yes |
| **Factory Droid** | `~/.factory/mcp.json` | Claude-compatible hooks. Bug: PostToolUse AC is dropped after MCP tool calls ([ref](https://docs.factory.ai/reference/hooks-reference)) | Partial: ACP; `droid exec -s <id>` resumes | `session_id` | Installer script | Yes |
| **Kiro (IDE + CLI)** | `.kiro/settings/mcp.json` | CLI hooks: agentSpawn, userPromptSubmit, pre/postToolUse, stop; command stdout becomes context ([docs](https://kiro.dev/docs/cli/v3/hooks/)) | Partial: Kiro CLI on ACP | UNVERIFIED | Installer; IDE | Yes |
| **Augment (Auggie)** | `~/.augment/settings.json` | Hooks: PreToolUse, PostToolUse, SessionStart/End, Stop(`block`). Unclear whether PostToolUse can inject ([docs](https://docs.augmentcode.com/cli/hooks)) | Partial: ACP | Hook payload | npm; plugin marketplaces | Yes |
| **Goose** | `~/.config/goose/config.yaml` `extensions` (every tool is MCP) | Hooks and plugins documented; schema UNVERIFIED | Partial: ACP; goosed API (UNVERIFIED) | Session name | Installer, desktop app | Yes |
| **Junie** | config.json, beta MCP | No hooks as of May 2026 ([ai-guardian#637](https://github.com/RedHatProductSecurity/ai-guardian/issues/637)); later reports conflict, so UNVERIFIED | Partial: `junie --acp true` ([docs](https://junie.jetbrains.com/docs/junie-cli-acp.html)) | | JetBrains IDE plugin, CLI | Yes |
| **Kimi Code CLI** | `/mcp-config`, `~/.kimi-code/` | "Lifecycle hooks ... block a risky tool call, log ... notify"; injection UNVERIFIED ([guide](https://dev.to/arshtechpro/kimi-code-cli-a-beginner-friendly-guide-to-moonshot-ais-terminal-coding-agent-39db)) | Partial: ACP | | npm, `install.ps1` | Yes |
| **Amp** | `~/.config/amp/settings.json` `amp.mcpServers` | Plugin API with "lifecycle event handlers"; AC semantics UNVERIFIED | `amp -x`; SDK; threads | Thread id | npm `@sourcegraph/amp` | Yes |
| **Crush** | `crush.json` `mcp` | Hooks: PreToolUse (block/allow) only; no inject found ([docs](https://github.com/charmbracelet/crush/blob/main/docs/hooks/README.md)) | No | | brew, go, npm | Yes |
| **Zed agent** | `settings.json` `context_servers` | None: "no hooks or events to observe tool use" ([zed#52688](https://github.com/zed-industries/zed/issues/52688)) | Zed is an ACP **client**; it does not take external input | Thread | Editor, extensions | Yes |
| **Warp** | Warp settings; `warp` CLI MCP | None found | Agent CLI dispatches local and cloud runs (UNVERIFIED) | Run id | App, CLI | Yes |
| **Devin Desktop** (formerly Windsurf) | `~/.codeium/windsurf/mcp_config.json` (path after the rename UNVERIFIED) | Former Cascade hooks: pre_* can block (exit 2); post_cascade_response is async and observe-only ([docs](https://docs.windsurf.com/windsurf/cascade/hooks)) | Devin Local has ACP (UNVERIFIED) | | IDE | Yes |
| **Muse Code** | `~/.config/muse/settings.json` `mcp_servers` | Hooks exist; inject UNVERIFIED (see §1) | Session messaging between sessions only; MSP SDK (UNVERIFIED) | `--session-id` | `curl dev.meta.ai/install.sh`, `irm .../install.ps1` | Yes (since 2026-09-16; session messaging is not on Windows) |
| Aider / Continue / Roo | Aider has no native MCP | None | None | | | Deprioritized: stagnant, EOL or archived |

## 4. Standards

- **MCP 2026-07-28 replaced 2025-11-25.** Legacy versions get a 12-month deprecation window ([stacktree](https://stacktr.ee/blog/mcp-2026-spec-changes), [MCP blog](https://blog.modelcontextprotocol.io/)).
  - **Sampling, Roots and Logging are deprecated** (SEP-2577). Do not build wake on sampling.
  - Sessions are removed; the core is now stateless.
  - Elicitation survives, restructured as Multi Round-Trip Requests.
  - `listChanged` and `resources/updated` notifications and `resources/subscribe` remain.
  - Tasks became an extension with `tasks/get` polling. MCP Apps is the first official extension (Final 2026-01-26).
  - 2025-11-25 itself added Tasks (experimental), URL-mode elicitation, sampling-with-tools and CIMD auth.
  - **Implication:** no MCP-standard way lets a server make a host start a turn. `resources/updated` reaches the client, but hosts do not turn it into a model turn. Claude Code's channel capability is a vendor extension. Khala's MCP server should stay tool-centric (`khala_read`/`khala_send`/`khala_event`) and treat push as per-harness.
- **AGENTS.md** (24.8k stars, stewarded by the Linux Foundation AAIF) is read by Codex, Copilot, Cursor, Devin/Windsurf, Kilo, Muse Code (CLAUDE.md as fallback), Gemini and Qwen (configurable). It is the cheapest cross-harness way to tell agents how to use Khala.
- **ACP** (Agent Client Protocol, from Zed, 4.4k stars; `@agentclientprotocol/sdk` 8.3M weekly downloads) has 40 agents in its registry: Codex, Claude Agent, Gemini, Copilot, Cursor, OpenCode, Goose, Junie, Kiro CLI, Droid, Cline, Kimi, Qwen, Augment, OpenHands, Pi, Hermes, OpenClaw, Mistral Vibe and more ([agents](https://agentclientprotocol.com/get-started/agents)). Muse, Amp, Crush, Warp and Aider are absent.
  - Turns are **client-initiated only**: "The turn begins when the Client sends a `session/prompt`" ([prompt-turn](https://agentclientprotocol.com/protocol/prompt-turn)).
  - `session/resume` is now stable. The v2 RFD (revised 2026-10-01) keeps "steering and queueing" as separate open concerns.
  - **Could ACP be a universal deliver-and-wake path? Yes, but only when Khala is the client**, meaning a "Khala-hosted agent" mode where Khala spawns `codex-acp`, `gemini --acp`, `copilot --acp` and similar, then sends `session/prompt` when a channel message arrives. That is a real universal wake for headless or background agents.
  - **It cannot wake a session the human already has open** in Zed, JetBrains or a TUI, because that editor owns the single client connection. Multi-client attach is not in the spec.
  - Conclusion: use ACP for Khala-managed agents, and hooks/channels for agents a human attaches to.
- **A2A** v1.0 (early 2026; 1.0.1 May 2026; Linux Foundation; 150+ organizations, 26k stars) covers agent-to-agent tasks between services ([Google blog](https://opensource.googleblog.com/2026/04/a-year-of-open-collaboration-celebrating-the-anniversary-of-a2a.html)). No coding harness exposes an A2A endpoint for its live session, so it is not a delivery path. At most, Khala could expose an A2A agent card later for cloud agents.

## 5. Prioritized top-8 recommendation

Claude Code is already supported. It remains the reference implementation and is excluded from the list below.

1. **Codex CLI.** It has the biggest install base (25.5M weekly downloads) and Claude-like hooks: Stop-block and PostToolUse AC, with `session_id` in stdin. app-server `turn/start` covers Khala-managed sessions.
2. **GitHub Copilot CLI plus VS Code agent mode.** One hook format (Claude-compatible) covers the CLI, VS Code and the cloud agent. `agentStop` block gives wake at turn end, and there is a plugin marketplace.
3. **OpenCode, with Kilo riding along.** Largest open-source community, and the only harness with a documented HTTP `prompt_async` for true idle wake. The JS plugin covers inject.
4. **Cursor (IDE plus CLI).** Large paid user base. The `stop` `followup_message` gives wake at turn end; `hooks.json` and `mcp.json` are simple.
5. **Gemini CLI, with Qwen Code nearly free since it is a fork.** AfterTool and BeforeAgent AC and the AfterAgent retry; ACP for managed mode.
6. **Muse Code.** The operator asked for it, it is new and has Meta's distribution behind it, and its config surface mirrors Claude Code. Its inject and wake paths need hands-on verification (§1).
7. **ACP generic adapter (Khala as ACP client).** One adapter wakes about 40 agents in managed mode (Goose, Junie, Kiro, Droid, Kimi, Augment, Cline, Hermes, Pi), and it backstops harnesses without hooks.
8. **Cline.** 70k stars and VS Code reach. `contextModification` on PostToolUse works in the extension; the CLI start hook is inert.

Next tier: Factory Droid and Augment (Claude-compatible hooks, cheap ports), then Kiro. Zed, Crush, Warp and Junie get MCP-only support (tools and AGENTS.md, no wake).
Skip Aider, Continue and Roo.

## 6. Capability matrix

Legend: Y = documented; P = partial or conditional; N = none found; ? = unverified.

| Harness | MCP client | Inject at tool or turn boundary | Wake idle session from outside |
|---|---|---|---|
| Claude Code | Y | Y (AC + Stop-block) | Y (channels) |
| Codex CLI | Y | Y (AC + Stop-block) | P (app-server `turn/start`, own thread) |
| Copilot CLI / VS Code | Y | Y (AC + agentStop block) | P (ACP / SDK ?) |
| OpenCode / Kilo | Y | Y (plugins) / ? | Y (`prompt_async`) / ? |
| Cursor | Y | P (stop `followup_message`; AC ?) | P (ACP hidden, `persist` ?) |
| Gemini CLI / Qwen Code | Y | Y (AC) | P (ACP) |
| Muse Code | Y | ? (hooks exist) | P (session-to-session only; MSP ?) |
| Cline | Y | Y (`contextModification`; CLI partial) | P (ACP) |
| Factory Droid | Y | P (AC dropped after MCP tools) | P (ACP, `exec -s`) |
| Augment | Y | P (Stop-block; AC ?) | P (ACP) |
| Kiro | Y | Y (stdout context) | P (ACP) |
| Goose | Y | ? | P (ACP) |
| Kimi Code | Y | ? | P (ACP) |
| Amp | Y | ? (plugin events) | ? (SDK) |
| Junie | Y (beta) | N/? | P (ACP) |
| Devin Desktop (formerly Windsurf) | Y | N (blocking or observe-only) | ? |
| Crush | Y | N (PreToolUse block only) | N |
| Zed agent | Y | N | N |
| Warp | Y | N | ? |
