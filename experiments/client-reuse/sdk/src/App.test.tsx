import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { App } from './App';
import { batch, fixtureReviewPort, deliveryLabel } from '../../fixtures/scenario';
import { fixtureAuthentication } from './ports';
test('embedded content does not duplicate host navigation', () => { const html = renderToStaticMarkup(<App embedded />); assert(!html.includes('<nav')); assert(html.includes('Khala')); });
test('unknown delivery remains unknown and selected batch stays exact', async () => { assert.equal(await fixtureReviewPort().approve(batch), 'unknown'); assert.match(deliveryLabel('unknown'), /unknown/); await assert.rejects(fixtureReviewPort().approve({ ...batch, bindingGeneration: 99 })); });
test('fixture authentication preserves invitation return only', async () => { assert.equal(await fixtureAuthentication().signInAndReturn('fixture-invitation'), 'fixture-invitation'); });

import { canSelectForProduction } from '../../fixtures/capabilities';
test('unproven mandatory OAuth capability prevents production selection', () => { assert.equal(canSelectForProduction('sdk-ui'), false); assert.equal(canSelectForProduction('element-module'), false); assert.equal(canSelectForProduction('sdk-ui', []), false); });
