// The hosted operations drill. Before an operator enables public discovery,
// this script runs against a staging composition: one account crawls from
// several sessions, and the drill proves four things. The hard page and
// per-session limits hold. The crawl reaches the operator alert sink. Engaging
// the kill switch removes public results within five minutes. Private results
// stay listed throughout. The report it returns is what `record_drill` accepts.

import { MAX_CHANNEL_LIST_PAGE_SIZE } from '@khala/contracts/messaging/index';
import type { OperatorAlert } from './crawl';
import { LIST_REQUESTS_PER_WINDOW, LIST_WINDOW_MS } from './listing';
import { type DrillReport, KILL_SWITCH_DEADLINE_MS } from './rollout';

export type DrillTarget = Readonly<{
  now(): number;
  sleep(ms: number): Promise<void>;
  /**
   * One GET of the agent listing route as the named session. Every session
   * belongs to the same crawling account, which has a private channel it may
   * list, and the staging catalog holds at least one public channel.
   */
  list(session: string): Promise<Response>;
  /** Crawl sessions; the last one is kept fresh for the kill-switch measurement. */
  sessions: readonly string[];
  setKillSwitch(engaged: boolean): Promise<void>;
  /** Alerts the configured operator sink received so far. */
  alerts(): Promise<readonly OperatorAlert[]>;
}>;

/** Poll the fresh session no faster than its own listing budget allows. */
export const KILL_SWITCH_POLL_MS = LIST_WINDOW_MS / LIST_REQUESTS_PER_WINDOW;

type Page = Readonly<{ items: readonly Readonly<{ visibility: string }>[] }>;

export async function runRolloutDrill(target: DrillTarget): Promise<DrillReport> {
  if (target.sessions.length < 3) throw new Error('the drill needs at least two crawl sessions and one measurement session');
  const crawlers = target.sessions.slice(0, -1);
  const probe = target.sessions.at(-1)!;
  const alertsBefore = (await target.alerts()).length;

  // Crawl: each session lists until the limiter refuses it, then keeps going
  // briefly so the account accumulates rate-limited requests.
  let pageCap = true;
  let limiter = true;
  for (const session of crawlers) {
    const windowStart = Math.floor(target.now() / LIST_WINDOW_MS);
    let accepted = 0;
    let refused = 0;
    for (let attempt = 0; attempt < LIST_REQUESTS_PER_WINDOW + 3; attempt += 1) {
      const response = await target.list(session);
      if (response.status === 200) {
        accepted += 1;
        pageCap &&= (await response.json() as Page).items.length <= MAX_CHANNEL_LIST_PAGE_SIZE;
      } else if (response.status === 429) {
        refused += 1;
      } else {
        limiter = false;
      }
    }
    // A crawl that crossed a window boundary legitimately gets a fresh budget.
    const sameWindow = Math.floor(target.now() / LIST_WINDOW_MS) === windowStart;
    limiter &&= sameWindow ? accepted === LIST_REQUESTS_PER_WINDOW && refused === 3 : accepted <= 2 * LIST_REQUESTS_PER_WINDOW;
  }
  const alert = (await target.alerts()).slice(alertsBefore).some(item => item.kind === 'channel_discovery.crawl_suspected');

  const baseline = await readPage(target, probe);
  const hadBoth = baseline !== null && baseline.items.some(isPublic) && baseline.items.some(isPrivate);

  await target.setKillSwitch(true);
  const engagedAt = target.now();
  let propagation = Number.POSITIVE_INFINITY;
  let privateRetained = false;
  try {
    while (target.now() - engagedAt < KILL_SWITCH_DEADLINE_MS) {
      const page = await readPage(target, probe);
      if (page && !page.items.some(isPublic)) {
        propagation = target.now() - engagedAt;
        privateRetained = page.items.some(isPrivate);
        break;
      }
      await target.sleep(KILL_SWITCH_POLL_MS);
    }
  } finally {
    await target.setKillSwitch(false);
  }

  return {
    v: 1,
    completedAt: new Date(target.now()).toISOString(),
    checks: { pageCap, limiter, alert, killSwitch: hadBoth && propagation < KILL_SWITCH_DEADLINE_MS, privateRetained },
    killSwitchPropagationMs: Number.isFinite(propagation) ? propagation : KILL_SWITCH_DEADLINE_MS,
  };
}

async function readPage(target: DrillTarget, session: string): Promise<Page | null> {
  const response = await target.list(session);
  return response.status === 200 ? await response.json() as Page : null;
}

const isPublic = (item: Readonly<{ visibility: string }>) => item.visibility === 'public';
const isPrivate = (item: Readonly<{ visibility: string }>) => item.visibility === 'private';
