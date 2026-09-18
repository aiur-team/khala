# 2026-09-17 exploration notes (designated fixture only)

Fixture: thread `01a0b261-639c-7cf1-a6b0-f485ee08dfac`, codex-cli 0.154.0, cwd
`<HOME>/.cache/khala-disposable/codex-target`, approval `never`, sandbox read-only.

- `codex app-server --listen unix://PATH` speaks WebSocket (HTTP 101 upgrade) on the
  Unix socket; `app-server proxy` forwards raw bytes, so a JSONL client over proxy
  hangs at `initialize`. The `ws` client needs `perMessageDeflate:false` and a `Host`.
- Before loading: `thread/read` status `notLoaded`, `canAcceptDirectInput:null`.
  `thread/resume` without overrides loaded it with approval `never`, read-only
  sandbox, same model/cwd; a `thread-writer-locks/<id>.lock` flock is then held by
  the native app-server pid, which is also the Unix listener pid (via /proc/net/unix).
- The thread stays loaded after the resuming client disconnects.
- Owner connection set `prior-marker-codex-alpha` (reply `MARKED`). A second,
  separate connection sent `thread/queue/add` while idle: the executor auto-started a
  turn ~1ms after queue acceptance; the userMessage item carried
  `clientId == clientUserMessageId`; reply was
  `release-nonce-explore-1 prior-marker-codex-alpha` on the same thread.
