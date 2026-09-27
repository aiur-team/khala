import type { ServerResponse } from 'node:http';
import { readJsonObject, sendError, sendJson } from '../http';
import type { RouteContext, RouteSpec } from '../server';
import type { Principal } from '../credentials';
import type { BindingStopService, StopTarget } from './service';

/**
 * Human-only: the route requires the browser session cookie, its request secret
 * and the exact loopback Origin before any body is read. Binding, discovery and
 * transport capabilities are refused.
 */
export const STOP_ROUTE = {
  method: 'POST',
  path: '/api/v1/channels/:channelId/stop',
  admission: 'authenticated',
} as const satisfies RouteSpec;

/** Largest explicit target list; the acceptance script names at most a pair. */
export const MAX_STOP_TARGETS = 16;
const MAX_ID_BYTES = 512;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_ID_BYTES
    && !/[\p{Cc}]/u.test(value);
}

/** `null` for every active binding, a bounded list of exact recorded targets, or `undefined` when malformed. */
export function decodeStopTargets(value: unknown): readonly StopTarget[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_STOP_TARGETS) return undefined;
  const targets: StopTarget[] = [];
  const seen = new Set<string>();
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined;
    const record = entry as Record<string, unknown>;
    const { bindingId, generation, agentParticipantId } = record;
    if (!exactKeys(record, ['bindingId', 'generation', 'agentParticipantId']) || !validId(bindingId)
      || !validId(agentParticipantId) || !Number.isSafeInteger(generation) || (generation as number) < 0) return undefined;
    const key = JSON.stringify([bindingId, generation]);
    if (seen.has(key)) return undefined;
    seen.add(key);
    targets.push({ bindingId, generation: generation as number, agentParticipantId });
  }
  return targets;
}

function fail(response: ServerResponse, status: number, code: Parameters<typeof sendError>[2]): void {
  sendError(response, status, code);
}

export async function handleStop(context: RouteContext<Principal>, deps: Readonly<{
  service: BindingStopService;
  maxBodyBytes: number;
  /** Whether the human may act on the channel; `unavailable` when the store cannot say. */
  humanMayStop(channelId: string, principal: Principal): 'allowed' | 'not_found' | 'forbidden' | 'unavailable';
}>): Promise<void> {
  const { principal, params, response } = context;
  if (principal?.kind !== 'human') {
    fail(response, 403, 'forbidden');
    return;
  }
  const channelId = params.channelId!;
  const body = await readJsonObject(context, deps.maxBodyBytes);
  const targets = decodeStopTargets(body.targets);
  if (!exactKeys(body, ['v', 'targets']) || body.v !== 1 || targets === undefined) {
    fail(response, 400, 'invalid_request');
    return;
  }
  const allowed = deps.humanMayStop(channelId, principal);
  if (allowed !== 'allowed') {
    if (allowed === 'not_found') fail(response, 404, 'not_found');
    else if (allowed === 'forbidden') fail(response, 403, 'not_joined');
    else fail(response, 503, 'unavailable');
    return;
  }
  const result = await deps.service.stop(channelId, targets);
  switch (result.kind) {
    case 'stopped':
      sendJson(response, 200, { v: 1, outcome: 'stopped', stopped: result.stopped, remaining: [] });
      return;
    case 'partial':
      // Never success: the reply names every binding that may still be active.
      sendJson(response, 200, { v: 1, outcome: 'partial', stopped: result.stopped, remaining: result.remaining });
      return;
    case 'rejected':
      fail(response, 409, 'operation_mismatch');
      return;
    default:
      fail(response, 503, 'unavailable');
  }
}
