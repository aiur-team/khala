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

The same authentication setting was applied to a user-started TUI with an
explicit loopback port. The plugin loaded, but the TUI exited before it became
usable because its own client request did not authenticate to its embedded
server:

```text
Error: opencode server GET http://127.0.0.1:41069/config/providers?directory=<proof-workspace>
→ 401 Unauthorized: (empty response body)
```

Result: **Blocked** for an authenticated companion using the TUI's built-in
server on OpenCode `1.17.10`. Running the same port without authentication made
the TUI work and enabled the empirical mode probes, but an unauthenticated API
is not an acceptable product route. The recommended product route is therefore
the in-process plugin API, with the built-in server treated as diagnostic only
until OpenCode fixes or documents authenticated embedded-TUI operation.
