import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeInternalDescriptor } from '@khala/contracts/internal/descriptor';
import { writeActiveDescriptor } from '../../descriptor/write';
import { mintCredential } from '../../server/credentials';
import { bobBinding, channelId, createChannelFixture, otherChannelId, type ChannelFixture } from '../../server/fixtures/channel-fixture';
import { clearDescriptorGrant, composeBindingControl, readActivatedBindings } from './index';

const NOW = Date.parse('2026-09-25T00:00:00.000Z');
const fixtures: ChannelFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

function fixture(): ChannelFixture {
  const created = createChannelFixture({ root: fs.mkdtempSync('/tmp/khala-binding-control-'), now: NOW });
  fixtures.push(created);
  return created;
}

const transport = { v: 1 as const, channelId, origin: 'http://127.0.0.1:4870', transportCapability: mintCredential() };
const granted = (bindingId: string) => ({ ...transport, grantRef: 'grant-1', bindingId, bindingCapability: mintCredential() });
const activePath = (fx: ChannelFixture) => path.join(fx.root, 'active.json');

describe('descriptor grant clearing', () => {
  it('rewrites the descriptor as transport-only when its grant names a stopped binding', () => {
    const fx = fixture();
    writeActiveDescriptor(fx.root, granted('binding-bob'));
    expect(clearDescriptorGrant(fx.root, new Set(['binding-bob']))).toBe('cleared');
    expect(fs.readFileSync(activePath(fx), 'utf8')).toBe(encodeInternalDescriptor(transport));
    expect(fs.statSync(activePath(fx)).mode & 0o777).toBe(0o600);
  });

  it('leaves another binding grant, a transport-only descriptor and a missing descriptor alone', () => {
    const fx = fixture();
    writeActiveDescriptor(fx.root, granted('binding-other'));
    const before = fs.readFileSync(activePath(fx), 'utf8');
    expect(clearDescriptorGrant(fx.root, new Set(['binding-bob']))).toBe('absent');
    expect(fs.readFileSync(activePath(fx), 'utf8')).toBe(before);

    writeActiveDescriptor(fx.root, transport);
    expect(clearDescriptorGrant(fx.root, new Set(['binding-bob']))).toBe('absent');

    fs.rmSync(activePath(fx));
    expect(clearDescriptorGrant(fx.root, new Set(['binding-bob']))).toBe('absent');
    expect(fs.existsSync(activePath(fx))).toBe(false);
  });

  it('fails closed on an unreadable descriptor', () => {
    const fx = fixture();
    fs.writeFileSync(activePath(fx), '{not json', { mode: 0o600 });
    expect(clearDescriptorGrant(fx.root, new Set(['binding-bob']))).toBe('failed');
    fs.rmSync(activePath(fx));
    fs.symlinkSync('/etc/hostname', activePath(fx));
    expect(clearDescriptorGrant(fx.root, new Set(['binding-bob']))).toBe('failed');
  });

  it('stops touching the descriptor once the launcher closes the control', () => {
    const fx = fixture();
    const control = composeBindingControl({ handle: fx.handle, root: fx.root });
    writeActiveDescriptor(fx.root, granted('binding-bob'));
    control.close();
    expect(control.clearGrant!(new Set(['binding-bob']))).toBe('absent');
    expect(fs.readFileSync(activePath(fx), 'utf8')).toContain('bindingCapability');
  });
});

describe('activated binding reader', () => {
  it('lists every generation activated for exactly that channel', () => {
    const fx = fixture();
    expect(readActivatedBindings(fx.handle, channelId)).toEqual([]);
    fx.handle.transaction(db => {
      db.prepare(`
        INSERT INTO discovery_activations (operation_key, binding_id, generation, channel_id, session_generation)
        VALUES ('op-bob', ?, 1, ?, 1)
      `).run(bobBinding.bindingId, channelId);
    });
    expect(readActivatedBindings(fx.handle, channelId)).toEqual([bobBinding]);
    expect(readActivatedBindings(fx.handle, otherChannelId)).toEqual([]);
  });
});
