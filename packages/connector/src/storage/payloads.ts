// Pending and released plaintext lives only inside the owner-local ledger, addressed by
// random opaque handles. A handle is never a filesystem path, URL or anything a model
// could fetch; only the owner endpoint resolves it.

import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** A fresh, unguessable payload handle for a release envelope or pending item. */
export function newPayloadRef(): string {
  return `payload_${randomBytes(16).toString('base64url')}`;
}

/** `sha256:<hex>` over exact bytes, the form `EventRef.contentDigest` uses. */
export function sha256Digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function insertPayload(db: DatabaseSync, payloadRef: string, bytes: Uint8Array): void {
  db.prepare('INSERT INTO payloads (payload_ref, digest, bytes) VALUES (?, ?, ?)')
    .run(payloadRef, sha256Digest(bytes), bytes);
}

export function payloadExists(db: DatabaseSync, payloadRef: string): boolean {
  return db.prepare('SELECT 1 FROM payloads WHERE payload_ref = ?').get(payloadRef) !== undefined;
}

/**
 * Returns the stored bytes only when they still match the digest recorded with them,
 * so on-disk damage surfaces as unavailable instead of as altered content.
 */
export function readPayload(db: DatabaseSync, payloadRef: string): Uint8Array | null {
  const row = db.prepare('SELECT digest, bytes FROM payloads WHERE payload_ref = ?').get(payloadRef) as
    | { digest: string; bytes: Uint8Array }
    | undefined;
  if (!row) return null;
  const bytes = new Uint8Array(row.bytes);
  return sha256Digest(bytes) === row.digest ? bytes : null;
}

/** Payload handles still referenced by a pending item or a release, for retention (KHA-130). */
export function payloadReferences(db: DatabaseSync, payloadRef: string): { pending: number; releases: number } {
  const pending = db.prepare('SELECT count(*) AS n FROM pending WHERE payload_ref = ?').get(payloadRef) as { n: number };
  const releases = db.prepare('SELECT count(*) AS n FROM releases WHERE payload_ref = ?').get(payloadRef) as { n: number };
  return { pending: pending.n, releases: releases.n };
}
