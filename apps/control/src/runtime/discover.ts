#!/usr/bin/env node
// Build-time route discovery. Runs `registerHumanHandlers`/`registerAgentHandlers`
// from the two literal, approved composition paths, validates their output, and
// emits the generated Netlify function entrypoint. Never runs at request time.

import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';
import { build } from 'esbuild';
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

  const presentPrefixes = new Set(presentDomains.map(domain => domain.prefix));
  return { presentDomains, absentPrefixes: [...new Set(absentPrefixes)].filter(prefix => !presentPrefixes.has(prefix)), routeManifest };
}

/** Netlify's functions input directory (`[functions].directory` in netlify.toml). */
export function functionsOutputDirectory(repoRoot: string): string {
  return path.join(repoRoot, 'infra/netlify/functions-generated');
}

/**
 * The extensionless, POSIX-separated specifier the generated function uses to
 * import `modulePath`. Derived from the real output directory, not a hardcoded
 * `../..`, so esbuild resolves it however deep that directory sits.
 */
export function importSpecifier(outputDirectory: string, modulePath: string): string {
  const relative = path.relative(outputDirectory, modulePath.replace(/\.ts$/u, '')).split(path.sep).join('/');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

export function renderGeneratedFunction(result: DiscoveryResult, repoRoot: string): string {
  const outputDirectory = functionsOutputDirectory(repoRoot);
  const runtimeImport = (file: string) => importSpecifier(outputDirectory, path.join(repoRoot, 'apps/control/src/runtime', file));
  const completeHostedDomains = result.presentDomains.some(domain => domain.key === 'human')
    && result.presentDomains.some(domain => domain.key === 'agent');
  const imports = completeHostedDomains
    ? `import { registerHostedProductionRoutes } from '${importSpecifier(outputDirectory, path.join(repoRoot, 'apps/control/src/composition/hosted-production.ts'))}';`
    : result.presentDomains
      .map(domain => `import { ${domain.exportName} } from '${importSpecifier(outputDirectory, domain.modulePath)}';`)
      .join('\n');
  const registrationCalls = completeHostedDomains
    ? '...registerHostedProductionRoutes()'
    : result.presentDomains.map(domain => `...${domain.exportName}()`).join(', ');
  const absentPrefixesLiteral = JSON.stringify(result.absentPrefixes);

  return `// GENERATED FILE — do not edit. Produced by apps/control/src/runtime/discover.ts
// via \`pnpm --filter @khala/control build:functions\`. This directory is
// Netlify's functions *input*, not its build output; it is gitignored.
import { createGateway } from '${runtimeImport('handler.ts')}';
import { readServerEnv } from '${runtimeImport('env.ts')}';
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

export async function bundleGeneratedFunction(result: DiscoveryResult, repoRoot: string): Promise<Uint8Array> {
  const outputDirectory = functionsOutputDirectory(repoRoot);
  await mkdir(outputDirectory, { recursive: true });
  const entry = path.join(outputDirectory, 'khala-control.mjs');
  const bundled = await build({
    stdin: {
      contents: renderGeneratedFunction(result, repoRoot),
      resolveDir: outputDirectory,
      sourcefile: 'khala-control.ts',
      loader: 'ts',
    },
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // libsodium's ESM build retains a Node crypto require as its WebCrypto
    // fallback. Provide an ESM-safe require for that built-in only.
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    metafile: true,
    write: false,
  });
  const externalImports = Object.values(bundled.metafile!.outputs)
    .flatMap(output => output.imports.filter(dependency => dependency.external).map(dependency => dependency.path));
  const builtins = new Set(builtinModules);
  const nonBuiltinImports = externalImports.filter(specifier => !specifier.startsWith('node:') && !builtins.has(specifier));
  if (nonBuiltinImports.length > 0) {
    throw new DiscoverError(`generated function has unbundled dependencies: ${nonBuiltinImports.join(', ')}`);
  }
  const bundle = bundled.outputFiles?.find(file => file.path === entry);
  if (!bundle) throw new DiscoverError('generated function bundle is missing');
  return bundle.contents;
}

async function run(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = repoRootFrom(here);
  const result = await discoverRoutes(repoRoot);
  const outputDirectory = functionsOutputDirectory(repoRoot);
  const bundle = await bundleGeneratedFunction(result, repoRoot);
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, 'khala-control.mjs'), bundle);
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
