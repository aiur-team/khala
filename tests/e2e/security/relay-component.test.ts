// Opt-in disposable Synapse/Postgres component evidence. This is intentionally
// separate from security.test.ts's final hosted/native acceptance entries.
import { describe, expect, it } from 'vitest';
import { isIssuedManifest } from '../harness/evidence';
import { runRelayComponent } from './relay-component';

describe.skipIf(process.env.KHALA_SECURITY_RELAY_COMPONENT !== '1')('disposable relay component', () => {
  it('decrypts at both SDK endpoints and scans owned PostgreSQL bytes and logs', async () => {
    const manifest = await runRelayComponent();
    expect(isIssuedManifest(manifest)).toBe(true);
    expect(manifest.mode).toBe('live-sdk');
    expect(manifest.records.map(record => record.kind)).toEqual([
      'relay.encrypted', 'relay.both_decrypted', 'relay.database_scanned',
      'relay.logs_scanned', 'relay.scanner_positive',
    ]);
    expect(manifest.records.every(record => record.driver === 'synapse-sdk')).toBe(true);
  }, 300_000);
});
