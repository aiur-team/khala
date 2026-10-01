import { describe, expect, it } from 'vitest';
import { allocateNamespace, fingerprintEffectiveConfig, validateCandidate, validateJournal, verifyArtifact, writeEvidence, type Candidate, type Receipt } from '../../../scripts/acceptance/candidate';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const a = 'a'.repeat(64);
const b = 'b'.repeat(64);
const measured = { input: a, artifact: b };
function candidate(lane: Candidate['lane']): Candidate {
  return {
    lane, sourceCommit: 'a'.repeat(40), lockfileSha256: a, configSha256: a,
    components: { web: lane === 'internal' ? 'N/A' : measured, function: lane === 'internal' ? 'N/A' : measured, cli: measured, connector: lane === 'internal' ? 'N/A' : measured, hook: lane === 'internal' ? 'N/A' : measured, plugin: lane === 'internal' ? 'N/A' : measured },
    images: { service: lane === 'internal' ? 'N/A' : a }, nativeVersions: { codex: '1.2.3' },
    differences: { origin: 'https://example.test', csp: 'strict', provider: 'local' }, namespace: 'candidate-aaaaaaaaaaaaaaaaaaaaaaaa',
  };
}
const journal: Receipt[] = (['pending', 'released', 'model-consumed', 'acknowledged', 'durable-browser-visible'] as const).map((stage, index) => ({ stage, operationId: 'op1', eventId: 'ev1', bindingId: 'binding1', generation: 1, origin: index === 2 || index === 3 ? 'model' : index === 4 ? 'browser' : 'server' }));

describe('candidate evidence', () => {
  it('accepts explicit internal N/A and enumerated external origin/CSP/provider differences', () => {
    const internal = candidate('internal');
    const external = { ...candidate('external'), namespace: 'candidate-bbbbbbbbbbbbbbbbbbbbbbbb' };
    expect(() => validateCandidate(internal)).not.toThrow();
    expect(() => validateCandidate(external, internal)).not.toThrow();
  });
  it('rejects stale bundles, wrong versions, reused namespaces and build drift', () => {
    const first = candidate('external');
    const next = { ...candidate('external'), namespace: 'candidate-bbbbbbbbbbbbbbbbbbbbbbbb' };
    expect(() => validateCandidate(next, first)).not.toThrow();
    expect(() => validateCandidate({ ...next, components: { ...next.components, web: { input: a, artifact: a } } }, first)).toThrow(/build drift/);
    expect(() => validateCandidate({ ...next, components: { ...next.components, web: { input: b, artifact: b } } }, first)).toThrow(/source\/input mismatch/);
    expect(() => validateCandidate({ ...next, nativeVersions: { codex: '1.2.4' } }, first)).toThrow(/wrong native version/);
    expect(() => validateCandidate(first, first)).toThrow(/reused namespace/);
    expect(() => validateCandidate({ ...next, images: {} })).toThrow(/service-image digest/);
  });
  it('requires a model-origin receipt and one exact event/binding generation', () => {
    expect(() => validateJournal(journal)).not.toThrow();
    expect(() => validateJournal(journal.slice(0, 4))).toThrow(/missing stage/);
    expect(() => validateJournal(journal.map((r, i) => i === 2 ? { ...r, origin: 'server' } : r) as Receipt[])).toThrow(/model-origin/);
    expect(() => validateJournal(journal.map((r, i) => i === 3 ? { ...r, generation: 2 } : r))).toThrow(/identity mismatch/);
  });
  it('rejects sensitive diagnostics and allocates distinct private namespaces', () => {
    expect(() => fingerprintEffectiveConfig({ token: 'abc' })).toThrow(/sensitive/);
    expect(() => fingerprintEffectiveConfig({ origin: 'https://example.test\nAuthorization:secret' })).toThrow(/sensitive/);
    expect(() => validateJournal([{ ...journal[0]!, operationId: 'secret\nbody' }, ...journal.slice(1)])).toThrow(/sensitive/);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-test-'));
    try {
      const artifact = path.join(directory, 'bundle.tgz');
      fs.writeFileSync(artifact, 'old bytes');
      expect(() => verifyArtifact(artifact, a)).toThrow(/stale bundle/);
      const namespace = allocateNamespace(directory);
      expect(namespace).not.toBe(allocateNamespace(directory));
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
      const run = { ...candidate('internal'), namespace };
      const file = writeEvidence(directory, run, journal);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(() => writeEvidence(directory, run, journal)).toThrow(/EEXIST/);
      expect(() => writeEvidence(directory, { ...run, token: 'secret' } as Candidate, journal)).toThrow(/unexpected diagnostic/);
      const invite = { ...run, differences: { ...run.differences, origin: 'https://example.test/invite/abc' }, namespace: allocateNamespace(directory) };
      expect(() => writeEvidence(directory, invite, journal)).toThrow(/origin-only URL/);
      expect(fs.existsSync(path.join(directory, `${invite.namespace}.json`))).toBe(false);
      expect(() => validateCandidate({ ...run, nativeVersions: { codex: 'invite-token' } })).toThrow(/sensitive/);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
