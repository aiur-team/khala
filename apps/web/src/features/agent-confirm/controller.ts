import type { AgentJoinView } from '@khala/contracts/m1/agent-join';
import type { AgentJoinError, AgentJoinPort, AgentJoinResult } from './ports';

export type AgentConfirmError = AgentJoinError | 'expired' | 'ready_timeout';
export type AgentConfirmSnapshot =
  | Readonly<{ state: 'loading' }>
  | Readonly<{ state: 'review' | 'connecting' | 'done'; view: AgentJoinView }>
  | Readonly<{ state: 'error'; code: AgentConfirmError; view?: AgentJoinView }>;

export function createAgentConfirmController({
  joinId, port, pollMs = 1000, readyTimeoutMs = 60_000, autoConfirmMs = 3000,
  now = () => Date.now(),
  setTimer = (callback: () => void, delay: number) => {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  },
}: {
  joinId: string;
  port: AgentJoinPort;
  pollMs?: number;
  readyTimeoutMs?: number;
  autoConfirmMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => () => void;
}) {
  let snapshot: AgentConfirmSnapshot = { state: 'loading' };
  let disposed = false;
  let started = false;
  let confirmAttempted = false;
  let generation = 0;
  let abort = new AbortController();
  let cancelPoll: (() => void) | undefined;
  let cancelDeadline: (() => void) | undefined;
  const listeners = new Set<() => void>();

  function publish(next: AgentConfirmSnapshot) {
    if (disposed) return;
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function endOperation() {
    generation += 1;
    abort.abort();
    abort = new AbortController();
    cancelPoll?.();
    cancelDeadline?.();
    cancelPoll = cancelDeadline = undefined;
    return generation;
  }

  function current(token: number) { return !disposed && generation === token; }

  function error(code: AgentConfirmError, view?: AgentJoinView) {
    endOperation();
    publish({ state: 'error', code, ...(view ? { view } : {}) });
  }

  async function request(call: (signal: AbortSignal) => Promise<AgentJoinResult>): Promise<AgentJoinResult> {
    try { return await call(abort.signal); }
    catch { return { kind: 'error', code: 'unavailable' }; }
  }

  function poll(view: AgentJoinView) {
    const token = endOperation();
    let latest = view;
    const deadline = now() + readyTimeoutMs;
    publish({ state: 'connecting', view });
    // A separate deadline also bounds an unresolved status request.
    cancelDeadline = setTimer(() => {
      if (current(token)) error('ready_timeout', latest);
    }, readyTimeoutMs);
    function schedule() {
      cancelPoll = setTimer(() => { void tick(); }, Math.min(pollMs, Math.max(0, deadline - now())));
    }
    async function tick() {
      if (!current(token)) return;
      if (now() >= deadline) { error('ready_timeout', latest); return; }
      const result = await request(signal => port.status(joinId, signal));
      if (!current(token)) return;
      if (result.kind === 'error') { error(result.code, latest); return; }
      latest = result.view;
      if (latest.state === 'expired') { error('expired', latest); return; }
      // The server invites the agent before it reports ready.
      if (latest.state === 'ready') { endOperation(); publish({ state: 'done', view: latest }); return; }
      publish({ state: 'connecting', view: latest });
      schedule();
    }
    schedule();
  }

  function accept(result: AgentJoinResult) {
    if (result.kind === 'error') { error(result.code); return; }
    const view = result.view;
    switch (view.state) {
      case 'pending':
        // A lost confirmation response may still have reached the server.
        if (confirmAttempted) poll(view);
        else {
          publish({ state: 'review', view });
          // Approve joins is off and this member issued the agent's link: confirm without a click,
          // after a short window in which the page names the agent and offers Cancel.
          if (view.access === 'auto') cancelPoll = setTimer(() => { void confirm(); }, autoConfirmMs);
        }
        break;
      case 'confirmed': poll(view); break;
      case 'ready': publish({ state: 'done', view }); break;
      case 'expired': error('expired', view); break;
    }
  }

  async function confirm() {
    if (disposed || snapshot.state !== 'review' || confirmAttempted) return;
    confirmAttempted = true;
    const view = snapshot.view;
    const token = endOperation();
    publish({ state: 'connecting', view });
    const result = await request(signal => port.confirm(joinId, signal));
    if (!current(token)) return;
    if (result.kind === 'error') error(result.code, view);
    else accept(result);
  }

  async function load() {
    const token = endOperation();
    publish({ state: 'loading' });
    const result = await request(signal => port.view(joinId, signal));
    if (current(token)) accept(result);
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    start() {
      if (disposed || started) return;
      started = true;
      void load();
    },
    confirm,
    /** Stops a pending no-click confirm; the page then waits for Confirm as usual. */
    cancelAuto() {
      if (disposed || snapshot.state !== 'review' || snapshot.view.access !== 'auto') return;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- drops access from the view
      const { access: _auto, ...view } = snapshot.view;
      endOperation();
      publish({ state: 'review', view });
    },
    retry() {
      if (disposed || snapshot.state !== 'error') return;
      const { code, view } = snapshot;
      if (code === 'ready_timeout' && view) poll(view);
      else if (code === 'unavailable' || code === 'signed_out') {
        if (confirmAttempted && view) poll(view);
        else void load();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      endOperation();
      listeners.clear();
    },
  };
}
export type AgentConfirmController = ReturnType<typeof createAgentConfirmController>;
