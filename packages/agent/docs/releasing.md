# Releasing khala-cli

`packages/agent/npm/package.json` names the published package (`khala-cli`) and its
version. The Claude plugin version equals it, and the plugin launcher pins
`<name>@<version>`. `.github/workflows/release-npm.yml` publishes on a `v*` tag with npm
OIDC trusted publishing; there is no npm token. The step-by-step procedure is the
`release` skill (`.claude/skills/release/SKILL.md`): bump, `node
packages/agent/scripts/sync-release.mjs`, merge, tag `v<version>`, `gh release create`.

## One-time npm setup

npm configures a trusted publisher on an existing package, so the first version is
published once by hand:

```sh
npm login                                  # an npm account that will own khala-cli
git checkout main && git pull              # or the release branch before it merges
pnpm install --frozen-lockfile
cd packages/agent/npm
npm publish --access public                # prepublishOnly builds and tests first
```

Then on npmjs.com, open **khala-cli → Settings → Trusted Publisher**, choose GitHub
Actions and enter organization/user `aiur-team`, repository `khala`, workflow filename
`release-npm.yml` (no environment). Optionally set **Publishing access** to require 2FA and
disallow tokens. Check the setup without publishing:

```sh
gh workflow run release-npm.yml --repo aiur-team/khala -f channel=dry-run
```

The dry run fails if npm's OIDC exchange fails. Release the next version through the
workflow; the hand-published version needs no tag run (the workflow refuses a version that
is already on the registry).

## Renaming the package

Edit `name` in `packages/agent/npm/package.json`, run `node
packages/agent/scripts/sync-release.mjs`, and replace `khala-cli` in the install docs
(`packages/agent/README.md`, `packages/agent/npm/README.md`, `packages/agent/docs/`,
`docs/user-guide.md`, `apps/web/src/landing/public/AGENTS.md`). Tests fail while the plugin
pins disagree with `npm/package.json`.

## OpenCode plugin

`khala-opencode` is bundled from `packages/opencode-plugin/` and versioned with
`khala-cli` by `sync-release.mjs`. The same `release-npm.yml` builds/tests/packs
both packages and publishes the plugin with npm OIDC. Before U22 merges, the
operator must hand-publish a placeholder plugin version, configure its trusted
publisher for `aiur-team/khala` and `release-npm.yml`, and confirm the dry-run
workflow above. Until the package exists, the workflow skips plugin publication
with a warning. The installer uses MCP-only mode when the matching plugin
version is unavailable, so this prerequisite must be checked before shipping
plugin support. A registry lookup failure also skips publication; inspect the
workflow warning rather than treating the CLI publication as plugin success.
