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
});

describe('renderRouteManifest', () => {
  it('always includes the built-in health route', () => {
    const manifest = JSON.parse(renderRouteManifest({ presentDomains: [], absentPrefixes: [], routeManifest: [] }));
    expect(manifest.routes).toEqual([{ path: '/api/health', methods: ['GET'], domain: 'runtime' }]);
  });
});
