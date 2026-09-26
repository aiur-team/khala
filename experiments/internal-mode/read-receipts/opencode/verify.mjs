import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Assesses a retained OpenCode receipt-proof report. Every rule is a contract
// acceptance criterion; test/verify.test.mjs removes one observation at a time
// and requires failure. The report holds correlation labels and redacted
// presence/equality results only: never token bytes, digests or message bodies.

export const PROVEN_VERSION = '1.17.10';
export const PROVEN_ROUTES = [
  'opencode-plugin-tool-after-transform',
  'opencode-plugin-idle-watcher-prompt',
  'opencode-plugin-session-idle-prompt',
  'opencode-plugin-khala-read',
];
const FORBIDDEN_FLAGS = ['--dangerously-skip-permissions', '--yolo', '--auto-approve', '--pure'];

/** case name -> the redacted result it must record. */
export const REQUIRED_CASES = {
  idleBatchNoAcknowledgement: { tokenReturned: false, receiptRecorded: false },
  busyBatchNoAcknowledgement: { tokenReturned: false, receiptRecorded: false },
  noLaterCall: { tokenReturned: false, receiptRecorded: false },
  nextCallAcknowledges: { tokenReturned: true, tokenEquality: 'equal', receiptRecorded: true },
  missingToken: { tokenReturned: false, receiptRecorded: false, conformanceFailure: true },
  duplicateToken: { tokenReturned: true, tokenEquality: 'equal', receiptRecorded: true, receiptCount: 1 },
  wrongToken: { tokenReturned: true, tokenEquality: 'unequal', receiptRecorded: false },
  wrongBinding: { tokenReturned: true, tokenEquality: 'equal', receiptRecorded: false },
  wrongGeneration: { tokenReturned: true, tokenEquality: 'equal', receiptRecorded: false },
  reconnect: { tokenReturned: true, tokenEquality: 'equal', receiptRecorded: true, receiptCount: 1 },
};

const ALLOWED_CASE_FIELDS = new Set([
  'batchLabel', 'tokenReturned', 'tokenEquality', 'receiptRecorded', 'receiptCount', 'conformanceFailure', 'note',
]);
const LABEL = /^[a-z][a-z0-9-]{0,39}$/;
// Labels are kebab-case words; any other long unbroken run is token-shaped.
const KEBAB_LABEL = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const tokenShaped = text => /sha256:|[0-9a-f]{32,}/.test(text)
  || (text.length >= 24 && !/\s/.test(text) && !KEBAB_LABEL.test(text));
const SECRET_KEY = /^(?:ack)?(?:batch)?token$|digest|secret|hash/i;

/** Finds any token-shaped string or token/digest-named string field in a parsed artifact. */
export function scanForSecrets(value, path = '$') {
  const hits = [];
  if (typeof value === 'string') {
    if (tokenShaped(value)) hits.push(`${path}: token-shaped string`);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => hits.push(...scanForSecrets(item, `${path}[${index}]`)));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key) && typeof item === 'string') hits.push(`${path}.${key}: token/digest-named string`);
      hits.push(...scanForSecrets(item, `${path}.${key}`));
    }
  }
  return hits;
}

export function assess(report) {
  const failures = [];
  const fail = message => failures.push(message);

  if (report?.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (report?.startedBy !== 'user-started-tui') fail('the TUI must be user-started (an agent-launched TUI is not this proof)');
  if (report?.openCodeVersion !== PROVEN_VERSION) fail(`OpenCode must be the exact ${PROVEN_VERSION}`);
  if (!String(report?.provider ?? '').startsWith('deepseek/')) fail('the DeepSeek provider/model must be recorded');
  if (!PROVEN_ROUTES.includes(report?.route)) fail('route must be one of the recorded plugin routes');
  if (report?.surface !== 'in_process_plugin') fail('surface must be the in-process plugin');
  if (report?.trustSettings !== 'default') fail('the proof must use default trust settings');
  if (!Array.isArray(report?.trustBypassFlagsUsed) || report.trustBypassFlagsUsed.length !== 0) fail('no trust bypass flag may be used');
  for (const launch of report?.launches ?? []) {
    for (const flag of FORBIDDEN_FLAGS) if (String(launch.command).includes(flag)) fail(`launch uses ${flag}`);
    if (/\bopencode\s+(run|serve|web)\b/.test(String(launch.command))) fail('launch must be the interactive TUI');
  }
  if (report?.hostedSubstitute === true) fail('hosted proof cannot substitute for the TUI');
  if (report?.hostSideLedger !== false) fail('no host-side duplicate ledger may exist');

  const cases = report?.cases ?? {};
  for (const [name, expected] of Object.entries(REQUIRED_CASES)) {
    const observed = cases[name];
    if (!observed) { fail(`missing case ${name}`); continue; }
    if (typeof observed.batchLabel !== 'string' || !LABEL.test(observed.batchLabel)) fail(`${name}: batch correlation label required`);
    for (const [field, value] of Object.entries(expected)) {
      if (observed[field] !== value) fail(`${name}: ${field} must be ${JSON.stringify(value)}`);
    }
    for (const field of Object.keys(observed)) if (!ALLOWED_CASE_FIELDS.has(field)) fail(`${name}: field ${field} is not a redacted result`);
  }

  for (const hit of scanForSecrets(report)) fail(`secret scan: ${hit}`);

  // Unproven pairs stay unknown; only a fully passing report may raise the ceiling.
  const proved = failures.length === 0;
  if (!proved && report?.capabilityCeiling !== undefined && report.capabilityCeiling !== 'unknown') {
    fail('an unproven pair must report capabilityCeiling "unknown"');
  }
  return { proved, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node verify.mjs <report.json>'); process.exit(2); }
  const result = assess(JSON.parse(await readFile(file, 'utf8')));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.proved ? 0 : 1);
}
