# Report: default-browser handoff and the launch token

Contract: `browser-handoff-spike` (`docs/product/internal-mode/internal-core.md`
§10, decision 13). The evidence was recorded on 2026-09-25. Canaries, home
paths and trial paths are redacted in the retained JSON.

## Question

The launcher hands the browser a bootstrap URL with a one-time credential in the
fragment: `http://127.0.0.1:<port>/__khala/bootstrap#credential=…&channel=…`.
Can a different, unprivileged local user read that credential from launcher,
opener or browser process metadata while the handoff happens?

## Method

- **Separate OS user.** The observer runs as uid 65534 in a container that
  shares the host PID namespace: `--pid=host --network=none
  --user=65534:65534 --cap-drop=ALL --security-opt=no-new-privileges` (image
  `mcr.microsoft.com/playwright:v1.63.0-noble`, used only for its Node). The
  evidence records its effective capability set as `0000000000000000` and its
  uid as distinct from the launcher's (1000). This is the view any other local
  account has through `/proc`.
- **Three layers.** On every sweep the observer reads `cmdline`, `comm` and
  `status` for every process on the host, plus per-thread `comm` and an
  `environ` read attempt for every process in the launcher's tree. It sweeps
  continuously from before the opener starts until after the browser is
  killed, which is roughly 190–290 full sweeps per trial. The launcher is the
  runner process. The opener is `/usr/bin/xdg-open`. The browser is every
  process of the resolved handler. The proof requires each layer to be
  observed in every trial. xdg-open waits on the browser it starts, so both
  stay alive for the whole handoff and are always observed.
- **Sampling limit.** Polling `/proc` can miss very short-lived processes, and
  it did miss xdg-open's millisecond helpers (`xdg-mime`, `file`, `sed`). They
  do not weaken the result. In the private-file handoff, the credential is
  never in any argument or environment value passed to any process. xdg-open
  receives only the path, so anything it derives or forwards contains at most
  that path. Only two processes read the file's contents: `file --mime-type`
  (which prints a MIME type) and the browser (observed for its whole life).
- **Canary and negative control.** Each trial uses a fresh random canary as
  the credential and scans for its raw, percent-encoded and base64 forms. Each
  profile runs 5 negative-control trials (`argv-url`, the conventional
  handoff) interleaved with 5 trials of the selected handoff. A profile counts
  only if the observer caught the negative-control leak in every control
  trial, which proves the observer is not blind.
- **Real delivery.** A fake loopback server with the bootstrap shape records
  whether the browser posted the exact canary. A handoff that leaks nothing
  but also delivers nothing fails.
- **Real opener, isolated handler.** The real xdg-open resolves the handler
  from an isolated `XDG_CONFIG_HOME`/`XDG_DATA_HOME`. That handler is a private
  desktop entry for the browser with a fresh profile directory. The run sets
  `XDG_CURRENT_DESKTOP=X-Generic` (xdg-open's generic mime path) and removes
  `BROWSER`. A display is present: without one, generic xdg-open skips the mime
  handler for `run-mailcap`, `mimeopen` or a built-in browser list.

## Results

| Profile | Handoff | Trials | Delivered | Credential observed cross-user |
|---|---|---|---|---|
| Chromium 150 headless | `argv-url` (control) | 5 | 5 | **5/5**: `cmdline` of xdg-open and of the browser main process |
| Chromium 150 headless | `private-file` | 5 | 5 | **0/5** |
| Firefox 152 headless | `argv-url` (control) | 5 | 5 | **5/5**: `cmdline` of xdg-open, of the browser main process, and of a forked child that inherited its argv |
| Firefox 152 headless | `private-file` | 5 | 5 | **0/5** |

Other observations, across all trials:

- `environ` of every process in the launcher's tree returned `EACCES` to the
  observer, all 39,495 attempts.
- The private handoff directory and file returned `EACCES` while they existed
  (1,156 probes) and `ENOENT` after cleanup. They were never readable or
  listable.
- The bootstrap exchange completed in 221–237 ms (Chromium) and
  1,120–1,253 ms (Firefox) after the opener started. The handoff file was
  deleted right after.
- In the controls, the URL appeared only where the browser's own startup argv
  was visible. For Chromium that was the main process. For Firefox it was the
  main process and a process forked (without exec) under a `-contentproc`
  process, which kept the main process's argv. Neither browser put the
  navigated URL into the argv of any exec'd renderer, zygote, GPU, utility or
  content process.

**Conclusion.** The conventional default-browser handoff exposes the launch
token to every local user and is rejected. The private-file handoff keeps it out
of launcher, opener and browser process metadata on both proven profiles.

## Supported-environment matrix

`matrix.json` is authoritative. `lib/profile.mjs` `MATCH_FIELDS` lists the
fields a runtime must match exactly.

| Profile id | Status | OS / procfs | Opener | Handler exec (`text/html`) | Handoff |
|---|---|---|---|---|---|
| `linux-xdg-open-generic-chromium150-headless` | **proven** | Linux, `hidepid` off | xdg-utils `xdg-open` 1.2.1, generic, display present | `/usr/bin/chromium --headless=new --user-data-dir=<PRIVATE_BROWSER_PROFILE> %U` | `private-file` |
| `linux-xdg-open-generic-firefox152-headless` | **proven** | Linux, `hidepid` off | xdg-utils `xdg-open` 1.2.1, generic, display present | `/usr/bin/firefox --headless --no-remote --profile <PRIVATE_BROWSER_PROFILE> %u` | `private-file` |
| `any-argv-url` | **rejected** | any | any | any | URL as argv |
| `linux-headful-default-browser` | unproven | Linux | xdg-open | the user's own handler, e.g. `/usr/bin/chromium %U` | `private-file` |
| `linux-xdg-open-desktop-specific` | unproven | Linux | gio / kde-open / exo-open via a named desktop | — | — |
| `linux-procfs-hidepid` | unproven | Linux, `hidepid=invisible`/`noaccess` | — | — | — |
| `macos-open`, `windows` | unproven | — | — | — | — |

## What this does not prove

- **The operator's own desktop default browser.** Both proven profiles use a
  headless browser from an isolated desktop entry, so running them opened no
  window on the operator's desktop. The mechanism under test is the same for
  a headful handler: xdg-open forwards only a path, and the browser navigates
  in-process. But a runtime whose handler is `/usr/bin/chromium %U` does not
  match either proven `handler.exec`, so automatic opening stays **off** for
  it. **As of this proof, no real user's default-browser configuration turns
  on automatic opening.** Every real launch prints the manual URL. The next
  step is to run `run.mjs --exec` with a headful entry where a window is
  acceptable, then add that profile.
- **An already-running browser.** Every trial started a fresh browser
  instance. A handler that forwards the path to a running instance over IPC
  is a different invocation path and needs its own proof.
- Desktop-specific openers, `hidepid` mounts, macOS and Windows (not tested and
  not claimed).
- On-disk browser state (history, session restore) is owned by the launching
  user and outside process metadata. The bootstrap page clears the fragment
  with `history.replaceState`, and the credential is single-use.
- Same-user and root observers are out of scope: they can read any process's
  memory.
