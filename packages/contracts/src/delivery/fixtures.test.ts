import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import messagingIntro from '../../fixtures/messaging/exact-intro.json';
import exact from '../../fixtures/delivery/exact-release.json';
import invalid from '../../fixtures/delivery/invalid.json';
import views from '../../fixtures/delivery/views.json';
import { decodeSessionBinding } from './binding';
import {
  type ApprovalCommand, type PolicySetCommand,
  decodeApprovalCommand, decodeApprovalResult, decodePolicyAck, decodePolicySetCommand,
  sameApprovalCommandInput, samePolicySetCommandInput,
} from './commands';
import { type Decoded, decodeDeliveryLimits } from './decode';
import { decodeEventRef } from './events';
import { decodeHarnessCapabilities } from './harness';
import * as delivery from './index';
import { decodeReleasedJob, releaseFromApproval, verifyReleasedJob } from './jobs';
import { decodeDeliveryReceipt } from './receipts';

const limits = (() => {
  const decoded = decodeDeliveryLimits(exact.limits);
  if (!decoded.ok) throw new Error('fixture limits must decode');
  return decoded.value;
})();

const decoders: Record<string, (input: unknown) => Decoded<unknown>> = {
  eventRef: decodeEventRef,
  binding: decodeSessionBinding,
  approvalCommand: input => decodeApprovalCommand(input, limits),
  policySetCommand: decodePolicySetCommand,
  policyAck: decodePolicyAck,
  releasedJob: input => decodeReleasedJob(input, limits),
  receipt: decodeDeliveryReceipt,
  capabilities: decodeHarnessCapabilities,
  approvalResult: input => decodeApprovalResult(input, limits),
};

function mutate(base: unknown, set: Record<string, unknown> = {}, remove: readonly string[] = []): unknown {
  const copy = structuredClone(base) as Record<string, unknown>;
  for (const [path, value] of Object.entries(set)) {
    const keys = path.split('.');
    let target = copy;
    for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
    target[keys.at(-1) as string] = structuredClone(value);
  }
  for (const key of remove) delete copy[key];
  return copy;
}

const lookup = (path: string): unknown =>
  path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], exact);

function decoded<T>(result: Decoded<T>): T {
  if (!result.ok) throw new Error(`fixture failed at ${result.field}`);
  return result.value;
}

describe('exact release fixture', () => {
  it.each([
    ['eventRef', 'eventRef'], ['binding', 'binding'], ['approvalCommand', 'approvalCommand'],
    ['policySetCommand', 'policySetCommand'], ['policyAck', 'policyAck'], ['releasedJob', 'releasedJob'],
    ['receipt', 'receipt'], ['capabilities', 'capabilities'],
  ])('%s decodes %s and round-trips byte-stable JSON', (decoder, path) => {
    const input = lookup(path);
    const result = decoders[decoder]!(input);
    expect(result).toEqual({ ok: true, value: input });
    if (result.ok) expect(JSON.stringify(result.value)).toBe(JSON.stringify(input));
  });

  it('releases exactly the fixture job from the fixture approval', () => {
    const approval = decoded(decodeApprovalCommand(exact.approvalCommand, limits));
    const result = releaseFromApproval({
      approval,
      items: approval.selection,
      binding: decoded(decodeSessionBinding(exact.binding)),
      policyVersion: approval.expectedPolicyVersion,
      release: exact.release as Parameters<typeof releaseFromApproval>[0]['release'],
    });
    expect(result).toEqual({ ok: true, value: exact.releasedJob });
    expect(verifyReleasedJob(decoded(decodeReleasedJob(exact.releasedJob, limits)), approval))
      .toEqual({ ok: true, value: exact.releasedJob });
  });
});

describe('messaging parity', () => {
  // The delivery decoders must accept the messaging worked values unchanged, with no
  // production import across the two contract subtrees.
  it('decodes the messaging binding and event reference with delivery decoders', () => {
    expect(decodeSessionBinding(messagingIntro.binding)).toEqual({ ok: true, value: messagingIntro.binding });
    expect(decodeEventRef(messagingIntro.eventRef)).toEqual({ ok: true, value: messagingIntro.eventRef });
    expect(exact.eventRef.contentDigest).toBe(messagingIntro.encoding.contentDigest);
  });

  it('rejects a messaging unavailable event reference as an event reference', () => {
    const unavailable = messagingIntro.timelineItemUnavailable.ref;
    expect(decodeEventRef(unavailable)).toEqual({ ok: false, code: 'invalid_field', field: 'contentDigest' });
  });

  it('rejects a messaging unavailable event reference in an approval selection', () => {
    const unavailable = messagingIntro.timelineItemUnavailable.ref;
    const approval = { ...exact.approvalCommand, roomId: unavailable.roomId, selection: [unavailable] };
    expect(decodeApprovalCommand(approval, limits))
      .toEqual({ ok: false, code: 'invalid_field', field: 'selection[0].contentDigest' });
  });
});

describe('invalid fixtures', () => {
  it.each(invalid.cases)('$name', testCase => {
    const input = mutate(lookup(testCase.base), testCase.set, 'remove' in testCase ? testCase.remove : []);
    expect(decoders[testCase.decoder]!(input)).toEqual({ ok: false, ...testCase.error });
  });

  it('lists every plan peer', () => {
    const names = [...invalid.cases, ...invalid.peers.cases].map(testCase => testCase.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining([
      'wrong digest prefix',
      'digest with a trailing hex digit',
      'digest with a leading prefix',
      'empty selection',
      'selection over the configured limit',
      'duplicate event identity with another digest',
      'unavailable event ref in a selection',
      'issuedAt without a zone',
      'unsafe expected policy version',
      'approval carrying an owner ID',
      'effective ack with no observed version',
      'rejected ack with free-text error',
      'released job without approval provenance',
      'released job with a malformed binding',
      'receipt free-text error',
      'failed receipt without an error',
      'boolean existing-session claim',
      'boolean reconcile claim',
      'tested support without evidence',
      'same command ID with identical input',
      'same command ID with reordered selection',
      'same policy command ID switching to auto',
      'changed selected digest invalidates the release',
      'next binding generation invalidates the release',
      'stale policy version',
      'release to another binding',
      'same content text in a new event',
      'partial release of an approval',
      'release recorded under another approval',
      'decoded release with a changed digest',
    ]));
  });

  it('knows how to run every peer check', () => {
    const known = ['sameApprovalCommandInput', 'samePolicySetCommandInput', 'releaseFromApproval', 'verifyReleasedJob'];
    expect(invalid.peers.cases.map(peer => peer.check).filter(check => !known.includes(check))).toEqual([]);
  });

  it.each(invalid.peers.cases.filter(peer => peer.check === 'sameApprovalCommandInput'))('peer: $name', peer => {
    const base = decoded(decodeApprovalCommand(lookup(peer.base!), limits));
    const changed = decoded(decodeApprovalCommand(mutate(lookup(peer.base!), peer.set), limits));
    expect(sameApprovalCommandInput(base as ApprovalCommand, changed as ApprovalCommand)).toBe(peer.expect);
  });

  it.each(invalid.peers.cases.filter(peer => peer.check === 'samePolicySetCommandInput'))('peer: $name', peer => {
    const base = decoded(decodePolicySetCommand(lookup(peer.base!)));
    const changed = decoded(decodePolicySetCommand(mutate(lookup(peer.base!), peer.set)));
    expect(samePolicySetCommandInput(base as PolicySetCommand, changed as PolicySetCommand)).toBe(peer.expect);
  });

  it.each(invalid.peers.cases.filter(peer => peer.check === 'releaseFromApproval'))('peer: $name', peer => {
    const input = mutate({
      approval: exact.approvalCommand,
      items: structuredClone(exact.approvalCommand.selection),
      binding: exact.binding,
      policyVersion: exact.approvalCommand.expectedPolicyVersion,
      release: exact.release,
    }, peer.set) as Parameters<typeof releaseFromApproval>[0];
    expect(releaseFromApproval(input)).toEqual({ ok: false, ...peer.error });
  });

  it.each(invalid.peers.cases.filter(peer => peer.check === 'verifyReleasedJob'))('peer: $name', peer => {
    const job = decoded(decodeReleasedJob(mutate(exact.releasedJob, peer.set), limits));
    const approval = decoded(decodeApprovalCommand(exact.approvalCommand, limits));
    expect(verifyReleasedJob(job, approval)).toEqual({ ok: false, ...peer.error });
  });
});

describe('view fixtures', () => {
  it.each(views.valid)('accepts: $name', testCase => {
    const expected = 'expected' in testCase ? testCase.expected : testCase.input;
    expect(decoders[testCase.decoder]!(testCase.input)).toEqual({ ok: true, value: expected });
  });

  it.each(views.invalid)('rejects: $name', testCase => {
    expect(decoders[testCase.decoder]!(testCase.input)).toEqual({ ok: false, ...testCase.error });
  });

  it('lists every evidence route and approval outcome', () => {
    expect(views.valid.map(view => view.name)).toEqual(expect.arrayContaining([
      'Claude 2.1.276 no-setup route is unsupported',
      'Codex native CLI queue notification is tested',
      'agent-installed listener remains unsupported',
      'Codex executor Khala did not start is unknown',
      'unproven generic harness is unknown',
      'disconnect after a possible submission is outcome_unknown',
      'ambiguous persistence keeps null versions',
      'same command ID with changed input',
      'cross-owner binding',
      'changed selected content',
      'ambiguous approval keeps its operation',
    ]));
  });
});

describe('public surface', () => {
  it('does not expose fixtures or test helpers', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { exports: Record<string, string> };
    expect(Object.entries(packageJson.exports).filter(([key, target]) => /fixture/i.test(key + target))).toEqual([]);
    expect(() => readFileSync(new URL('./fixtures.ts', import.meta.url))).toThrow();
    expect(Object.keys(delivery).filter(name => /fixture|fake/i.test(name))).toEqual([]);
    const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(indexSource).not.toMatch(/from '[^']*(fixtures|\.test)/);
  });

  it('imports nothing from the messaging domain', () => {
    for (const file of ['decode.ts', 'ids.ts', 'events.ts', 'binding.ts', 'jobs.ts', 'commands.ts', 'receipts.ts', 'harness.ts']) {
      expect(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')).not.toMatch(/messaging/);
    }
  });
});
