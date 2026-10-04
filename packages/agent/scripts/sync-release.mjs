// Propagates packages/agent/npm/package.json (the single source of truth for the published
// package name and version) into the Claude plugin: the launcher pins, plugin.json and both
// marketplaces. The plugin version equals the package version. Run after changing either:
//   node packages/agent/scripts/sync-release.mjs
// `--check` only reports drift (src/release.test.ts runs the same check).
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const agent = fileURLToPath(new URL('..', import.meta.url));
const repo = fileURLToPath(new URL('../../..', import.meta.url));
const plugin = `${agent}claude-plugin/khala`;
export const files = {
  manifest: `${agent}npm/package.json`,
  launcher: `${plugin}/bin/khala`,
  plugin: `${plugin}/.claude-plugin/plugin.json`,
  devMarketplace: `${agent}claude-plugin/.claude-plugin/marketplace.json`,
  marketplace: `${repo}.claude-plugin/marketplace.json`,
  releases: `${agent}src/hooks/fixtures/claude-plugin-releases.json`,
};
/** Plugin files whose content defines a plugin release (see claude-plugin.test.ts). */
export const RELEASE_CONTENT = ['hooks/hooks.json', 'skills/khala/SKILL.md', '.mcp.json', 'bin/khala'];

export async function pluginContentHash() {
  const content = await Promise.all(RELEASE_CONTENT.map(file => fs.readFile(`${plugin}/${file}`, 'utf8')));
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const json = value => JSON.stringify(value, null, 2) + '\n';

/** Returns [file, expected text] for every synced file. */
export async function expectedFiles() {
  const { name, version } = await readJson(files.manifest);
  if (!/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name)) throw new Error(`invalid package name ${name}`);
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid version ${version}`);
  const out = [];
  const launcher = (await fs.readFile(files.launcher, 'utf8'))
    .replace(/^KHALA_PACKAGE=.*$/m, `KHALA_PACKAGE=${name}`)
    .replace(/^KHALA_VERSION=.*$/m, `KHALA_VERSION=${version}`);
  out.push([files.launcher, launcher]);
  const manifest = await readJson(files.plugin);
  out.push([files.plugin, json({ ...manifest, version })]);
  for (const file of [files.devMarketplace, files.marketplace]) {
    const market = await readJson(file);
    market.plugins = market.plugins.map(entry => entry.name === 'khala' ? { ...entry, version } : entry);
    out.push([file, json(market)]);
  }
  return { name, version, files: out };
}

async function main() {
  const check = process.argv.includes('--check');
  const { name, version, files: expected } = await expectedFiles();
  const drift = [];
  for (const [file, text] of expected) {
    if (await fs.readFile(file, 'utf8') === text) continue;
    drift.push(file);
    if (!check) await fs.writeFile(file, text);
  }
  if (!check) {
    // Record this release's plugin content; a released version's content never changes.
    const releases = await readJson(files.releases);
    const hash = await pluginContentHash();
    if (releases[version] && releases[version] !== hash) {
      throw new Error(`plugin ${version} was released with different content; bump the version in npm/package.json`);
    }
    if (!releases[version]) { releases[version] = hash; await fs.writeFile(files.releases, json(releases)); }
  }
  if (check && drift.length) {
    console.error(`out of sync with ${name}@${version}; run node packages/agent/scripts/sync-release.mjs:\n${drift.join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log(`${check ? 'in sync' : 'synced'}: ${name}@${version}`);
  }
}
if (import.meta.url === `file://${process.argv[1]}`) await main();
