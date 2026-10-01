# Codex 0.159.3 native boundary probe

2026-10-01, Linux x64, `codex-cli 0.159.3`. This probe used only synthetic text
and a disposable saved Codex home and workdir. It made no Khala channel send.
The executor was `codex exec`, not a person-owned interactive TUI; that route
difference is another reason this observation cannot promote hosted listening.

## Result

| Mode | Native event | Model-visible observation | Receipt observation | Verdict |
| --- | --- | --- | --- | --- |
| Steer | `PreToolUse` | The hook's `decision: "block"` stopped `printf ready`; the model saw the reason and attempted a later tool call containing the synthetic token. | The later shell call failed before execution because the disposable app-server socket directory failed Codex's bubblewrap check. | Boundary visible; no executed receipt. |
| Sync | `Stop` | The hook's `decision: "block"` continued the same turn. The model saw the reason and attempted a later tool call containing the synthetic token. The next `Stop` reported `stop_hook_active: true`. | The later shell call failed at the same sandbox setup step. | Boundary visible; no executed receipt. |

The Steer and Sync runs used separate disposable saved sessions. Their exact
thread IDs are retained only in the private 0600 probe manifest. A third
saved-session attempt configured a disposable local MCP receipt tool. Codex
parsed that server's configuration (`codex mcp list --json`), but the model reported that the tool
was absent from its registry, so no MCP call ran. That attempt also produced
no receipt. The private raw rollouts were inspected but are not retained.

This is a **negative receipt probe**, not a negative hook probe. The CLI has
usable model-visible tool and turn boundaries. It does not yet have a proven
model-origin `khala_read` or `khala_send` call returning the offered batch token
under the same held session binding and generation. A hook output, an old
version's conformance proof, and a command that was only attempted cannot be
promoted to `batch_token_next_call`. Hosted Codex 0.159.3 therefore remains
typed unsupported for Steer, Sync, Async, and acknowledgement.

## 2026-10-01 gate audit

The installed 0.159.2 and 0.159.3 CLIs both expose `queue --thread --message`,
the `hooks` feature, and an MCP configuration that `codex mcp list --json`
parses. These API surfaces do not establish that a queued notice wakes the
same normally trusted TUI, or that its later Khala read executes and advances
the exact binding and generation. A potential 0.159.2 read/ACK witness was
reported on 2026-10-01, but its retained binding and generation provenance and
native queued wake have not been independently verified. The 0.159.3 probe
above ended before an executed receipt. The 0.157.1 fixture pin
is therefore an evidence boundary, not a demonstrated removal of the APIs in
newer versions. The native crash gate continues to return
`native_version_unproven` for both installed versions, before Docker effects.

A later private, operator-supplied 0.159.2 snapshot was inspected on 2026-10-01.
Its SQLite ledger passed `quick_check`; the copied current binding matched the
ledger binding, releases, release items, and an `agent_acknowledged` receipt at
the same generation. Its provenance note labels native read/ACK as observed,
but the snapshot contains no saved native rollout or executed-call trace to
independently bind those operations to the Codex session. It explicitly marks
queue-hook execution `not_observed`. This supports a narrower ledger/ACK
finding and does not prove the queued same-session Sync route required by the
native crash gate. No private identifiers or content are retained here.

## Reproduce the native observation

With an existing private `$TMPDIR`, the following recreates the isolated hook.
The auth symlink lets Codex use its normal account; the script does not read or
print its contents. The token is synthetic, never a channel message.

```sh
probe_root=$(mktemp -d "$TMPDIR/khala-718-codex-XXXXXX")
chmod 700 "$probe_root"
mkdir -m 700 "$probe_root/home" "$probe_root/work"
ln -s "${CODEX_HOME:-$HOME/.codex}/auth.json" "$probe_root/home/auth.json"
printf '[features]\nhooks = true\n' > "$probe_root/home/config.toml"
cat > "$probe_root/hook.py" <<'PY'
import json, os, pathlib, sys
v = json.load(sys.stdin)
root = pathlib.Path(os.environ['CODEX_HOME']).parent
mode = (root / 'mode').read_text()
event = v.get('hook_event_name')
with (root / 'events.jsonl').open('a') as out:
    out.write(json.dumps({key: v.get(key) for key in
        ('hook_event_name', 'session_id', 'turn_id', 'stop_hook_active')}) + '\n')
if (mode == 'steer' and event == 'PreToolUse') or (
    mode == 'sync' and event == 'Stop' and not v.get('stop_hook_active')):
    marker = root / ('issued-' + mode + '-' + str(v.get('turn_id')))
    if not marker.exists():
        marker.write_text('1')
        print(json.dumps({'decision': 'block', 'reason':
            'Synthetic boundary probe. On your next tool call, return exact '
            'batchToken: probe-718-' + mode + '-7e42b9'}))
PY
PROBE_ROOT="$probe_root" python3 - <<'PY'
import json, os
root = os.environ['PROBE_ROOT']
json.dump({'hooks': {event: [{'hooks': [{'type': 'command',
    'command': 'python3 ' + root + '/hook.py', 'timeout': 15}]}]
    for event in ('PreToolUse', 'Stop')}}, open(root + '/home/hooks.json', 'w'))
PY
for mode in steer sync; do
  printf '%s' "$mode" > "$probe_root/mode"
  CODEX_HOME="$probe_root/home" codex exec --skip-git-repo-check \
    --sandbox read-only --dangerously-bypass-hook-trust --json \
    -C "$probe_root/work" \
    'Call a shell tool with printf ready. If a hook gives a batchToken, make a later shell tool call that prints ACK and that exact token. Do not guess it.' \
    > "$probe_root/$mode.jsonl" 2> "$probe_root/$mode.stderr"
done
rg 'thread.started|command_execution|turn.completed' "$probe_root"/*.jsonl
```

The trust bypass was confined to the disposable, locally reviewed hook; it
does not establish that an installed Khala hook was trusted in an owner's
session. In the JSONL output, verify the blocked first tool call, the later
model-origin call containing the exact token, and whether that later call
actually completed. The latter is the decisive check. For production support,
repeat with the installed trusted Khala hook and a held owner-approved binding:
the next **executed** Khala call must echo `ackBatchToken`, advance the exact
binding/generation inbox, and yield a correlated durable receipt. The
smallest route upgrade is that exact saved-session end-to-end witness; no new
Codex CLI version is required by the boundary observations alone.

The [official hook contract](https://learn.chatgpt.com/docs/hooks) describes
`PreToolUse` block/context output and `Stop` continuation, but the result above
is limited to the installed version and the observed saved sessions.
