import { describe, expect, it } from 'vitest';
import type { OwnerId } from '@khala/contracts/messaging/index';
import { ownerFromMatrixUserId, ownerMatrixLocalpart, ownerMatrixUserId } from './matrix-identity';

const server = 'matrix.example.test';

describe('owner Matrix account mapping', () => {
  it('escapes uppercase base64url bytes for Synapse while preserving an already-valid legacy ID', () => {
    expect(ownerMatrixLocalpart('owner_closure' as OwnerId)).toBe('khala_b3du=z=x=jf=y2xvc3=vy=z=q');
    expect(ownerMatrixUserId('n' as OwnerId, server)).toBe('@khala_bg:matrix.example.test');
  });

  it('round trips distinct opaque owners and refuses noncanonical aliases', () => {
    const owners = ['owner_closure', 'owner_Closure', 'own_abcdef0123456789', 'n', 'N'] as OwnerId[];
    const users = owners.map(owner => ownerMatrixUserId(owner, server));
    expect(new Set(users).size).toBe(owners.length);
    for (let i = 0; i < owners.length; i++) expect(ownerFromMatrixUserId(users[i]!, server)).toBe(owners[i]);
    expect(ownerFromMatrixUserId('@khala_b3duzxjfy2xvc3vyzq:matrix.example.test', server)).toBeNull();
    expect(ownerFromMatrixUserId(`${users[0]}=a`, server)).toBeNull();
    expect(ownerFromMatrixUserId(users[0]!, 'elsewhere.test')).toBeNull();
  });
});
