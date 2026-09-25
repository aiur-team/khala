# OpenCode server authentication

## Headless server control

A throwaway random password was supplied through
`OPENCODE_SERVER_PASSWORD`; it was not placed in the target process argv. The
server bound only loopback. Requests to `/global/health` produced:

```text
missing credential: 401
wrong credential:   401
correct credential: 200 {"healthy":true,"version":"1.17.10"}
listener:            127.0.0.1:41068
```

This proves OpenCode's headless Basic-auth mechanism, but a separately started
`opencode serve` process is not the user's agent and cannot satisfy a listening
mode.

## Embedded interactive-TUI blocker

The same authentication setting was applied to an agent-launched TUI with an
explicit loopback port. The plugin loaded, but the TUI exited before it became
usable because its own client request did not authenticate to its embedded
server:

```text
Error: opencode server GET http://127.0.0.1:41069/config/providers?directory=<proof-workspace>
→ 401 Unauthorized: (empty response body)
```

Result: **Blocked** for an authenticated *external* companion that uses the
TUI's built-in server on OpenCode `1.17.10`. An unauthenticated port is not an
acceptable route (decision 33).

The product route does not need a port. The 2026-09-25 mode proofs launched the
TUI with no `--port` and no password, and `ss -ltnp` showed no OpenCode
listener. The plugin reached the session through the in-process SDK client
that OpenCode passes to every plugin. See [`results.md`](results.md). The
built-in server stays out of scope until OpenCode fixes or documents
authenticated embedded-TUI operation.
