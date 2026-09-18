import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { App } from './App';
import { batch, fixtureReviewPort, deliveryLabel } from '../../fixtures/scenario';
import { fixtureAuthentication } from './ports';
test('embedded content does not duplicate host navigation', () => { const html = renderToStaticMarkup(<App embedded />); assert(!html.includes('<nav')); assert(html.includes('Khala')); });
test('unknown delivery remains unknown and selected batch stays exact', async () => { assert.equal(await fixtureReviewPort().approve(batch), 'unknown'); assert.match(deliveryLabel('unknown'), /unknown/); await assert.rejects(fixtureReviewPort().approve({ ...batch, bindingGeneration: 99 })); });
test('fixture authentication preserves invitation return only', async () => { assert.equal(await fixtureAuthentication().signInAndReturn('fixture-invitation'), 'fixture-invitation'); });

import { readdir, readFile } from 'node:fs/promises';
import { capabilities, canSelectForProduction } from '../../fixtures/capabilities';
test('unproven mandatory OAuth capability prevents production selection', () => { assert.equal(canSelectForProduction('sdk-ui'), false); assert.equal(canSelectForProduction('element-module'), false); assert.equal(canSelectForProduction('sdk-ui', []), false); });
test('a mocked supported row cannot hide a failed or untested mandatory flow', () => {
  const proven = capabilities.filter(row => row.candidate === 'sdk-ui').map(row => ({ ...row, result: 'supported' as const, testPath: row.testPath ?? 'fixture' }));
  assert.equal(canSelectForProduction('sdk-ui', proven), true);
  const mock = { ...proven[0]!, testPath: 'mock.spec.ts' };
  assert.equal(canSelectForProduction('sdk-ui', [...proven, { ...mock, result: 'unsupported' }]), false);
  assert.equal(canSelectForProduction('sdk-ui', [...proven, { ...mock, result: 'not-tested' }]), false);
  assert.equal(canSelectForProduction('sdk-ui', proven.map((row, index) => index === 0 ? { ...row, testPath: null } : row)), false);
});
test('candidates ship no credentials or real endpoint defaults', async () => {
  const root = new URL('../../', import.meta.url);
  const dirs = ['sdk/src', 'element/src', 'fixtures'];
  for (const dir of dirs) for (const name of (await readdir(new URL(dir, root))).filter(name => !name.includes('.test.'))) {
    const text = await readFile(new URL(`${dir}/${name}`, root), 'utf8');
    for (const host of text.match(/https?:\/\/[^\s'"`)]+/g) ?? []) assert.match(host, /\.invalid\b|127\.0\.0\.1|localhost/, `${dir}/${name}: ${host}`);
    for (const host of text.match(/[!#@][\w-]+:[\w.-]+/g) ?? []) assert.match(host, /\.invalid$/, `${dir}/${name}: ${host}`);
    assert.doesNotMatch(text, /access_token|refresh_token|syt_|password\s*[:=]/i, `${dir}/${name}`);
  }
});
