---
title: Wire the Claude session adapter into the internal server and mcp-serve
issue: 377
status: active
---

# Claude MCP production wiring

## Problem

`createClaudeSessionAdapter` has no production composition. Nothing mounts
`CLAUDE_SESSION_PATH`, and `khala` never sets `deps.claude`, so `mcp-serve` under
`KHALA_MCP_HARNESS=claude` exits `transport_unavailable` and every `/khala` hook or
command answers `unavailable`. The Claude-mode grant test binds sessions from a
local `Set` rather than the channel-access journal.

## Decisions

- **Host.** The adapter runs in the internal launcher's server, the process that
  writes the owner-only `active.json` whose `transportCapability` the Claude client
  presents. The loopback server edge gains one injected route (`agentSession`)
  admitted only for the transport principal; the edge still imports nothing from
  the agent CLI.
- **Authenticator.** A constant-time match against the launch's transport
  capability yields one installation principal.
- **Access.** Each Claude session gets its own discovery identity
  (`harness: claude`, the session ID), issued once through the existing issue
  route and kept below `<root>/discovery/<principal>/`. Requests, status and
  listing go through the real journal routes with that identity's capability.
  An owner-approved status runs the existing journaled activation
  (`activateInternalAccess`) into a per-session granted descriptor beside that
  identity, never the shared `active.json`.
- **Directory.** A session resolves to the newest active `claude` binding whose
  stored session digest is that session's digest, looked up in the channel store
  (the `bindings_session` index). A session with no activated grant resolves to
  nothing.
- **Binding services.** Send uses the internal client over the per-session
  granted descriptor. Roster comes from the channel store. Capabilities are the
  production `claudeCapabilities`, whose acknowledgement stays `unknown`, so the
  adapter keeps hook pulls and reads `unproven` as it already does. Mode reads
  answer `unavailable` like the CLI's unset listening-mode port. No fence is
  composed, so there is no pending signal and no watcher window.
- **CLI.** `main.ts` supplies `createClaudeSessionClient` over
  `<state>/internal/active.json`.
- **Create.** #371 landed during this work. `khala_create_channel` is registered
  session-bound in the Claude registry and files the create intent under the
  session's own discovery identity. A retry under the same operation ID reads
  that request's state, so `khala_channel_create_status` stays out of the
  plugin's frozen tool set. Like `khala channels create`, nothing is activated.

## Units

1. `apps/internal`: `ChannelStore.sessionBinding`, the `agentSession` route in
   `channel-server.ts`, and `composition/claude-session/` composing the adapter.
   The launcher passes it in.
2. `packages/agent-cli`: `activePath` option on `activateInternalAccess`,
   `claude` in `main.ts`, and removal of the `Set`-based grant test.
3. An integration test in `apps/internal` that launches the real server. It
   runs `mcp-serve` in Claude mode for two sessions, lets the owner approve one
   session's request, activates it, and proves that only that session sends and
   lists the roster.

## Wrong-implementation check

Filing the access request for a hard-coded session binds that session instead, so
the requesting session stays `session_not_bound` and the integration test fails.
