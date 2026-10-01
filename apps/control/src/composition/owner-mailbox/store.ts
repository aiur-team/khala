import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  decodeApprovalCommand, decodeApprovalResult, decodeDeliveryLimits, decodeDeliveryReceiptTransport,
  decodeEventRef, decodeHarnessCapabilities, decodePolicyAck, decodePolicySetCommand, decodeSessionBinding,
  type OwnerAuthority, type SessionBinding,
} from '@khala/contracts/delivery/index';
import { sameJsonValue, type AuthPrincipal, type ControlStore, type JsonValue } from '@khala/contracts/messaging/index';

export const OWNER_MAILBOX_MAX_ENTRIES = 64;
// Stop must remain queueable after the ordinary command budget is exhausted.
const OWNER_MAILBOX_STOP_RESERVE = 1;
const MAX_UNRESOLVED_READS_PER_KIND = 8;
const SUBMIT_ATTEMPTS = 64;
export const OWNER_MAILBOX_TTL_MS = 24 * 60 * 60 * 1000;
export type OwnerCommandKind = 'controls_status' | 'controls_set' | 'review_preview' | 'review_approve' | 'channel_stop';
export type OwnerMailboxCommand = Readonly<{
  operationId: string;
  kind: OwnerCommandKind;
  body: JsonValue;
}>;
export type OwnerMailboxEntry = OwnerMailboxCommand & Readonly<{
  outcome: JsonValue | null;
  authority: OwnerAuthority;
  authorityMac: string;
}>;
type Document = Readonly<{
  v: 1;
  bindingId: string;
  generation: number;
  ownerId: string;
  roomId: string;
  entries: readonly OwnerMailboxEntry[];
}>;
export type MailboxResult<T> = Readonly<{ kind: 'ok'; value: T }> | Readonly<{ kind: 'conflict' | 'unavailable' | 'capacity' }>;
export type MailboxSubmitDiagnostic = 'index_read_unavailable' | 'archive_read_unavailable'
  | 'archive_write_unavailable' | 'index_cas_unavailable' | 'index_cas_exhausted' | 'capacity';
const ID = /^[A-Za-z0-9_-]{8,64}$/u;
const decodedLimits = decodeDeliveryLimits({ maxPayloadBytes: 64 * 1024, maxSelectionEvents: 32 });
if (!decodedLimits.ok) throw new Error('owner_mailbox_limits_invalid');
const DELIVERY_LIMITS = decodedLimits.value;

/** The mailbox contains no plaintext, key, bearer, browser cookie or claimed owner authority. */
export function createOwnerMailbox(input: Readonly<{
  store: ControlStore;
  binding: SessionBinding;
  roomId: string;
  clock: () => number;
  authoritySecret: string;
  submitDiagnostic?: (cause: MailboxSubmitDiagnostic) => void;
}>) {
  const { store, binding, roomId, clock, authoritySecret, submitDiagnostic } = input;
  if (authoritySecret.length < 32) throw new Error('owner mailbox authority secret too short');
  const key = `owner-mailbox.v1.${createHash('sha256').update(`${binding.bindingId}\0${binding.generation}`).digest('hex')}`;
  // Completed commands live at stable per-operation keys. The bounded document
  // is only a poll index, so a long-lived binding cannot exhaust it with results.
  const archiveKey = (operationId: string) => `owner-mailbox-result.v1.${createHash('sha256')
    .update(`${binding.bindingId}\0${binding.generation}\0${operationId}`).digest('hex')}`;
  const previewKey = `owner-review-preview.v1.${createHash('sha256')
    .update(`${binding.bindingId}\0${binding.generation}`).digest('hex')}`;
  const initial: Document = { v: 1, bindingId: binding.bindingId, generation: binding.generation,
    ownerId: binding.ownerId, roomId, entries: [] };
  function validPreviewId(command: OwnerMailboxCommand): boolean {
    if (command.kind !== 'review_preview') return true;
    const digest = createHash('sha256').update(JSON.stringify(command.body)).digest('hex').slice(0, 32);
    return new RegExp(`^preview_${digest}_[a-f0-9]{8}$`, 'u').test(command.operationId);
  }
  function parse(raw: JsonValue): Document | null {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const value = raw as Record<string, JsonValue>;
    if (Object.keys(value).sort().join(',') !== 'bindingId,entries,generation,ownerId,roomId,v'
      || value.v !== 1 || value.bindingId !== binding.bindingId || value.generation !== binding.generation
      || value.ownerId !== binding.ownerId || value.roomId !== roomId || !Array.isArray(value.entries)
      || value.entries.length > OWNER_MAILBOX_MAX_ENTRIES + OWNER_MAILBOX_STOP_RESERVE) return null;
    const entries: OwnerMailboxEntry[] = [];
    const ids = new Set<string>();
    for (const item of value.entries) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
      const entry = item as Record<string, JsonValue>;
      if (Object.keys(entry).sort().join(',') !== 'authority,authorityMac,body,kind,operationId,outcome'
        || typeof entry.operationId !== 'string' || !ID.test(entry.operationId)
        || !['controls_status', 'controls_set', 'review_preview', 'review_approve', 'channel_stop'].includes(String(entry.kind))
        || ids.has(entry.operationId) || !validBody(entry.kind as OwnerCommandKind, entry.body!, binding, roomId)
        || !validPreviewId(entry as unknown as OwnerMailboxCommand)
        || entry.outcome === undefined || !validAuthority(entry, binding, roomId, authoritySecret)
        || (entry.outcome !== null && !validOutcome(entry.kind as OwnerCommandKind, entry.outcome, binding, entry.body!))) return null;
      ids.add(entry.operationId);
      entries.push(entry as OwnerMailboxEntry);
    }
    if (entries.filter(entry => entry.kind === 'channel_stop').length > OWNER_MAILBOX_STOP_RESERVE
      || entries.filter(entry => entry.kind !== 'channel_stop').length > OWNER_MAILBOX_MAX_ENTRIES) return null;
    return { ...initial, entries };
  }
  async function read(): Promise<MailboxResult<Readonly<{ document: Document; revision: string | null; expiresAt: string | null }>>> {
    const found = await store.read<JsonValue>(key);
    if (found.kind === 'unavailable') return { kind: 'unavailable' };
    if (found.kind === 'absent') return { kind: 'ok', value: { document: initial, revision: null, expiresAt: null } };
    const document = parse(found.record.value);
    return document ? { kind: 'ok', value: { document, revision: found.record.revision, expiresAt: found.record.expiresAt } } : { kind: 'unavailable' };
  }
  async function write(document: Document, expectedRevision: string | null, expiresAt: string): Promise<'applied' | 'conflict' | 'unavailable'> {
    const fingerprint = createHash('sha256').update(JSON.stringify([expectedRevision, document, expiresAt])).digest('base64url');
    const result = await store.compareAndSet<JsonValue>({ key, expectedRevision,
      operationId: `mailbox.${fingerprint}`,
      next: { value: document as unknown as JsonValue, expiresAt },
    });
    if (result.kind === 'applied') return 'applied';
    if (result.kind === 'conflict') return 'conflict';
    return 'unavailable';
  }
  async function archived(operationId: string): Promise<MailboxResult<OwnerMailboxEntry | null>> {
    const found = await store.read<JsonValue>(archiveKey(operationId));
    if (found.kind === 'unavailable') return { kind: 'unavailable' };
    if (found.kind === 'absent') return { kind: 'ok', value: null };
    const parsed = parse({ ...initial, entries: [found.record.value] } as unknown as JsonValue);
    const entry = parsed?.entries[0];
    return entry?.operationId === operationId && entry.outcome !== null
      ? { kind: 'ok', value: entry } : { kind: 'unavailable' };
  }
  async function archive(entry: OwnerMailboxEntry, expiresAt: string): Promise<'applied' | 'conflict' | 'unavailable'> {
    const result = await store.compareAndSet<JsonValue>({ key: archiveKey(entry.operationId), expectedRevision: null,
      operationId: `mailbox-result.${createHash('sha256').update(JSON.stringify(entry)).digest('base64url')}`,
      next: { value: entry as unknown as JsonValue, expiresAt },
    });
    if (result.kind === 'applied') return 'applied';
    if (result.kind === 'unavailable') return 'unavailable';
    const prior = await archived(entry.operationId);
    return prior.kind === 'ok' && prior.value && sameValue(prior.value as unknown as JsonValue, entry as unknown as JsonValue)
      ? 'applied' : prior.kind === 'unavailable' ? 'unavailable' : 'conflict';
  }
  async function retire(operationId: string): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await read();
      if (current.kind !== 'ok' || !current.value.expiresAt) return;
      const { document, revision, expiresAt } = current.value;
      if (!document.entries.some(item => item.operationId === operationId)) return;
      const saved = await write({ ...document, entries: document.entries.filter(item => item.operationId !== operationId) }, revision, expiresAt);
      if (saved === 'applied' || saved === 'unavailable') return;
    }
  }
  async function savePreview(entry: OwnerMailboxEntry, replay = false): Promise<'ok' | 'unavailable'> {
    if (entry.kind !== 'review_preview' || !plain(entry.outcome) || entry.outcome.ok !== true) return 'ok';
    if (!plain(entry.outcome.preview) || !Array.isArray(entry.outcome.preview.pending)
      || !entry.outcome.preview.pending.every(item => {
        const decoded = decodeEventRef(item);
        return decoded.ok && decoded.value.roomId === roomId;
      })) return 'unavailable';
    for (let attempt = 0; attempt < 8; attempt++) {
      const found = await store.read<JsonValue>(previewKey);
      if (found.kind === 'unavailable') return 'unavailable';
      const previous = found.kind === 'record' ? found.record.value : null;
      if (previous !== null && (!plain(previous) || !plain(previous.preview)
        || typeof previous.operationId !== 'string'
        || !validOutcome('review_preview', { ok: true, preview: previous.preview }, binding, entry.body))) return 'unavailable';
      if (previous !== null && plain(previous) && typeof previous.authenticatedAt === 'string'
        && (previous.authenticatedAt > entry.authority.authenticatedAt
          || previous.operationId === entry.operationId
          || replay && previous.authenticatedAt === entry.authority.authenticatedAt)) return 'ok';
      const next = { operationId: entry.operationId, authenticatedAt: entry.authority.authenticatedAt,
        preview: entry.outcome.preview } as JsonValue;
      const saved = await store.compareAndSet<JsonValue>({ key: previewKey,
        expectedRevision: found.kind === 'record' ? found.record.revision : null,
        operationId: `review-preview.${createHash('sha256').update(JSON.stringify([next, found.kind === 'record' ? found.record.revision : null])).digest('base64url')}`,
        next: { value: next, expiresAt: new Date(Date.parse(entry.authority.authenticatedAt) + OWNER_MAILBOX_TTL_MS).toISOString() } });
      if (saved.kind === 'applied') return 'ok';
      if (saved.kind === 'unavailable') return 'unavailable';
    }
    return 'unavailable';
  }
  async function settlePreview(entry: OwnerMailboxEntry): Promise<'ok' | 'unavailable'> {
    if (entry.kind !== 'review_approve' || !plain(entry.outcome) || entry.outcome.ok !== true) return 'ok';
    const approval = decodeApprovalCommand(entry.body, DELIVERY_LIMITS);
    if (!approval.ok) return 'unavailable';
    for (let attempt = 0; attempt < 8; attempt++) {
      const found = await store.read<JsonValue>(previewKey);
      if (found.kind === 'unavailable') return 'unavailable';
      if (found.kind === 'absent') return 'ok';
      const value = found.record.value;
      if (!plain(value) || !plain(value.preview)
        || !validOutcome('review_preview', { ok: true, preview: value.preview }, binding, { bindingId: binding.bindingId })
        || !Array.isArray(value.preview.pending)) return 'unavailable';
      const pending = value.preview.pending.filter(ref => !approval.value.selection.some(selected =>
        sameValue(ref as JsonValue, selected as unknown as JsonValue)));
      if (pending.length === value.preview.pending.length) return 'ok';
      const next = { ...value, preview: { ...value.preview, pending } } as JsonValue;
      const saved = await store.compareAndSet<JsonValue>({ key: previewKey,
        expectedRevision: found.record.revision,
        operationId: `review-settle.${createHash('sha256').update(JSON.stringify([entry.operationId, found.record.revision])).digest('base64url')}`,
        next: { value: next, expiresAt: found.record.expiresAt } });
      if (saved.kind === 'applied') return 'ok';
      if (saved.kind === 'unavailable') return 'unavailable';
    }
    return 'unavailable';
  }
  return {
    /** Last connector-verified metadata, scoped to this exact binding generation. */
    async lastReviewPreview(): Promise<MailboxResult<JsonValue | null>> {
      const found = await store.read<JsonValue>(previewKey);
      if (found.kind === 'unavailable') return { kind: 'unavailable' };
      if (found.kind === 'absent') return { kind: 'ok', value: null };
      const value = found.record.value;
      return plain(value) && plain(value.preview)
        && validOutcome('review_preview', { ok: true, preview: value.preview }, binding, { bindingId: binding.bindingId })
        && Array.isArray(value.preview.pending) && value.preview.pending.every(item => {
          const decoded = decodeEventRef(item);
          return decoded.ok && decoded.value.roomId === roomId;
        })
        ? { kind: 'ok', value: value.preview as JsonValue } : { kind: 'unavailable' };
    },
    /** Browser route calls only after OIDC cookie+CSRF and active binding/room checks. */
    async submit(command: OwnerMailboxCommand, principal: AuthPrincipal): Promise<MailboxResult<OwnerMailboxEntry>> {
      if (!ID.test(command.operationId) || !validBody(command.kind, command.body, binding, roomId)
        || !validPreviewId(command)) return { kind: 'conflict' };
      if (principal.ownerId !== binding.ownerId || !principal.providerIssuer || !principal.providerSubject) return { kind: 'conflict' };
      for (let attempt = 0; attempt < SUBMIT_ATTEMPTS; attempt++) {
        const prior = await archived(command.operationId);
        if (prior.kind !== 'ok') { submitDiagnostic?.('archive_read_unavailable'); return prior; }
        if (prior.value) return prior.value.kind === command.kind && sameValue(prior.value.body, command.body)
          && prior.value.authority.issuer === principal.providerIssuer && prior.value.authority.subject === principal.providerSubject
          ? { kind: 'ok', value: prior.value } : { kind: 'conflict' };
        const current = await read();
        if (current.kind !== 'ok') { submitDiagnostic?.('index_read_unavailable'); return current; }
        const { document, revision, expiresAt } = current.value;
        const existing = document.entries.find(entry => entry.operationId === command.operationId);
        if (existing) return existing.kind === command.kind && sameValue(existing.body, command.body)
          && existing.authority.issuer === principal.providerIssuer && existing.authority.subject === principal.providerSubject
          ? { kind: 'ok', value: existing } : { kind: 'conflict' };
        // An archive write always precedes removal from this poll index. Legacy
        // completed previews may be compacted because their IDs bind the body.
        let entries = [...document.entries];
        const readOnly = command.kind === 'review_preview' || command.kind === 'controls_status';
        if (command.kind !== 'channel_stop'
          && entries.filter(entry => entry.kind !== 'channel_stop').length >= OWNER_MAILBOX_MAX_ENTRIES
          && (!readOnly || !entries.some(entry => entry.kind === 'review_preview' || entry.kind === 'controls_status'))) {
          for (const entry of entries) {
            if (entry.kind === 'channel_stop') continue;
            const completed = await archived(entry.operationId);
            if (completed.kind !== 'ok') { submitDiagnostic?.('archive_read_unavailable'); return completed; }
            if (completed.value) entries = entries.filter(item => item.operationId !== entry.operationId);
          }
        }
        const replaceable = entries.filter(entry => entry.kind !== 'channel_stop'
          && (entry.kind === 'review_preview' || entry.kind === 'controls_status'));
        // A legacy full mailbox may have 32 reads of each kind. Migrate it a
        // little at a time so one owner request does not need dozens of blob writes.
        let evictions = 0;
        while (command.kind !== 'channel_stop' && evictions < 2 && (
          entries.filter(entry => entry.kind !== 'channel_stop').length >= OWNER_MAILBOX_MAX_ENTRIES
          || readOnly && entries.filter(entry => entry.kind === command.kind && entry.outcome === null).length >= MAX_UNRESOLVED_READS_PER_KIND
        )) {
          const preferred = readOnly && entries.filter(entry => entry.kind === command.kind && entry.outcome === null).length >= MAX_UNRESOLVED_READS_PER_KIND
            ? replaceable.findIndex(entry => entry.kind === command.kind && entry.outcome === null) : -1;
          const oldest = preferred < 0 ? replaceable.shift() : replaceable.splice(preferred, 1)[0];
          if (!oldest) break;
          // The result key is the durable decision point. A concurrent agent
          // completion may win this CAS; then its original result takes precedence.
          const saved = await archive({ ...oldest, outcome: oldest.outcome ?? { ok: false, code: 'unavailable' } },
            expiresAt ?? new Date(clock() + OWNER_MAILBOX_TTL_MS).toISOString());
          if (saved === 'unavailable') { submitDiagnostic?.('archive_write_unavailable'); return { kind: 'unavailable' }; }
          if (saved === 'conflict') {
            const winner = await archived(oldest.operationId);
            if (winner.kind !== 'ok' || !winner.value) {
              submitDiagnostic?.('archive_read_unavailable'); return { kind: 'unavailable' };
            }
          }
          entries = entries.filter(entry => entry.operationId !== oldest.operationId);
          evictions++;
        }
        if (command.kind === 'channel_stop'
          ? entries.some(entry => entry.kind === 'channel_stop')
          : entries.filter(entry => entry.kind !== 'channel_stop').length >= OWNER_MAILBOX_MAX_ENTRIES) {
          submitDiagnostic?.('capacity');
          return { kind: 'capacity' };
        }
        const authority: OwnerAuthority = {
          ownerId: binding.ownerId, issuer: principal.providerIssuer, subject: principal.providerSubject,
          authenticatedAt: new Date(clock()).toISOString(),
          authorizationId: `authz_${createHash('sha256').update(`${binding.bindingId}\0${command.operationId}\0${principal.providerIssuer}\0${principal.providerSubject}`).digest('base64url')}` as OwnerAuthority['authorizationId'],
        };
        const entry: OwnerMailboxEntry = { ...command, authority, authorityMac: authorityMac(command, authority, binding, roomId, authoritySecret), outcome: null };
        const saved = await write({ ...document, entries: [...entries, entry] }, revision,
          expiresAt ?? new Date(clock() + OWNER_MAILBOX_TTL_MS).toISOString());
        if (saved === 'applied') return { kind: 'ok', value: entry };
        if (saved === 'unavailable') { submitDiagnostic?.('index_cas_unavailable'); return { kind: 'unavailable' }; }
        // Give a competing writer a chance to advance the index before retrying.
        await new Promise(resolve => setTimeout(resolve, attempt % 4));
      }
      submitDiagnostic?.('index_cas_exhausted');
      return { kind: 'unavailable' };
    },
    /** Agent route calls only after current DPoP binding/generation authorization. */
    async pending(): Promise<MailboxResult<readonly OwnerMailboxEntry[]>> {
      const current = await read();
      if (current.kind !== 'ok') return current;
      const pending: OwnerMailboxEntry[] = [];
      for (const entry of current.value.document.entries) {
        if (entry.outcome !== null) continue;
        const prior = await archived(entry.operationId);
        if (prior.kind !== 'ok') return prior;
        if (prior.value) {
          if ((await savePreview(prior.value, true)) !== 'ok' || (await settlePreview(prior.value)) !== 'ok') {
            return { kind: 'unavailable' };
          }
          await retire(entry.operationId);
        } else pending.push(entry);
      }
      return { kind: 'ok', value: pending };
    },
    /** Agent route publishes only typed handler output; retries return the stored first result. */
    async complete(operationId: string, outcome: JsonValue): Promise<MailboxResult<OwnerMailboxEntry>> {
      const encoded = JSON.stringify(outcome);
      if (!ID.test(operationId) || typeof encoded !== 'string' || encoded.length > 32_768) return { kind: 'conflict' };
      for (let attempt = 0; attempt < 8; attempt++) {
        const prior = await archived(operationId);
        if (prior.kind !== 'ok') return prior;
        if (prior.value) return sameValue(prior.value.outcome!, outcome)
          ? (await savePreview(prior.value, true)) === 'ok' && (await settlePreview(prior.value)) === 'ok'
            ? { kind: 'ok', value: prior.value } : { kind: 'unavailable' }
          : { kind: 'conflict' };
        const current = await read();
        if (current.kind !== 'ok') return current;
        const { document, expiresAt } = current.value;
        const existing = document.entries.find(entry => entry.operationId === operationId);
        if (!existing || !validOutcome(existing.kind, outcome, binding, existing.body)) return { kind: 'conflict' };
        if (existing.outcome !== null && !sameValue(existing.outcome, outcome)) return { kind: 'conflict' };
        const entry = { ...existing, outcome };
        if (!expiresAt) return { kind: 'unavailable' };
        const saved = await archive(entry, expiresAt);
        if (saved === 'applied') {
          // The archive is the decision point. Only its winning outcome may
          // change the owner preview; failed reconciliation stays in the index
          // for a later poll to finish without re-executing the command.
          if ((await savePreview(entry)) !== 'ok' || (await settlePreview(entry)) !== 'ok') {
            return { kind: 'unavailable' };
          }
          if (entry.kind !== 'channel_stop') await retire(operationId);
          return { kind: 'ok', value: entry };
        }
        if (saved !== 'conflict') return { kind: 'unavailable' };
      }
      return { kind: 'unavailable' };
    },
    /** Browser route reads only the exact operation after revalidating owner authority. */
    async result(operationId: string): Promise<MailboxResult<OwnerMailboxEntry | null>> {
      if (!ID.test(operationId)) return { kind: 'conflict' };
      const prior = await archived(operationId);
      if (prior.kind !== 'ok' || prior.value) return prior;
      const current = await read();
      return current.kind === 'ok' ? { kind: 'ok', value: current.value.document.entries.find(entry => entry.operationId === operationId) ?? null }
        : current;
    },
  };
}

function sameValue(a: JsonValue, b: JsonValue): boolean { return sameJsonValue(a, b); }
function plain(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
function validBody(kind: OwnerCommandKind, body: JsonValue, binding: SessionBinding, roomId: string): boolean {
  if (!plain(body)) return false;
  if (kind === 'channel_stop') return keys(body, ['operationId', 'ownerId', 'roomId', 'expectedRoomRevision'])
    && typeof body.operationId === 'string' && ID.test(body.operationId)
    && body.ownerId === binding.ownerId && body.roomId === roomId && body.expectedRoomRevision === 0;
  if (kind === 'controls_set') {
    const decoded = decodePolicySetCommand(body);
    return decoded.ok && decoded.value.bindingId === binding.bindingId && decoded.value.roomId === roomId
      && decoded.value.expectedBindingGeneration === binding.generation && decoded.value.mode === 'review';
  }
  if (kind === 'review_approve') {
    const decoded = decodeApprovalCommand(body, DELIVERY_LIMITS);
    return decoded.ok && decoded.value.bindingId === binding.bindingId && decoded.value.roomId === roomId
      && decoded.value.expectedBindingGeneration === binding.generation;
  }
  if (kind === 'controls_status') return Object.keys(body).join(',') === 'bindingId' && body.bindingId === binding.bindingId;
  if (kind === 'review_preview') {
    if (Object.keys(body).sort().join(',') !== 'bindingId,candidates,releaseIds' || body.bindingId !== binding.bindingId
      || !Array.isArray(body.candidates) || body.candidates.length > 32 || !Array.isArray(body.releaseIds)
      || body.releaseIds.length > 64 || !body.releaseIds.every(id => typeof id === 'string' && ID.test(id))) return false;
    return body.candidates.every(candidate => {
      const decoded = decodeEventRef(candidate);
      return decoded.ok && decoded.value.roomId === roomId;
    });
  }
  return false;
}

/** Accept only the connector handlers' finite metadata results. A DPoP agent cannot put message bodies in Blobs. */
function validOutcome(kind: OwnerCommandKind, outcome: JsonValue, binding: SessionBinding, body: JsonValue): boolean {
  if (!plain(outcome)) return false;
  if (kind === 'channel_stop') {
    if (!keys(outcome, ['kind', 'receipt']) || outcome.kind !== 'stopped' || !plain(outcome.receipt)) return false;
    const receipt = outcome.receipt;
    return keys(receipt, ['operationId', 'ownerId', 'roomId', 'expectedRoomRevision', 'bindingId', 'bindingGeneration', 'state', 'cleanupRequested'])
      && plain(body) && receipt.operationId === body.operationId
      && receipt.ownerId === binding.ownerId && receipt.roomId === body.roomId
      && receipt.expectedRoomRevision === body.expectedRoomRevision && receipt.bindingId === binding.bindingId
      && receipt.bindingGeneration === binding.generation && receipt.state === 'stopped'
      && receipt.cleanupRequested === true;
  }
  if (kind === 'review_approve') return decodeApprovalResult(outcome, DELIVERY_LIMITS).ok;
  if (kind === 'controls_set') {
    if (!keys(outcome, ['ok', 'ack']) || outcome.ok !== true) return keys(outcome, ['ok', 'code'])
      && outcome.ok === false && outcome.code === 'forbidden';
    const decoded = decodePolicyAck(outcome.ack);
    return decoded.ok && decoded.value.bindingId === binding.bindingId && decoded.value.generation === binding.generation;
  }
  if (outcome.ok === false) return keys(outcome, ['ok', 'code']) && (
    outcome.code === 'forbidden' || outcome.code === 'unavailable' || (kind === 'review_preview' && outcome.code === 'revoked'));
  if (kind === 'review_preview') {
    if (!keys(outcome, ['ok', 'preview']) || outcome.ok !== true || !plain(outcome.preview)) return false;
    const preview = outcome.preview;
    if (!keys(preview, ['v', 'bindingId', 'bindingGeneration', 'policyVersion', 'pending', 'receipts'])
      || preview.v !== 1 || preview.bindingId !== binding.bindingId || preview.bindingGeneration !== binding.generation
      || !count(preview.policyVersion) || !Array.isArray(preview.pending) || preview.pending.length > 32
      || !Array.isArray(preview.receipts) || preview.receipts.length > 64) return false;
    return preview.pending.every(item => decodeEventRef(item).ok)
      && preview.receipts.every(item => decodeDeliveryReceiptTransport(item).ok);
  }
  if (!keys(outcome, ['ok', 'status']) || outcome.ok !== true || !plain(outcome.status)) return false;
  const status = outcome.status;
  if (!keys(status, ['v', 'binding', 'bindingStatus', 'capabilities', 'policy', 'requested', 'busy', 'latestReceipt'])
    || status.v !== 1 || status.bindingStatus !== 'active' || typeof status.busy !== 'boolean') return false;
  const decodedBinding = decodeSessionBinding(status.binding);
  if (!decodedBinding.ok || decodedBinding.value.bindingId !== binding.bindingId
    || decodedBinding.value.generation !== binding.generation) return false;
  if (status.capabilities !== null && !decodeHarnessCapabilities(status.capabilities).ok) return false;
  if (status.latestReceipt !== null && !decodeDeliveryReceiptTransport(status.latestReceipt).ok) return false;
  if (!plain(status.policy) || !keys(status.policy, ['bindingId', 'generation', 'effectiveVersion', 'effectiveMode', 'paused'])
    || status.policy.bindingId !== binding.bindingId || status.policy.generation !== binding.generation
    || (status.policy.effectiveVersion !== null && !count(status.policy.effectiveVersion))
    || (status.policy.effectiveMode !== null && !['review', 'auto'].includes(String(status.policy.effectiveMode)))
    || (status.policy.paused !== null && typeof status.policy.paused !== 'boolean')) return false;
  if (status.requested === null) return true;
  const requested = status.requested;
  return plain(requested) && keys(requested, ['commandId', 'version', 'mode', 'paused', 'connectorState', 'errorCode'])
    && typeof requested.commandId === 'string' && /^[A-Za-z0-9_-]{1,256}$/u.test(requested.commandId)
    && count(requested.version) && ['review', 'auto'].includes(String(requested.mode))
    && typeof requested.paused === 'boolean' && ['pending', 'offline', 'rejected'].includes(String(requested.connectorState))
    && (requested.errorCode === null || ['forbidden', 'stale_policy', 'stale_binding', 'idempotency_conflict', 'unavailable', 'outcome_unknown'].includes(String(requested.errorCode)));
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function authorityMac(command: OwnerMailboxCommand, authority: OwnerAuthority, binding: SessionBinding, roomId: string, secret: string): string {
  return createHmac('sha256', secret).update(JSON.stringify([
    'khala-owner-mailbox-v1', binding.bindingId, binding.generation, roomId,
    command.operationId, command.kind, command.body, authority,
  ])).digest('base64url');
}

function validAuthority(entry: Record<string, JsonValue>, binding: SessionBinding, roomId: string, secret: string): boolean {
  if (!plain(entry.authority) || typeof entry.authorityMac !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/u.test(entry.authorityMac)) return false;
  const raw = entry.authority;
  if (!keys(raw, ['ownerId', 'issuer', 'subject', 'authenticatedAt', 'authorizationId'])
    || raw.ownerId !== binding.ownerId || typeof raw.issuer !== 'string' || !raw.issuer
    || typeof raw.subject !== 'string' || !raw.subject
    || typeof raw.authenticatedAt !== 'string' || !Number.isFinite(Date.parse(raw.authenticatedAt))
    || typeof raw.authorizationId !== 'string' || !/^authz_[A-Za-z0-9_-]{43}$/u.test(raw.authorizationId)) return false;
  const authority = raw as OwnerAuthority;
  const expected = authorityMac(entry as unknown as OwnerMailboxCommand, authority, binding, roomId, secret);
  return timingSafeEqual(Buffer.from(expected), Buffer.from(entry.authorityMac));
}
