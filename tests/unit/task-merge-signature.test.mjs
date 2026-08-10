// tests/unit/task-merge-signature.test.mjs
//
// mergeServer's contract: "Emits 'tasks:changed' only when the merge actually
// changed something, so an idle poll causes no re-render or save churn."
//
// That promise used to be false. sig() stringified whatever properties happened
// to be hanging off a task object, so the moment anything decorated a task with
// a local-only field (the comment thread parked itself on `t.comments` /
// `t._commentsLoaded`) the local signature could never match a fresh server row
// again — and every 30s poll emitted 'tasks:changed' against a completely idle
// server. Seven views re-rendered, the PersistenceEngine woke up with nothing to
// save, and an open comment thread collapsed to "Loading comments…" mid-typing
// while it refetched.
//
// These tests lock the promise: change detection sees the SERVER shape only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

global.window = global.window || {};
global.App = global.window.App = {};

const emitted = [];
App.EventBus = { emit: (name, payload) => emitted.push([name, payload]), on: () => {} };

require('../../js/utils.js');
require('../../js/models/TaskModel.js');

// One server row, written the way _mapTaskRow writes it.
const serverRow = (over = {}) => ({
  id: 't1', title: 'LIEN FILING', description: '', type: 'admin', label: 'none',
  company: 'roofing', creator: 'abraham', assignee: 'abraham', assigneeIds: ['abraham'],
  due: '2026-08-14', dueTime: null, reminderAt: null, reminderOffset: null,
  priority: 'high', status: 'todo', project: null, watchers: [], subtasks: [],
  activity: [], stuck: null, clearedAt: null, createdAt: '2026-08-01T10:00:00Z',
  completedAt: null, focusSeq: null, woNumber: 3,
  ...over,
});

const freshModel = (rows) => {
  emitted.length = 0;
  const m = new App.TaskModel();
  m.hydrate(rows);
  return m;
};
const changes = () => emitted.filter(([n]) => n === 'tasks:changed').length;

/* ---------- the promise ---------- */

test('idle poll over undecorated tasks emits nothing', () => {
  const m = freshModel([serverRow()]);
  assert.equal(m.mergeServer([serverRow()]), false);
  assert.equal(changes(), 0);
});

test('idle poll emits nothing when a task carries local-only decoration', () => {
  // THE BUG: the open task has a comment thread parked on it. The server row
  // has no such fields, so the old JSON.stringify comparison always differed.
  const decorated = serverRow();
  decorated._commentsLoaded = true;
  decorated._draftScrollTop = 120;
  const m = freshModel([decorated]);

  assert.equal(m.mergeServer([serverRow()]), false, 'decoration must be invisible to change detection');
  assert.equal(changes(), 0, 'an idle poll must not re-render the app');
});

test('repeated idle polls stay silent (no 30s churn)', () => {
  const decorated = serverRow();
  decorated._commentsLoaded = true;
  const m = freshModel([decorated]);
  for (let i = 0; i < 5; i++) m.mergeServer([serverRow()]);
  assert.equal(changes(), 0);
});

test('property order alone is not a change', () => {
  const m = freshModel([serverRow()]);
  // Same values, different insertion order — a real risk now that rows can come
  // from a local create as well as from _mapTaskRow.
  const reordered = {};
  for (const k of Object.keys(serverRow()).reverse()) reordered[k] = serverRow()[k];
  assert.equal(m.mergeServer([reordered]), false);
  assert.equal(changes(), 0);
});

/* ---------- still detects the changes that matter ---------- */

test('a real server edit emits exactly once', () => {
  const decorated = serverRow();
  decorated._commentsLoaded = true;
  const m = freshModel([decorated]);

  assert.equal(m.mergeServer([serverRow({ status: 'done' })]), true);
  assert.equal(changes(), 1);
  assert.equal(m.find('t1').status, 'done');
});

test('a nested server edit (subtasks) is still a change', () => {
  const m = freshModel([serverRow()]);
  assert.equal(m.mergeServer([serverRow({ subtasks: [{ t: 'Notarize', d: false }] })]), true);
  assert.equal(changes(), 1);
});

test('a task appearing or disappearing server-side is a change', () => {
  let m = freshModel([serverRow()]);
  assert.equal(m.mergeServer([serverRow(), serverRow({ id: 't2', title: 'NEW' })]), true);

  m = freshModel([serverRow(), serverRow({ id: 't2' })]);
  assert.equal(m.mergeServer([serverRow()]), true);
});

/* ---------- non-destructive merge, unchanged ---------- */

test('a dirty task keeps its local copy and is not clobbered', () => {
  const m = freshModel([serverRow()]);
  m.update('t1', { title: 'MY UNSAVED TITLE' });
  emitted.length = 0;

  m.mergeServer([serverRow({ title: 'SOMEONE ELSE WROTE THIS' })]);
  assert.equal(m.find('t1').title, 'MY UNSAVED TITLE');
  assert.ok(m.dirtyIds().has('t1'), 'still dirty, so the pending save still runs');
});

test('a locally-created task the server has not seen survives the merge', () => {
  const m = freshModel([serverRow()]);
  m.add(serverRow({ id: 'local-1', title: 'JUST CREATED' }));
  emitted.length = 0;

  m.mergeServer([serverRow()]);
  assert.ok(m.find('local-1'), 'local-only task must not be dropped by a poll');
});

/* ---------- the thread is out of reach of the poll ---------- */

test('replacing every task row leaves the comment threads untouched', () => {
  require('../../js/models/CommentStore.js');
  const store = new App.CommentStore();
  store.hydrate('t1', [{ id: 'c1', authorId: 'kristine', body: 'ON IT', reactions: [] }]);

  const m = freshModel([serverRow()]);
  m.mergeServer([serverRow({ status: 'review' })]);   // wholesale row replacement

  assert.equal(store.isLoaded('t1'), true, 'thread must not be sheared off by the poll');
  assert.equal(store.rows('t1').length, 1);
});
