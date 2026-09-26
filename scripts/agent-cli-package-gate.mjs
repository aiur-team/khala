// Release gate for the published agent CLI (`@aiur/khala`). It packs the package
// exactly as npm would publish it, then refuses the tarball unless it is
// self-contained: an allowlisted file set, complete publish metadata, no runtime
// dependencies, no consumer lifecycle hook in the package or anything bundled
// into it, a bin that installs into an empty prefix and runs outside this
// workspace, and an `@aiur/khala/opencode` export that imports from that prefix. The
// release workflow publishes the tarball this gate accepted.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const PACKAGE_NAME = '@aiur/khala';
// Spelled in parts so this file does not itself count as a live reference.
export const OLD_PACKAGE_NAME = ['@khala', 'agent-cli'].join('/');
// `khala-internal.js` is the separately loaded `khala internal` runtime; `opencode.js` is
// the OpenCode plugin behind the `@aiur/khala/opencode` export.
export const PACKED_FILES = ['README.md', 'dist/khala-internal.js', 'dist/khala.js', 'dist/opencode.js', 'package.json'];
export const OPENCODE_EXPORT = `${PACKAGE_NAME}/opencode`;
export const BUNDLES =['dist/khala.js', 'dist/khala-internal.js', 'dist/opencode.js'];
export const REPOSITORY_URL = 'git+https://github.com/aiur-team/khala.git';
// Scripts npm (or git-dependency preparation) runs on a consumer's machine.
export const CONSUMER_HOOKS = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare'];
const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));

/** Errors for consumer lifecycle hooks declared by one manifest. */
export function lifecycleHookErrors(manifest, label) {
  return CONSUMER_HOOKS.filter(hook => typeof manifest.scripts?.[hook] === 'string')
    .map(hook => `${label} declares consumer lifecycle hook "${hook}"`);
}

/** Checks the exact file list of the packed tarball against the allowlist. */
export function packedFileErrors(files) {
  const actual = [...files].sort();
  const extra = actual.filter(file => !PACKED_FILES.includes(file));
  const missing = PACKED_FILES.filter(file => !actual.includes(file));
  return [
    ...extra.map(file => `tarball contains non-allowlisted file ${file}`),
    ...missing.map(file => `tarball is missing ${file}`),
  ];
}

/** Checks identity, publish/provenance metadata and self-containment of the packed manifest. */
export function manifestErrors(manifest) {
  const errors = [];
  if (manifest.name !== PACKAGE_NAME) errors.push(`package name is ${manifest.name}, expected ${PACKAGE_NAME}`);
  if (manifest.private) errors.push('package is private');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? '') || manifest.version === '0.0.0') errors.push(`package version ${manifest.version} is not publishable`);
  if (typeof manifest.license !== 'string' || !manifest.license) errors.push('package has no license');
  if (manifest.repository?.url !== REPOSITORY_URL || manifest.repository?.directory !== 'packages/agent-cli') errors.push('repository must name the source repository and package directory for provenance');
  if (manifest.publishConfig?.access !== 'public' || manifest.publishConfig?.provenance !== true) errors.push('publishConfig must request public access with provenance');
  if (typeof manifest.engines?.node !== 'string') errors.push('package does not declare a Node engine');
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.khala;
  if (path.posix.normalize(bin ?? '') !== 'dist/khala.js') errors.push('bin "khala" must be dist/khala.js');
  for (const field of DEPENDENCY_FIELDS) {
    const value = manifest[field];
    if (value && (Array.isArray(value) ? value.length : Object.keys(value).length)) errors.push(`package declares ${field}; the runtime closure must be bundled`);
  }
  errors.push(...lifecycleHookErrors(manifest, PACKAGE_NAME));
  // Any export a consumer can resolve must land inside the tarball; workspace
  // source is reachable only through the opt-in `khala-source` condition.
  for (const [subpath, target] of Object.entries(typeof manifest.exports === 'object' && manifest.exports ? manifest.exports : {})) {
    const resolved = resolveConditional(target, ['node', 'import', 'default']);
    if (resolved && !resolved.includes('*') && !PACKED_FILES.includes(path.posix.normalize(resolved))) errors.push(`export ${subpath} resolves outside the tarball (${resolved})`);
    if (resolved?.includes('*')) errors.push(`export ${subpath} exposes a wildcard (${resolved})`);
  }
  // Setup installs this export as the OpenCode plugin, so a consumer must be able to import it.
  const plugin = resolveConditional(manifest.exports?.['./opencode'] ?? null, ['node', 'import', 'default']);
  if (path.posix.normalize(plugin ?? '') !== 'dist/opencode.js') errors.push(`export ./opencode must resolve to dist/opencode.js for consumers (${plugin})`);
  return errors;
}

function resolveConditional(target, conditions) {
  if (typeof target === 'string' || target === null) return target;
  if (Array.isArray(target)) return target.map(item => resolveConditional(item, conditions)).find(Boolean) ?? null;
  for (const [condition, value] of Object.entries(target)) {
    if (conditions.includes(condition)) {
      const resolved = resolveConditional(value, conditions);
      if (resolved) return resolved;
    }
  }
  return null;
}

function nearestManifest(filename) {
  for (let directory = path.dirname(filename); ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'package.json');
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(directory) === directory) return undefined;
  }
}

/**
 * Checks the bundled runtime closure recorded in an esbuild metafile: every
 * package that contributed code must be free of consumer lifecycle hooks, and
 * the bundle may import nothing but Node built-ins.
 */
export function closureErrors(metafile, workingDirectory) {
  const errors = [];
  const manifests = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const manifest = nearestManifest(path.resolve(workingDirectory, input));
    if (manifest) manifests.add(fs.realpathSync(manifest));
    else errors.push(`bundled input ${input} has no owning package.json`);
  }
  for (const manifest of [...manifests].sort()) {
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    errors.push(...lifecycleHookErrors(parsed, `bundled package ${parsed.name ?? manifest}`));
  }
  for (const [output, meta] of Object.entries(metafile.outputs)) {
    for (const entry of meta.imports) {
      const specifier = entry.path;
      if (!entry.external || !(specifier.startsWith('node:') || builtins.has(specifier))) {
        errors.push(`${output} keeps a runtime import of ${specifier}; only Node built-ins may stay external`);
      }
    }
  }
  return errors;
}

/** Live (non-historical) tracked files that still name the pre-rename package. */
export function oldIdentityReferences(repositoryRoot = root) {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repositoryRoot, encoding: 'utf8' }).split('\0').filter(Boolean);
  // `docs/` is the dated record of plans, research and contracts, which describe the migration itself.
  return tracked.filter(file => !file.startsWith('docs/'))
    .filter(file => {
      const filename = path.join(repositoryRoot, file);
      return fs.existsSync(filename) && fs.readFileSync(filename, 'utf8').includes(OLD_PACKAGE_NAME);
    });
}

function run(command, args, options) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options, env: { ...process.env, ...options.env } });
  if (result.error) throw result.error;
  return result;
}

/**
 * Packs `packageDirectory`, runs every check, and installs the tarball into an
 * empty prefix to execute `npx @aiur/khala status`. Returns the accepted
 * tarball path and any errors; a non-empty error list means do not publish.
 */
export function gatePackage({ packageDirectory = path.join(root, 'packages/agent-cli'), outputDirectory } = {}) {
  const work = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-package-gate-'));
  const destination = outputDirectory ?? path.join(work, 'pack');
  fs.mkdirSync(destination, { recursive: true });
  // Isolated cache: nothing a previous install cached can satisfy this one.
  const env = { npm_config_cache: path.join(work, 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' };
  const pack = run('npm', ['pack', '--json', '--pack-destination', destination], { cwd: packageDirectory, env });
  if (pack.status !== 0) return { errors: [`npm pack failed: ${pack.stderr.trim()}`], work };
  const [packed] = JSON.parse(pack.stdout);
  const tarball = path.join(destination, packed.filename);
  const errors = packedFileErrors(packed.files.map(file => file.path));

  const extracted = path.join(work, 'extracted');
  fs.mkdirSync(extracted);
  execFileSync('tar', ['-xzf', tarball, '-C', extracted]);
  errors.push(...manifestErrors(JSON.parse(fs.readFileSync(path.join(extracted, 'package/package.json'), 'utf8'))));

  for (const bundled of BUNDLES) {
    const metafilePath = path.join(packageDirectory, `${bundled}.meta.json`);
    if (fs.existsSync(metafilePath)) errors.push(...closureErrors(JSON.parse(fs.readFileSync(metafilePath, 'utf8')), packageDirectory));
    else errors.push(`prepack produced no metafile for ${bundled}; the runtime closure cannot be audited`);
  }
  if (errors.length) return { errors, tarball, work };

  // A fresh prefix with no network: the tarball must install and run on its own.
  const prefix = path.join(work, 'prefix');
  fs.mkdirSync(prefix);
  fs.writeFileSync(path.join(prefix, 'package.json'), '{"private":true}\n');
  const install = run('npm', ['install', '--offline', '--no-package-lock', tarball], { cwd: prefix, env });
  if (install.status !== 0) return { errors: [`fresh-prefix install failed: ${install.stderr.trim()}`], tarball, work };
  const home = path.join(work, 'home');
  const status = run('npx', ['--offline', PACKAGE_NAME, 'status'], {
    cwd: prefix,
    env: { ...env, HOME: home, XDG_STATE_HOME: path.join(home, 'state'), NODE_PATH: '' },
  });
  let report;
  try { report = JSON.parse(status.stdout); } catch { report = undefined; }
  if (status.status !== 0 || report?.v !== 1 || report?.connected !== false) {
    errors.push(`npx ${PACKAGE_NAME} status failed in a fresh prefix (exit ${status.status}): ${status.stderr.trim() || status.stdout.trim()}`);
  }
  const installed = fs.realpathSync(path.join(prefix, 'node_modules', PACKAGE_NAME, 'dist/khala.js'));
  if (!installed.startsWith(fs.realpathSync(prefix) + path.sep)) errors.push(`installed bin resolves outside the prefix (${installed})`);
  errors.push(...openCodeExportErrors(prefix, env));
  return { errors, tarball, work, prefix };
}

/**
 * Imports `@aiur/khala/opencode` from the installed prefix, as a consumer would, and
 * checks that it resolves inside the prefix to an OpenCode v1 plugin module.
 */
function openCodeExportErrors(prefix, env) {
  const probe = `const specifier = ${JSON.stringify(OPENCODE_EXPORT)};
const plugin = (await import(specifier)).default;
console.log(JSON.stringify({ resolved: import.meta.resolve(specifier), id: plugin?.id, server: typeof plugin?.server }));`;
  const result = run(process.execPath, ['--input-type=module', '-e', probe], { cwd: prefix, env: { ...env, NODE_PATH: '' } });
  let loaded;
  try { loaded = JSON.parse(result.stdout); } catch { loaded = undefined; }
  if (result.status !== 0 || !loaded) return [`import("${OPENCODE_EXPORT}") failed in a fresh prefix: ${result.stderr.trim()}`];
  const errors = [];
  const resolved = fs.realpathSync(fileURLToPath(loaded.resolved));
  const expected = fs.realpathSync(path.join(prefix, 'node_modules', PACKAGE_NAME, 'dist/opencode.js'));
  if (resolved !== expected) errors.push(`${OPENCODE_EXPORT} resolves to ${resolved}, not the installed dist/opencode.js`);
  if (loaded.id !== 'khala' || loaded.server !== 'function') errors.push(`${OPENCODE_EXPORT} is not an OpenCode plugin module ({ id: 'khala', server })`);
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputIndex = process.argv.indexOf('--out');
  const outputDirectory = outputIndex > 0 ? path.resolve(process.argv[outputIndex + 1]) : undefined;
  const references = oldIdentityReferences();
  const { errors, tarball } = gatePackage(outputDirectory ? { outputDirectory } : {});
  errors.push(...references.map(file => `${file} still references ${OLD_PACKAGE_NAME}`));
  if (errors.length) {
    console.error(`Package gate refused ${PACKAGE_NAME}:\n${errors.map(error => `- ${error}`).join('\n')}`);
    process.exitCode = 1;
  } else console.log(`Package gate passed: ${tarball}`);
}
