---
name: release
description: "Release a new version of the khala CLI (npm package khala-cli) and the Claude plugin that pins it: bump packages/agent/npm/package.json, sync the plugin, tag v<version>, push the tag and create a GitHub Release; the release-npm workflow publishes. Use for /release, 'release khala', 'publish khala-cli', 'bump the khala version' or 'tag a release'."
---

# Release khala-cli

`packages/agent/npm/package.json` is the single source of truth for the published package
name and version. The Claude plugin version equals the package version, and its launcher
(`packages/agent/claude-plugin/khala/bin/khala`) pins `<name>@<version>`. Pushing a `v*`
tag runs `.github/workflows/release-npm.yml`, which builds, smokes and publishes with npm
OIDC trusted publishing. Nobody runs `npm publish` by hand after the one-time bootstrap
(see `packages/agent/docs/releasing.md`).

## 1. Pre-flight

```bash
git status --porcelain          # must be empty
git branch --show-current       # should be main
git fetch origin && git status -sb
git describe --tags --abbrev=0 2>/dev/null
node -p "require('./packages/agent/npm/package.json').version"
```

Show the current version, latest tag and commits since it. Block on a dirty tree.

## 2. Pick the version

Next semver after the current one (`x.y.z`, no `v`). Check it is free:

```bash
git tag -l "v<version>"
npm view khala-cli@<version> version   # must print nothing
```

## 3. Bump and sync

```bash
node -e 'const f="packages/agent/npm/package.json";const p=require("./"+f);p.version=process.argv[1];require("fs").writeFileSync(f,JSON.stringify(p,null,2)+"\n")' <version>
node packages/agent/scripts/sync-release.mjs
pnpm --filter @khala/agent test
pnpm --filter @khala/agent build
(cd packages/agent/npm && npm pack --pack-destination /tmp) && node packages/agent/scripts/smoke-package.mjs /tmp/khala-cli-<version>.tgz
```

`sync-release.mjs` rewrites the launcher pins, `plugin.json`, both marketplaces and records
the plugin content hash in `src/hooks/fixtures/claude-plugin-releases.json`. Commit as
`chore(release): khala-cli <version>` and merge it to `main` through a PR.

## 4. Tag and release

From the merged `main`:

```bash
git tag -a v<version> -m "khala-cli <version>"
git push origin v<version>
gh release create v<version> --generate-notes --title "v<version>" --repo aiur-team/khala
```

The tag must equal the package version or the workflow stops in `setup`.

## 5. Watch the publish

```bash
gh run list --workflow release-npm.yml --repo aiur-team/khala --limit 3
gh run watch <run-id> --repo aiur-team/khala
npm view khala-cli version
```

The publish job polls the registry for up to five minutes. Friends pick the new plugin up
with `claude plugin marketplace update khala` and `claude plugin update khala@khala`, then a
restart; Codex users re-run `npx -y khala-cli@latest install codex`.

## Dry run

`gh workflow run release-npm.yml --repo aiur-team/khala -f channel=dry-run` builds, smokes
and runs `npm publish --dry-run`, failing if npm's OIDC exchange fails (trusted publisher
not configured).

## Re-release (same version)

npm never accepts a version twice. If the publish failed before upload, delete and re-push
the tag; if it published, bump to the next patch instead.

```bash
gh release delete v<version> --repo aiur-team/khala --yes
git tag -d v<version> && git push origin :refs/tags/v<version>
```
