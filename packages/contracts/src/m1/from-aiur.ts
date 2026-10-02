import { displayText, isWellFormed, label, utf8Length } from '../messaging/decode';
import { encodeChannelEvent, formatChannelEventLine, statusFor, type ChannelEventContent, type ChannelEventStatus } from './channel-event';

export type AiurMapOptions = Readonly<{ ticketLabel?: (id: string) => string; repo?: string }>;
type RecordValue = Record<string, unknown>;
const kindPattern = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;
function object(value: unknown): RecordValue | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as RecordValue : undefined;
}
const str = (value: unknown): string | undefined => typeof value === 'string' && value.length ? value : undefined;
const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
function valid(value: unknown, bytes: number, points?: number, display = false): string | undefined {
  const text = str(value);
  if (!text) return undefined;
  try {
    const checked = display ? displayText(text, '', bytes) : label(text, '', bytes);
    if (points !== undefined && [...checked].length > points) return undefined;
    return checked;
  } catch { return undefined; }
}
function idOf(value: unknown): string | undefined {
  return valid(num(value) !== undefined ? String(value) : value, 64, 64);
}
function sha(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-fA-F]{7,64}$/.test(value) ? value.toLowerCase() : undefined;
}
function https(value: unknown): string | undefined {
  const text = str(value);
  if (!text || utf8Length(text) > 2048 || !isWellFormed(text)) return undefined;
  try { return new URL(text).protocol === 'https:' ? text : undefined; } catch { return undefined; }
}
function time(value: unknown): string | undefined {
  const text = str(value);
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : undefined;
}
function oneLine(value: unknown, max = 200): string | undefined {
  const text = str(value)?.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  if (!text || !isWellFormed(text)) return undefined;
  const points: string[] = [];
  for (const point of text) {
    if (points.length === max) return valid(`${points.slice(0, max - 1).join('')}…`, max * 4, max, true);
    points.push(point);
  }
  return valid(text, max * 4, max, true);
}
function branch(value: unknown): string | undefined {
  const ref = str(value)?.replace(/^refs\/heads\//, '');
  return ref?.startsWith('refs/') ? undefined : valid(ref, 255);
}

/** Maps only event metadata; comment bodies and CI instructions are never read. */
export function mapAiurEvent(input: unknown, opts: AiurMapOptions = {}): ChannelEventContent | null {
  try {
    const raw = object(input);
    if (!raw || typeof raw.topic !== 'string') return null;
    const topic = raw.topic;
    const match = /^ticket\.([^.]+)\.(.+)$/.exec(topic);
    const ticketId = match?.[1];
    const cls = match?.[2] ?? (topic.startsWith('agent.') ? topic : undefined);
    if (!cls) return null;
    // An explicitly malformed PR object is not a lifecycle record.
    const pr = object(raw.pr);
    if (raw.pr !== undefined && !pr) return null;
    const head = object(pr?.head);
    const base = object(pr?.base);
    const comment = object(raw.comment);
    const ticket = ticketId ?? str(raw.source_ticket_id);
    const ticketLabel = ticket === undefined ? undefined : valid((opts.ticketLabel ?? (id => id))(ticket), 256, 64, true);
    let prNumber = num(pr?.number) ?? num(raw.pr_number);
    const headSha = sha(head?.sha) ?? sha(raw.head_sha) ?? sha(raw.sha);
    const branchName = branch(head?.ref) ?? branch(raw.ref);
    const repoCandidate = str(raw.repo) ?? str(object(base?.repo)?.full_name) ?? opts.repo;
    const repo = valid(repoCandidate, 140);
    const repoName = repo && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? repo : undefined;
    const eventId = idOf(raw.id) ?? idOf(raw.event_id);
    const occurredAt = time(raw.timestamp) ?? time(raw.occurred_at) ?? time(raw.first_seen_at) ?? time(object(raw.ticket_observation)?.occurred_at);
    const kind = utf8Length(cls) <= 128 && kindPattern.test(cls) ? cls : 'custom.unknown';
    let status: ChannelEventStatus = statusFor({ kind: cls });
    let summary: string;
    let actor: string | undefined;
    let url: string | undefined;
    const lifecycle = ['pr.opened', 'pr.ready_for_review', 'pr.merged'].includes(cls);
    if (lifecycle) {
      actor = oneLine(object(pr?.user)?.login, 64);
      url = https(pr?.html_url);
    }
    switch (cls) {
      case 'branch.push': summary = headSha ? `pushed ${headSha.slice(0, 7)}` : 'branch pushed'; break;
      case 'pr.opened': summary = prNumber ? `${pr?.draft === true || raw.draft === true ? 'draft ' : ''}PR #${prNumber} opened` : 'PR opened'; break;
      case 'pr.ready_for_review': summary = 'review requested'; break;
      case 'pr.merged': summary = prNumber ? `PR #${prNumber} merged` : 'PR merged'; break;
      case 'pr.review_comment': {
        const reviewPr = /\/pulls\/(\d+)$/.exec(str(comment?.pull_request_url) ?? '');
        prNumber = reviewPr ? num(Number(reviewPr[1])) : undefined;
        actor = oneLine(object(comment?.user)?.login, 64);
        let review = 'review comment';
        if (comment?.state === 'CHANGES_REQUESTED') {
          status = 'failure';
          review = 'changes requested';
        } else if (comment?.state === 'APPROVED') {
          status = 'success';
          review = 'approved';
        }
        summary = actor ? `${review} by ${actor}` : review;
        url = https(comment?.html_url);
        break;
      }
      case 'issue.commented': {
        actor = oneLine(object(comment?.user)?.login, 64);
        summary = actor ? `comment by ${actor}` : 'comment';
        url = https(comment?.html_url);
        break;
      }
      case 'ci.passed': summary = 'CI passed'; break;
      case 'ci.failed': {
        const check = Array.isArray(raw.checks) ? oneLine(object(raw.checks[0])?.name, 120) : undefined;
        summary = check ? `CI failed: ${check}` : 'CI failed';
        break;
      }
      case 'pr.parked_ready': summary = 'ready to merge'; break;
      case 'agent.paused': summary = 'paused'; break;
      default:
        if (cls.startsWith('agent.attention.')) {
          status = raw.needs_attention === false || cls.endsWith('.resolved') ? 'info' : 'attention';
          summary = oneLine(raw.message) ?? 'attention';
        } else if (cls.startsWith('agent.')) {
          summary = oneLine(raw.message) ?? oneLine(cls.slice(6).replace(/\./g, ' ')) ?? 'event';
        } else summary = oneLine(cls.replace(/\./g, ' ')) ?? 'event';
    }
    let key: string | undefined;
    if (lifecycle && repoName && prNumber && headSha) {
      const action = typeof raw.topic_class === 'string' ? cls.slice(3) : valid(raw.action, 128) ?? cls.slice(3);
      key = `pr:${repoName}:${action}:${prNumber}:${headSha}`;
    } else if (cls === 'pr.review_comment' && comment?.state !== undefined && repoName && prNumber && idOf(comment?.id)) {
      key = `review:${repoName}:${prNumber}:${idOf(comment?.id)}`;
    } else if ((cls === 'ci.passed' || cls === 'ci.failed') && ticketId && headSha) {
      key = `ci:${ticketId}:${cls.slice(3)}:${headSha}`;
    } else if (eventId) key = `aiur:${eventId}`;
    const subject = {
      ...(ticketLabel ? { ticket: ticketLabel } : {}), ...(prNumber ? { pr: prNumber } : {}),
      ...(headSha ? { sha: headSha } : {}), ...(branchName ? { branch: branchName } : {}), ...(repoName ? { repo: repoName } : {}),
    };
    // Individually valid fields can still overflow the formatted body's byte limit.
    const summaryBudget = 1024 - utf8Length(formatChannelEventLine({ summary: '', subject }));
    if (utf8Length(summary) > summaryBudget) {
      let shortened = '';
      let bytes = 0;
      for (const point of summary) {
        const size = utf8Length(point);
        if (bytes + size > summaryBudget - utf8Length('…')) break;
        shortened += point;
        bytes += size;
      }
      summary = `${shortened}…`;
    }
    const encoded = encodeChannelEvent({
      kind, status, summary, subject,
      source: { system: 'aiur', ...(valid(topic, 256) ? { topic } : {}), ...(eventId ? { event_id: eventId } : {}) },
      ...(actor ? { actor } : {}), ...(url ? { url } : {}), ...(occurredAt ? { occurred_at: occurredAt } : {}),
      ...(valid(key, 200) ? { key } : {}),
    });
    return encoded.ok ? encoded.value : null;
  } catch { return null; }
}
