// Retained-artifact secret scan for the Claude read-receipt run. Artifacts may hold
// non-secret correlation labels and redacted presence/equality results only: never
// token bytes, reusable digests of tokens, or message content.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const TOKEN_LINE = /batchToken/i;
// Long unbroken base64url/hex runs are how a token or a digest of one would appear.
const OPAQUE_RUN = /[A-Za-z0-9_-]{32,}/;
const DIGEST = /sha-?(1|256|384|512)[:=-]?[0-9a-f]{16,}/i;
const ALLOWED_KEYS = new Set([
  'label', 'present', 'equal', 'result', 'scenario', 'route', 'version', 'claudeCodeVersion', 'capturedAt', 'platform',
  'scenarios', 'provenPairs', 'limitations', 'status', 'ordinaryUserStartedCli',
]);

/** Returns the findings for one artifact's text; each names a rule and location, never the matched bytes. */
export function scanText(name, text, canaries = []) {
  const findings = [];
  for (const [index, line] of text.split('\n').entries()) {
    const where = `${name}:${index + 1}`;
    if (TOKEN_LINE.test(line)) findings.push({ where, rule: 'batch-token-line' });
    if (DIGEST.test(line)) findings.push({ where, rule: 'reusable-digest' });
    if (OPAQUE_RUN.test(line)) findings.push({ where, rule: 'opaque-run' });
    for (const canary of canaries) if (canary !== '' && line.includes(canary)) findings.push({ where, rule: 'canary' });
  }
  if (name.endsWith('.json')) {
    try { collectKeys(JSON.parse(text), findings, name); } catch { findings.push({ where: name, rule: 'invalid-json' }); }
  }
  return findings;
}

function collectKeys(value, findings, name) {
  if (Array.isArray(value)) { for (const item of value) collectKeys(item, findings, name); return; }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (!ALLOWED_KEYS.has(key)) findings.push({ where: `${name}#${key}`, rule: 'unexpected-key' });
    collectKeys(child, findings, name);
  }
}

export async function scanDirectory(dir, canaries = []) {
  const findings = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(json|txt|log)$/.test(entry.name)) continue;
    findings.push(...scanText(entry.name, await readFile(join(dir, entry.name), 'utf8'), canaries));
  }
  return findings;
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const findings = await scanDirectory(process.argv[2] ?? new URL('.', import.meta.url).pathname, process.argv.slice(3));
  for (const finding of findings) console.error(`${finding.where}: ${finding.rule}`);
  process.exit(findings.length === 0 ? 0 : 1);
}
