/** Fail-closed correlation for a disposable three-party conversation.
 * The caller must obtain these facts from independent browser, Matrix, owner
 * mailbox, and native-session observations. A transport success is not a read.
 */
export type Actor = 'codex' | 'claude';
export type NativeFact = Readonly<{
  actor: Actor; sessionId: string; bindingId: string; generation: number;
  operationId: string; challengeEventId: string; releaseId: string;
  modelReadEventId: string; observedReadEventIds: readonly string[];
  readBindingId: string; readGeneration: number;
  ackReleaseId: string; ackBindingId: string; ackGeneration: number;
  replyEventId: string; replyOrigin: 'model' | 'connector';
}>;
export type BrowserFact = Readonly<{
  challengeEventId: string; replyEventId: string;
  encryptedEventIds: readonly string[]; reloadedEventIds: readonly string[];
}>;

function requireId(value: string, field: string): void {
  if (!value || !/^[A-Za-z0-9_$.:/+!=~-]{4,256}$/u.test(value)) throw new Error(`external_witness_${field}_invalid`);
}

export function verifyExternalConversation(native: readonly NativeFact[], browser: readonly BrowserFact[],
  peer: Readonly<{ from: Actor; to: Actor; eventId: string; readEventId: string; replyEventId: string }>): void {
  if (native.length !== 2 || browser.length !== 2 || native[0]?.actor === native[1]?.actor
    || new Set(native.map(row => row.actor)).size !== 2) throw new Error('external_witness_distinct_actors_required');
  if (native[0]!.sessionId === native[1]!.sessionId || native[0]!.bindingId === native[1]!.bindingId)
    throw new Error('external_witness_distinct_sessions_required');
  if (native[0]!.challengeEventId === native[1]!.challengeEventId)
    throw new Error('external_witness_distinct_challenges_required');
  for (const [index, fact] of native.entries()) {
    const web = browser[index]!;
    for (const field of ['sessionId', 'bindingId', 'operationId', 'challengeEventId', 'releaseId',
      'modelReadEventId', 'readBindingId', 'ackReleaseId', 'ackBindingId', 'replyEventId'] as const) requireId(fact[field], field);
    // A newly admitted hosted binding starts at generation 0. Generation is a
    // revision, not a count of completed reconnects.
    if (!Number.isSafeInteger(fact.generation) || fact.generation < 0) throw new Error('external_witness_generation_invalid');
    if (fact.modelReadEventId !== fact.challengeEventId || fact.ackReleaseId !== fact.releaseId
      || fact.readBindingId !== fact.bindingId || fact.ackBindingId !== fact.bindingId
      || fact.readGeneration !== fact.generation || fact.ackGeneration !== fact.generation)
      throw new Error('external_witness_model_read_or_ack_missing');
    if (!fact.observedReadEventIds.includes(fact.challengeEventId)
      || fact.observedReadEventIds.includes(native[1 - index]!.challengeEventId))
      throw new Error('external_witness_cross_binding_read_leak');
    if (fact.replyOrigin !== 'model') throw new Error('external_witness_model_reply_missing');
    if (web.challengeEventId !== fact.challengeEventId || web.replyEventId !== fact.replyEventId
      || !web.encryptedEventIds.includes(fact.challengeEventId)
      || !web.encryptedEventIds.includes(fact.replyEventId)
      || !web.reloadedEventIds.includes(fact.replyEventId))
      throw new Error('external_witness_durable_encrypted_reply_missing');
  }
  if (peer.from === peer.to || !native.some(row => row.actor === peer.from)
    || !native.some(row => row.actor === peer.to) || peer.eventId !== peer.readEventId
    || !browser.some(row => row.encryptedEventIds.includes(peer.eventId)
      && row.encryptedEventIds.includes(peer.replyEventId)
      && row.reloadedEventIds.includes(peer.replyEventId)))
    throw new Error('external_witness_peer_exchange_missing');
}
