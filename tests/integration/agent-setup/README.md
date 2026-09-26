# Setup acceptance (E09 `setup-cli-acceptance`)

This suite is the release gate for `npx @aiur/khala setup|status|remove`. It
runs black-box against the packed tarball: the gate packs `packages/agent-cli`
(or takes `KHALA_SETUP_TARBALL`), installs it offline into an empty prefix
outside this repository, and runs the installed bin with Node. Each test gets
a synthetic machine with its own `HOME` and a PATH that holds only fake
`claude`, `codex`, and `opencode` executables and the few shell utilities they
use. A fake answers `--version` and logs its argv. The host's `/usr/bin` is
never on that PATH, so a real harness on the test host cannot leak in. Setup
needs nothing else from a harness, because every adapter mutates through
guarded direct edits.

```sh
node --test tests/integration/agent-setup/setup-acceptance.test.mjs
```

Scratch prefixes and homes go under the system temp directory. If `TMPDIR` points inside this repository, they go to `/tmp` instead, so the installed package can never resolve workspace `node_modules`. They are removed at the end; set `KHALA_SETUP_KEEP=1` to keep them for inspection.

CI runs it after `pnpm test`. The release workflow runs it against the exact
tarball the package gate accepted and publishes that tarball only after it passes.

Unit coverage and per-mutation fault injection stay beside the setup modules
(`packages/agent-cli/src/setup/`). This suite covers only the packaged flow.

## What it proves

| Case | Proof |
| --- | --- |
| Packaged install | The tarball installs and runs outside the repository; CI asserts the pinned Node from `.node-version`. |
| Clean lifecycle | A plan, a repeated plan, and a dry run are byte-identical and zero-write (bytes, modes, and mtimes). The confirmation carries harnesses, actions, paths, backup, digest, and request. Confirmed setup applies. A second setup changes and writes nothing. Bare `status` exits 0 and `status --check` exits 3 while Codex hooks await review. Confirmed remove restores every pre-Khala byte and absence. |
| Native hook approval | After a simulated Codex approval, status is `configured_effect_unknown` (`ok: true`) and `--check` still exits 3, because Claude and Codex routes stay `unknown` until a live proof. Removal leaves the trust records intact. |
| Mixed harness states | No harness is a zero-write `no_harness` (exit 0). With a supported Claude, an unsupported Codex, and no OpenCode, setup refuses (exit 3) before any write. A failed version probe differs from absence. Without the unsupported harness, only Claude is planned, and no absent harness gets a config root. |
| Absent harnesses are reported | `status` and `setup` report every absent harness with `executable.present: false`, no detected version, and no components. Absent harnesses are never planned and create no config root. |
| Unsupported upgrade | An unsupported version refuses setup, but manifest-driven removal still restores the baseline. |
| Stale confirmation | After an observed target changes, the old digest returns the replacement plan (exit 5) and writes nothing. |
| Drift-safe removal | A user edit to a managed file refuses the whole removal (exit 3) with no partial writes. Once the bytes match again, removal completes. |
| Upgrade | Setup with the package, upgrade to a repacked `0.2.0-acceptance.1`, then remove. The result is the pre-Khala bytes, not the v1 postimage. |
| Concurrency | A fake `codex --version` holds the first setup inside its lock (the executor replans there). A second confirmed setup gets `conflict`/`setup_busy` (exit 3) and writes nothing. |
| Kill while locked | A setup SIGKILLed while holding the lock leaves no half-done harness. The next confirmed setup reclaims the dead holder's lock and applies. |
| Kill mid-transaction | A setup SIGKILLed after its journal records an applied operation, before the commit point, leaves no torn file: every planned path is its preimage or its postimage. `status --check` exits 4 with `recovery_required`. `setup`, `remove`, a dry run, and a setup confirmed with the interrupted digest each return a recovery plan (exit 5, `recovery_available`) and write nothing. At least one planned path already holds its postimage. Confirming the recovery plan rolls every write back in one command (exit 0, `recovered`), leaving every pre-Khala byte and absence with no journal. |
| Descriptor discovery | The Claude hook entry (`khala claude <op>`) and the Codex/OpenCode MCP entry (bare `mcp-serve`), each run through the staged launcher, reach whichever loopback server the current `$XDG_STATE_HOME/khala/internal/active.json` names after the descriptor moves. The hook presents that launch's transport credential. The MCP entry, given a granted launch, presents that launch's binding credential. No entry is rewritten. |
| Secret redaction | Sentinel descriptor ports and tokens are rotated mid-run. They never appear in harness config, fake-harness argv, plans, the manifest, backups, or any output. Seeded user secrets never appear in output. Rotating the descriptor plans nothing and rewrites no entry. |

## Wrong-implementation checks

Each guard below was reverted in source and the suite rerun (it repacks from
source). The named test then failed:

| Guard reverted | Test that fails |
| --- | --- |
| `payload.ts`: launcher bytes append the runtime descriptor | `descriptor port and token never reach …` (the contract's wrong-implementation killer) |
| `transaction.ts` `nextManifest`: take the baseline from the current preimage instead of the previous entry | `setup v1 -> upgrade v2 -> remove restores the pre-Khala bytes …` |
| `transaction.ts` `acquireLock`: treat a live holder as stale | `a second mutation while one holds the lock gets a stable busy result …` |
| `plan.ts` `refusalState` and `transaction.ts` drift check: allow removal over drift | `drift refuses the whole removal …` |
| `plan.ts` `observe`: skip a harness with no executable instead of reporting it absent | `absent harnesses are reported without creating their config roots` |
| `plan.ts` `prepare`: ignore an existing journal | `a crash mid-transaction leaves no torn file …` |
| `transaction.ts` `rollback`: skip `restoreTarget`, so recovery restores nothing | `a crash mid-transaction is recovered by the next confirmed command` |
| `cli/main.ts`: read the Claude descriptor from `$XDG_DATA_HOME` instead of `$XDG_STATE_HOME` | `the Claude hook entry re-reads a moved runtime descriptor …` |
| `cli/main.ts`: drop `defaultDescriptorPath`, so a bare `mcp-serve` composes no local client | `the Codex and OpenCode MCP entry resolves a moved runtime descriptor` |

Reproduce any row by making the edit and running
`node --test --test-name-pattern='<test name>' tests/integration/agent-setup/setup-acceptance.test.mjs`.
