# Disposable external stack

## Goal and boundary

Run the built hosted web, generated control function, local Netlify Blobs,
disposable Dex and Synapse/Postgres, and an installed CLI packaging check through one
trusted HTTPS loopback origin. This is a local topology proof; deployed provider
behavior and the three-party canary remain separate acceptance gates.

## Implementation units

1. **Isolated process topology.** Add an `infra/preview` runner that allocates a
   unique namespace, private secret/config directory, loopback ports and CA.
   Reuse the pinned Compose images and renderers. Start Netlify Dev in a private
   network namespace because its CLI binds its proxy on all interfaces; bridge
   only owned Unix sockets to the host's loopback Docker ports. Terminate
   children and remove only the runner's Compose project and private files.
   Tests: `infra/preview/external-local.test.ts` checks origin, namespace,
   cleanup ownership and fail-closed inputs.
2. **Production artifacts and capability.** Build generated functions and web
   with the exact root Netlify configuration, package the installed CLI, and
   preflight `/api/health`, `/api/human/auth/login` redirect, direct function
   route, and a persisted auth-session record in local Blobs emulation across a function restart. Fix a discovered
   packaging/runtime seam in the narrowest module and add its focused test.
   Tests: `infra/preview/external-local.test.ts` plus the existing control
   store SDK tests.
3. **Browser and CLI handoff smoke.** Reuse the hosted human Playwright flow with
   disposable Dex identities, observer account, Matrix ciphertext inspection,
   and installed CLI `status`/`channels open` commands with a private profile.
   Expose the installed CLI and live topology descriptor to #811 for native
   connector read/write and model-visible receipt acceptance. Report named stages,
   source/artifact hashes, versions and scope names without raw process logs.
   Tests: `tests/integration/human/create-share-chat.spec.ts` and a new local
   runner integration test that rejects HTTP, fixture tokens and local auth.
4. **Docs.** Document one command and its prerequisites in
   `infra/preview/README.md`; update existing operator docs if the new command
   alters a documented interface.

## Risks and verification

- Netlify Dev's current proxy binds all interfaces. A network namespace must
  contain it; the public entry is the runner's loopback HTTPS listener.
- The Netlify CLI may select a monorepo subproject. Explicit `--filter`,
  absolute `--dir` and absolute `--functions` are required. A live probe on
  this branch established that those flags route `/api/health` to the generated
  function.
- Never enable `KHALA_LOCAL_AUTH`, reuse a Matrix device/profile, print raw
  browser/PTY/container logs, or infer success from HTTP alone.
