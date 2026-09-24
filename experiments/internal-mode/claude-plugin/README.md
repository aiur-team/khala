# Claude Code interactive hook probe

Research-only harness for `docs/product/internal-mode/claude-plugin.md`. It loads
as a development plugin and records only hook metadata: event, Claude session
ID, working directory, prompt ID, stop-loop state, and tool name. It does not
read transcripts or other sessions.

The hook atomically claims one pending JSON file by renaming it from
`<session-id>.<channel>.json`; competing hook processes therefore cannot drain
the same item. This is an exclusive-claim proof, not the production
acknowledgement design: the probe deletes the claim after reading and is not
crash-safe. The three isolated channels exercise:

- synchronous `PostToolUse` context;
- `Stop` continuation instead of idling;
- a long-running `UserPromptSubmit` hook with `asyncRewake`, staged only after
  the interactive session is idle.

`skills/khala/SKILL.md` is a non-functional naming probe. It establishes how
Claude Code exposes a plugin-packaged dispatcher and whether the requested
`/khala <subcommand>` spelling can be provided by the plugin itself.

On Claude Code 2.1.282, entering `/khala join` in an interactive TTY loaded the
plugin skill and produced `KHPLUG-COMMAND join`; the first token was available
through `$ARGUMENTS`. This proves the literal dispatcher shape, not the four
Khala operations behind it.

Validate the plugin with:

```sh
claude plugin validate --strict experiments/internal-mode/claude-plugin
node --test experiments/internal-mode/claude-plugin/probe.test.mjs
```

Each live run uses a fresh directory under `$TMPDIR`; no run evidence or message
content is committed.
