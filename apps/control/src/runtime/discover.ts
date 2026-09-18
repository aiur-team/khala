#!/usr/bin/env node
// Build-time route discovery. Runs `registerHumanHandlers`/`registerAgentHandlers`
// from the two literal, approved composition paths, validates their output, and
// emits the generated Netlify function entrypoint. Never runs at request time.

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { HEALTH_PATH, RESERVED_PREFIXES, type RouteRegistration } from './handler';

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

type Domain = Readonly<{
  key: string;
  prefix: string;
  modulePath: string;
  exportName: string;
}>;

export class DiscoverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoverError';
  }
}

/** Resolved from this file's own location so discovery works from any CWD. */
export function repoRootFrom(runtimeDirectory: string): string {
  return path.resolve(runtimeDirectory, '../../../..');
}

function domainsFor(repoRoot: string): readonly Domain[] {
  return [
    {
      key: 'human',
      prefix: '/api/human/',
      modulePath: path.join(repoRoot, 'apps/control/src/composition/human/handlers.ts'),
      exportName: 'registerHumanHandlers',
    },
    {
      key: 'agent',
      prefix: '/api/agent/',
      modulePath: path.join(repoRoot, 'apps/control/src/composition/agent/handlers.ts'),
      exportName: 'registerAgentHandlers',
    },
  ];
}

function validateRegistration(domain: Domain, registration: unknown, seenPaths: Map<string, string>): RouteRegistration {
  if (typeof registration !== 'object' || registration === null) {
    throw new DiscoverError(`${domain.key}: a route registration must be an object`);
  }
  const { path: routePath, methods, handle } = registration as Record<string, unknown>;
  if (typeof routePath !== 'string' || !routePath.startsWith(domain.prefix)) {
    throw new DiscoverError(`${domain.key}: route path ${JSON.stringify(routePath)} must start with ${domain.prefix}`);
  }
  if (!Array.isArray(methods) || methods.length === 0 || !methods.every(method => typeof method === 'string' && HTTP_METHODS.has(method))) {
    throw new DiscoverError(`${domain.key}: route ${routePath} has an invalid methods list`);
  }
  if (typeof handle !== 'function') throw new DiscoverError(`${domain.key}: route ${routePath} is missing a handle function`);
  if (seenPaths.has(routePath)) {
    throw new DiscoverError(`duplicate route path ${routePath} registered by both ${seenPaths.get(routePath)} and ${domain.key}`);
  }
  seenPaths.set(routePath, domain.key);
  return { path: routePath, methods: methods as readonly string[], handle: handle as RouteRegistration['handle'] };
}

export type DiscoveryResult = Readonly<{
  presentDomains: readonly Domain[];
  absentPrefixes: readonly string[];
  routeManifest: readonly Readonly<{ path: string; methods: readonly string[]; domain: string }>[];
}>;

/**
 * An absent producer module is a safe, deliberate no-op (its routes are simply
 * not registered; see `absentPrefixes`) so this ticket can build before
 * KHA-132/133 land. An *existing but malformed* producer — wrong export shape,
 * a route outside its own domain prefix, a route double-registered with
 * another domain — is always a build error, never silently skipped.
 */
export async function discoverRoutes(repoRoot: string): Promise<DiscoveryResult> {
  const seenPaths = new Map<string, string>();
  const presentDomains: Domain[] = [];
  const absentPrefixes: string[] = [];
  const routeManifest: { path: string; methods: readonly string[]; domain: string }[] = [];

  for (const domain of domainsFor(repoRoot)) {
    if (!existsSync(domain.modulePath)) {
      absentPrefixes.push(domain.prefix);
      continue;
    }
    const moduleExports = (await import(pathToFileURL(domain.modulePath).href)) as Record<string, unknown>;
    const factory = moduleExports[domain.exportName];
    if (typeof factory !== 'function') {
      throw new DiscoverError(`${domain.modulePath} must export a function named ${domain.exportName}`);
    }
    const registrations = factory();
    if (!Array.isArray(registrations)) {
      throw new DiscoverError(`${domain.exportName}() must return an array of route registrations`);
    }
    for (const registration of registrations) {
      const validated = validateRegistration(domain, registration, seenPaths);
      routeManifest.push({ path: validated.path, methods: validated.methods, domain: domain.key });
    }
    presentDomains.push(domain);
  }

  return { presentDomains, absentPrefixes, routeManifest };
}

export function renderGeneratedFunction(result: DiscoveryResult): string {
  const imports = result.presentDomains
    .map(domain => `import { ${domain.exportName} } from '../../apps/control/src/composition/${domain.key}/handlers';`)
    .join('\n');
  const registrationCalls = result.presentDomains.map(domain => `...${domain.exportName}()`).join(', ');
  const absentPrefixesLiteral = JSON.stringify(result.absentPrefixes);

  return `// GENERATED FILE — do not edit. Produced by apps/control/src/runtime/discover.ts
// via \`pnpm --filter @khala/control build:functions\`. This directory is
// Netlify's functions *input*, not its build output; it is gitignored.
import { createGateway } from '../../apps/control/src/runtime/handler';
import { readServerEnv } from '../../apps/control/src/runtime/env';
${imports}

// Fails closed at cold start if required server config is absent (never logs
// a value); the resolved app origin also seeds the gateway's Origin check.
const serverEnv = readServerEnv();

const gateway = createGateway({
  registrations: [${registrationCalls}],
  absentPrefixes: ${absentPrefixesLiteral},
  appOrigin: serverEnv.publicAppOrigin,
});

export default gateway;
`;
}

export function renderRouteManifest(result: DiscoveryResult): string {
  return JSON.stringify(
    {
      reservedPrefixes: RESERVED_PREFIXES,
      absentPrefixes: result.absentPrefixes,
      routes: [{ path: HEALTH_PATH, methods: ['GET'], domain: 'runtime' }, ...result.routeManifest],
    },
    null,
    2,
  ) + '\n';
}

async function run(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = repoRootFrom(here);
  const result = await discoverRoutes(repoRoot);
  const outputDirectory = path.join(repoRoot, 'infra/netlify/functions-generated');
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, 'khala-control.ts'), renderGeneratedFunction(result), 'utf8');
  await writeFile(path.join(outputDirectory, 'route-manifest.json'), renderRouteManifest(result), 'utf8');
  const domainSummary = result.presentDomains.map(domain => domain.key).join(', ') || 'none';
  console.log(`build:functions: ${result.routeManifest.length} route(s) from [${domainSummary}]; absent: ${result.absentPrefixes.join(', ') || 'none'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => {
    console.error(error instanceof DiscoverError ? `build:functions failed: ${error.message}` : error);
    process.exitCode = 1;
  });
}
