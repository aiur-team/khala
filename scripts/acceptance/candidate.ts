// Portable, deliberately small evidence envelope for either local E2E lane.
// Callers supply measured digests; this module validates their relationship and
// writes only allowlisted identifiers, never the observations themselves.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';

export type Lane = 'internal' | 'external';
export type Component = 'web' | 'function' | 'cli' | 'connector' | 'hook' | 'plugin';
export type Digest = Readonly<{ input: string; artifact: string }>;
export type Candidate = Readonly<{
  lane: Lane;
  sourceCommit: string;
  lockfileSha256: string;
  components: Record<Component, Digest | 'N/A'>;
  configSha256: string;
  images: Record<string, string | 'N/A'>;
  nativeVersions: Record<string, string>;
  differences: Readonly<{ origin: string; csp: string; provider: string }>;
  namespace: string;
}>;

const sha = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40}$/;
const safe = /^[a-zA-Z0-9._/@:+-]{1,160}$/;
const namespacePattern = /^candidate-[a-f0-9]{24}$/;
const components: Component[] = ['web', 'function', 'cli', 'connector', 'hook', 'plugin'];
const hosted: Component[] = ['web', 'function', 'connector', 'hook', 'plugin'];
const allowedDifferences = new Set(['origin', 'csp', 'provider']);
const candidateKeys = ['lane', 'sourceCommit', 'lockfileSha256', 'components', 'configSha256', 'images', 'nativeVersions', 'differences', 'namespace'];

function requireSafe(value: string, name: string): void {
  if (!safe.test(value)) throw new Error(`${name}: sensitive or invalid diagnostic content`);
}
function requireDigest(value: string, name: string): void {
  if (!sha.test(value)) throw new Error(`${name}: expected sha256 digest`);
}

export function validateCandidate(candidate: Candidate, baseline?: Candidate): void {
  if (Object.keys(candidate).sort().join() !== [...candidateKeys].sort().join()) throw new Error('candidate: sensitive or unexpected diagnostic content');
  if (Object.keys(candidate.components).sort().join() !== [...components].sort().join()) throw new Error('components: unexpected diagnostic content');
  if (Object.keys(candidate.differences).sort().join() !== [...allowedDifferences].sort().join()) throw new Error('differences: non-allowlisted field');
  if (!['internal', 'external'].includes(candidate.lane)) throw new Error('invalid lane');
  if (!commit.test(candidate.sourceCommit)) throw new Error('source commit mismatch');
  requireDigest(candidate.lockfileSha256, 'lockfile');
  requireDigest(candidate.configSha256, 'effective config');
  if (!namespacePattern.test(candidate.namespace)) throw new Error('namespace: must be a private allocated run namespace');
  for (const name of components) {
    const item = candidate.components[name];
    if (item === 'N/A') {
      if (candidate.lane !== 'internal' || name === 'cli') throw new Error(`${name}: N/A is only valid for hosted internal components`);
    } else if (item && typeof item === 'object') {
      if (Object.keys(item).sort().join() !== 'artifact,input') throw new Error(`${name}: sensitive or unexpected diagnostic content`);
      requireDigest(item.input, `${name} input`);
      requireDigest(item.artifact, `${name} artifact`);
    } else throw new Error(`${name}: missing digest`);
  }
  if (candidate.lane === 'internal' && hosted.some(name => candidate.components[name] !== 'N/A')) throw new Error('internal hosted components must be N/A');
  for (const [name, value] of Object.entries(candidate.images)) {
    requireSafe(name, 'image name');
    if (value === 'N/A' && candidate.lane !== 'internal') throw new Error(`${name}: external image missing`);
    if (value !== 'N/A') requireDigest(value, `${name} image`);
  }
  if (!Object.keys(candidate.nativeVersions).length) throw new Error('missing native version');
  for (const [name, version] of Object.entries(candidate.nativeVersions)) {
    requireSafe(name, 'native name');
    requireSafe(version, `${name} native version`);
  }
  for (const field of ['origin', 'csp', 'provider'] as const) requireSafe(candidate.differences[field], field);
  if (baseline) {
    if (candidate.namespace === baseline.namespace) throw new Error('reused namespace');
    if (candidate.sourceCommit !== baseline.sourceCommit || candidate.lockfileSha256 !== baseline.lockfileSha256) throw new Error('source/input mismatch');
    for (const name of components) {
      const old = baseline.components[name];
      const current = candidate.components[name];
      if (old !== 'N/A' && current !== 'N/A' && old.input !== current.input) throw new Error(`${name} source/input mismatch`);
      if (old !== 'N/A' && current !== 'N/A' && old.artifact !== current.artifact) throw new Error(`${name} non-allowlisted build drift`);
    }
    if (candidate.configSha256 !== baseline.configSha256) throw new Error('non-allowlisted config drift');
    for (const name of new Set([...Object.keys(candidate.images), ...Object.keys(baseline.images)])) {
      if (candidate.images[name] !== baseline.images[name] && candidate.images[name] !== 'N/A' && baseline.images[name] !== 'N/A') throw new Error(`${name} non-allowlisted image drift`);
    }
    for (const name of Object.keys(baseline.nativeVersions)) if (candidate.nativeVersions[name] !== baseline.nativeVersions[name]) throw new Error(`${name} wrong native version`);
    for (const name of Object.keys(candidate.differences)) if (!allowedDifferences.has(name)) throw new Error(`${name}: non-allowlisted difference`);
  }
}

export function allocateNamespace(directory: string): string {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (;;) {
    const namespace = `candidate-${randomBytes(12).toString('hex')}`;
    try {
      fs.writeFileSync(`${directory}/${namespace}`, '', { flag: 'wx', mode: 0o600 });
      return namespace;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

export type Stage = 'pending' | 'released' | 'model-consumed' | 'acknowledged' | 'durable-browser-visible';
export type Receipt = Readonly<{ stage: Stage; operationId: string; eventId: string; bindingId: string; generation: number; origin: 'model' | 'server' | 'browser' }>;
const order: Stage[] = ['pending', 'released', 'model-consumed', 'acknowledged', 'durable-browser-visible'];

export function validateJournal(receipts: readonly Receipt[]): void {
  if (receipts.length !== order.length) throw new Error('missing stage receipt');
  receipts.forEach((receipt, index) => {
    if (Object.keys(receipt).sort().join() !== 'bindingId,eventId,generation,operationId,origin,stage') throw new Error('receipt: sensitive or unexpected diagnostic content');
    if (receipt.stage !== order[index]) throw new Error(`missing ${order[index]} stage receipt`);
    for (const field of ['operationId', 'eventId', 'bindingId'] as const) requireSafe(receipt[field], field);
    if (!Number.isSafeInteger(receipt.generation) || receipt.generation < 1) throw new Error('invalid binding generation');
    const first = receipts[0]!;
    if (index && (receipt.operationId !== first.operationId || receipt.eventId !== first.eventId || receipt.bindingId !== first.bindingId || receipt.generation !== first.generation)) throw new Error('stage identity mismatch');
    const expected = index === 2 || index === 3 ? 'model' : index === 4 ? 'browser' : 'server';
    if (receipt.origin !== expected) throw new Error(`${receipt.stage}: missing ${expected}-origin receipt`);
  });
}

export function fingerprintEffectiveConfig(config: Record<string, unknown>): string {
  const forbidden = /secret|token|password|key|credential|invite|body|ciphertext|storage|log/i;
  const entries = Object.entries(config).sort(([a], [b]) => a.localeCompare(b));
  for (const [name, value] of entries) {
    if (forbidden.test(name) || typeof value !== 'string' || !safe.test(value)) throw new Error(`effective config: sensitive or invalid diagnostic content in ${name}`);
  }
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

/** Reject a stale artifact before its digest enters a candidate manifest. */
export function verifyArtifact(file: string, expectedSha256: string): void {
  requireDigest(expectedSha256, 'artifact');
  if (createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== expectedSha256) throw new Error('stale bundle: artifact digest mismatch');
}

/** Exclusive private output; callers retain only this sanitized schema. */
export function writeEvidence(directory: string, candidate: Candidate, receipts: readonly Receipt[], baseline?: Candidate): string {
  validateCandidate(candidate, baseline);
  validateJournal(receipts);
  if (!fs.existsSync(`${directory}/${candidate.namespace}`)) throw new Error('namespace was not allocated for this run');
  const file = `${directory}/${candidate.namespace}.json`;
  fs.writeFileSync(file, `${JSON.stringify({ candidate, receipts }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return file;
}
