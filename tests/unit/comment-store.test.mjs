// tests/unit/comment-store.test.mjs
//
// CommentStore owns every task's thread — the rows, whether they've been
// loaded, and the single in-flight fetch. It exists because threads used to
// live ON the Task row (`t.comments` / `t._commentsLoaded`), and a Task row is
// a server-owned value the 30s poll replaces wholesale: the thread was sheared
// off every poll, collapsing an open thread to "Loading comments…" for the
// length of a refetch while the user was typing into it.
//
// The store emits nothing — the caller owns 'comments:changed' — so all of this
// is testable without an EventBus or a DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

global.window = global.window || {};
global.App = global.window.App = {};
require('../../js/models/CommentStore.js');

const row = (id, over = {}) => ({ id, authorId: 'kristine', body: 'ON IT', kind: 'comment', reactions: [], ...over });

// A loader that records its calls and resolves when told to.
const deferredLoader = () => {
  const calls = [];
  let resolve;
  const load = (taskId) => { calls.push(taskId); return new Promise(r => { resolve = r; }); };
  return { load, calls, settle: (rows) => resolve(rows) };
};

/* ---------- empty state ---------- */

test('an unknown thread reads as empty and unloaded', () => {
  const s = new App.CommentStore({ load: async () => [] });
  assert.deepEqual(s.rows('t1'), []);
  assert.equal(s.isLoaded('t1'), false);
  assert.equal(s.count('t1'), 0);
});

test('rows() never returns null, so callers need no fallback', () => {
  const s = new App.CommentStore();
  assert.ok(Array.isArray(s.rows('nope')));
});

/* ---------- loading ---------- */

test('ensureLoaded fetches once and marks the thread loaded', async () => {
  let calls = 0;
  const s = new App.CommentStore({ load: async () => { calls++; return [row('c1')]; } });

  const rows = await s.ensureLoaded('t1');
  assert.equal(calls, 1);
  assert.equal(rows.length, 1);
  assert.equal(s.isLoaded('t1'), true);
  assert.equal(s.count('t1'), 1);

  await s.ensureLoaded('t1');
  assert.equal(calls, 1, 'an already-loaded thread must not refetch');
});

test('concurrent ensureLoaded calls share ONE fetch', async () => {
  const d = deferredLoader();
  const s = new App.CommentStore({ load: d.load });

  const a = s.ensureLoaded('t1');
  const b = s.ensureLoaded('t1');
  assert.equal(d.calls.length, 1, 'two renders in the same tick must not double-fetch');

  d.settle([row('c1')]);
  assert.deepEqual((await a).map(r => r.id), ['c1']);
  assert.deepEqual((await b).map(r => r.id), ['c1']);
});

test('an empty thread still counts as loaded (so the UI stops saying "Loading")', async () => {
  const s = new App.CommentStore({ load: async () => [] });
  await s.ensureLoaded('t1');
  assert.equal(s.isLoaded('t1'), true);
  assert.deepEqual(s.rows('t1'), []);
});

test('a failed load resolves empty, does not reject, and stays retryable', async () => {
  let calls = 0;
  const s = new App.CommentStore({ load: async () => { calls++; throw new Error('offline'); } });

  const rows = await s.ensureLoaded('t1');
  assert.deepEqual(rows, []);
  assert.equal(s.isLoaded('t1'), false, 'a failure must not pretend the thread is loaded');

  await s.ensureLoaded('t1');
  assert.equal(calls, 2, 'the next render gets to retry');
});

test('threads are independent of each other', async () => {
  const s = new App.CommentStore({ load: async (id) => [row(`${id}-c1`)] });
  await s.ensureLoaded('t1');
  assert.equal(s.isLoaded('t1'), true);
  assert.equal(s.isLoaded('t2'), false);
  assert.equal(s.count('t2'), 0);
});

test('a store built with no loader never claims a thread is loaded', async () => {
  const s = new App.CommentStore();
  assert.deepEqual(await s.ensureLoaded('t1'), []);
  assert.equal(s.isLoaded('t1'), false);
});

/* ---------- posting ---------- */

test('append adds the row and marks the thread loaded', () => {
  const s = new App.CommentStore({ load: async () => [] });
  s.append('t1', row('c1'));
  assert.equal(s.count('t1'), 1);
  assert.equal(s.isLoaded('t1'), true, 'my own post proves the thread exists');
});

test('append keeps posting order', () => {
  const s = new App.CommentStore();
  s.append('t1', row('c1'));
  s.append('t1', row('c2'));
  assert.deepEqual(s.rows('t1').map(r => r.id), ['c1', 'c2']);
});

test('hydrate seeds a thread without a fetch', () => {
  const s = new App.CommentStore({ load: async () => { throw new Error('must not be called'); } });
  s.hydrate('t1', [row('c1'), row('c2')]);
  assert.equal(s.isLoaded('t1'), true);
  assert.equal(s.count('t1'), 2);
});

/* ---------- refresh ----------
   The open thread has to keep up with teammates. It used to do so by accident:
   the 30s task poll replaced the task row, the thread parked on it was lost, and
   the view refetched — which is precisely the collapse this work removed. So the
   refresh is now deliberate, and reports whether anything actually changed, so
   a quiet thread never triggers a re-render. */

test('refresh reports false when the server has nothing new', async () => {
  const s = new App.CommentStore({ load: async () => [row('c1')] });
  await s.ensureLoaded('t1');
  assert.equal(await s.refresh('t1'), false, 'an unchanged thread must not re-render the pane');
});

test('refresh reports true and swaps in the new rows', async () => {
  let serverRows = [row('c1')];
  const s = new App.CommentStore({ load: async () => serverRows.slice() });
  await s.ensureLoaded('t1');

  serverRows = [row('c1'), row('c2', { authorId: 'andres', body: 'ON MY WAY' })];
  assert.equal(await s.refresh('t1'), true);
  assert.deepEqual(s.rows('t1').map(r => r.id), ['c1', 'c2']);
});

test('refresh notices a reaction added by someone else', async () => {
  let serverRows = [row('c1', { reactions: [] })];
  const s = new App.CommentStore({ load: async () => JSON.parse(JSON.stringify(serverRows)) });
  await s.ensureLoaded('t1');

  serverRows = [row('c1', { reactions: [{ memberId: 'andres', emoji: '👍' }] })];
  assert.equal(await s.refresh('t1'), true);
});

test('refresh keeps a just-posted row the server has not returned yet', async () => {
  const s = new App.CommentStore({ load: async () => [row('c1')] });
  await s.ensureLoaded('t1');
  s.append('t1', row('mine', { body: 'JUST POSTED' }));

  await s.refresh('t1');
  assert.deepEqual(s.rows('t1').map(r => r.id), ['c1', 'mine'],
    'a refresh landing mid-post must not make my own comment disappear');
});

test('refresh does not load a thread that was never opened', async () => {
  let calls = 0;
  const s = new App.CommentStore({ load: async () => { calls++; return [row('c1')]; } });
  assert.equal(await s.refresh('t1'), false);
  assert.equal(calls, 0, 'only the open thread is worth a round trip');
  assert.equal(s.isLoaded('t1'), false);
});

test('a failed refresh keeps the rows on screen and reports no change', async () => {
  let fail = false;
  const s = new App.CommentStore({ load: async () => { if (fail) throw new Error('offline'); return [row('c1')]; } });
  await s.ensureLoaded('t1');

  fail = true;
  assert.equal(await s.refresh('t1'), false);
  assert.equal(s.count('t1'), 1, 'an outage must not blank the thread');
  assert.equal(s.isLoaded('t1'), true);
});

/* ---------- reactions ---------- */

test('toggleReaction adds mine, and revert puts it back exactly', () => {
  const s = new App.CommentStore();
  s.hydrate('t1', [row('c1', { reactions: [{ memberId: 'andres', emoji: '👍' }] })]);

  const flip = s.toggleReaction('t1', 'c1', 'abraham', '👍');
  assert.equal(flip.had, false);
  assert.deepEqual(s.rows('t1')[0].reactions, [
    { memberId: 'andres', emoji: '👍' },
    { memberId: 'abraham', emoji: '👍' },
  ]);

  flip.revert();
  assert.deepEqual(s.rows('t1')[0].reactions, [{ memberId: 'andres', emoji: '👍' }],
    'a failed save must restore the exact prior state');
});

test('toggleReaction removes mine, and revert puts it back exactly', () => {
  const s = new App.CommentStore();
  s.hydrate('t1', [row('c1', { reactions: [{ memberId: 'abraham', emoji: '🎉' }, { memberId: 'andres', emoji: '🎉' }] })]);

  const flip = s.toggleReaction('t1', 'c1', 'abraham', '🎉');
  assert.equal(flip.had, true);
  assert.deepEqual(s.rows('t1')[0].reactions, [{ memberId: 'andres', emoji: '🎉' }]);

  flip.revert();
  assert.deepEqual(s.rows('t1')[0].reactions, [
    { memberId: 'abraham', emoji: '🎉' },
    { memberId: 'andres', emoji: '🎉' },
  ]);
});

test('toggleReaction tolerates a row with no reactions field', () => {
  const s = new App.CommentStore();
  s.hydrate('t1', [{ id: 'c1', authorId: 'kristine', body: 'HI' }]);
  const flip = s.toggleReaction('t1', 'c1', 'abraham', '✅');
  assert.equal(flip.had, false);
  assert.deepEqual(s.rows('t1')[0].reactions, [{ memberId: 'abraham', emoji: '✅' }]);
  flip.revert();
  assert.deepEqual(s.rows('t1')[0].reactions, []);
});

test('toggleReaction on an unknown comment or thread returns null', () => {
  const s = new App.CommentStore();
  s.hydrate('t1', [row('c1')]);
  assert.equal(s.toggleReaction('t1', 'nope', 'abraham', '👍'), null);
  assert.equal(s.toggleReaction('nope', 'c1', 'abraham', '👍'), null);
});

test('reverting one reaction does not disturb another', () => {
  const s = new App.CommentStore();
  s.hydrate('t1', [row('c1', { reactions: [] })]);
  const a = s.toggleReaction('t1', 'c1', 'abraham', '👍');
  s.toggleReaction('t1', 'c1', 'andres', '🎉');
  a.revert();
  assert.deepEqual(s.rows('t1')[0].reactions, [{ memberId: 'andres', emoji: '🎉' }]);
});
