// tests/unit/reports-to.test.mjs
//
// Multiple supervisors (migration 073). A profile stores supervisor_ids[] — each
// element a team_members id. Every listed supervisor "oversees" the person. Rows
// written before 073 may carry only the scalar supervisor_id, so fall back to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

global.window = global.window || {};
global.App = global.window.App = {};
require('../../js/utils.js');

const U = global.App.utils;

const A = 'abraham';
const B = 'joshua';
const C = 'someone';

const twoBosses = { member_id: 'kristin', supervisor_ids: [A, B] };
const oneBoss    = { member_id: 'andres',  supervisor_ids: [A] };
const noBoss     = { member_id: 'olivia',  supervisor_ids: [] };
const legacy     = { member_id: 'jesse',   supervisor_id: A }; // pre-073 row, no array

test('reportsTo is true for EACH supervisor in the list', () => {
  assert.equal(U.reportsTo(twoBosses, A), true);
  assert.equal(U.reportsTo(twoBosses, B), true);
});

test('reportsTo is false for someone not in the list', () => {
  assert.equal(U.reportsTo(twoBosses, C), false);
  assert.equal(U.reportsTo(oneBoss, B), false);
  assert.equal(U.reportsTo(noBoss, A), false);
});

test('reportsTo falls back to the legacy scalar supervisor_id', () => {
  assert.equal(U.reportsTo(legacy, A), true);
  assert.equal(U.reportsTo(legacy, B), false);
});

test('reportsTo guards bad input', () => {
  assert.equal(U.reportsTo(null, A), false);
  assert.equal(U.reportsTo(twoBosses, ''), false);
  assert.equal(U.reportsTo(twoBosses, null), false);
});
