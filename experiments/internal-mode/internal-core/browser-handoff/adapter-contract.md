# Opener adapter contract

This is the narrow seam `internal-launcher` uses to request a browser. The
reference implementation is `lib/opener-adapter.mjs`, with tests in
`test/handoff.test.mjs`.

```ts
type OpenOutcome =
  | { opened: true; profileId: string; cleanup(): Promise<void> }
  | { opened: false; reason: string };

openBootstrap(input: {
  bootstrapUrl: string;        // http://127.0.0.1:<port>/__khala/bootstrap#credential=…&channel=…
  credential: string;          // the one-time credential inside bootstrapUrl
  matrix: MatrixEntry[];       // matrix.json profiles
  handoffParent: string;       // user-owned directory, e.g. $XDG_RUNTIME_DIR/khala
  env: Record<string, string>;
}): Promise<OpenOutcome>;
```

## Rules

1. **Launch never depends on it.** The launcher always prints the manual local
   URL. Every `opened: false` is a normal outcome, and the adapter never
   throws for an environment or opener failure.
2. **Proven profiles only.** The adapter captures the runtime profile
   (`captureProfile`) itself, from the exact environment it will pass to the
   opener, so the profiled handler is the one xdg-open resolves. It opens only
   when `automaticOpenDecision` finds an exact match on every `MATCH_FIELDS`
   entry of a `proven` matrix profile. That includes whether a display is
   present. If profiling fails, or any field is missing, unknown or different,
   automatic opening is off.
3. **Private-file handoff only.** Create a fresh `0700` directory under
   `handoffParent` and write `open.html` into it with mode `0600` and
   exclusive create. The file holds only the fixed no-referrer document whose
   script calls `location.replace(<bootstrapUrl>)`. The opener argv is exactly
   `[<absolute path to open.html>]`.
4. **Fixed opener and environment.** Spawn `xdg-open` detached with `stdio`
   ignored. Pass the inherited environment with `XDG_CURRENT_DESKTOP=X-Generic`
   and `BROWSER` removed. Do not wait for the browser.
5. **Guard before spawn.** If the credential, in raw, percent-encoded or
   base64 form, appears anywhere in the opener argv or environment, refuse
   with `opened: false` and spawn nothing.
6. **Short-lived file.** The caller removes the handoff directory as soon as
   the bootstrap exchange succeeds, after a short deadline (at most the
   credential's own expiry), and on launcher shutdown, whichever comes first.
   If spawning fails, the adapter removes it immediately.
7. **Never** pass the URL or credential as argv to any process, put it in any
   environment variable, or hand it to a `BROWSER` template or
   desktop-specific opener.
