# Muse Code (Meta, binary `muse`) as a Khala host

Researched 2026-10-05. WebFetch answers come from a small summarizer, so quotes are as returned by it, not byte-checked.
**Access limit:** the dedicated hooks reference (`https://dev.meta.ai/docs/muse-code/hooks`) and `/docs/muse-code/cli` return an SSO identity prompt. Anything that needs them is UNVERIFIED.
The SDK docs site `https://meta-models.github.io/muse-code-sdk/` only returned a redirect stub (`next/`) and was not followed.

## 1. MCP config
- Location: `~/.config/muse/settings.json`. Needs `"schema_version": 1`.
  - Source: https://dev.meta.ai/docs/muse-code/configuration
  - Quote: "A file that omits that key fails every command at startup with `malformed settings file`."
- Schema: `mcp_servers` map. Each entry has `transport`: `stdio` (`command`, `args`, `env`, optional `framing`) or `streamable_http` (`url`, `headers`). It also takes `enabled` and `mode` (`required` default, or `optional`).
  - Source: https://dev.meta.ai/docs/muse-code/extending
  - Example: `{"mcp_servers":{"my-tools":{"transport":"stdio","command":"my-mcp-server","args":[]}}}`
  - Third-party example: https://porteden.com/blog/muse-code-mcp-servers/ (HTTP only).
- Env: stdio entries take an `env` map. The changelog says "MCP server configs support environment variable interpolation via `${VAR}` syntax" and "Stdio MCP servers receive `MUSE_SESSION_ID` environment variable".
  - Source: https://dev.meta.ai/docs/muse-code/changelog
- Scope: the file is user-global only.
  - Source: https://github.com/meta-models/muse-code-sdk/issues/65
  - Quote: "A project `.mcp.json` is not loaded (a stdio server declared there is never spawned)." There are no `--mcp-config` flags as of 1.4.1.
- Caveat: issue #65 says `settings.json` "accepts `mcpServers`" (camelCase), while the docs use `mcp_servers`. Use the docs form. The camelCase alias is UNVERIFIED.
- MCP tools run outside the sandbox. Read-only tools skip the approval prompt, and the others will prompt (changelog). Handshake protocol is 2025-06-18 (changelog), so no 2026-07-28 features.

## 2. Hooks
- Sources (extending): project `.muse/hooks.json`, a user `hooks` block in settings.json, and a managed file via `managed_hooks_path`. Plugin hooks need startup review and trust (changelog).
- Events (15, from extending): SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure, PreLLMCall, PostLLMCall, PreCompact, PostCompact, SubagentStart, SubagentStop, Notification, Stop, SessionEnd.
  - Also: an observation-only `Interrupt` hook (fires on Escape) appears in the changelog but not in the event list. This is a doc inconsistency.
- Quote (extending): "A hook binds a shell command to a lifecycle event. When the event fires, Muse Code runs the command and acts on its result: enforce a check, format code, or block an action before it happens."
- **Input JSON, output JSON, exit-code semantics: UNVERIFIED.** The public extending page gives no schemas, and the hooks page is behind SSO.
- **Additional context after a tool call: UNVERIFIED.** There is no `additionalContext` documentation. A WebFetch summary of extending claimed hooks "cannot return additional context", but the page text has no such statement, so treat that summary as unreliable.
  - The changelog line "Sessions support `additionalContext` through workspace roots and MCP configurations" is about workspace roots, not hooks.
- Force a continue or retry at Stop: UNVERIFIED.
  - The changelog says a failed hook's "declared successor runs as an ordinary hook at the same event and can ask for your approval". This is not a continue mechanism.
  - Hook results over MSP are enumerated as `allowed | blocked | modified | observed | error | timedOut` (https://github.com/meta-models/muse-code-sdk/issues/49). "modified" hints at input rewriting, not context injection.
  - SessionEnd "cannot block termination or inject later context" (extending).
- Do NOT use https://github.com/jellologic/claude-code-muse/issues/40. Its `decision:"block"` and `additionalContext` semantics describe Claude Code hooks driving a Muse subagent, not Muse's own hook engine.

## 3. Session id
- MCP server: the `MUSE_SESSION_ID` env var is passed to stdio servers (changelog, quoted above). The exact release that added it is not stated.
- Hook: UNVERIFIED. Presumably in stdin JSON or env, but no source was reachable.
- CLI: `muse exec` accepts `--session-id` to resume (https://aq.dev/agents/muse-code/, per prior research; not re-fetched).
- Interactive: `/name` shows or sets a 3-32 character session name (https://dev.meta.ai/docs/muse-code/session-messaging).

## 4. Idle wake
- **Session messaging** (https://dev.meta.ai/docs/muse-code/session-messaging) is the only wake-like feature.
  - Quote: "Send a bounded piece of context from one live Muse Code session to another."
  - Delivery modes: steer ("at its next safe model step"), queue ("when the next turn starts"), and notify-only ("without adding it to the recipient model's context").
  - Idle default: "defaults to notifying idle recipients, though senders can request ... waking at specific safe points." The changelog says "Approved peer notifications wake idle agents by default", and "Peer messages that cannot start a turn now show as parked until your next turn".
  - Limits: "interactive sessions for the same user account on the same macOS or Linux machine"; "up to 8,192 bytes"; "currently unavailable on Windows".
  - Peer messages are accepted, rejected or withheld with privacy controls, so the user must approve the peer (changelog).
- **Whether a non-Muse process (the Khala MCP server) can act as a peer sender is UNVERIFIED.** No sender CLI, IPC path or wire format is documented. Only `/name` is visible.
- **MSP (`muse serve`) cannot attach to the user's session.** It is "newline-delimited JSON-RPC 2.0 over stdio" where "the client owns the process" (search result, citing the SDK and https://github.com/sanjay3290/muse-acp).
  - Issue #36 quote: "muse serve: --listen is not available in v1; the unix-socket and websocket transports are deferred post-v1". Its summary says remote control of a running local session is not possible.
  - Using MSP would mean Khala spawns the agent. That is wrapping, which is forbidden.
- No async re-arming hook (asyncRewake analogue) is documented. The changelog says "Background monitors and reminders use wake mechanisms", but these are internal to the session. Hook-driven wake is UNVERIFIED.
- Candidate WORKAROUND to prototype: a Khala MCP tool or hook that sends a session-messaging peer message. Blocked until the sender interface is documented.

## 5. Install and packaging
- Install: `curl -fsSL https://dev.meta.ai/install.sh | sh` (Linux/macOS), `irm https://dev.meta.ai/install.ps1 | iex` (Windows). Source: https://dev.meta.ai/docs/muse-code
- **No `muse mcp add`.** The only `muse mcp` subcommands found are `login <server>` and `logout <server>` (OAuth; extending, changelog). A search summary says "Muse Code has no add command for MCP servers", so the user (or `khala` installer) must edit settings.json. The installer must preserve sibling keys and `schema_version`.
- Plugins exist ("enabled plugin bundles" in extending). They can carry skills, hooks, agents and commands, and they "Claude plugin command and skill declarations" load (changelog). The manifest format, and whether a plugin can ship `mcp_servers`, are UNVERIFIED. Possible reuse of Khala's Claude plugin is UNVERIFIED.
- Project instructions: `AGENTS.md` (per prior research, not re-verified).

## 6. Windows
- Native Windows build exists (install.ps1). Quirks (https://dev.meta.ai/docs/muse-code): "PowerShell replaces Bash", the sandbox "may require administrator approval initially", voice is unsupported, and **session messaging is unavailable**.
- Hook commands run "directly through your shell" (extending). The shell on Windows (PowerShell vs cmd) is UNVERIFIED, so Khala hook commands must be shell-neutral.
- The Windows settings path is UNVERIFIED (docs show only `~/.config/muse/settings.json`).
- Stdio framing: the `framing` option exists, and the changelog notes "Slow stdio MCP servers admitted on first try if emitting newline-delimited JSON". Use NDJSON.

## Feature table
| Item | Status | Note |
|---|---|---|
| MCP stdio server registration | SUPPORTED | Edit `~/.config/muse/settings.json` `mcp_servers`; no CLI add |
| Per-project MCP config | BLOCKED | `.mcp.json` ignored; global only |
| Session id for MCP server | SUPPORTED | `MUSE_SESSION_ID` env |
| Session id in hooks | UNVERIFIED | Hooks page is behind SSO |
| Hook events incl. PostToolUse and Stop | SUPPORTED | 15 events listed |
| Hook input/output JSON schema | UNVERIFIED | Not publicly reachable |
| Steer (inject after tool call) | UNVERIFIED | Hook additionalContext unknown. WORKAROUND candidate: agent polls `khala_read` via AGENTS.md instruction (weak) |
| Sync (inject at turn end) | UNVERIFIED | Stop-hook continue unknown; same fallback |
| Async (on demand) | SUPPORTED | MCP tools `khala_read`/`khala_send` |
| Idle wake, non-wrapping | WORKAROUND (unproven) | Session-messaging peer send; external sender undocumented; Linux/macOS only |
| Idle wake via MSP/serve | BLOCKED | Stdio, client-owned process; no attach, no listen in v1 |
| Idle wake on Windows | BLOCKED | Session messaging unavailable |
| CLI to add MCP server | BLOCKED | Only `muse mcp login/logout`; write settings.json directly |
| Plugin packaging | UNVERIFIED | Plugins exist; manifest and MCP bundling unknown |
| Windows install and run | SUPPORTED | install.ps1; PowerShell shell; no wake |

Next step: get SSO access to the hooks page, or run `muse` locally with a logging hook to capture the real stdin and stdout contract and test peer messaging from outside.
