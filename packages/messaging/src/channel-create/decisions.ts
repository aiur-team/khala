// Owner decisions with creation fulfilment. The journal's decision port records
// the owner's approval; for a `create` request this decorator then runs the
// creation workflow, so approval creates exactly one secret channel. Access
// requests, denials, and mutes pass through unchanged. Creation failure never
// undoes the approval: it stays durable and the next inbox read, retried
// decision, or connector exchange reconciles the same channel.

import type {
  AuthPrincipal,
  CallOptions,
  ChannelAccessDecisionPort,
  ChannelAccessOwnerProjection,
} from '@khala/contracts/messaging/index';
import type { ChannelCreateWorkflow } from './workflow';

export function withChannelCreateFulfillment(deps: Readonly<{
  decisions: ChannelAccessDecisionPort;
  workflow: ChannelCreateWorkflow;
}>): ChannelAccessDecisionPort {
  async function decide(
    input: Parameters<ChannelAccessDecisionPort['decide']>[0],
    owner: AuthPrincipal,
    options?: CallOptions,
  ): ReturnType<ChannelAccessDecisionPort['decide']> {
    const result = await deps.decisions.decide(input, owner, options);
    if (result.kind !== 'ok' || !needsFulfillment(result.value, ['approved', 'connecting'])) return result;
    await safe(() => deps.workflow.fulfill(result.value.requestHandle, options));
    const listed = await safe(() => deps.decisions.inbox(owner, options));
    const current = listed?.kind === 'ok'
      ? listed.value.find(request => request.requestHandle === result.value.requestHandle)
      : undefined;
    return current === undefined ? result : { kind: 'ok', value: current };
  }

  /** Reconciles approvals whose creation did not finish, for example after a restart. */
  async function inbox(owner: AuthPrincipal, options?: CallOptions): ReturnType<ChannelAccessDecisionPort['inbox']> {
    const listed = await deps.decisions.inbox(owner, options);
    if (listed.kind !== 'ok') return listed;
    let reconciled = false;
    for (const request of listed.value) {
      if (!needsFulfillment(request, ['approved', 'connecting'])) continue;
      if (await safe(() => deps.workflow.unsettled(request.requestHandle, options)) !== true) continue;
      await safe(() => deps.workflow.fulfill(request.requestHandle, options));
      reconciled = true;
    }
    return reconciled ? await deps.decisions.inbox(owner, options) : listed;
  }

  return Object.freeze({ inbox, decide, setMute: deps.decisions.setMute });
}

function needsFulfillment(
  request: ChannelAccessOwnerProjection,
  outcomes: readonly ChannelAccessOwnerProjection['outcome'][],
): boolean {
  return request.operationKind === 'create' && request.ownerDecision === 'approved' && outcomes.includes(request.outcome);
}

async function safe<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch {
    return null;
  }
}
