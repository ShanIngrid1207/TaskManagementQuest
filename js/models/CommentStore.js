window.App = window.App || {};

/* CommentStore — owns every task's comment thread: the rows, whether the thread
   has been loaded, and the single in-flight fetch that stops two renders in the
   same tick double-fetching.

   Threads deliberately do NOT live on the Task row. A Task is a server-owned
   value that the 30s sync poll replaces wholesale (TaskModel.mergeServer), so
   anything parked on it is destroyed on the next poll. Parking the thread there
   (`t.comments` / `t._commentsLoaded`) cost us twice: an open thread collapsed
   to "Loading comments…" for the length of a refetch while the user was typing
   into it, and the decoration made every idle poll look like a change, so the
   whole app re-rendered every 30 seconds. Threads and task rows have different
   lifetimes; they now have different homes.

   Keyed by task id, so a thread outlives any particular task object.

   This module emits nothing and touches no DOM — the caller owns
   'comments:changed'. That keeps load-once semantics, in-flight dedupe, failure
   handling and the optimistic reaction flip testable in plain node. */
App.CommentStore = class CommentStore {
  /* `load(taskId) -> Promise<rows>` is injected (SupabaseDataStore.loadComments
     in the app, a fake in tests). A store built without one never loads — the
     preview harnesses seed themselves through hydrate() instead. */
  constructor({ load } = {}) {
    this._load = typeof load === 'function' ? load : null;
    this._threads = new Map(); // taskId -> { rows, loaded, inflight }
  }

  _thread(taskId) {
    let th = this._threads.get(taskId);
    if (!th) { th = { rows: [], loaded: false, inflight: null }; this._threads.set(taskId, th); }
    return th;
  }

  /* ---------- reads ---------- */

  // Always an array, so callers never need `|| []`.
  rows(taskId) { return this._thread(taskId).rows; }

  /* Whether this thread has been fetched. Distinct from "has rows": an empty
     loaded thread reads "No comments yet", an empty unloaded one reads
     "Loading comments…". A failed fetch stays unloaded so the next render retries. */
  isLoaded(taskId) { return this._thread(taskId).loaded; }

  count(taskId) { return this._thread(taskId).rows.length; }

  /* ---------- loading ---------- */

  /* Fetch this thread at most once. Concurrent callers share the single
     in-flight promise. Resolves to the rows and NEVER rejects: a load failure
     leaves the thread unloaded (and empty) so a later render can try again,
     which is the behaviour a lazily-rendered thread wants — the alternative is
     an unhandled rejection on every re-render of an offline detail page. */
  ensureLoaded(taskId) {
    const th = this._thread(taskId);
    if (th.loaded) return Promise.resolve(th.rows);
    if (th.inflight) return th.inflight;
    if (!this._load) return Promise.resolve(th.rows);

    // Start the fetch now, not on the next microtask — but tolerate a loader
    // that throws synchronously rather than rejecting.
    let started;
    try { started = Promise.resolve(this._load(taskId)); }
    catch (e) { started = Promise.reject(e); }

    th.inflight = started
      .then(rows => {
        th.rows = Array.isArray(rows) ? rows : [];
        th.loaded = true;
        return th.rows;
      })
      .catch(e => {
        console.warn('[comments] load failed:', e);
        return th.rows;
      })
      .then(rows => { th.inflight = null; return rows; });

    return th.inflight;
  }

  /* Re-pull an ALREADY-OPEN thread and report whether anything actually changed.
     Resolves false without a round trip for a thread nobody has opened.

     Callers use the return value to decide whether to emit 'comments:changed',
     so a quiet thread costs a query and nothing else — no re-render, no lost
     caret. This replaces the accident that used to keep threads fresh: the task
     poll would replace the task row, the thread parked on it vanished, and the
     view refetched it, collapsing the thread to "Loading comments…" every 30s.

     Rows the server hasn't returned yet are kept, so a refresh landing between
     a post's insert and its next read can't make the author's own comment
     flicker out. Like ensureLoaded, never rejects — an outage leaves what's on
     screen exactly where it is. */
  refresh(taskId) {
    const th = this._thread(taskId);
    if (!th.loaded || !this._load) return Promise.resolve(false);

    let started;
    try { started = Promise.resolve(this._load(taskId)); }
    catch (e) { started = Promise.reject(e); }

    return started
      .then(fetched => {
        const serverRows = Array.isArray(fetched) ? fetched : [];
        const serverIds = new Set(serverRows.map(r => r.id));
        const pending = th.rows.filter(r => !serverIds.has(r.id));
        const next = serverRows.concat(pending);
        if (JSON.stringify(next) === JSON.stringify(th.rows)) return false;
        th.rows = next;
        return true;
      })
      .catch(e => {
        console.warn('[comments] refresh failed:', e);
        return false;
      });
  }

  /* Seed a thread with known rows and no round trip — preview harnesses and
     tests. Marks the thread loaded. */
  hydrate(taskId, rows) {
    const th = this._thread(taskId);
    th.rows = Array.isArray(rows) ? rows.slice() : [];
    th.loaded = true;
    return th.rows;
  }

  /* Append a posted row. Marks the thread loaded: my own comment is proof the
     thread exists, so posting into a never-opened thread doesn't flash
     "Loading comments…" underneath it. */
  append(taskId, row) {
    if (!row) return null;
    const th = this._thread(taskId);
    th.rows.push(row);
    th.loaded = true;
    return row;
  }

  find(taskId, commentId) {
    return this._thread(taskId).rows.find(c => c.id === commentId) || null;
  }

  /* ---------- reactions ---------- */

  /* Flip `memberId`'s `emoji` on one comment and hand back the undo, so the
     optimistic write and its rollback are one thing expressed once — a caller
     can't get the two out of sync. Returns { had, revert } where `had` is the
     pre-flip state (the caller needs it to pick add vs remove on the wire), or
     null if the comment isn't in this thread.

     revert() restores the exact prior state, including the removed entry's
     position — not just "push it back on the end". */
  toggleReaction(taskId, commentId, memberId, emoji) {
    const c = this.find(taskId, commentId);
    if (!c) return null;
    if (!Array.isArray(c.reactions)) c.reactions = [];

    const idx = c.reactions.findIndex(r => r.memberId === memberId && r.emoji === emoji);
    if (idx !== -1) {
      const [removed] = c.reactions.splice(idx, 1);
      return {
        had: true,
        revert: () => { c.reactions.splice(Math.min(idx, c.reactions.length), 0, removed); },
      };
    }
    const added = { memberId, emoji };
    c.reactions.push(added);
    return {
      had: false,
      revert: () => {
        const at = c.reactions.indexOf(added);
        if (at !== -1) c.reactions.splice(at, 1);
      },
    };
  }
};

/* Node test harness (tests/unit) requires this file directly. */
if (typeof module !== 'undefined' && module.exports) module.exports = { CommentStore: App.CommentStore };
