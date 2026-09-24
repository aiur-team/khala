import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const forbidden = /\brooms?\b/i;
const sourcePattern = /\.[cm]?[jt]sx?$/;
const ignoredPath = /(?:^|\/)(?:browser-harness|dist|node_modules)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const visibleAttributes = new Set(['alt', 'aria-label', 'aria-description', 'placeholder', 'title']);
const normalize = value => value.split(path.sep).join('/');

function filesBelow(directory, pattern) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries.flatMap(entry => {
    const filename = path.join(directory, entry.name);
    if (ignoredPath.test(normalize(filename))) return [];
    if (entry.isDirectory()) return filesBelow(filename, pattern);
    return pattern.test(filename) ? [filename] : [];
  });
}

function isAllowed(value) {
  const trimmed = value.trim();
  if (!forbidden.test(trimmed)) return true;
  return [...trimmed.matchAll(/\brooms?\b/gi)].every(match => isAllowedRoomOccurrence(trimmed, match.index, match[0].length));
}

function isAllowedRoomOccurrence(value, index, length) {
  const before = value.slice(0, index);
  const after = value.slice(index + length);
  if (/(?:^|\W)Matrix\s+$/i.test(before)) return true;
  if (before.endsWith('m.') && after.startsWith('.')) return true;
  if (/\/_matrix\/client\/(?:v\d+|unstable)\/$/i.test(before) && /^[/?#]/.test(after)) return true;
  return /^rooms?_[a-z0-9_]+$/i.test(value) || /^rooms?-\d+$/.test(value);
}

function checkTypeScript(filename, root, errors) {
  const text = fs.readFileSync(filename, 'utf8');
  if (!forbidden.test(text)) return;
  const ast = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, filename.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const report = (node, value) => {
    if (!isAllowed(value)) {
      const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
      errors.add(`${normalize(path.relative(root, filename))}:${line}: user-facing Khala copy uses ${JSON.stringify(value.trim())}`);
    }
  };
  function visit(node) {
    if (ts.isJsxText(node)) report(node, node.text);
    if (ts.isJsxAttribute(node) && visibleAttributes.has(node.name.text)) {
      const initializer = node.initializer;
      if (initializer && ts.isStringLiteral(initializer)) report(initializer, initializer.text);
      if (initializer && ts.isJsxExpression(initializer) && initializer.expression
        && (ts.isStringLiteral(initializer.expression) || ts.isNoSubstitutionTemplateLiteral(initializer.expression))) report(initializer.expression, initializer.expression.text);
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const parent = node.parent;
      const moduleSpecifier = (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node;
      const jsxAttribute = ts.isJsxAttribute(parent);
      const propertyName = (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name === node;
      const typeLiteral = ts.isLiteralTypeNode(parent);
      if (!moduleSpecifier && !jsxAttribute && !propertyName && !typeLiteral) report(node, node.text);
    }
    if (ts.isTemplateExpression(node)) {
      report(node.head, node.head.text);
      for (const span of node.templateSpans) report(span.literal, span.literal.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}

function checkHtml(filename, root, errors) {
  const text = fs.readFileSync(filename, 'utf8');
  const report = (value, offset) => {
    if (!isAllowed(value)) {
      const contentOffset = offset + Math.max(value.search(/\S/), 0);
      const line = text.slice(0, contentOffset).split(/\r\n?|\n/).length;
      errors.add(`${normalize(path.relative(root, filename))}:${line}: user-facing Khala copy uses ${JSON.stringify(value.trim())}`);
    }
  };
  for (const match of text.matchAll(/>([^<]+)</g)) report(match[1] ?? '', (match.index ?? 0) + 1);
  for (const match of text.matchAll(/(?:alt|aria-label|aria-description|placeholder|title)\s*=\s*(["'])([\s\S]*?)\1/gi)) {
    const value = match[2] ?? '';
    report(value, (match.index ?? 0) + match[0].indexOf(value));
  }
}

export function checkTerminology(root) {
  root = path.resolve(root);
  const errors = new Set();
  for (const filename of [path.join(root, 'apps/web/src'), path.join(root, 'packages/agent-cli/src')].flatMap(directory => filesBelow(directory, sourcePattern))) checkTypeScript(filename, root, errors);
  for (const filename of filesBelow(path.join(root, 'apps/web/src/landing'), /\.html$/)) checkHtml(filename, root, errors);
  return [...errors].sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkTerminology(process.argv[2] ?? process.cwd());
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else console.log('Khala terminology passed.');
}
