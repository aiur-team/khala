# @khala/listener

Pure listener modes, delivery decisions, frame bounds and Claude-style hook codecs.
Khala owns the I/O and product wording; this package owns the reference behavior.

## Language-neutral artifacts

`spec/v1/` is generated from the TypeScript reference for consumers that cannot
run TypeScript. No network access or Node process is needed to consume the JSON.

- `listening-mode.v1.schema.json`: draft 2020-12 schema. Select a named `$defs`
  entry (`mode`, `command`, `control`, `support`, `hookGolden`) with a local
  reference, or validate against the root union. Objects reject unknown keys.
  The shared command is `{v: 1, agent, mode}` with an opaque nonempty agent ID.
  Control and support are projections: they omit Khala binding/route evidence,
  use `effective_reason`, and accept nullable requested/effective modes and reasons.
  Matrix member-only `mute` is outside this three-mode delivery specification.
  This schema does not replace Khala's wire decoders or their identifier checks.
- `scheduler.v1.json`: 768 rows across both harnesses, four hook boundaries,
  three modes, busy states, ages `0`, `119999`, `120000`, `null`, continuation
  flags and interrupt flags. Snake-case fields map to the reference's camel-case
  input names. `interrupted_since_busy` preserves the current reference's
  interrupt-aware prompt behavior. Continuation affects Stop only. Each row
  records whether its mode delivers and whether the hook only marks idle.
- `goldens/hook/*.json`: raw `stdin`, expected `parsed` input (`null` when
  rejected), neutral `frame`, exact `stdout` including its newline, harness and
  `stop_context`. Both harnesses share the codec. Cases cover absent/boolean/invalid
  continuation values, invalid JSON, missing sessions and Stop context support.
  SessionStart is a no-op. Stop's legacy block reason and context path both use
  `<frame/>`; consumers supply their own product wording and version gating.
- `goldens/*.json`: valid emulated-steer support and notice control projections,
  plus an invalid carrier example (`cancel`), which validators must reject.
- `MANIFEST.json`: spec version `1.0.0` and SHA256 of every other artifact's exact
  UTF-8 bytes. Paths are relative to `spec/v1/`; the manifest excludes itself.

Regenerate at the repository root:

```sh
node packages/listener/scripts/generate-spec.mjs
node packages/listener/scripts/generate-spec.mjs --check
pnpm --filter @khala/listener test
```

`--check` rejects changed, missing and unexpected files. Package tests run it
before replaying the scheduler and codec fixtures and checking schema projections.
The generator uses `tsx` from the repository's existing development dependencies;
no runtime dependency or wire decoder is added. JSON object keys and artifact
paths are sorted, with no clock-dependent values.

## Optional projection fields

| Field | Values | Meaning |
| --- | --- | --- |
| `control.backlog_on_leave_async` | `skip`, `notice` | `skip` advances past unread backlog (Khala behavior); `notice` leaves bodies pull-only and shows a notice. |
| `support.steer.steer_carrier` | `native`, `emulated_interrupt` | Describes how steer reaches the session, separately from its support status. |

Both fields are optional in v1; existing projections without them remain valid.
The TypeScript reference exports `ListeningModeControl` and
`ListeningModeSupportMap` for these projections. `steer_carrier` is only valid
on the `steer` entry. Renderers must read it: `emulated_interrupt` must always
be shown as **steer (interrupts current turn)**. It is not a support status;
`experimental` remains the status for an experimental interrupting route.
Khala does not adopt `notice` or `emulated_interrupt`; its scheduler and Matrix
wire decoders are unchanged. These fields describe consumer behavior, not new
scheduler inputs.
