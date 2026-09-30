import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, rm, open } from 'node:fs/promises';
import type { LocalInbox } from './hosted-codex';

type Delivery = Parameters<LocalInbox['enqueue']>[0];
type StoredDelivery = Omit<Delivery, 'payload'> & { payload: string };
type Row = { key: string; authorName: string; delivery: StoredDelivery | null; delivered: boolean; acknowledged: boolean; originalReleaseId: string | null };
type State = { v: 1; rows: Row[]; releases: Record<string, string[]>; releaseDigests: Record<string, string>; legacySeeded?: boolean };
const keyFor = (roomId: string, eventId: string) => JSON.stringify([roomId, eventId]);
const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** The journal contains event identities/names and approved bytes only. Held bodies never enter it. */
export function createOrderedProjection(filename: string) {
  let serial = Promise.resolve();
  let cached: State | null = null;
  const run = <T>(fn: (state: State) => Promise<T>): Promise<T> => {
    const task = serial.then(async () => {
      if (!cached) {
        const text = await readFile(filename, 'utf8').catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        });
        cached = text === null ? { v: 1, rows: [], releases: {}, releaseDigests: {} } : JSON.parse(text) as State;
        if (!cached || !cached.releaseDigests || typeof cached.releaseDigests !== 'object' || cached.v !== 1 || !Array.isArray(cached.rows) || !cached.releases
          || typeof cached.releases !== 'object' || Array.isArray(cached.releases)
          || Object.values(cached.releases).some(ids => !Array.isArray(ids) || ids.some(id => typeof id !== 'string'))
          || cached.rows.some(row => !row || typeof row.key !== 'string' || typeof row.authorName !== 'string'
            || typeof row.delivered !== 'boolean' || typeof row.acknowledged !== 'boolean'
            || !(row.originalReleaseId === null || typeof row.originalReleaseId === 'string')
            || !(row.delivery === null || typeof row.delivery === 'object' && typeof row.delivery.payload === 'string'
              && typeof row.delivery.releaseId === 'string' && Array.isArray(row.delivery.events)))
          || new Set(cached.rows.map(row => row.key)).size !== cached.rows.length) throw new Error('ordered_projection_corrupt');
      }
      return fn(cached);
    });
    serial = task.then(() => undefined, () => { cached = null; });
    return task;
  };
  async function save(state: State) {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, filename);
      const directory = await open(filename.slice(0, filename.lastIndexOf('/')), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
  }
  async function flush(state: State, inbox: LocalInbox) {
    for (const row of state.rows) {
      if (row.delivered) continue;
      if (!row.delivery) break;
      const { payload, ...delivery } = row.delivery;
      await inbox.enqueue({ ...delivery, payload: Buffer.from(payload, 'base64') });
      row.delivered = true;
      await save(state);
      await inbox.notifyListener('released').catch(() => 'unavailable' as const);
    }
  }
  return {
    seedLegacy(references: readonly Readonly<{ roomId: string; eventId: string; authorParticipantId: string; ledgerRevision: number; previouslyDelivered: boolean }>[]) {
      return run(async state => {
        if (state.legacySeeded) return;
        // A journal already populated by #548 has recorded every observed event before its cursor commits.
        if (state.rows.length === 0) {
          let previousRevision = 0;
          for (const reference of references) {
            if (reference.ledgerRevision <= previousRevision) throw new Error('ordered_projection_legacy_order_invalid');
            previousRevision = reference.ledgerRevision;
            state.rows.push({ key: keyFor(reference.roomId, reference.eventId), authorName: reference.authorParticipantId,
              delivery: null, delivered: reference.previouslyDelivered, acknowledged: false, originalReleaseId: null });
          }
        }
        state.legacySeeded = true;
        await save(state);
      });
    },
    observe(roomId: string, eventId: string, authorName: string) {
      return run(async state => {
        const key = keyFor(roomId, eventId);
        if (!state.rows.some(row => row.key === key)) {
          state.rows.push({ key, authorName, delivery: null, delivered: false, acknowledged: false, originalReleaseId: null });
          await save(state);
        }
      });
    },
    metadata(delivery: Delivery, inbox: LocalInbox) {
      return run(async state => {
        const ref = delivery.events[0]!;
        const key = keyFor(ref.roomId, ref.eventId);
        const existing = state.rows.find(row => row.key === key);
        const stored = { ...delivery, payload: Buffer.from(delivery.payload).toString('base64') };
        if (existing?.delivery && JSON.stringify(existing.delivery) !== JSON.stringify(stored)) throw new Error('ordered_projection_conflict');
        if (!existing) state.rows.push({ key, authorName: '', delivery: stored, delivered: false, acknowledged: false, originalReleaseId: null });
        else existing.delivery = stored;
        await save(state);
        await flush(state, inbox);
      });
    },
    enqueue(delivery: Delivery, inbox: LocalInbox): Promise<'appended' | 'duplicate'> {
      return run(async state => {
        if (state.releases[delivery.releaseId]) {
          if (state.releaseDigests[delivery.releaseId] !== digest(delivery.payload)) throw new Error('ordered_projection_conflict');
          await flush(state, inbox); return 'duplicate';
        }
        const tuple = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(delivery.payload)) as unknown[];
        if (tuple[0] !== 'khala.release.v1' || !Array.isArray(tuple[5]) || tuple[5].length !== delivery.events.length) throw new Error('ordered_projection_invalid_release');
        const ids: string[] = [];
        for (const [index, ref] of delivery.events.entries()) {
          const row = state.rows.find(row => row.key === keyFor(ref.roomId, ref.eventId));
          if (!row || row.delivery) throw new Error('ordered_projection_event_missing');
          const id = `projection_${createHash('sha256').update(JSON.stringify([delivery.bindingId, delivery.generation, delivery.releaseId, ref.roomId, ref.eventId])).digest('hex')}`;
          const item = tuple[5][index];
          if (!Array.isArray(item) || item.length !== 6 || item[1] !== ref.eventId || item[0] !== ref.roomId) throw new Error('ordered_projection_invalid_release');
          const payload = Buffer.from(JSON.stringify(['khala.attributed-release.v1', id, tuple[2], tuple[3], tuple[4], [[...item, row.authorName]]]));
          row.delivery = { ...delivery, releaseId: id, events: [ref], payload: payload.toString('base64'), payloadDigest: digest(payload) };
          row.originalReleaseId = delivery.releaseId;
          ids.push(id);
        }
        state.releases[delivery.releaseId] = ids;
        state.releaseDigests[delivery.releaseId] = digest(delivery.payload);
        await save(state);
        await flush(state, inbox);
        return 'appended';
      });
    },
    acknowledge(ids: readonly string[]) {
      return run(async state => {
        for (const id of ids) {
          if (!id.startsWith('projection_')) continue;
          const row = state.rows.find(row => row.delivery?.releaseId === id);
          if (!row?.delivered) throw new Error('ordered_projection_acknowledgement_unknown');
          row.acknowledged = true;
        }
        await save(state);
        const candidates = new Set(state.rows.filter(row => row.delivery && ids.includes(row.delivery.releaseId)).map(row => row.originalReleaseId));
        const completed = Object.entries(state.releases).filter(([id]) => candidates.has(id)).filter(([, parts]) => parts.every(id => state.rows.some(row => row.delivery?.releaseId === id && row.acknowledged))).map(([id]) => id);
        return [...ids.filter(id => !id.startsWith('projection_') && !id.startsWith('rename_')), ...completed];
      });
    },
    flush: (inbox: LocalInbox) => run(state => flush(state, inbox)),
  };
}
