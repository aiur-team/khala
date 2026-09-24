# OpenCode 1.17.10 proof output

Captured on `orangekid` on 2026-09-24. The OpenCode binary resolved through
mise at the versioned path below. Secrets, session IDs, URLs, full prompts, and
transcripts are omitted; fixed markers and state fields are retained verbatim.

## Version inventory

```text
$ hostname
orangekid
$ command -v opencode
/home/everdred/.local/share/mise/installs/opencode/1.17.10/opencode
$ opencode --version
1.17.10
$ node --version
v22.23.2
$ node -p "require('./.opencode/node_modules/@opencode-ai/plugin/package.json').version"
1.17.10
$ node -p "require('./.opencode/node_modules/@opencode-ai/sdk/package.json').version"
1.17.10
```

## Session-addressed probes

The original throwaway HTTP/SDK command lines were not retained. These are the
raw stdout fields captured from their filtered responses, rather than a
reconstructed transcript.

```text
# idle session prompt
SYNC-DEEPSEEK-OK

# busy session: status, then second-prompt result
busy
BUSY-SECOND-OK.

# TUI append + submit
TUI-PUSH-DEEPSEEK-OK

# real plugin: message count before, count after, result
2
4
PLUGIN-PUSH-DEEPSEEK-OK

# hard abort: abort response, session status, error name, follow-up result
true
idle
MessageAbortedError
AFTER-ABORT-DEEPSEEK-OK
```

## Catalog drift observed during review

The original proof selected `deepseek/deepseek-flash`. A later fresh-data
catalog lookup returned this output and omitted that model, so an exact replay
now fails closed.

```text
$ opencode models deepseek
deepseek/deepseek-v4-flash
deepseek/deepseek-v4-flash-vision-exp
deepseek/deepseek-v4-pro
```
