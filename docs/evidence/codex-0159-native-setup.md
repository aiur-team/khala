# Codex 0.159 setup compatibility

2026-09-29, Linux x86_64. This check covers setup independently of #42 and #523's
hosted owner approval and model-visible read/send acceptance. No production
channel, credential, session transcript, or model turn was used.

The test in `packages/agent-cli/src/setup/adapters/codex.test.ts` runs the guarded
setup executor in a disposable home with the real Khala skill. An explicitly
provided vendor executable then reads the MCP configuration with `mcp list
--json` and discovers the skill through app-server `initialize` / `skills/list`.
It checks the staged absolute MCP launcher, leaves hooks `awaiting_hook_review`,
and keeps delivery `unknown`. Removal deletes Khala's owned native paths while
preserving baseline files. App-server may create its own system skills/cache;
these are vendor-owned and disappear with the disposable home.

Reproduce with an exact `@openai/codex` installation outside the repository and
an existing private TMPDIR (the operator `/tmp` quota was exhausted):

```sh
TMPDIR=/private/tmp KHALA_TEST_CODEX_EXECUTABLE=/absolute/path/to/codex \
  pnpm --filter @aiur/khala test src/setup/adapters/codex.test.ts
```

The native test is opt-in; ordinary CI still exercises setup and removal for
each supported exact version through the existing confined filesystem tests.
Versions 0.159.0 and 0.159.1 failed that setup regression before allowlist support.
The exact npm 0.159.0 and 0.159.1 native suites each passed 23/23, including
actual skill discovery and MCP parsing. Typecheck and changed-file ESLint passed. Local Node was
24.18.0; repository CI pins 22.23.2.

This evidence does not establish hook execution, MCP server connection, exact
existing-session discovery, queue delivery, owner approval, or a read/send
receipt. #42 retains exact-session proof; #592 retains the hosted candidate/join
fix. #523 must remain open until its live native acceptance passes.
