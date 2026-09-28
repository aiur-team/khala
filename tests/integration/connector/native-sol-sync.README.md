# Codex 0.157.1 Sol native sync preflight

This disposable preflight is the missing native evidence gate for #42. It uses the
production Codex setup adapter and transaction executor to install the Khala
skill, hooks, and MCP entry into a private `CODEX_HOME`. The installed launcher
calls the production `codex-hook` and `read` commands against the production
file inbox. The binding, effective `sync` mode, and local control client are
injected only for this preflight; it does not prove hosted control or Matrix.

The operator starts a single Codex TUI separately with the existing ChatGPT
login and exact `gpt-6-sol` model. No test code launches that TUI. The native
folder and hook trust prompts must be accepted normally; do not use a trust
bypass or another model. `bind` reads the private rollout metadata and the live
process to require one matching session ID, version, model, workdir, Codex home,
and native PID. It reports only those facts, not session contents.

From the repository root, with the candidate 0.157.1 adapter change in place,
set owner-private paths for a fresh run. Keep these values in the shell that
runs every fixture command and the Codex TUI:

```sh
export KHALA_42_SYNC_ROOT=/home/everdred/.cache/k42sol-native
export KHALA_42_REPO_ROOT=/home/everdred/.cache/khala-executor/42-sol-native-recovery-sol
export KHALA_42_SYNC_WORKDIR="$KHALA_42_SYNC_ROOT/workdir"
export KHALA_42_CODEX_BIN=/home/everdred/.local/share/mise/installs/node/24.18.0/bin/codex
export CODEX_HOME="$KHALA_42_SYNC_ROOT/codex-home"
export XDG_CONFIG_HOME="$KHALA_42_SYNC_ROOT/config"
export XDG_DATA_HOME="$KHALA_42_SYNC_ROOT/data"
export XDG_STATE_HOME="$KHALA_42_SYNC_ROOT/state"
export TMPDIR="$KHALA_42_SYNC_ROOT/tmp"
export PATH="/home/everdred/.local/share/mise/installs/node/24.18.0/bin:$PATH"
mkdir -p "$CODEX_HOME" "$TMPDIR" "$KHALA_42_SYNC_WORKDIR"
chmod 700 "$KHALA_42_SYNC_ROOT" "$CODEX_HOME" "$TMPDIR" "$KHALA_42_SYNC_WORKDIR"
git -C "$KHALA_42_SYNC_WORKDIR" init -q
/home/everdred/.local/share/mise/installs/node/22.23.2/bin/node --import tsx \
  tests/integration/connector/native-sol-sync-fixture.ts setup
```

In a bounded, monitored PTY scope, start the native CLI using the existing
same-account auth copy. Use an actual PTY, not tmux. The inner shell removes
that copy on normal exit; the outer shell removes it even if the scoped process
is killed. After a host crash, remove it manually before doing anything else.

```sh
systemd-run --user --scope --unit=khala-42-native-sol-sync \
  -p MemoryHigh=4G -p MemoryMax=6G -p MemorySwapMax=0 \
  -p CPUQuota=200% -p TasksMax=512 -p RuntimeMaxSec=900 \
  /bin/bash -c 'cleanup() { /bin/sh "$KHALA_42_REPO_ROOT/tests/integration/connector/native-sol-auth-cleanup.sh"; }; trap cleanup EXIT; \
    test ! -e "$CODEX_HOME/auth.json" || exit 1; \
    install -m 600 /home/everdred/.codex/auth.json "$CODEX_HOME/auth.json"; \
    cd "$KHALA_42_SYNC_WORKDIR" || exit 1; \
    "$KHALA_42_CODEX_BIN" -m gpt-6-sol -C "$KHALA_42_SYNC_WORKDIR" \
      -s workspace-write --add-dir "$KHALA_42_SYNC_ROOT/state"'
KHALA_42_NATIVE_STATUS=$?
/bin/sh "$KHALA_42_REPO_ROOT/tests/integration/connector/native-sol-auth-cleanup.sh"
test ! -e "$CODEX_HOME/auth.json" || exit 1
test "$KHALA_42_NATIVE_STATUS" -eq 0
```

Send `Reply READY only, then end this turn. Do not sleep or call tools.` as the
standby prompt, allow its turn to finish, and leave the TUI running.
Verify Codex's own folder and hook review rather than editing a `trusted_hash`
record. From another shell with the same environment, execute:

```sh
/home/everdred/.local/share/mise/installs/node/22.23.2/bin/node --import tsx \
  tests/integration/connector/native-sol-sync-fixture.ts bind
/home/everdred/.local/share/mise/installs/node/22.23.2/bin/node --import tsx \
  tests/integration/connector/native-sol-sync-fixture.ts enqueue
/home/everdred/.local/share/mise/installs/node/22.23.2/bin/node --import tsx \
  tests/integration/connector/native-sol-sync-fixture.ts queue
/home/everdred/.local/share/mise/installs/node/22.23.2/bin/node --import tsx \
  tests/integration/connector/native-sol-sync-fixture.ts verify
```

`queue` uses the production scrubbed-env process port and its fixed notice. It
does not put a released body in argv, environment, or its result. Observe
whether the idle native TUI starts a new turn from that notice before any
operator prompt. A successful `queue` exit by itself proves only acceptance by
the queue CLI. If the TUI remains idle, record that failed wake observation,
then send a separate content-free prompt to test narrower next-turn `sync`
delivery. Do not merge the two observations. `verify`
requires the released synthetic marker in the model-visible hook context and
the same session's agent relay, a model-originated `read --ack` correlated to
the pinned native session, exact current batch and isolated tool worker that advances
the production inbox cursor, and absence of the unsubmitted marker. The
unsubmitted marker is generated but never enqueued, so its absence checks only
the fixture's transport boundary; it does not prove pending-item filtering.
That remains a separate assertion in the #42 crash runner. A failed or missing observation is a
failed preflight, not a substitute native claim.

Keep the raw rollout, auth copy, and synthetic markers inside the private
fixture directory. Remove the temporary auth copy after the run. Only the
sanitized boolean result and non-secret process/version facts belong in a PR.
The #42 Synapse/SQLite crash runner remains a separate subsequent proof and
must use the same verified native session, exact model and supported version.
