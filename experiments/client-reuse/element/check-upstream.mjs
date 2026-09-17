import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const revision = 'f2e247684496637f80e73805442e7d8e99f68548';
const files = [
  'apps/web/src/components/structures/LoggedInView.tsx',
  'packages/module-api/src/api/navigation.ts',
  'packages/module-api/src/api/builtins.ts',
  'packages/module-api/README.md', 'README.md',
  'LICENSE-AGPL-3.0', 'LICENSE-GPL-3.0', 'LICENSE-COMMERCIAL',
];
const sources = {};
for (const file of files) {
  const response = await fetch(`https://raw.githubusercontent.com/element-hq/element-web/${revision}/${file}`, { signal: AbortSignal.timeout(15000) });
  assert(response.ok, `Source unavailable: ${file}`);
  sources[file] = await response.text();
}
const host = sources[files[0]];
assert(host.includes('pageElement = moduleRenderer();'));
assert(host.includes('<SpacePanel />\n                    {leftPanel}\n                    {roomView}'));
assert(sources[files[1]].includes('registerLocationRenderer'));
assert(sources[files[2]].includes('renderRoomView'));
const result = { revision, recorded_at: new Date().toISOString(), source_checks: 'pass', runtime_host: 'not-tested', files: Object.fromEntries(Object.entries(sources).map(([file, text]) => [file, { sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) }])) };
await writeFile('source-evidence.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
