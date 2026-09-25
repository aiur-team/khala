# Browser handoff process-metadata proof

Can `khala internal` open the default browser without another local OS user
reading the fragment launch credential from process metadata? This spike answers
that with real processes observed from a separate unprivileged OS user.

- **Result:** the conventional handoff (`xdg-open '<url>#credential=…'`) leaks.
  The credential appeared in both xdg-open's and the browser's
  `/proc/<pid>/cmdline` in every negative-control trial. The selected
  **private-file** handoff was clean in every trial. It passes only the path of
  a 0600 HTML file in a fresh 0700 directory, and the browser navigates to the
  fragment URL in-process.
- **Supported environments:** two exact Linux profiles (xdg-open 1.2.1 in
  generic mode, headless Chromium 150 or Firefox 152). See
  [`report.md`](report.md) and [`matrix.json`](matrix.json). Every other
  environment keeps automatic opening off.
- **Launcher seam:** [`adapter-contract.md`](adapter-contract.md), with a
  reference implementation in `lib/opener-adapter.mjs`. Whatever this spike
  finds, the launcher prints the local URL for manual opening, so launch is
  never blocked on it.

The harness has no product-package imports. Its fake loopback server mirrors
the `authenticated-loopback-server` bootstrap shape: the credential arrives only
in the fragment and is exchanged by a same-origin POST.

## Validate retained evidence

From the repository root, using Node 22.23.2 or 24.18.0 on Linux:

```sh
node --test experiments/internal-mode/internal-core/browser-handoff/test/*.test.mjs
node experiments/internal-mode/internal-core/browser-handoff/verify.mjs
```

The unit tests run the real trial pipeline with stand-in opener and browser
processes and a same-user observer. They need no Docker and no browser. The
**wrong-implementation test** (`test/trial.test.mjs`) passes the canary URL
directly as opener argv and requires the harness to detect the leak and fail the
trial.

## Repeat the live proof

This needs Docker (to run the observer as uid 65534), `xdg-open`, and the
browser under test:

```sh
cd experiments/internal-mode/internal-core/browser-handoff
node run.mjs --browser chromium --trials 5 --out evidence/linux-xdg-open-generic-chromium.json
node run.mjs --browser firefox  --trials 5 --out evidence/linux-xdg-open-generic-firefox.json
```

Each run builds an isolated XDG config whose `text/html` and `http(s)` handler
is a private desktop entry. The run never touches the operator's browser
profile or default-handler settings. Each trial uses a fresh canary, a fresh
browser profile and a fresh fake server. The run exits non-zero unless
`verify.mjs` accepts the evidence. To prove another invocation path, pass
`--exec` with a `{profile}` placeholder that isolates the browser, for example a
headful entry on a machine where a window may appear:

```sh
node run.mjs --browser chromium --exec '/usr/bin/chromium --user-data-dir={profile} %U' --out evidence/<id>.json
```

Then add a `proven` entry with the resulting profile to `matrix.json`.
`verify.mjs` fails if that entry's profile differs from its evidence.
