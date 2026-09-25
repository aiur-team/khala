import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiscoverError, discoverRoutes, renderGeneratedFunction, renderRouteManifest, repoRootFrom } from './discover';

let repoRoot: string;

async function writeHandlers(domain: 'human' | 'agent', source: string): Promise<void> {
  const directory = join(repoRoot, 'apps/control/src/composition', domain);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'handlers.ts'), source, 'utf8');
}

const noopHandle = "async () => new Response(null, { status: 204 })";

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'khala-discover-'));
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

describe('repoRootFrom', () => {
  it('resolves four levels up from apps/control/src/runtime', () => {
    expect(repoRootFrom('/repo/apps/control/src/runtime')).toBe('/repo');
  });
});

describe('discoverRoutes', () => {
  it('omits an absent domain safely and records its prefix', async () => {
    const result = await discoverRoutes(repoRoot);
    expect(result.presentDomains).toEqual([]);
    expect(result.absentPrefixes).toEqual(['/api/human/', '/api/agent/']);
    expect(result.routeManifest).toEqual([]);
  });

  it('discovers a present domain and validates its routes', async () => {
    await writeHandlers('human', `
      export function registerHumanHandlers() {
        return [{ path: '/api/human/auth/callback', methods: ['GET'], handle: ${noopHandle} }];
      }
    `);
    const result = await discoverRoutes(repoRoot);
    expect(result.presentDomains.map(domain => domain.key)).toEqual(['human']);
    expect(result.absentPrefixes).toEqual(['/api/agent/']);
    expect(result.routeManifest).toEqual([{ path: '/api/human/auth/callback', methods: ['GET'], domain: 'human' }]);
  });

  it('fails the build on a route registered outside its own domain prefix', async () => {
    await writeHandlers('human', `
      export function registerHumanHandlers() {
        return [{ path: '/api/agent/steal', methods: ['GET'], handle: ${noopHandle} }];
      }
    `);
    await expect(discoverRoutes(repoRoot)).rejects.toThrow(DiscoverError);
  });

  it('fails the build on a missing registration export', async () => {
    await writeHandlers('human', 'export const somethingElse = 1;');
    await expect(discoverRoutes(repoRoot)).rejects.toThrow(/must export a function named registerHumanHandlers/);
  });

  it('rejects two registrations from the same domain that reuse a path', async () => {
    await writeHandlers('human', `
      export function registerHumanHandlers() {
        return [
          { path: '/api/human/shared', methods: ['GET'], handle: ${noopHandle} },
          { path: '/api/human/shared', methods: ['POST'], handle: ${noopHandle} },
        ];
      }
    `);
    await expect(discoverRoutes(repoRoot)).rejects.toThrow(/duplicate route path/);
  });

  it('rejects a route path outside every domain prefix, including the reserved health path', async () => {
    await writeHandlers('human', `
      export function registerHumanHandlers() {
        return [{ path: '/api/health', methods: ['GET'], handle: ${noopHandle} }];
      }
    `);
    await expect(discoverRoutes(repoRoot)).rejects.toThrow(/must start with \/api\/human\//);
  });

  it('rejects a route with an empty or invalid methods list', async () => {
    await writeHandlers('human', `
      export function registerHumanHandlers() {
        return [{ path: '/api/human/broken', methods: [], handle: ${noopHandle} }];
      }
    `);
    await expect(discoverRoutes(repoRoot)).rejects.toThrow(/invalid methods list/);
  });

  it('rejects a test double whose registrations() does not return an array', async () => {
    await writeHandlers('human', `
      export function registerHumanHandlers() {
        return { path: '/api/human/broken' };
      }
    `);
    await expect(discoverRoutes(repoRoot)).rejects.toThrow(/must return an array/);
  });
});

describe('renderGeneratedFunction', () => {
  it('imports only present domains and bakes in the absent prefixes', () => {
    const rendered = renderGeneratedFunction({
      presentDomains: [{ key: 'human', prefix: '/api/human/', modulePath: '/x', exportName: 'registerHumanHandlers' }],
      absentPrefixes: ['/api/agent/'],
      routeManifest: [],
    });
    expect(rendered).toContain("import { registerHumanHandlers } from '../../apps/control/src/composition/human/handlers';");
    expect(rendered).not.toContain('registerAgentHandlers');
    expect(rendered).toContain('"/api/agent/"');
    expect(rendered).toContain('export default gateway;');
  });

  it('validates the server environment before building the gateway and seeds appOrigin from it', () => {
    const rendered = renderGeneratedFunction({ presentDomains: [], absentPrefixes: [], routeManifest: [] });
    expect(rendered).toContain("import { readServerEnv } from '../../apps/control/src/runtime/env';");
    expect(rendered).toContain('const serverEnv = readServerEnv();');
    expect(rendered).toContain('appOrigin: serverEnv.publicAppOrigin');
  });
});

describe('renderRouteManifest', () => {
  it('always includes the built-in health route', () => {
    const manifest = JSON.parse(renderRouteManifest({ presentDomains: [], absentPrefixes: [], routeManifest: [] }));
    expect(manifest.routes).toEqual([{ path: '/api/health', methods: ['GET'], domain: 'runtime' }]);
  });

  it('pins the production discovery manifest and exposes no public pairing redeem route', async () => {
    const actualRoot = repoRootFrom(import.meta.dirname);
    const manifest = JSON.parse(renderRouteManifest(await discoverRoutes(actualRoot)));
    expect(manifest.routes).toEqual([
      { path: '/api/health', methods: ['GET'], domain: 'runtime' },
      { path: '/api/human/pairing/request', methods: ['POST', 'GET'], domain: 'human' },
      { path: '/api/human/pairing/decision', methods: ['POST'], domain: 'human' },
      { path: '/api/human/channel-access/inbox', methods: ['GET'], domain: 'human' },
      { path: '/api/human/channel-access/decision', methods: ['POST'], domain: 'human' },
      { path: '/api/human/channel-access/mute', methods: ['POST'], domain: 'human' },
      { path: '/api/human/channel-discovery/bootstrap/authorize', methods: ['GET', 'POST'], domain: 'human' },
      { path: '/api/human/channel-discovery/settings', methods: ['PUT'], domain: 'human' },
      { path: '/api/human/channel-discovery/allowlist', methods: ['POST'], domain: 'human' },
      { path: '/api/human/channel-discovery/rollout', methods: ['PUT'], domain: 'human' },
      { path: '/api/agent/status', methods: ['GET'], domain: 'agent' },
      { path: '/api/agent/pairing/claim', methods: ['POST'], domain: 'agent' },
      { path: '/api/agent/pairing/result', methods: ['POST'], domain: 'agent' },
      { path: '/api/agent/channel-access/request', methods: ['POST'], domain: 'agent' },
      { path: '/api/agent/channel-access/create', methods: ['POST'], domain: 'agent' },
      { path: '/api/agent/channel-access/status', methods: ['GET'], domain: 'agent' },
      { path: '/api/agent/channel-discovery/bootstrap/token', methods: ['POST'], domain: 'agent' },
      { path: '/api/agent/channels', methods: ['GET'], domain: 'agent' },
    ]);
    expect(JSON.stringify(manifest)).not.toContain('pairing/redeem');
    expect(JSON.stringify(manifest)).not.toMatch(/channel-access\/(exchange|grant)|:\w|\*/);
  });
});
