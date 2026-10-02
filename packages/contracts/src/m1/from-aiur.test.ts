import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mapAiurEvent } from './from-aiur';
import { decodeChannelEvent, formatChannelEventLine } from './channel-event';
import branchPush from '../../fixtures/aiur-events/branch-push.json';
import prOpenedDraft from '../../fixtures/aiur-events/pr-opened-draft.json';
import prReadyForReview from '../../fixtures/aiur-events/pr-ready-for-review.json';
import prMerged from '../../fixtures/aiur-events/pr-merged.json';
import prReviewChangesRequested from '../../fixtures/aiur-events/pr-review-changes-requested.json';
import issueCommented from '../../fixtures/aiur-events/issue-commented.json';
import ciPassed from '../../fixtures/aiur-events/ci-passed.json';
import ciFailed from '../../fixtures/aiur-events/ci-failed.json';
import alertPrParkedReady from '../../fixtures/aiur-events/alert-pr-parked-ready.json';
import alertAgentAttention from '../../fixtures/aiur-events/alert-agent-attention.json';
import agentBlocked from '../../fixtures/aiur-events/agent-blocked.json';
import agentPaused from '../../fixtures/aiur-events/agent-paused.json';
import wakePrOpened from '../../fixtures/aiur-events/wake-pr-opened.json';
import systemBranchPush from '../../fixtures/aiur-events/system-branch-push.json';
import unknownClass from '../../fixtures/aiur-events/unknown-class.json';

const options = { ticketLabel: (id: string) => `AIUR-${id}` };
const cases = [
  { name: 'branch-push', fixture: branchPush, expected: {"v": 1, "kind": "branch.push", "summary": "pushed 3f9c2ab", "status": "info", "subject": {"ticket": "AIUR-395", "sha": "3f9c2ab0d1", "branch": "feat/events-cursor", "repo": "aiur-team/aiur"}, "source": {"system": "aiur", "topic": "ticket.395.branch.push", "event_id": "88123"}, "key": "aiur:88123", "body": "AIUR-395 pushed 3f9c2ab · feat/events-cursor"} },
  { name: 'pr-opened-draft', fixture: prOpenedDraft, expected: {"v": 1, "kind": "pr.opened", "summary": "draft PR #412 opened", "status": "info", "subject": {"ticket": "AIUR-395", "pr": 412, "sha": "3f9c2ab0d1", "branch": "feat/events-cursor", "repo": "aiur-team/aiur"}, "source": {"system": "aiur", "topic": "ticket.395.pr.opened", "event_id": "88123"}, "actor": "kweaver", "url": "https://github.com/aiur-team/aiur/pull/412", "occurred_at": "2026-10-01T10:09:00.000Z", "key": "pr:aiur-team/aiur:opened:412:3f9c2ab0d1", "body": "AIUR-395 draft PR #412 opened · feat/events-cursor"} },
  { name: 'pr-ready-for-review', fixture: prReadyForReview, expected: {"v": 1, "kind": "pr.ready_for_review", "summary": "review requested", "status": "pending", "subject": {"ticket": "AIUR-395", "pr": 412, "sha": "3f9c2ab0d1", "branch": "feat/events-cursor", "repo": "aiur-team/aiur"}, "source": {"system": "aiur", "topic": "ticket.395.pr.ready_for_review", "event_id": "88123"}, "actor": "kweaver", "url": "https://github.com/aiur-team/aiur/pull/412", "occurred_at": "2026-10-01T10:09:00.000Z", "key": "pr:aiur-team/aiur:ready_for_review:412:3f9c2ab0d1", "body": "AIUR-395 review requested · feat/events-cursor"} },
  { name: 'pr-merged', fixture: prMerged, expected: {"v": 1, "kind": "pr.merged", "summary": "PR #412 merged", "status": "success", "subject": {"ticket": "AIUR-395", "pr": 412, "sha": "3f9c2ab0d1", "branch": "feat/events-cursor", "repo": "aiur-team/aiur"}, "source": {"system": "aiur", "topic": "ticket.395.pr.merged", "event_id": "88123"}, "actor": "kweaver", "url": "https://github.com/aiur-team/aiur/pull/412", "occurred_at": "2026-10-01T10:09:00.000Z", "key": "pr:aiur-team/aiur:closed:412:3f9c2ab0d1", "body": "AIUR-395 PR #412 merged · feat/events-cursor"} },
  { name: 'pr-review-changes-requested', fixture: prReviewChangesRequested, expected: {"v": 1, "kind": "pr.review_comment", "summary": "changes requested by octocat", "status": "failure", "subject": {"ticket": "AIUR-395", "pr": 412}, "source": {"system": "aiur", "topic": "ticket.395.pr.review_comment", "event_id": "88123"}, "actor": "octocat", "url": "https://github.com/aiur-team/aiur/pull/412#pullrequestreview-9876", "key": "aiur:88123", "body": "AIUR-395 changes requested by octocat · PR #412"} },
  { name: 'issue-commented', fixture: issueCommented, expected: {"v": 1, "kind": "issue.commented", "summary": "comment by octocat", "status": "info", "subject": {"ticket": "AIUR-395"}, "source": {"system": "aiur", "topic": "ticket.395.issue.commented", "event_id": "88123"}, "actor": "octocat", "url": "https://github.com/aiur-team/aiur/issues/395#issuecomment-9877", "key": "aiur:88123", "body": "AIUR-395 comment by octocat"} },
  { name: 'ci-passed', fixture: ciPassed, expected: {"v": 1, "kind": "ci.passed", "summary": "CI passed", "status": "success", "subject": {"ticket": "AIUR-395", "pr": 412, "sha": "3f9c2ab0d1"}, "source": {"system": "aiur", "topic": "ticket.395.ci.passed", "event_id": "88123"}, "key": "ci:395:passed:3f9c2ab0d1", "body": "AIUR-395 CI passed · PR #412"} },
  { name: 'ci-failed', fixture: ciFailed, expected: {"v": 1, "kind": "ci.failed", "summary": "CI failed: test", "status": "failure", "subject": {"ticket": "AIUR-395", "pr": 412, "sha": "3f9c2ab0d1"}, "source": {"system": "aiur", "topic": "ticket.395.ci.failed", "event_id": "88123"}, "key": "ci:395:failed:3f9c2ab0d1", "body": "AIUR-395 CI failed: test · PR #412"} },
  { name: 'alert-pr-parked-ready', fixture: alertPrParkedReady, expected: {"v": 1, "kind": "pr.parked_ready", "summary": "ready to merge", "status": "pending", "subject": {"ticket": "AIUR-395"}, "source": {"system": "aiur", "topic": "ticket.395.pr.parked_ready"}, "body": "AIUR-395 ready to merge"} },
  { name: 'alert-agent-attention', fixture: alertAgentAttention, expected: {"v": 1, "kind": "agent.attention.ci", "summary": "CI needs attention", "status": "attention", "subject": {"ticket": "AIUR-395"}, "source": {"system": "aiur", "topic": "ticket.395.agent.attention.ci"}, "body": "AIUR-395 CI needs attention"} },
  { name: 'agent-blocked', fixture: agentBlocked, expected: {"v": 1, "kind": "agent.blocked", "summary": "Waiting on contract", "status": "attention", "subject": {"ticket": "AIUR-395"}, "source": {"system": "aiur", "topic": "ticket.395.agent.blocked", "event_id": "88123"}, "key": "aiur:88123", "body": "AIUR-395 Waiting on contract"} },
  { name: 'agent-paused', fixture: agentPaused, expected: {"v": 1, "kind": "agent.paused", "summary": "paused", "status": "attention", "subject": {"ticket": "AIUR-395"}, "source": {"system": "aiur", "topic": "ticket.395.agent.paused", "event_id": "88123"}, "key": "aiur:88123", "body": "AIUR-395 paused"} },
  { name: 'wake-pr-opened', fixture: wakePrOpened, expected: {"v": 1, "kind": "pr.opened", "summary": "draft PR #412 opened", "status": "info", "subject": {"ticket": "AIUR-395", "pr": 412, "sha": "3f9c2ab0d1"}, "source": {"system": "aiur", "topic": "ticket.395.pr.opened", "event_id": "88123"}, "occurred_at": "2026-10-01T10:09:00.000Z", "key": "aiur:88123", "body": "AIUR-395 draft PR #412 opened · PR #412"} },
  { name: 'system-branch-push', fixture: systemBranchPush, expected: null },
  { name: 'unknown-class', fixture: unknownClass, expected: {"v": 1, "kind": "foo.bar", "summary": "foo bar", "status": "info", "subject": {"ticket": "AIUR-9"}, "source": {"system": "aiur", "topic": "ticket.9.foo.bar", "event_id": "88123"}, "key": "aiur:88123", "body": "AIUR-9 foo bar"} },
] as const;

describe('mapAiurEvent', () => {
  it.each(cases)('maps $name exactly', ({ fixture, expected }) => {
    const result = mapAiurEvent(fixture, options);
    expect(result).toEqual(expected);
    if (result) expect(decodeChannelEvent(result).ok).toBe(true);
  });
  it('formats the ready-for-review example and preserves its link', () => {
    const result = mapAiurEvent(prReadyForReview, options)!;
    expect(formatChannelEventLine(result)).toBe('AIUR-395 review requested · feat/events-cursor');
    expect(result.url).toBe('https://github.com/aiur-team/aiur/pull/412');
  });
  it('deduplicates lifecycle records by action and normalized head', () => {
    const result = mapAiurEvent(prReadyForReview, options)!;
    expect(mapAiurEvent(prReadyForReview, options)?.key).toBe(result.key);
    expect(mapAiurEvent({ ...prReadyForReview, pr: { ...prReadyForReview.pr, head: { ...prReadyForReview.pr.head, sha: 'abcdef1234' } } }, options)?.key).not.toBe(result.key);
    const wake = { ...wakePrOpened, repo: 'aiur-team/aiur' };
    expect(mapAiurEvent(wake, options)?.key).toBe(mapAiurEvent(prOpenedDraft, options)?.key);
    expect(mapAiurEvent({ ...wake, action: undefined }, options)?.key).toBe(mapAiurEvent(prOpenedDraft, options)?.key);
    expect(mapAiurEvent({ ...wake, action: 'merged' }, options)?.key).toBe(mapAiurEvent(prOpenedDraft, options)?.key);
  });
  it('never reads comment bodies, copied messages or failure excerpts', () => {
    for (const fixture of [prReviewChangesRequested, issueCommented, ciFailed]) {
      const result = mapAiurEvent(fixture, options);
      expect(result).not.toBeNull();
      const output = JSON.stringify(result);
      expect(output).not.toContain('ignore previous');
      expect(output).not.toContain('Diagnose this failure');
      expect(output).not.toContain('SECRET failing assertion');
      const forbidden = { ...fixture };
      Object.defineProperty(forbidden, 'message', { get: () => { throw new Error('message read'); } });
      Object.defineProperty(forbidden, 'failure_excerpt', { get: () => { throw new Error('excerpt read'); } });
      if ('comment' in fixture) {
        Object.defineProperty(forbidden, 'comment', { value: { ...fixture.comment, get body() { throw new Error('body read'); } } });
      }
      expect(mapAiurEvent(forbidden, options)).toEqual(result);
    }
  });
  it('uses review submission IDs and the PR URL number, never the ticket or review context', () => {
    const result = mapAiurEvent(prReviewChangesRequested, { ...options, repo: 'aiur-team/aiur' });
    expect(result?.subject?.pr).toBe(412);
    expect(result?.key).toBe('review:aiur-team/aiur:412:9876');
    expect(mapAiurEvent({ ...prReviewChangesRequested, comment: { ...prReviewChangesRequested.comment, state: 'APPROVED' } })?.status).toBe('success');
    expect(mapAiurEvent({ ...prReviewChangesRequested, comment: { ...prReviewChangesRequested.comment, state: undefined, pull_request_url: undefined } })?.subject?.pr).toBeUndefined();
  });
  it('maps unknown classes safely without reading their message', () => {
    expect(mapAiurEvent({ ...unknownClass, topic: 'ticket.9.foo..bar' })?.kind).toBe('custom.unknown');
    expect(mapAiurEvent({ topic: `ticket.9.${'x'.repeat(129)}` })?.kind).toBe('custom.unknown');
    expect(mapAiurEvent({ topic: 'executor.wake' })).toBeNull();
    expect(mapAiurEvent({ topic: 'system.main.branch.push' })).toBeNull();
  });
  it('handles attention state and ticketless agent alerts', () => {
    expect(mapAiurEvent({ ...alertAgentAttention, needs_attention: false })?.status).toBe('info');
    expect(mapAiurEvent({ ...alertAgentAttention, topic: 'ticket.395.agent.attention.ci.resolved' })?.status).toBe('info');
    expect(mapAiurEvent({ ...alertAgentAttention, topic: 'agent.attention.ci' }, options)?.subject?.ticket).toBe('AIUR-395');
    expect(mapAiurEvent({ topic: 'agent.unblocked' })?.status).toBe('success');
    expect(mapAiurEvent({ topic: 'agent.pause.request' })?.status).toBe('attention');
    expect(mapAiurEvent({ topic: 'agent.progress.checkin' })?.summary).toBe('progress checkin');
  });
  it.each([null, [], 'x', {}, { topic: 5 }, { topic: 'ticket.1.pr.opened', pr: 'nope' }, new Date()])('rejects malformed input without throwing: %s', input => {
    expect(() => mapAiurEvent(input)).not.toThrow();
    expect(mapAiurEvent(input)).toBeNull();
  });
  it('contains failures from proxies and caller-provided label functions', () => {
    expect(mapAiurEvent({ get topic() { throw new Error('getter'); } })).toBeNull();
    expect(mapAiurEvent(new Proxy({}, { getPrototypeOf() { throw new Error('proxy'); } }))).toBeNull();
    expect(mapAiurEvent(prReadyForReview, { ticketLabel() { throw new Error('label'); } })).toBeNull();
  });
  it('omits invalid optional metadata while retaining the event', () => {
    const result = mapAiurEvent({
      ...prReadyForReview, id: 'x'.repeat(65), timestamp: 'bad date',
      pr: { ...prReadyForReview.pr, number: -1, html_url: 'http://github.com/aiur-team/aiur/pull/412',
        head: { ref: '🙂'.repeat(64), sha: 'not-a-sha' }, base: { repo: { full_name: 'bad repo' } },
        user: { login: '\u202eunsafe' } },
    }, { ticketLabel: () => 'x'.repeat(65) })!;
    expect(result).not.toBeNull();
    expect(result.subject).toEqual({});
    for (const field of ['url', 'actor', 'key', 'occurred_at']) expect(result).not.toHaveProperty(field);
    expect(result.source).not.toHaveProperty('event_id');
    expect(mapAiurEvent({ topic: `ticket.1.${'x'.repeat(260)}` })?.source).toEqual({ system: 'aiur' });
    expect(mapAiurEvent({ topic: 'ticket.1.branch.push', ref: 'refs/tags/v1' })?.subject?.branch).toBeUndefined();
  });
  it('normalizes safe text, timestamps and fallback IDs', () => {
    const result = mapAiurEvent({ topic: 'ticket.1.agent.blocked', id: -1, event_id: 'fallback', message: '  waiting\n\tfor\u0001 contract  ', occurred_at: 'bad', ticket_observation: { occurred_at: '2026-10-01T10:09:00Z' } });
    expect(result?.summary).toBe('waiting for contract');
    expect(result?.source?.event_id).toBe('fallback');
    expect(result?.occurred_at).toBe('2026-10-01T10:09:00.000Z');
    const truncated = mapAiurEvent({ topic: 'agent.blocked', message: '🙂'.repeat(201) })?.summary;
    expect([...truncated!]).toHaveLength(200);
    expect(truncated?.endsWith('…')).toBe(true);
  });
  it('retains valid metadata when the formatted line needs summary truncation', () => {
    const result = mapAiurEvent({ topic: 'ticket.395.agent.blocked', message: '🙂'.repeat(200), ref: 'x'.repeat(255) }, options);
    expect(result).not.toBeNull();
    expect(result?.subject).toEqual({ ticket: 'AIUR-395', branch: 'x'.repeat(255) });
    expect(result?.summary.endsWith('…')).toBe(true);
    expect(Buffer.byteLength(result!.body)).toBeLessThanOrEqual(1024);
    expect(decodeChannelEvent(result).ok).toBe(true);
  });
  it.each([undefined, [], [{ name: null }], [{ name: '' }]])('uses a safe CI failure fallback with checks %s', checks => {
    const result = mapAiurEvent({ ...ciFailed, checks });
    expect(result?.summary).toBe('CI failed');
    expect(result?.status).toBe('failure');
  });
  it('has no Aiur package dependency', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies });
    expect(names.filter(name => name.toLowerCase().includes('aiur'))).toEqual([]);
  });
});
