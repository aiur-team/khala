import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { StopControl } from './StopControl';
import { type StopController, type StopView, createStopController } from './stop-controller';
import { createHttpStopPort } from '../composition/stop-http';
import { type BindingStopPort, type StopOutcome, decodeStopReply } from './stop-port';

const bob = { bindingId: 'binding-bob', generation: 1, harness: 'codex', agentParticipantId: 'participant-bob' };
const carol = { bindingId: 'binding-carol', generation: 1, harness: 'claude', agentParticipantId: 'participant-carol' };
const CHANNEL_URL = 'http://127.0.0.1:4871/channels/ch_1';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('HTTP Stop port', () => {
  it('posts one human Stop for every binding with the request secret and same-origin credentials', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ v: 1, outcome: 'stopped', stopped: [bob], remaining: [] }), { status: 200 }));
    const port = createHttpStopPort({ origin: 'http://127.0.0.1:4871', requestSecret: 'secret', fetch });
    expect(await port.stop('ch_1')).toEqual({ kind: 'stopped', stopped: [bob] });
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:4871/api/v1/channels/ch_1/stop', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      body: JSON.stringify({ v: 1, targets: null }),
      headers: expect.objectContaining({ 'x-khala-request-secret': 'secret', 'content-type': 'application/json' }),
    }));
  });

  it('maps every non-success to a failure and never to success', async () => {
    const reply = (status: number, body: unknown = { error: { code: 'x' } }) => {
      const port = createHttpStopPort({
        origin: 'http://127.0.0.1:4871', requestSecret: 's', fetch: async () => new Response(JSON.stringify(body), { status }),
      });
      return port.stop('ch_1');
    };
    expect(await reply(401)).toEqual({ kind: 'failed', reason: 'session_ended' });
    expect(await reply(403)).toEqual({ kind: 'failed', reason: 'forbidden' });
    expect(await reply(409)).toEqual({ kind: 'failed', reason: 'rejected' });
    expect(await reply(503)).toEqual({ kind: 'failed', reason: 'unavailable' });
    expect(await reply(200, { v: 1, outcome: 'stopped', stopped: [], remaining: [{ ...bob, reason: 'revoke_failed' }] }))
      .toEqual({ kind: 'failed', reason: 'unavailable' });
    const offline = createHttpStopPort({ origin: 'http://127.0.0.1:4871', requestSecret: 's', fetch: async () => { throw new TypeError('offline'); } });
    expect(await offline.stop('ch_1')).toEqual({ kind: 'failed', reason: 'unavailable' });
  });

  it('decodes partial replies strictly', () => {
    expect(decodeStopReply({ v: 1, outcome: 'partial', stopped: [bob], remaining: [{ ...carol, reason: 'descriptor_pending' }] }))
      .toEqual({ kind: 'partial', stopped: [bob], remaining: [{ ...carol, reason: 'descriptor_pending' }] });
    expect(decodeStopReply({ v: 1, outcome: 'partial', stopped: [bob], remaining: [] })).toBeNull();
    expect(decodeStopReply({ v: 1, outcome: 'partial', stopped: [], remaining: [{ ...carol, reason: 'other' }] })).toBeNull();
    expect(decodeStopReply({ v: 1, outcome: 'stopped', stopped: [{ ...bob, generation: -1 }], remaining: [] })).toBeNull();
  });
});

describe('Stop controller', () => {
  it('requires confirmation, sends exactly once while in flight, and reports success', async () => {
    const pending = deferred<StopOutcome>();
    const stop = vi.fn(() => pending.promise);
    const controller = createStopController({ stop }, 'ch_1');
    controller.confirm();
    expect(stop).not.toHaveBeenCalled();

    controller.request();
    expect(controller.getView()).toEqual({ phase: 'confirming' });
    controller.confirm();
    controller.confirm();
    controller.request();
    controller.retry();
    expect(controller.getView()).toEqual({ phase: 'stopping' });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith('ch_1');

    pending.resolve({ kind: 'stopped', stopped: [bob] });
    await pending.promise;
    await Promise.resolve();
    expect(controller.getView()).toEqual({ phase: 'stopped', stopped: [bob] });
  });

  it('cancels without sending and retries a partial outcome', async () => {
    const outcomes: StopOutcome[] = [
      { kind: 'partial', stopped: [bob], remaining: [{ ...carol, reason: 'revoke_failed' }] },
      { kind: 'stopped', stopped: [carol] },
    ];
    const port: BindingStopPort = { stop: vi.fn(async () => outcomes.shift()!) };
    const controller = createStopController(port, 'ch_1');
    controller.request();
    controller.cancel();
    expect(controller.getView()).toEqual({ phase: 'idle' });
    expect(port.stop).not.toHaveBeenCalled();

    controller.request();
    controller.confirm();
    await vi.waitFor(() => expect(controller.getView().phase).toBe('partial'));
    controller.retry();
    await vi.waitFor(() => expect(controller.getView()).toEqual({ phase: 'stopped', stopped: [carol] }));
    expect(port.stop).toHaveBeenCalledTimes(2);
  });

  it('treats a throwing port as an unconfirmed failure', async () => {
    const controller = createStopController({ stop: async () => { throw new Error('boom'); } }, 'ch_1');
    controller.request();
    controller.confirm();
    await vi.waitFor(() => expect(controller.getView()).toEqual({ phase: 'failed', reason: 'unavailable' }));
  });
});

function fixed(view: StopView): StopController {
  return {
    getView: () => view, subscribe: () => () => undefined, request: vi.fn(), cancel: vi.fn(), confirm: vi.fn(), retry: vi.fn(), dispose: vi.fn(),
  };
}

const render = (view: StopView) => renderToStaticMarkup(<StopControl controller={fixed(view)} replacementAccessUrl={CHANNEL_URL} />);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

describe('StopControl', () => {
  it('says exactly what Stop does and keeps an empty live region mounted', () => {
    const html = render({ phase: 'idle' });
    expect(text(html)).toContain('Agent command-line sessions you started keep running');
    expect(html).toMatch(/<p class="stop-control__status" role="status" aria-live="polite"><\/p>/);
    expect(html).toContain('>Stop agent delivery</button>');
    expect(text(html)).not.toMatch(/terminat|kill|end(s)? the agent session/i);
  });

  it('asks for confirmation with the process and server guarantees', () => {
    const html = render({ phase: 'confirming' });
    expect(html).toMatch(/role="group" aria-labelledby="[^"]+"/);
    expect(text(html)).toContain('Stop delivery to agents in this channel?');
    expect(text(html)).toContain('does not close, interrupt or signal any agent command-line session');
    expect(text(html)).toContain('The local Khala server, this channel, its history and this page keep working');
    expect(html).toContain('>Stop delivery</button>');
    expect(html).toContain('>Cancel</button>');
    expect(html).not.toContain('disabled');
  });

  it('disables both actions and announces progress while Stop is in flight', () => {
    const html = render({ phase: 'stopping' });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('>Stopping agent delivery…</p>');
    expect((html.match(/disabled=""/g) ?? []).length).toBe(2);
    expect(html).not.toContain('Stop agent delivery</button>');
  });

  it('announces success and links into the channel access flow for a replacement', () => {
    const html = render({ phase: 'stopped', stopped: [bob, carol] });
    expect(html).toContain('Agent delivery stopped. 2 agent bindings were revoked.');
    expect(text(html)).toContain('codex agent (participant-bob, binding binding-bob)');
    expect(text(html)).toContain(`/khala join ${CHANNEL_URL}`);
    expect(html).toContain(`<a href="${CHANNEL_URL}">`);
    expect(text(html)).toContain('still running');
  });

  it('names the remaining bindings on a partial outcome without claiming success, and offers retry', () => {
    const html = render({ phase: 'partial', stopped: [bob], remaining: [{ ...carol, reason: 'revoke_failed' }] });
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain('Stop did not finish');
    expect(text(html)).toContain('claude agent (participant-carol, binding binding-carol): its binding could not be revoked.');
    expect(text(html)).not.toContain('Agent delivery stopped');
    expect(html).toContain('>Retry Stop</button>');
  });

  it('reports failures with retry only when retrying can help', () => {
    const unavailable = render({ phase: 'failed', reason: 'unavailable' });
    expect(unavailable).toContain('role="alert"');
    expect(text(unavailable)).toContain('Agents may still receive messages');
    expect(unavailable).toContain('>Retry Stop</button>');
    const ended = render({ phase: 'failed', reason: 'session_ended' });
    expect(ended).not.toContain('Retry Stop');
  });
});
