// Reverts each guarded line in a temporary copy of the kit and confirms the
// test suite fails.   node experiments/interactive-cli/claude-app/mutations.mjs
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname);
const MUTATIONS = [
  ['fetch acknowledges (no replay of the outstanding batch)', 'lib/store.mjs', 'if (outstanding) {', 'if (false) {'],
  ['a duplicate acknowledgement is accepted', 'lib/store.mjs', 'if (batch.ackedAt) {', 'if (false) {'],
  ['releases leave in directory order', 'lib/store.mjs', ".filter(name => name.endsWith('.json')).sort().slice", ".filter(name => name.endsWith('.json')).reverse().slice"],
  ['message body logged', 'lib/store.mjs', 'sha256: sha(message) });', 'sha256: message });'],
  ['forged HTTP session accepted', 'server/http.mjs', "if (!connection) return res.writeHead(404).end();", "if (!connection) return res.writeHead(200).end();"],
  ['notifications count as delivery (async gaps ignored)', 'verify.mjs', '  return gaps;\n}', '  return [];\n}'],
  ['undeclared or unnamed client accepted', 'verify.mjs', 'if (!expectedClients.has(name)) {', 'if (false) {'],
  ['undeclared clients or conversations still graded', 'verify.mjs', "...DECLARED_LISTS.filter(key => !Array.isArray(run[key]) || run[key].length === 0 || !run[key].every(nonEmpty)),", ''],
  ['echo accepted outside delivery..acknowledgement', 'verify.mjs', 'ack.releaseIds.includes(e.release) && firstDelivery(ack) < index.get(e) && index.get(e) < index.get(ack)', 'ack.releaseIds.includes(e.release)'],
  ['echo accepted from any conversation', 'verify.mjs', "e.observation === 'model-echo' && run.targetConversations.includes(e.conversation));", "e.observation === 'model-echo');"],
  ['mixed MCP clients accepted', 'verify.mjs', 'if (clientNames.size > 1)', 'if (false)'],
  ['acknowledgement from an unidentified connection accepted', 'verify.mjs', '&& clientOf(e.connectionId) !== null);', ');'],
  ['replay accepted without an ordered before-ack restart', 'verify.mjs', 'first < at && at < index.get(d) && opened.get(d.connectionId) > at', 'true'],
  ['after-ack restart accepted without a later read', 'verify.mjs', "(e.kind === 'empty' || e.kind === 'delivered') && index.get(e) > at && opened.get(e.connectionId) > at", 'true'],
  ['operator fields overwrite reserved log fields', 'lib/store.mjs', '      appVersion: this.run.appVersion,\n    })}', '      appVersion: this.run.appVersion,\n      ...fields,\n    })}'],
  ['stale lock never broken', 'lib/store.mjs', 'if (held && Date.now() - held.mtimeMs > STALE_LOCK_MS)', 'if (false)'],
  ['notify allowed on HTTP shapes', 'khala-admin.mjs', "if (store.run.shape !== 'desktop_extension')", 'if (false)'],
  ['shape/transport mismatch accepted', 'verify.mjs', 'if (connection.transport !== SHAPE_TRANSPORT[run.shape])', 'if (false)'],
  ['duplicate after ack accepted', 'verify.mjs', 'if (again.length)', 'if (false)'],
  ['reordering accepted', 'verify.mjs', "if (firstDelivered.join() !== arrival.slice(0, firstDelivered.length).join())", 'if (false)'],
  ['push mode unsupported without a recorded negative', 'verify.mjs', 'if (!negative) return unknown', 'if (false) return unknown'],
  ['incomplete identity still graded', 'verify.mjs', "if (missingIdentity.length) return unknown(route, `identity", "if (false) return unknown(route, `identity"],
];

let survived = 0;
for (const [name, file, from, to] of MUTATIONS) {
  const copy = mkdtempSync(join(tmpdir(), 'khala-claude-app-mutant-'));
  cpSync(root, copy, { recursive: true, filter: source => !source.includes('/evidence') });
  const path = join(copy, file);
  const text = readFileSync(path, 'utf8');
  if (!text.includes(from)) throw new Error(`guarded line not found for "${name}": ${from}`);
  writeFileSync(path, text.replace(from, to));
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=10000', join(copy, 'proof.test.mjs')], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
  });
  const failed = [...run.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]);
  const killed = run.status !== 0 && failed.length > 0;
  if (!killed) survived += 1;
  process.stdout.write(`${killed ? 'KILLED  ' : 'SURVIVED'} ${name}\n${failed.map(test => `         ✖ ${test}\n`).join('')}`);
}
process.exitCode = survived ? 1 : 0;
