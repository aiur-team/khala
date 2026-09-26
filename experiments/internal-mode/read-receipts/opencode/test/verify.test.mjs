import assert from 'node:assert/strict';
import test from 'node:test';
import { REQUIRED_CASES, assess, scanForSecrets } from '../verify.mjs';

// A synthetic report shaped like a passing live run. It is a fixture for the
// verifier only; it is not evidence and is never retained as one.
function passing() {
  return structuredClone({
    schemaVersion: 1,
    startedBy: 'user-started-tui',
    sessionId: 'ses_1a2b3c4d5e6f7g8h9i0j1k2l3m',
    openCodeVersion: '1.17.10',
    provider: 'deepseek/deepseek-flash',
    route: 'opencode-plugin-idle-watcher-prompt',
    surface: 'in_process_plugin',
    trustSettings: 'default',
    trustBypassFlagsUsed: [],
    launches: [{ command: 'opencode' }],
    hostedSubstitute: false,
    hostSideLedger: false,
    capabilityCeiling: 'batch_token_next_call',
    cases: Object.fromEntries(Object.entries(REQUIRED_CASES).map(([name, expected]) => [name, { batchLabel: `batch-${name.toLowerCase()}`, ...expected }])),
  });
}

const rejects = (mutate, pattern) => {
  const report = passing();
  mutate(report);
  const result = assess(report);
  assert.equal(result.proved, false, 'mutated report must not prove');
  assert.match(result.failures.join('\n'), pattern);
};

test('a complete user-started report proves', () => {
  assert.deepEqual(assess(passing()), { proved: true, failures: [] });
});

test('every required case is load-bearing', () => {
  for (const name of Object.keys(REQUIRED_CASES)) rejects(report => { delete report.cases[name]; }, new RegExp(`missing case ${name}`));
});

test('an acknowledgement recorded without the next-call token fails', () => {
  rejects(report => { report.cases.idleBatchNoAcknowledgement.receiptRecorded = true; }, /idleBatchNoAcknowledgement/);
  rejects(report => { report.cases.busyBatchNoAcknowledgement.receiptRecorded = true; }, /busyBatchNoAcknowledgement/);
  rejects(report => { report.cases.noLaterCall.receiptRecorded = true; }, /noLaterCall/);
  rejects(report => { report.cases.missingToken.receiptRecorded = true; }, /missingToken/);
  rejects(report => { report.cases.missingToken.conformanceFailure = false; }, /missingToken/);
});

test('wrong binding, generation or token that still records a receipt fails', () => {
  for (const name of ['wrongBinding', 'wrongGeneration', 'wrongToken']) {
    rejects(report => { report.cases[name].receiptRecorded = true; }, new RegExp(name));
  }
});

test('a duplicate token that creates a second receipt fails', () => {
  rejects(report => { report.cases.duplicateToken.receiptCount = 2; }, /duplicateToken/);
});

test('an honestly labelled agent-launched default-settings run proves', () => {
  const report = passing();
  report.startedBy = 'agent-launched-default-settings';
  report.launches = [{ command: 'opencode --pure' }];
  assert.deepEqual(assess(report), { proved: true, failures: [] });
});

test('the launch command and session ID are required', () => {
  rejects(report => { delete report.launches; }, /launch command/);
  rejects(report => { report.launches = []; }, /launch command/);
  rejects(report => { report.launches = [{ command: '' }]; }, /exact command/);
  rejects(report => { delete report.sessionId; }, /session ID/);
  rejects(report => { report.startedBy = 'agent-launched'; }, /honestly label/);
});

test('any --dangerously* flag is a trust bypass', () => {
  rejects(report => { report.launches = [{ command: 'opencode --dangerously-skip-permissions' }]; }, /--dangerously-skip-permissions/);
  rejects(report => { report.launches = [{ command: 'opencode --dangerously-anything' }]; }, /--dangerously-anything/);
});

test('a bypassed, hosted or wrong-version run cannot prove', () => {
  rejects(report => { report.openCodeVersion = '1.18.0'; }, /exact 1\.17\.10/);
  rejects(report => { report.route = 'opencode-plugin-busy-prompt-async'; }, /route/);
  rejects(report => { report.trustBypassFlagsUsed = ['--yolo']; }, /bypass/);
  rejects(report => { report.launches = [{ command: 'opencode run hi' }]; }, /interactive TUI/);
  rejects(report => { report.hostedSubstitute = true; }, /hosted/);
  rejects(report => { report.hostSideLedger = true; }, /ledger/);
});

test('retained artifacts never carry token bytes or reusable digests', () => {
  rejects(report => { report.cases.reconnect.ackBatchToken = 'tok'; }, /reconnect/);
  rejects(report => { report.cases.reconnect.note = 'kQ9xZ3mB7vLpR2sT8wYcD4fGhJ'; }, /secret scan/);
  rejects(report => { report.cases.reconnect.note = `sha256:${'a'.repeat(64)}`; }, /secret scan/);
  rejects(report => { report.cases.reconnect.tokenDigest = 'abc'; }, /secret scan|redacted/);
  assert.deepEqual(scanForSecrets({ batchLabel: 'batch-a', tokenReturned: true }), []);
});

test('an unproven report cannot advertise a ceiling above unknown', () => {
  rejects(report => { delete report.cases.reconnect; }, /capabilityCeiling/);
});
