import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const normalize = value => value.split(path.sep).join('/');
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
const serverDependencies = /^(?:@matrix-org\/matrix-sdk-crypto-nodejs|better-sqlite3|sqlite3|keytar|@netlify\/blobs|server-only)(?:\/|$)/;
const packageOf = name => name.split('/').slice(0, 2).join('/');
const sourcePattern = /\.[cm]?[jt]sx?$/;
const testPattern = /\.(test|spec)\.[cm]?[jt]sx?$/;
// Local automation opens G-AUTOMATION. Only the internal composition may import it,
// and no hosted graph may reach it by path or by the provider's stable marker.
const LOCAL_AUTOMATION_MARKER = 'khala:local-automation-authority';
const localAutomation = /^(?:apps\/internal\/src\/composition\/local-automation\/|packages\/policy\/src\/listening-mode\/limits\.[cm]?[jt]sx?$)/;
const hostedRoot = /^apps\/(?:web|control|connector)\//;
// Shared web primitives other features may import. They may not import features themselves.
const sharedFeatures = new Set(['approval-decision']);

function filesBelow(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', 'dist', 'fixtures'].includes(entry.name)) return [];
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(filename) : sourcePattern.test(filename) ? [filename] : [];
  });
}

/** The resolved import graph of every source below apps/ and packages/, plus the files carrying the marker. */
export function buildGraph(root) {
  root = path.resolve(root);
  const errors = new Set();
  const marked = new Set();
  const sources = ['apps', 'packages'].flatMap(area => filesBelow(path.join(root, area)));
  const packages = new Map();
  for (const area of ['apps', 'packages']) {
    const directory = path.join(root, area);
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory)) {
      const filename = path.join(directory, entry, 'package.json');
      if (fs.existsSync(filename)) packages.set(JSON.parse(fs.readFileSync(filename, 'utf8')).name, path.dirname(filename));
    }
  }
  const graph = new Map();
  for (const filename of sources) {
    const relative = normalize(path.relative(root, filename));
    const packageDirectory = path.join(root, packageOf(relative));
    const configPath = ts.findConfigFile(packageDirectory, ts.sys.fileExists);
    let options = { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, allowJs: true };
    if (configPath) {
      const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
      options = { ...options, ...ts.parseJsonConfigFileContent(loaded.config, ts.sys, path.dirname(configPath)).options };
    }
    const text = fs.readFileSync(filename, 'utf8');
    if (text.includes(LOCAL_AUTOMATION_MARKER)) marked.add(relative);
    const ast = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
    const edges = [];
    function visit(node) {
      let literal;
      let computed = false;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) literal = node.moduleSpecifier;
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) literal = node.moduleReference.expression;
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) literal = node.argument.literal;
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        literal = node.arguments[0];
        computed = !literal || !(ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal));
      }
      if (computed) edges.push({ specifier: '<computed import>', computed: true });
      if (literal && (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal))) {
        const specifier = literal.text;
        let resolved = ts.resolveModuleName(specifier, filename, options, ts.sys).resolvedModule?.resolvedFileName;
        // Resolve workspace exports even before pnpm has linked the workspace.
        if (!resolved && /^@(?:khala\/|aiur\/khala(?:\/|$))/.test(specifier)) {
          const name = specifier.split('/').slice(0, 2).join('/');
          const dir = packages.get(name);
          if (dir) {
            const subpath = './' + specifier.split('/').slice(2).join('/');
            const exports = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).exports ?? {};
            for (const [key, entry] of Object.entries(exports)) {
              const target = typeof entry === 'string' ? entry : entry?.['khala-source'];
              if (typeof target !== 'string') continue;
              const [prefix, suffix = ''] = key.split('*');
              if (key === subpath || (key.includes('*') && subpath.startsWith(prefix) && subpath.endsWith(suffix))) {
                const candidate = path.resolve(dir, target.replace('*', subpath.slice(prefix.length, suffix ? -suffix.length : undefined)));
                if (fs.existsSync(candidate)) resolved = candidate;
              }
            }
          }
          if (!resolved) errors.add(`${relative}: unresolved workspace import ${specifier}`);
        }
        edges.push({ specifier, target: resolved ? normalize(path.relative(root, resolved)) : undefined });
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    graph.set(relative, edges);
  }
  return { graph, errors, marked };
}

export function checkBoundaries(root) {
  const { graph, errors, marked } = buildGraph(root);
  for (const [origin, edges] of graph) {
    if (testPattern.test(origin)) continue;
    const owner = packageOf(origin);
    const composition = origin.includes('/composition/');
    for (const edge of edges) {
      // The loopback server is a transport edge: Node built-ins, the internal store and contracts only.
      if (origin.startsWith('apps/internal/src/server/')) {
        const builtin = builtins.has(edge.specifier.replace(/^node:/, ''));
        const local = edge.target && /^(?:apps\/internal\/src\/(?:server|store)\/|packages\/contracts\/)/.test(edge.target);
        if (!builtin && !local) errors.add(`${origin}: loopback server may import only Node built-ins, the internal store and contracts (${edge.specifier})`);
      }
      if (!edge.target) continue;
      const destination = packageOf(edge.target);
      if (localAutomation.test(edge.target) && !origin.startsWith('apps/internal/src/composition/') && !localAutomation.test(origin)) errors.add(`${origin}: local automation is importable only from the internal composition (${edge.specifier})`);
      if (testPattern.test(edge.target) || edge.target.includes('/fixtures/')) errors.add(`${origin}: production cannot import tests or fixtures (${edge.specifier})`);
      if (owner === 'packages/contracts') {
        if (destination !== owner) errors.add(`${origin}: contracts cannot import implementations (${edge.specifier})`);
        const fromDomain = origin.split('/')[3];
        const toDomain = edge.target.split('/')[3];
        if (['messaging', 'delivery'].includes(fromDomain) && ['messaging', 'delivery'].includes(toDomain) && fromDomain !== toDomain) errors.add(`${origin}: contract domains cannot import each other (${edge.specifier})`);
      }
      if (owner !== destination && destination.startsWith('apps/')) errors.add(`${origin}: cannot import an app (${edge.specifier})`);
      if (!composition && owner !== destination && destination.startsWith('packages/') && destination !== 'packages/contracts') errors.add(`${origin}: cross-component implementation requires a composition root (${edge.specifier})`);
      const fromFeature = origin.match(/^apps\/web\/src\/features\/([^/]+)/)?.[1];
      const toFeature = edge.target.match(/^apps\/web\/src\/features\/([^/]+)/)?.[1];
      if (fromFeature && toFeature && fromFeature !== toFeature && !sharedFeatures.has(toFeature)) errors.add(`${origin}: sibling feature import (${edge.specifier})`);
    }
    const browser = origin.startsWith('apps/web/');
    const hosted = hostedRoot.test(origin);
    const policy = origin.startsWith('packages/policy/');
    // Browser, policy and contracts graphs must stay pure; hosted server graphs only
    // have to stay clear of local automation.
    const pure = browser || policy || owner === 'packages/contracts';
    if (!pure && !hosted) continue;
    if (marked.has(origin) && hosted) errors.add(`${origin}: hosted source carries the local automation marker`);
    const seen = new Set();
    function walk(current, chain) {
      if (seen.has(current)) return;
      seen.add(current);
      for (const edge of graph.get(current) ?? []) {
        const trace = [...chain, edge.specifier].join(' -> ');
        if (pure && edge.computed) errors.add(`${origin}: unanalyzable import (${trace})`);
        if (pure && (builtins.has(edge.specifier.replace(/^node:/, '')) || serverDependencies.test(edge.specifier))) errors.add(`${origin}: server-only dependency (${trace})`);
        if (edge.target) {
          // Local modules outside the scanned roots cannot silently end traversal.
          // Third-party internals remain dependency-review scope, not this graph.
          if (pure && !graph.has(edge.target) && !edge.target.split('/').includes('node_modules')) errors.add(`${origin}: local module outside the checked graph (${trace})`);
          if (hosted && (edge.target.startsWith('apps/internal/') || localAutomation.test(edge.target) || marked.has(edge.target))) errors.add(`${origin}: hosted graph reaches local automation (${trace})`);
          if (browser && /^(?:apps\/(?:control|connector)|packages\/(?:connector|harnesses))\//.test(edge.target)) errors.add(`${origin}: browser reaches owner/server code (${trace})`);
          if (policy && !edge.target.startsWith('packages/policy/') && !edge.target.startsWith('packages/contracts/')) errors.add(`${origin}: policy reaches I/O or implementation (${trace})`);
          walk(edge.target, [...chain, edge.specifier]);
        } else if (policy && !edge.computed) errors.add(`${origin}: policy external dependency is not a contract (${trace})`);
      }
    }
    walk(origin, []);
  }
  return [...errors].sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkBoundaries(process.argv[2] ?? process.cwd());
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else console.log('Import boundaries passed.');
}
