# Native setup check: Codex 0.158.0 and Claude Code 2.1.284

2026-09-28, Linux x86_64. This is an isolated setup compatibility check, not a
model-delivery or owner-admission proof. No production channel or capability was
used.

## Installed contracts

- `@openai/codex@0.158.0` was installed into a private directory from npm.
  `codex --version` returned `codex-cli 0.158.0`. In an isolated `CODEX_HOME`,
  the Khala setup plan installed only the skill, `hooks.json`, and the
  `[mcp_servers.khala]` entry among Codex-owned components. The exact CLI's
  `codex mcp list` reported `khala` enabled with the staged absolute launcher.
  Hook trust remains `awaiting_hook_review`; no hook firing or model turn was
  observed on this version.
- The installed `claude --version` returned `2.1.284 (Claude Code)`. In an
  isolated home, the Khala setup plan installed one directory-marketplace
  plugin, including its skill, hooks, and MCP entry. The exact CLI's
  `claude mcp list` resolved `plugin:khala:khala` through the staged launcher
  and connected to its MCP server. A Claude model turn was not observed.
- `khala status` on the isolated home reported both versions as supported and
  their components present. Claude's route remained `unknown`; Codex's route
  remained `unknown` with hooks awaiting native review. `connected` was false.

## Reproduction and boundary

The focused setup tests in `packages/agent-cli/src/setup/adapters/` passed
48/48, and the agent CLI typecheck and package build passed. The production
operator home was not changed. The private setup was applied using the
`planDigest` from `khala setup --dry-run`, then inspected with `khala status`,
`codex mcp list`, and `claude mcp list` under the same private HOME/XDG roots.

The current workspace has no running owner-started internal launcher, and the
hosted channel-access routes remain unfinished in #518. #42 owns the
persistent production connector. Until those paths are available and a channel
owner approves access, this check cannot establish a session-bound production
request, model-visible read, send, or acknowledgement. #230 retains the Codex
receipt proof; this setup check does not promote its route claims.
