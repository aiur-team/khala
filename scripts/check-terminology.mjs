import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Flags "room" and "chat" nouns in user-facing Khala copy; "channel" is the product noun.
// Allowed without annotation: Matrix protocol vocabulary ("Matrix room", m.room.*, /_matrix/ paths),
// snake_case machine identifiers (room_id, chat_…), "chat" as a verb ("agents chat in a channel"),
// and the operator's splash sentence below. Any other string that must keep the word, such as a DOM id,
// storage key or route that has to stay stable, needs an inline suppression with a reason on the same
// or preceding line: `// khala-terminology-allow: <reason>` or `<!-- khala-terminology-allow: <reason> -->`.
const forbidden = /\b(?:rooms?|chats?)\b/i;
const occurrences = /\b(?:rooms?|chats?)\b/gi;
const splashSentence = 'Encrypted chat for humans and their agents.';
const suppression = /khala-terminology-allow:[ \t]*\S/;
const sourcePattern = /\.[cm]?[jt]sx?$/;
const ignoredPath = /(?:^|\/)(?:dist|node_modules)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/;
// Every string attribute is visible copy unless it is machine-only.
const machineAttributes = new Set([
  'className', 'class', 'id', 'htmlFor', 'for', 'name', 'key', 'href', 'src', 'type', 'value', 'role', 'rel', 'target',
  'autoComplete', 'aria-labelledby', 'aria-describedby', 'aria-controls',
]);
const isVisibleAttribute = name => !machineAttributes.has(name) && !/^data-/i.test(name);
const inlineHtmlTag = /<\/?(?:a|b|code|em|i|small|span|strong)\b[^>]*>/gi;
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
  if (trimmed.replace(/\s+/g, ' ') === splashSentence) return true;
  return [...trimmed.matchAll(occurrences)].every(match => isAllowedOccurrence(trimmed, match.index, match[0]));
}

function isAllowedOccurrence(value, index, word) {
  const before = value.slice(0, index);
  const after = value.slice(index + word.length);
  if (/^chats?$/i.test(word)) {
    if (/^chats?_[a-z0-9_]+$/i.test(value)) return true;
    // A verb is followed by a preposition and not preceded by a determiner or modifier.
    return /^\s+(?:in|with|about|together)\b/i.test(after)
      && !/(?:^|\W)(?:a|an|the|this|that|these|those|your|our|my|their|his|her|its|each|every|any|new|group|private|encrypted|agent|human)\s+$/i.test(before);
  }
  if (/(?:^|\W)Matrix\s+$/i.test(before)) return true;
  if (before.endsWith('m.') && after.startsWith('.')) return true;
  if (/\/_matrix\/client\/(?:v\d+|unstable)\/$/i.test(before) && /^[/?#]/.test(after)) return true;
  return /^rooms?_[a-z0-9_]+$/i.test(value) || /^rooms?-\d+$/.test(value);
}

function suppressedLines(text) {
  const lines = new Set();
  text.split(/\r\n?|\n/).forEach((line, index) => {
    if (suppression.test(line)) {
      lines.add(index + 1);
      lines.add(index + 2);
    }
  });
  return lines;
}

function checkTypeScript(filename, root, errors) {
  const text = fs.readFileSync(filename, 'utf8');
  if (!forbidden.test(text)) return;
  const ast = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, filename.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const suppressed = suppressedLines(text);
  const report = (node, value) => {
    const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
    if (!isAllowed(value) && !suppressed.has(line)) {
      errors.add(`${normalize(path.relative(root, filename))}:${line}: user-facing Khala copy uses ${JSON.stringify(value.trim())}`);
    }
  };
  function visit(node) {
    if (ts.isJsxText(node)) report(node, node.text);
    if (ts.isJsxAttribute(node) && isVisibleAttribute(node.name.getText(ast))) {
      const initializer = node.initializer;
      if (initializer && ts.isStringLiteral(initializer)) report(initializer, initializer.text);
      if (initializer && ts.isJsxExpression(initializer) && initializer.expression
        && (ts.isStringLiteral(initializer.expression) || ts.isNoSubstitutionTemplateLiteral(initializer.expression))) report(initializer.expression, initializer.expression.text);
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const parent = node.parent;
      const moduleSpecifier = (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node;
      const jsxAttribute = ts.isJsxAttribute(parent) || (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent));
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
  const source = fs.readFileSync(filename, 'utf8');
  // Blank inline tags in place so a sentence split by <span> reads whole and offsets stay stable.
  const text = source.replace(inlineHtmlTag, tag => ' '.repeat(tag.length));
  const suppressed = suppressedLines(source);
  const report = (value, offset) => {
    const contentOffset = offset + Math.max(value.search(/\S/), 0);
    const line = text.slice(0, contentOffset).split(/\r\n?|\n/).length;
    if (!isAllowed(value) && !suppressed.has(line)) {
      errors.add(`${normalize(path.relative(root, filename))}:${line}: user-facing Khala copy uses ${JSON.stringify(value.trim().replace(/\s+/g, ' '))}`);
    }
  };
  for (const match of text.matchAll(/>([^<]+)</g)) report(match[1] ?? '', (match.index ?? 0) + 1);
  for (const match of text.matchAll(/<[a-z][\w-]*\s([^>]*)>/gi)) {
    const attributes = match[1] ?? '';
    const attributesOffset = (match.index ?? 0) + match[0].indexOf(attributes);
    for (const attribute of attributes.matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
      if (!isVisibleAttribute(attribute[1])) continue;
      const value = attribute[3] ?? '';
      report(value, attributesOffset + (attribute.index ?? 0) + attribute[0].indexOf(value, attribute[1].length));
    }
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
