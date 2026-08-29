window.App = window.App || {};

App.SupabaseDataStore = class SupabaseDataStore {
  constructor({ supabase, currentUser, role }) {
    if (!supabase) throw new Error('Supabase client is required.');
    this.supabase = supabase;
    this.currentUser = currentUser;
    this.role = role || 'member';
    this._profileColumns = 'id, email, full_name, approved, role, email_verified, member_id, supervisor_id, company_ids, avatar_url, position, created_at';
    // Last-seen updated_at per task id — used as an optimistic-concurrency guard
    // so a save can't silently clobber an edit made elsewhere.
    this._taskVersions = {};
    // PostgREST caps a single response at its max-rows setting (~1000 by
    // default) and SILENTLY truncates — no error. Any unbounded list read
    // (tasks, time_entries, team_members, notifications) must page through with
    // .range() or rows simply vanish once a table grows past the cap. See
    // _pageAll.
    this._PAGE_SIZE = 1000;
  }

  /* Page through a select in fixed chunks until a short page comes back, so a
     table larger than PostgREST's max-rows cap is fully read instead of silently
     truncated. `buildQuery()` MUST return a fresh PostgREST query each call
     (with a STABLE .order() so paging windows don't overlap or skip) — we add
     .range() on top. Returns the concatenated rows. */
  async _pageAll(buildQuery, label) {
    const size = this._PAGE_SIZE;
    const out = [];
    for (let from = 0; ; from += size) {
      const to = from + size - 1;
      const res = await buildQuery().range(from, to);
      this._throwIfError(res, label);
      const rows = res.data || [];
      out.push(...rows);
      // A page shorter than the window means we've reached the end. (An exactly-
      // full final page costs one extra empty request, which is harmless.)
      if (rows.length < size) break;
    }
    return out;
  }

  async loadProfiles() {
    const res = await this.supabase
      .from('profiles')
      .select(this._profileColumns)
      .order('created_at', { ascending: false });
    this._throwIfError(res, 'profiles');
    return res.data || [];
  }

  async loadNotifications() {
    // Paged so a busy inbox isn't truncated at the PostgREST max-rows cap.
    // Secondary .order('id') keeps the paging window stable.
    const rows = await this._pageAll(
      () => this.supabase
        .from('notifications')
        .select('*')
        .eq('member_id', this.currentUser)
        .order('created_at', { ascending: false })
        .order('id', { ascending: true }),
      'notifications',
    );
    return rows.map(row => this._mapNotificationRow(row));
  }

  // ----- Task comments (migrations 053, 064) -----
  // Shape a task_comments row (optionally with an embedded comment_reactions
  // array from PostgREST) into the client comment object. `kind` (064) is a
  // real column; older rows default to 'comment'. Reactions are returned raw
  // (one {memberId, emoji} per row) — the view aggregates counts + "mine".
  _mapCommentRow(r) {
    const rx = Array.isArray(r.comment_reactions) ? r.comment_reactions : [];
    return {
      id: r.id,
      taskId: r.task_id,
      authorId: r.author_id,
      body: r.body || '',
      kind: r.kind || 'comment',
      mentions: Array.isArray(r.mentions) ? r.mentions : [],
      reactions: rx.map(x => ({ memberId: x.member_id, emoji: x.emoji })),
      createdAt: r.created_at,
    };
  }

  async loadComments(taskId) {
    const res = await this.supabase
      .from('task_comments')
      .select('*, comment_reactions(member_id, emoji)')
      .eq('task_id', taskId)
      .order('created_at', { ascending: true });
    this._throwIfError(res, 'task_comments');
    return (res.data || []).map(r => this._mapCommentRow(r));
  }

  // Latest comments across every task the viewer can see (RLS-scoped). The
  // Home "Comments & mentions" feed filters these down to my-tasks + mentions
  // client-side, so one small query serves the whole feed.
  async loadRecentComments(limit = 40) {
    const res = await this.supabase
      .from('task_comments')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    this._throwIfError(res, 'task_comments recent');
    return (res.data || []).map(r => this._mapCommentRow(r));
  }

  async addComment(taskId, { body, mentions, kind }) {
    const res = await this.supabase
      .from('task_comments')
      .insert({
        task_id: taskId,
        author_id: this.currentUser,
        body: String(body || ''),
        mentions: Array.isArray(mentions) ? mentions : [],
        kind: ['comment', 'note', 'call'].includes(kind) ? kind : 'comment',
      })
      .select('*, comment_reactions(member_id, emoji)')
      .single();
    this._throwIfError(res, 'task_comments insert');
    return this._mapCommentRow(res.data);
  }

  // ----- Comment reactions (migration 064) -----
  // Toggle is a two-call add/remove keyed on (comment, me, emoji); the unique
  // index makes a re-add a no-op at the DB level, but the UI never double-adds.
  async addReaction(commentId, emoji) {
    const res = await this.supabase
      .from('comment_reactions')
      .insert({ comment_id: commentId, member_id: this.currentUser, emoji: String(emoji) })
      .select('member_id, emoji')
      .single();
    this._throwIfError(res, 'comment_reactions insert');
    return { memberId: res.data.member_id, emoji: res.data.emoji };
  }

  async removeReaction(commentId, emoji) {
    const res = await this.supabase
      .from('comment_reactions')
      .delete()
      .eq('comment_id', commentId)
      .eq('member_id', this.currentUser)
      .eq('emoji', String(emoji));
    this._throwIfError(res, 'comment_reactions delete');
  }

  async load() {
    // The four unbounded lists (team_members, tasks, time_entries,
    // notifications) are paged so they aren't silently truncated at PostgREST's
    // max-rows cap. Each .order() is stable so paging windows are correct.
    // active_timers (≤1 row/user) and profiles stay single-shot.
    const [
      peopleRows,
      taskRows,
      entryRows,
      notificationRows,
      timersRes,
      profilesRes,
      projectsRes,
      taxTypesRes,
      taxStatusesRes,
      taxLabelsRes,
      taxSopsRes,
    ] = await Promise.all([
      this._pageAll(() => this.supabase.from('team_members').select('*').order('name', { ascending: true }).order('id', { ascending: true }), 'people'),
      this._pageAll(() => this.supabase.from('tasks').select('*').order('created_at', { ascending: true }).order('id', { ascending: true }), 'tasks'),
      this._pageAll(() => this.supabase.from('time_entries').select('*').order('start_at', { ascending: false }).order('id', { ascending: true }), 'time entries'),
      this._pageAll(() => this.supabase.from('notifications').select('*').eq('member_id', this.currentUser).order('created_at', { ascending: false }).order('id', { ascending: true }), 'notifications'),
      this.supabase.from('active_timers').select('*'),
      (App.can('roles.manage') || App.can('team.view'))
        ? this.supabase.from('profiles').select(this._profileColumns).order('created_at', { ascending: false })
        : Promise.resolve({ data: [], error: null }),
      this.supabase.from('projects').select('*').order('created_at', { ascending: true }),
      // Customizable per-company task taxonomy (migrations 056-058). RLS scopes rows to
      // the caller's companies. App.taxonomy hydrates from these; constants are the fallback.
      this.supabase.from('task_types').select('*'),
      this.supabase.from('task_type_statuses').select('*'),
      this.supabase.from('task_labels').select('*'),
      this._optionalSelect('task_label_sops'),
    ]);

    this._throwIfError(timersRes, 'active timers');
    this._throwIfError(profilesRes, 'profiles');
    this._throwIfError(projectsRes, 'projects');
    this._throwIfError(taxTypesRes, 'task types');
    this._throwIfError(taxStatusesRes, 'task statuses');
    this._throwIfError(taxLabelsRes, 'task labels');

    this._taskVersions = {};
    const tasks = taskRows.map(row => {
      this._taskVersions[row.id] = row.updated_at;
      return this._mapTaskRow(row);
    });

    return {
      people: this._mapPeople(peopleRows),
      profiles: profilesRes.data || [],
      tasks,
      timeEntries: entryRows.map(row => ({
        id: row.id,
        userId: row.user_id,
        taskId: row.task_id,
        start: Date.parse(row.start_at),
        end: Date.parse(row.end_at),
        durationMs: Number(row.duration_ms || 0),
        note: row.note || '',
      })),
      activeTimers: Object.fromEntries((timersRes.data || []).map(row => [
        row.user_id,
        {
          taskId: row.task_id,
          startedAt: Date.parse(row.started_at),
          taskTitle: row.task_title || null,
          taskCompany: row.task_company || null,
        },
      ])),
      notifications: notificationRows.map(row => this._mapNotificationRow(row)),
      projects: this._mapProjects(projectsRes.data || []),
      taxonomy: {
        types: taxTypesRes.data || [],
        statuses: taxStatusesRes.data || [],
        labels: taxLabelsRes.data || [],
        sops: taxSopsRes.data || [],
      },
    };
  }

  /* A select that yields [] instead of throwing when the table isn't there yet.
     task_label_sops (migration 069) ships in the client before it exists on every
     database, and a hard failure here would take the whole boot load down. Zero
     rows is also exactly what App.taxonomy.activeSop() needs to fall back to the
     built-in App.SOP_CHECKLISTS, so an un-migrated database degrades to the
     defaults rather than to a broken app. */
  async _optionalSelect(table) {
    try {
      const res = await this.supabase.from(table).select('*');
      return res.error ? { data: [], error: null } : res;
    } catch (e) {
      return { data: [], error: null };
    }
  }

  /* Tasks-only refresh for the background sync poll. Mirrors the tasks query in
     load(). The optimistic-lock version map (_taskVersions) is advanced to the
     server's latest for every task EXCEPT those the caller flags as dirty: a
     dirty task has an unsaved local edit whose pending save must still lock
     against the version that edit was based on, so refreshing it here would mask
     a genuine concurrent-edit conflict. RLS scopes the rows as on initial load. */
  async loadTasks(skipVersionIds) {
    // Paged so the poll re-pull isn't truncated once the tasks table grows past
    // the PostgREST max-rows cap. Secondary .order('id') keeps paging stable.
    const rows = await this._pageAll(
      () => this.supabase
        .from('tasks')
        .select('*')
        .order('created_at', { ascending: true })
        .order('id', { ascending: true }),
      'tasks',
    );
    return rows.map(row => {
      if (!skipVersionIds || !skipVersionIds.has(row.id)) {
        this._taskVersions[row.id] = row.updated_at;
      }
      return this._mapTaskRow(row);
    });
  }

  /* ---------- save (non-destructive: upserts + deltas) ----------
     `tasks` and `timeEntries` are the CHANGED subset (the models track what's
     dirty). Nothing is deleted-and-reinserted; the only deletes are clearing
     the current user's own single active-timer row on clock-out.
     Returns { conflicts } — tasks the server had a newer version of. */
  async save({ tasks, timeEntries, activeTimers, notifications }) {
    const conflicts = [];
    if (App.can('tasks.write') && tasks && tasks.length) {
      const c = await this._saveTasks(tasks);
      conflicts.push(...c);
    }
    await this._upsertTimeEntries(timeEntries || []);
    await this._syncActiveTimer(activeTimers || {});
    await this._upsertNotifications(notifications || []);
    return { conflicts };
  }

  async _saveTasks(tasks) {
    const conflicts = [];
    for (const task of tasks) {
      const row = this._taskRow(task);
      const known = this._taskVersions[task.id];
      if (known) {
        // Optimistic lock: only update if the row hasn't changed since we read it.
        const res = await this.supabase
          .from('tasks')
          .update(row)
          .eq('id', task.id)
          .eq('updated_at', known)
          .select('updated_at')
          .maybeSingle();
        this._throwIfError(res, 'saving task');
        if (!res.data) {
          // Optimistic-lock conflict: the server row changed under us. Do NOT
          // wholesale-replace the local task with the server copy — that discards
          // the local edit we were trying to save (e.g. a clearDoneTasks
          // `clearedAt` would be reverted to the server's null and lost).
          // Instead FIELD-MERGE: server row is the base, then re-apply the
          // locally-edited fields on top. We advance the known version to the
          // server's updated_at so the single-flight retry's next save passes the
          // lock (the merged task stays dirty upstream → it WILL be retried).
          // This converges: each retry carries the latest server updated_at, so
          // it can't loop on the same stale-version conflict.
          const fresh = await this._refetchTask(task.id);
          if (fresh) {
            this._taskVersions[fresh.row.id] = fresh.updatedAt;
            const mergedTask = this._mergeConflict(fresh.task, task);
            // Flag so app.js re-marks it dirty (instead of clearing it) and lets
            // the coalescing save retry write the merged result.
            mergedTask._conflictMerged = true;
            conflicts.push(mergedTask);
          }
        } else {
          this._taskVersions[task.id] = res.data.updated_at;
        }
      } else {
        const res = await this.supabase
          .from('tasks')
          .insert(row)
          .select('updated_at')
          .single();
        this._throwIfError(res, 'creating task');
        this._taskVersions[task.id] = res.data.updated_at;
      }
    }
    return conflicts;
  }

  async _refetchTask(id) {
    const res = await this.supabase.from('tasks').select('*').eq('id', id).maybeSingle();
    if (res.error || !res.data) return null;
    return { updatedAt: res.data.updated_at, row: res.data, task: this._mapTaskRow(res.data) };
  }

  /* Field-merge for an optimistic-lock conflict (fix #4).
     `serverTask` is the freshly-refetched authoritative row (mapped to camel);
     `localTask` is the in-memory copy whose save just lost the lock — i.e. the
     user's intended edits. We have only whole-task dirty tracking, so every
     editable field on localTask is treated as locally-dirty and re-applied on
     top of the server base. Server-owned metadata that the client never edits
     (id, createdAt) is taken from the server row. The result is the local edits
     preserved while inheriting any server-only fields the local copy lacks.
     Returns a NEW object so the caller can decide how to splice it in. */
  _mergeConflict(serverTask, localTask) {
    // List of fields the UI can edit and the save writes back (see _taskRow).
    // These are re-applied from the local copy so the conflicting save isn't
    // silently dropped. Everything else (id, createdAt, …) comes from the server.
    const EDITABLE = [
      'title', 'description', 'type', 'label', 'company', 'creator',
      'assignee', 'assigneeIds', 'project', 'due', 'dueTime', 'reminderAt', 'reminderOffset',
      'priority', 'status', 'watchers', 'subtasks', 'activity', 'stuck',
      'clearedAt', 'completedAt', 'focusSeq', 'woNumber',
    ];
    const merged = { ...serverTask };
    for (const f of EDITABLE) {
      if (Object.prototype.hasOwnProperty.call(localTask, f)) merged[f] = localTask[f];
    }
    // activity is an append-only log, so local-wins would silently drop entries
    // another device appended — union both sides instead (dedup by who|what|at,
    // chronological). Deliberately NOT done for watchers: that's an edited set
    // where a removal must stick, and a union would resurrect removed entries.
    const srvAct = Array.isArray(serverTask.activity) ? serverTask.activity : [];
    const locAct = Array.isArray(localTask.activity) ? localTask.activity : [];
    if (srvAct.length || locAct.length) {
      const seen = new Set();
      merged.activity = [...srvAct, ...locAct].filter(a => {
        const k = `${a && a.who}|${a && a.what}|${a && a.at}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }).sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
    }
    return merged;
  }

  _taskRow(task) {
    return {
      id: task.id,
      title: task.title,
      description: task.description || '',
      type: task.type || 'admin',
      // The app uses the 'none' sentinel for "No label", but the DB
      // tasks_label_check constraint only allows NULL or a real label
      // ('roof'/'roof_framing'/'framing'). Map 'none' → NULL so picking
      // "No label" doesn't trip the constraint and silently fail the save.
      label: (task.label && task.label !== 'none') ? task.label : null,
      // bid_status is retired (the Bid pipeline is now the Bid type's own statuses);
      // the column is kept for history but no longer written from new code.
      bid_status: null,
      company_id: task.company,
      creator_id: task.creator,
      assignee_id: task.assignee,
      // Ordered multi-assignee (migration 060). Lead = assignee_ids[0] and is
      // mirrored into assignee_id above so existing RLS/queries keep working.
      assignee_ids: (Array.isArray(task.assigneeIds) && task.assigneeIds.length)
        ? task.assigneeIds
        : (task.assignee ? [task.assignee] : []),
      project_id: task.project || null,
      due: task.due,
      due_time: task.dueTime || null,
      reminder_at: task.reminderAt || null,
      // Reminder offset spec for future server-side firing (migration 062).
      reminder_offset: task.reminderOffset || null,
      priority: task.priority || 'medium',
      urgency: task.priority || 'medium',
      status: task.status || 'todo',
      watchers: task.watchers || [],
      subtasks: task.subtasks || [],
      activity: task.activity || [],
      // "Stuck" / blocked-on state (migration 063). null = not stuck; else
      // { reason, on, at }. Written back on flagStuck / unblock.
      stuck: task.stuck || null,
      cleared_at: task.clearedAt || null,
      completed_at: task.completedAt || null,
      focus_seq: (task.focusSeq === null || task.focusSeq === undefined) ? null : task.focusSeq,
      // Per-company work-order number (migration 061); assigned server-side at create.
      wo_number: (task.woNumber === null || task.woNumber === undefined) ? null : task.woNumber,
    };
  }

  /* Insert one project folder. RLS gates to the caller's company window
     (migration 055). Returns { id }. */
  async createProject(row) {
    const res = await this.supabase.from('projects').insert(row).select('id').single();
    this._throwIfError(res, 'creating project');
    return res.data;
  }

  /* Atomically claim the next per-company work-order number (migration 061).
     Returns the assigned int, or null offline / on error (caller leaves the
     task unnumbered; it can be backfilled later). */
  async assignWoNumber(company) {
    if (!company) return null;
    try {
      const res = await this.supabase.rpc('assign_wo_number', { company });
      if (res.error) { console.warn('[wo] assign_wo_number failed', res.error); return null; }
      return typeof res.data === 'number' ? res.data : null;
    } catch (err) {
      console.warn('[wo] assign_wo_number threw', err);
      return null;
    }
  }

  /* Patch one project folder (e.g. status -> 'done' to complete it, or back to
     'active' to reopen). RLS gates to the caller's company window (migration
     055 "company members can update projects"). */
  async updateProject(id, patch) {
    if (!id) return;
    const res = await this.supabase.from('projects').update(patch).eq('id', id);
    this._throwIfError(res, 'updating project');
  }

  /* Delete one project folder. Tasks filed under it are UNFILED, not deleted:
     migration 055 re-points tasks.project_id -> ON DELETE SET NULL. RLS gates
     to the caller's company window (migration 055 "company members can delete
     projects"). */
  async deleteProject(id) {
    if (!id) return;
    const res = await this.supabase.from('projects').delete().eq('id', id);
    this._throwIfError(res, 'deleting project');
  }

  /* ---------- Task taxonomy CRUD (Settings → Task setup) ----------
     All writes are RLS-gated to developer/admin/construction_supervisor of the
     row's company (migration 056). Soft-delete = update {active:false}; rows are
     never hard-deleted so historical tasks keep resolving their type/status/label.
     Reads come back through loadTaxonomy() in the exact shape App.taxonomy.hydrate
     expects (same as load()'s `taxonomy` block). */
  async loadTaxonomy() {
    const [t, s, l, sop] = await Promise.all([
      this.supabase.from('task_types').select('*'),
      this.supabase.from('task_type_statuses').select('*'),
      this.supabase.from('task_labels').select('*'),
      this._optionalSelect('task_label_sops'),
    ]);
    this._throwIfError(t, 'task types');
    this._throwIfError(s, 'task statuses');
    this._throwIfError(l, 'task labels');
    return { types: t.data || [], statuses: s.data || [], labels: l.data || [], sops: sop.data || [] };
  }

  /* Proactive check-ins config (single row, id=1). Read/written by the boss-only
     CheckinSettingsView; the scheduled `checkins` Edge Function reads the same
     row via the service role. Admin RLS (migration 070) gates these calls. */
  async getCheckinSettings() {
    const { data, error } = await this.supabase
      .from('checkin_settings').select('*').eq('id', 1).single();
    if (error) throw error;
    return data;
  }

  async saveCheckinSettings(patch) {
    const row = {
      morning_enabled: !!patch.morning_enabled,
      eod_enabled: !!patch.eod_enabled,
      stalled_enabled: !!patch.stalled_enabled,
      stalled_days: Math.max(1, Math.min(90, parseInt(patch.stalled_days, 10) || 3)),
      eod_idle_minutes: Math.max(15, Math.min(480, parseInt(patch.eod_idle_minutes, 10) || 90)),
      updated_by: this.currentUser || null,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await this.supabase
      .from('checkin_settings').update(row).eq('id', 1).select().single();
    if (error) throw error;
    return data;
  }

  async createTaskType(row) {
    const res = await this.supabase.from('task_types').insert(row).select('*').single();
    this._throwIfError(res, 'creating task type');
    return res.data;
  }
  async updateTaskType(id, patch) {
    const res = await this.supabase.from('task_types').update(patch).eq('id', id).select('*').single();
    this._throwIfError(res, 'updating task type');
    return res.data;
  }

  async createTaskStatus(row) {
    const res = await this.supabase.from('task_type_statuses').insert(row).select('*').single();
    this._throwIfError(res, 'creating status');
    return res.data;
  }
  async updateTaskStatus(id, patch) {
    const res = await this.supabase.from('task_type_statuses').update(patch).eq('id', id).select('*').single();
    this._throwIfError(res, 'updating status');
    return res.data;
  }

  async createTaskLabel(row) {
    const res = await this.supabase.from('task_labels').insert(row).select('*').single();
    this._throwIfError(res, 'creating label');
    return res.data;
  }
  async updateTaskLabel(id, patch) {
    const res = await this.supabase.from('task_labels').update(patch).eq('id', id).select('*').single();
    this._throwIfError(res, 'updating label');
    return res.data;
  }

  /* SOP checklist steps, one row per step of a label's job-type SOP (migration 069).
     Unlike types/statuses/labels these are NOT soft-deleted: a checklist step carries
     no history on existing tasks (its text was copied into the task's own checklist at
     creation), so removing one is a plain delete. */
  async createSopStep(row) {
    const res = await this.supabase.from('task_label_sops').insert(row).select('*').single();
    this._throwIfError(res, 'creating SOP step');
    return res.data;
  }
  async updateSopStep(id, patch) {
    const res = await this.supabase.from('task_label_sops').update(patch).eq('id', id).select('*').single();
    this._throwIfError(res, 'updating SOP step');
    return res.data;
  }
  async deleteSopStep(id) {
    const res = await this.supabase.from('task_label_sops').delete().eq('id', id);
    this._throwIfError(res, 'removing SOP step');
  }

  /* Hard-delete a single task on demand. RLS gates this to the same
     roles allowed by migration 017's "role users can delete tasks"
     policy (admin / construction_supervisor / developer / supervisor /
     sales). All child rows hanging off task_id (time_entries,
     active_timers, notifications) cascade-delete via the schema FKs. */
  async deleteTask(id) {
    if (!id) return;
    const res = await this.supabase.from('tasks').delete().eq('id', id);
    this._throwIfError(res, 'deleting task');
    delete this._taskVersions[id];
  }

  /* Hard-delete tasks whose cleared_at is older than the grace window.
     Runs on app boot (best-effort); RLS gates this to the same roles
     allowed by migration 017's "role users can delete tasks" policy.
     Returns the number of rows removed, or 0 if RLS blocked or nothing
     was due. Never throws — a network blip on boot shouldn't break login. */
  async purgeExpiredClearedTasks({ graceDays = 30 } = {}) {
    try {
      const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000).toISOString();
      const res = await this.supabase
        .from('tasks')
        .delete()
        .lt('cleared_at', cutoff)
        .select('id');
      if (res.error) {
        console.warn('[datastore] purge cleared tasks failed', res.error);
        return 0;
      }
      return (res.data || []).length;
    } catch (err) {
      console.warn('[datastore] purge cleared tasks threw', err);
      return 0;
    }
  }

  async _upsertTimeEntries(entries) {
    const rows = entries
      .filter(entry => entry.userId === this.currentUser)
      .map(entry => ({
        id: entry.id,
        user_id: entry.userId,
        task_id: entry.taskId,
        start_at: new Date(entry.start).toISOString(),
        end_at: new Date(entry.end).toISOString(),
        duration_ms: Math.max(0, Math.round(entry.durationMs || 0)),
        note: entry.note || '',
      }));
    if (!rows.length) return;
    const res = await this.supabase.from('time_entries').upsert(rows, { onConflict: 'id' });
    this._throwIfError(res, 'saving time entries');
  }

  async _syncActiveTimer(activeTimers) {
    const mine = activeTimers[this.currentUser];
    if (mine) {
      const res = await this.supabase.from('active_timers').upsert([{
        user_id: this.currentUser,
        task_id: mine.taskId,
        started_at: new Date(mine.startedAt).toISOString(),
        task_title: mine.taskTitle || null,
        task_company: mine.taskCompany || null,
      }], { onConflict: 'user_id' });
      this._throwIfError(res, 'saving active timer');
    } else {
      const res = await this.supabase.from('active_timers').delete().eq('user_id', this.currentUser);
      this._throwIfError(res, 'clearing active timer');
    }
  }

  async _upsertNotifications(notifications) {
    const rows = (notifications || []).map(notification => ({
      id: notification.id,
      member_id: this.currentUser,
      task_id: notification.taskId || null,
      meta: notification.meta || '',
      html: notification.html || '',
      read: !!notification.read,
    }));
    if (!rows.length) return;
    const res = await this.supabase.from('notifications').upsert(rows, { onConflict: 'id' });
    this._throwIfError(res, 'saving notifications');
  }

  /* Deliver in-app notifications to OTHER members (assignees, watchers).
     RLS lets sales/supervisor/admin/construction_supervisor insert rows for any
     member_id, so recipients see them in their own inbox on next load/poll. */
  async sendNotifications(recipients) {
    const rows = (recipients || [])
      .filter(r => r && r.memberId && r.memberId !== this.currentUser)
      .map(r => ({
        id: App.utils.uid('n'),
        member_id: r.memberId,
        task_id: r.taskId || null,
        meta: r.meta || '',
        html: r.html || '',
        read: false,
      }));
    if (!rows.length) return;
    let res = await this.supabase.from('notifications').insert(rows);
    // notifications.task_id is a FK to tasks.id, but it's only a deep-link —
    // the message in `html` stands on its own. If the task isn't persisted
    // (a just-created task still mid-save, or one already deleted) the insert
    // trips notifications_task_id_fkey and the whole statement rolls back. Re-
    // try once with task_id cleared so the recipient still gets the alert
    // rather than losing it to a transient/edge condition.
    if (this._isTaskFkViolation(res.error) && rows.some(row => row.task_id)) {
      res = await this.supabase
        .from('notifications')
        .insert(rows.map(row => ({ ...row, task_id: null })));
    }
    this._throwIfError(res, 'sending notifications');
  }

  // True only for a foreign-key violation (23503) on the task_id FK — so we
  // retry by dropping the deep-link, not for an unrelated FK (e.g. member_id),
  // where a null task_id wouldn't help and the error should surface.
  _isTaskFkViolation(error) {
    if (!error || error.code !== '23503') return false;
    const msg = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`.toLowerCase();
    return msg.includes('task_id');
  }

  /* Best-effort email via the `notify-email` Edge Function. Returns
     { ok, skipped?, error? } and never throws, so a missing/undeployed function
     degrades gracefully to in-app only. */
  async sendEmail({ to, subject, html }) {
    const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
    if (!recipients.length) return { ok: false, skipped: true };
    try {
      const { data, error } = await this.supabase.functions.invoke('notify-email', {
        body: { to: recipients, subject, html },
      });
      if (error) return { ok: false, error: (error && error.message) || String(error) };
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  }

  /* "Report a problem" — submit via the report-problem Edge Function (the
     only write path to bug_reports). Returns { ok, emailed?, status?, error? }
     and never throws: the modal turns failures into inline errors. */
  async submitBugReport({ type, description, context }) {
    try {
      const { data, error } = await this.supabase.functions.invoke('report-problem', {
        body: { type, description, context },
      });
      if (error) {
        // Supabase wraps non-2xx as `error` with a `.context.status`.
        const status = (error.context && error.context.status) || null;
        let msg = (error && error.message) || 'Could not send the report.';
        try {
          const body = await error.context.json();
          if (body && body.error) msg = body.error;
        } catch (e) { /* body already consumed or not JSON */ }
        return { ok: false, status, error: msg };
      }
      return { ok: true, emailed: !!(data && data.emailed) };
    } catch (err) {
      return { ok: false, status: null, error: (err && err.message) || String(err) };
    }
  }

  /* Daily AI briefing via the ai-assistant Edge Function. Returns
     { ok, briefing?, error? } and never throws so Home degrades gracefully. */
  async getBriefing() {
    try {
      const { data, error } = await this.supabase.functions.invoke('ai-assistant', {
        body: { action: 'briefing' },
      });
      if (error) {
        const status = (error.context && error.context.status) || null;
        let msg = (error && error.message) || 'AI unavailable.';
        try { const body = await error.context.json(); if (body && body.error) msg = body.error; }
        catch (_e) { /* body already consumed or not JSON */ }
        return { ok: false, status, error: msg };
      }
      return { ok: true, briefing: data && data.briefing };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  }

  /* Weekly digest via the ai-assistant Edge Function. Returns { ok, digest?, error? }
     and never throws so Home degrades gracefully. */
  async getWeeklyDigest() {
    try {
      const { data, error } = await this.supabase.functions.invoke('ai-assistant', {
        body: { action: 'weekly_digest', today: App.utils.todayISO(0) },
      });
      if (error) {
        const status = (error.context && error.context.status) || null;
        let msg = (error && error.message) || 'AI unavailable.';
        try { const body = await error.context.json(); if (body && body.error) msg = body.error; }
        catch (_e) { /* body already consumed or not JSON */ }
        return { ok: false, status, error: msg };
      }
      return { ok: true, digest: data && data.digest };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  }

  /* Per-project AI rollup via the ai-assistant Edge Function. Returns
     { ok, rollup?, generatedAt?, error? } and never throws so the Projects
     drawer degrades gracefully. */
  async projectRollup({ projectId, projectName, today }) {
    try {
      const { data, error } = await this.supabase.functions.invoke('ai-assistant', {
        body: { action: 'project_rollup', projectId, projectName, today },
      });
      if (error) {
        const status = (error.context && error.context.status) || null;
        let msg = (error && error.message) || 'AI unavailable.';
        try { const body = await error.context.json(); if (body && body.error) msg = body.error; }
        catch (_e) { /* body already consumed or not JSON */ }
        return { ok: false, status, error: msg };
      }
      return { ok: true, rollup: data && data.rollup, generatedAt: data && data.generatedAt };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  }

  /* Natural-language task draft via the ai-assistant Edge Function. Returns
     { ok, draft?, error? } and never throws so the New Task page degrades quietly. */
  async draftTask({ text, team, companies, today, types, labels, projects, statuses }) {
    try {
      const { data, error } = await this.supabase.functions.invoke('ai-assistant', {
        body: { action: 'draft_task', text, team, companies, today, types, labels, projects, statuses },
      });
      if (error) return { ok: false, error: (error && error.message) || 'AI unavailable.' };
      return { ok: true, draft: data && data.draft };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  }

  /* Speech → text via the ai-assistant Edge Function. Returns
     { ok, text?, error? } and never throws so the New Task page degrades quietly. */
  async transcribe({ audio, mime }) {
    try {
      const { data, error } = await this.supabase.functions.invoke('ai-assistant', {
        body: { action: 'transcribe', audio, mime },
      });
      if (error) return { ok: false, error: (error && error.message) || 'Voice unavailable.' };
      if (!data || data.ok === false) return { ok: false, error: (data && data.error) || 'Voice unavailable.' };
      return { ok: true, text: (data && data.text) || '' };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  }

  /* Ask-your-tasks chat via the ai-assistant Edge Function. Returns
     { ok, answer?, error? } and never throws so the drawer degrades gracefully. */
  async chat({ question, history, tasks, today, truncated, clock, me }) {
    try {
      const { data, error } = await this.supabase.functions.invoke('ai-assistant', {
        body: { action: 'chat', question, history, tasks, today, truncated, clock, me },
      });
      if (error) return { ok: false, error: (error && error.message) || 'AI unavailable.' };
      return { ok: true, answer: data && data.answer };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  }

  /* Developer-only (RLS): every submitted report, newest first. */
  async listBugReports() {
    const res = await this.supabase
      .from('bug_reports')
      .select('*')
      .order('created_at', { ascending: false });
    this._throwIfError(res, 'loading bug reports');
    return res.data || [];
  }

  /* Developer-only (RLS): triage toggle. status is 'open' | 'resolved'. */
  async setBugReportStatus(id, status) {
    const res = await this.supabase
      .from('bug_reports')
      .update({ status, resolved_at: status === 'resolved' ? new Date().toISOString() : null })
      .eq('id', id)
      .select('*')
      .single();
    this._throwIfError(res, 'updating bug report');
    return res.data;
  }

  async updateProfileAccess(profileId, updates) {
    const patch = {
      role: updates.role,
      approved: !!updates.approved,
    };
    // supervisorId / companyIds / position are optional; only set them when provided.
    if ('supervisorId' in updates) patch.supervisor_id = updates.supervisorId || null;
    if ('companyIds' in updates) patch.company_ids = Array.isArray(updates.companyIds) ? updates.companyIds : [];
    if ('position' in updates) patch.position = updates.position || null;
    const res = await this.supabase
      .from('profiles')
      .update(patch)
      .eq('id', profileId)
      .select(this._profileColumns)
      .single();
    this._throwIfError(res, 'updating profile access');
    return res.data;
  }

  /* Remove a user's access by hard-deleting their profile row, then prune
     their team_members row so they also drop out of the assignee picker
     (App.PEOPLE). RLS gates the profile delete to managers (migration 024's
     "managers can delete profiles" policy) and forbids deleting your own.

     The team_members delete is best-effort: the member-side FKs on tasks /
     time_entries are ON DELETE RESTRICT, so if the person is still load-
     bearing for real data the delete fails — we swallow that and keep the
     row so their name still renders on historical tasks. Only truly
     orphaned members (no remaining references) actually get removed, which
     mirrors the prune in migration 025. With no profile the account is
     treated as unapproved and gated out of the app (AuthModel.isApproved). */
  /* Fully delete a user. Prefers the delete-user Edge Function, which also
     removes the Auth login (freeing the email for re-registration) using the
     service role. Falls back to a profile-only delete if the function isn't
     deployed yet, so the button still revokes access in the meantime.
     Returns { emailFreed: boolean }. */
  async deleteProfile(profileId, memberId) {
    if (!profileId) return { emailFreed: false };

    try {
      const { data, error } = await this.supabase.functions.invoke('delete-user', {
        body: { profileId, memberId: memberId || null },
      });
      if (error) throw error;
      if (data && data.ok) return { emailFreed: data.emailFreed !== false };
      throw new Error((data && data.error) || 'delete-user did not confirm success');
    } catch (err) {
      // Function unavailable (not deployed) or errored — fall back to removing
      // the profile directly so access is still revoked. The email stays
      // reserved until the function is deployed.
      console.warn('[datastore] delete-user function unavailable; profile-only fallback:', err && err.message);
      const res = await this.supabase.from('profiles').delete().eq('id', profileId);
      this._throwIfError(res, 'deleting profile');
      if (memberId) {
        const memberRes = await this.supabase.from('team_members').delete().eq('id', memberId);
        if (memberRes && memberRes.error) {
          console.warn('[datastore] team_member kept (still referenced or blocked):', memberRes.error.message);
        }
      }
      return { emailFreed: false };
    }
  }

  /* Create a brand-new user (admin-created account). Invokes the create-user
     Edge Function, which makes the Auth login (the browser can't), approves the
     profile with the chosen role/company/supervisor, and emails the person their
     default password. Returns { ok, profileId, memberId, emailSent }. Throws an
     Error carrying the function's message on failure (e.g. duplicate email). */
  async createUser({ fullName, email, role, companyIds, supervisorId }) {
    const { data, error } = await this.supabase.functions.invoke('create-user', {
      body: {
        fullName,
        email,
        role,
        companyIds: Array.isArray(companyIds) ? companyIds : [],
        supervisorId: supervisorId || null,
      },
    });
    if (error) {
      // Supabase wraps a non-2xx as `error`; the JSON body (with our message)
      // is on error.context. Surface the function's message when we can read it.
      let message = error.message || 'Could not add the person.';
      try {
        const body = await error.context?.json?.();
        if (body && body.error) message = body.error;
      } catch { /* fall back to error.message */ }
      throw new Error(message);
    }
    if (!data || !data.ok) throw new Error((data && data.error) || 'Could not add the person.');
    return data;
  }

  _mapTaskRow(row) {
    return {
      id: row.id,
      title: row.title,
      description: row.description || '',
      type: row.type || 'admin',
      // DB stores NULL for "no label"; the app uses the 'none' sentinel
      // everywhere (display + the picker), so normalise on the way in.
      label: row.label || 'none',
      company: row.company_id,
      creator: row.creator_id,
      assignee: row.assignee_id,
      // Ordered multi-assignee (migration 060); fall back to the single assignee
      // for rows created before the column existed.
      assigneeIds: (Array.isArray(row.assignee_ids) && row.assignee_ids.length)
        ? row.assignee_ids
        : (row.assignee_id ? [row.assignee_id] : []),
      due: row.due,
      dueTime: row.due_time || null,
      reminderAt: row.reminder_at || null,
      reminderOffset: row.reminder_offset || null,
      priority: row.priority || row.urgency || 'medium',
      status: row.status,
      project: row.project_id || null,
      watchers: Array.isArray(row.watchers) ? row.watchers : [],
      subtasks: Array.isArray(row.subtasks) ? row.subtasks : [],
      activity: Array.isArray(row.activity) ? row.activity : [],
      // "Stuck" / blocked-on state (migration 063); null when not stuck.
      stuck: row.stuck || null,
      clearedAt: row.cleared_at || null,
      createdAt: row.created_at || null,
      completedAt: row.completed_at || null,
      // Focus list (execution order) sort-key. null = not in the assignee's Focus.
      focusSeq: (row.focus_seq === null || row.focus_seq === undefined) ? null : Number(row.focus_seq),
      // Per-company work-order number (migration 061); null until assigned.
      woNumber: (row.wo_number === null || row.wo_number === undefined) ? null : Number(row.wo_number),
    };
  }

  _mapNotificationRow(row) {
    return {
      id: row.id,
      taskId: row.task_id,
      meta: row.meta,
      html: row.html,
      read: !!row.read,
      createdAt: row.created_at || null,
    };
  }

  _mapPeople(rows) {
    return rows.reduce((acc, row) => {
      acc[row.id] = {
        id: row.id,
        name: row.name || row.full_name || row.email || row.id,
        full: row.full_name || row.name || row.email || row.id,
        email: row.email || '',
        color: App.utils.safeColor(row.color),
        avatar_url: row.avatar_url || null,
        // Companies this member belongs to (mirrored from profiles, migration 045).
        // Lets the assignee/watcher pickers stay company-scoped even for workers,
        // who can't read profiles and so build the picker straight from this roster.
        company_ids: Array.isArray(row.company_ids) ? row.company_ids : [],
        // Backed by an approved profile? Used to filter the assignee/watcher
        // picker for non-manager sessions, which can't read profiles directly
        // (migration 039). Absent column (pre-migration) -> treat as active.
        active: row.active !== false,
        position: row.position || null,
        role: row.role || null,
      };
      return acc;
    }, {});
  }

  _mapProjects(rows) {
    return rows.reduce((acc, row) => {
      acc[row.id] = {
        id: row.id,
        name: row.name || row.id,
        color: row.color || '#8f867b',
        client: row.client || '',
        status: row.status || 'active',
        address: row.address || '',
        dueDate: row.due_date || null,
        companyId: row.company_id,
      };
      return acc;
    }, {});
  }

  /* Projects-only refresh (after create/rename/delete). Mirrors the projects
     query in load(); RLS scopes rows exactly as on initial load. */
  async loadProjects() {
    const res = await this.supabase
      .from('projects')
      .select('*')
      .order('created_at', { ascending: true });
    this._throwIfError(res, 'projects');
    return this._mapProjects(res.data || []);
  }

  _throwIfError(result, label) {
    if (result && result.error) {
      // Defensive: App.errors should always be loaded (errors.js precedes this
      // file in HTML script order), but fall back to a plain Error rather than
      // a TypeError if something's mis-wired.
      if (App.errors && App.errors.fromSupabase) {
        throw App.errors.fromSupabase(result.error, label);
      }
      throw new Error(`Supabase ${label} failed: ${result.error.message}`);
    }
  }
};
