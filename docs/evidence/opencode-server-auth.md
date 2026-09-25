# OpenCode 1.17.10 server-auth evidence

This is the retained server-auth subset of the OpenCode interactive proof from
PR #180. It records a capability boundary, not a product server route. Khala
does not start or host OpenCode, and a separately launched `opencode serve`
process is not the user's agent.

## Proof environment

The run took place on `<executor-host>` on 2026-09-24. Home-directory prefixes
and the throwaway Basic-auth values are redacted; ports, executable identity,
commands, status codes, and the failing request path are retained.

```text
$ hostname
<executor-host>
$ command -v opencode
~/.local/share/mise/installs/opencode/1.17.10/opencode
$ opencode --version
1.17.10
$ sha256sum ~/.local/share/mise/installs/opencode/1.17.10/opencode
4536e58d53033b0c5ef4d25bbbe6715199a675b3fbec56f10997bb989b3e8c2b
```

The shell path selected `1.17.10`; `mise exec -- opencode --version` selected a
different Node-installed `1.15.6`, so every observation below concerns the
explicit `1.17.10` executable path.

## Headless Basic auth

The password was passed only through `OPENCODE_SERVER_PASSWORD`. It appeared in
neither the server argv nor retained logs. The server listened on loopback.
Commands are exact apart from the marked password and home-path redactions:

```sh
OPENCODE_SERVER_PASSWORD='<redacted-random>' ~/.local/share/mise/installs/opencode/1.17.10/opencode serve --hostname 127.0.0.1 --port 41068
curl --silent --output /dev/null --write-out '%{http_code}\n' http://127.0.0.1:41068/global/health
curl --silent --output /dev/null --write-out '%{http_code}\n' --user 'opencode:<redacted-wrong>' http://127.0.0.1:41068/global/health
curl --silent --user 'opencode:<redacted-random>' http://127.0.0.1:41068/global/health
```

```text
missing credential: 401
wrong credential:   401
correct credential: 200 {"healthy":true,"version":"1.17.10"}
listener:            127.0.0.1:41068
```

This proves the headless server's Basic-auth enforcement. It does not prove a
delivery route into the user's interactive TUI.

## Authenticated embedded-TUI blocker

The proof agent then launched the TUI with normal trust settings and the same
environment-only password pattern. It did not call the session user-started: a
human did not start this trial. There were no bypass flags or isolated settings.

```sh
OPENCODE_SERVER_PASSWORD='<redacted-random>' ~/.local/share/mise/installs/opencode/1.17.10/opencode --hostname 127.0.0.1 --port 41069 --model deepseek/deepseek-flash
```

The project plugin loaded, but OpenCode's own client did not authenticate to
its embedded server. The TUI exited before it became usable:

```text
Error: opencode server GET http://127.0.0.1:41069/config/providers?directory=<proof-workspace>
→ 401 Unauthorized: (empty response body)
```

Result: an authenticated external client of the TUI's embedded server is
blocked on `1.17.10`. Removing authentication made the HTTP surface work, but
an unauthenticated server is not an acceptable proof route under normal trust
settings.

## Enforced conclusion

OpenCode delivery evidence is admissible only when the plugin uses the SDK
client supplied inside the already-running TUI process. It must not depend on
Khala launching a server or on an external client of the embedded server. The
fixture verifier is in
[`experiments/internal-mode/opencode-bridge/auth/`](../../experiments/internal-mode/opencode-bridge/auth/).

The wrong-implementation fixture records unauthenticated embedded-server calls
that all returned `200`; the verifier still rejects it. HTTP success is not
evidence of an admissible route.
