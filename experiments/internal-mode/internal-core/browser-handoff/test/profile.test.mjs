import assert from 'node:assert/strict';
import test from 'node:test';
import { automaticOpenDecision, procfsHidepid, profileMismatch } from '../lib/profile.mjs';

const proven = {
  os: 'linux',
  procfsHidepid: 'off',
  opener: { implementation: 'xdg-utils xdg-open', version: '1.2.1', mode: 'generic', display: 'present' },
  handler: { mimeType: 'text/html', exec: '/usr/bin/firefox --headless --no-remote --profile <PRIVATE_BROWSER_PROFILE> %u' },
  browser: { name: 'firefox', major: '152' },
  handoff: 'private-file',
};
const matrix = [
  { id: 'unproven-same', status: 'unproven', profile: { ...proven, browser: { name: 'firefox', major: '153' } } },
  { id: 'firefox', status: 'proven', profile: proven },
];

test('an exact match with a proven profile allows automatic opening', () => {
  assert.deepEqual(automaticOpenDecision(structuredClone(proven), matrix), { open: true, profileId: 'firefox' });
});

test('automatic opening stays off when the runtime profile cannot be established', () => {
  assert.equal(automaticOpenDecision(null, matrix).open, false);
  const partial = { ...proven, opener: { ...proven.opener, version: undefined } };
  const decision = automaticOpenDecision(partial, matrix);
  assert.equal(decision.open, false);
  assert.match(decision.reason, /not established: opener\.version/);
});

test('automatic opening stays off when any match field differs from the proof', () => {
  for (const change of [
    { procfsHidepid: 'invisible' },
    { opener: { ...proven.opener, mode: 'gnome' } },
    { opener: { ...proven.opener, display: 'absent' } },
    { handler: { ...proven.handler, exec: '/usr/bin/firefox %u' } },
    { browser: { name: 'firefox', major: '153' } },
    { handoff: 'argv-url' },
  ]) {
    const decision = automaticOpenDecision({ ...proven, ...change }, matrix);
    assert.equal(decision.open, false, JSON.stringify(change));
    assert.match(decision.reason, /differs from proof/);
  }
});

test('unproven matrix entries never allow opening', () => {
  assert.equal(automaticOpenDecision(proven, [{ ...matrix[1], status: 'unproven' }]).open, false);
  assert.equal(profileMismatch(proven, proven), null);
});

test('procfs hidepid is read from the /proc mount options', () => {
  assert.equal(procfsHidepid('proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\n'), 'off');
  assert.equal(procfsHidepid('proc /proc proc rw,relatime,hidepid=invisible 0 0\n'), 'invisible');
  assert.equal(procfsHidepid('sysfs /sys sysfs rw 0 0\n'), undefined);
});
