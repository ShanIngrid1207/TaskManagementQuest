window.App = window.App || {};

/* TaskModel — owns the tasks array.
   Mutating methods emit 'tasks:changed'. Pure query methods do not. */
App.TaskModel = class TaskModel {
  constructor() {
    this.tasks = [];
    this._dirty = new Set(); // ids of tasks changed since last successful save
  }

  /* ---------- hydration / seed ---------- */
  hydrate(arr) {
    this.tasks = Array.isArray(arr) ? arr : [];
    this._dirty.clear();
  }

  /* ---------- dirty tracking (drives delta saves) ---------- */
  _markDirty(id) { if (id) this._dirty.add(id); }
  // Returns the changed task objects and clears the dirty set (optimistic).
  takeDirty() {
    const ids = [...this._dirty];
    this._dirty.clear();
    return ids.map(id => this.find(id)).filter(Boolean);
  }
  // Re-flag ids as dirty (e.g. when a save failed and must be retried).
  markDirty(ids) { (ids || []).forEach(id => this._markDirty(id)); }
  // Replace a task with the authoritative server version (conflict resolution).
  applyServer(task) {
    if (!task) return;
    const i = this.tasks.findIndex(t => t.id === task.id);
    if (i === -1) this.tasks.push(task); else this.tasks[i] = task;
    this._dirty.delete(task.id);
    App.EventBus.emit('tasks:changed');
  }

  /* Apply a FIELD-MERGED server-conflict result (server base + local edits) and
     KEEP the task dirty so the next save retries it. Used on optimistic-lock
     conflicts (fix #4): the datastore has already advanced its known version to
     the server's updated_at, so the retry's lock will pass and the merge
     converges (no infinite conflict loop). Emitting 'tasks:changed' both
     re-renders and (via the bound `persist` debounce) schedules that retry. */
  applyServerKeepDirty(task) {
    if (!task) return;
    const i = this.tasks.findIndex(t => t.id === task.id);
    if (i === -1) this.tasks.push(task); else this.tasks[i] = task;
    this._markDirty(task.id);
    App.EventBus.emit('tasks:changed');
  }

  // Snapshot of the ids with unsaved edits — passed to the data store's poll
  // so it won't advance their optimistic-lock version out from under a pending save.
  dirtyIds() { return new Set(this._dirty); }

  /* Merge a fresh server snapshot into the local tasks WITHOUT discarding
     unsaved local edits. Tasks the user has touched since the last successful
     save (the dirty set) keep their local copy — the pending delta-save will
     reconcile them — while every other task is replaced by the server row, so
     work created by other people shows up. Locally-created tasks the server
     doesn't know about yet are preserved. Emits 'tasks:changed' only when the
     merge actually changed something, so an idle poll causes no re-render or
     save churn. Returns true if it emitted. */
  mergeServer(serverTasks) {
    if (!Array.isArray(serverTasks)) return false;
    const serverIds = new Set(serverTasks.map(t => t.id));
    const merged = serverTasks.map(t =>
      this._dirty.has(t.id) ? (this.find(t.id) || t) : t
    );
    for (const id of this._dirty) {
      if (!serverIds.has(id)) {
        const local = this.find(id);
        if (local) merged.push(local);
      }
    }
    const changed = this._signature(this.tasks) !== this._signature(merged);
    this.tasks = merged;
    if (changed) App.EventBus.emit('tasks:changed');
    return changed;
  }

  /* Canonical signature of a task list, used by mergeServer to answer "did the
     server actually change anything?". Two rules make that answer honest:

     1. LOCAL-ONLY FIELDS ARE INVISIBLE. Anything underscore-prefixed is view or
        cache state some other module hung on the task; the server never sent it
        and never will, so counting it means the local list can never match a
        fresh server snapshot again — every idle poll then emits 'tasks:changed'
        forever. That is not hypothetical: the comment thread used to park
        `_commentsLoaded` here, and the whole app re-rendered every 30 seconds
        because of it. Underscore-prefix is therefore the convention for
        decorating a task in place; prefer not decorating it at all.
     2. KEY ORDER IS NOT A CHANGE. Rows reach us both from _mapTaskRow and from
        a local create, which build their objects in different orders.

     The rule is deliberately one-sided: skip local decoration, keep every
     server field. Wrongly skipping a real column would hide other people's
     edits until reload — a far worse failure than the churn it replaces. */
  _signature(list) {
    const canon = (v) => {
      if (Array.isArray(v)) return v.map(canon);
      if (v && typeof v === 'object') {
        const out = {};
        for (const k of Object.keys(v).sort()) {
          if (k.charAt(0) === '_') continue;
          out[k] = canon(v[k]);
        }
        return out;
      }
      return v;
    };
    return JSON.stringify(
      [...list]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map(canon)
    );
  }

  seedDefaults() {
    const iso = App.utils.todayISO;
    this.tasks = [
      { id:'t1',  title:'Lien filing — CNL job', type:'admin', company:'roofing', creator:'abraham', assignee:'abraham', watchers:['kristine'], due:iso(-4), priority:'urgent',   status:'todo',    description:'Mechanic\'s lien paperwork prepped. Need to file with Maricopa County recorder before end of week.', subtasks:[{t:'Pull deed info',d:true},{t:'Notarize',d:false}], activity:[{who:'Abraham',what:'created this task',when:'5d ago'}] },
      { id:'t2',  title:'Update QR ROC complaint draft', type:'admin', company:'roofing', creator:'abraham', assignee:'kristine', watchers:[], due:iso(-2), priority:'high', status:'pending', description:'Add the contract excerpt and email chain as exhibits before sending.', subtasks:[], activity:[{who:'Abraham',what:'assigned this to Kristine',when:'3d ago'}] },
      { id:'t3',  title:'CNL demand letter follow-up', type:'ar', company:'roofing', creator:'abraham', assignee:'abraham', watchers:['kristine'], due:iso(0), priority:'critical', status:'todo', description:'Call CNL accounting by EOD. If no commitment, file mechanic\'s lien tomorrow + Justice Court small claims by Friday.', subtasks:[{t:'Send certified letter',d:true},{t:'Call accounting',d:false},{t:'Prep lien paperwork',d:false}], activity:[{who:'Kristine',what:'uploaded letter.pdf',when:'2h ago'},{who:'Abraham',what:'set due date today',when:'yesterday'}] },
      { id:'t4',  title:'Paradise Valley demo punch list', type:'bid', company:'roofing', creator:'abraham', assignee:'alkeith', watchers:['abraham'], due:iso(0), priority:'urgent', status:'todo', description:'Final walkthrough items. See photos in shared album.', subtasks:[{t:'Tear-off west slope',d:true},{t:'Replace decking 2 sheets',d:true},{t:'Drip edge install',d:false},{t:'Final cleanup + photos',d:false}], activity:[{who:'Abraham',what:'assigned this to Alkeith',when:'yesterday'}] },
      { id:'t5',  title:'Jesus week-2 KPI review', type:'meeting', company:'roofing', creator:'abraham', assignee:'abraham', watchers:['jesus'], due:iso(0), priority:'high', status:'review', description:'Review against 90-day vesting milestones. Doors knocked, appts set, contracts signed.', subtasks:[], activity:[] },
      { id:'t6',  title:'Send Andres weekly QA brief', type:'admin', company:'drafting', creator:'abraham', assignee:'abraham', watchers:[], due:iso(0), priority:'medium', status:'todo', description:'', subtasks:[], activity:[] },
      { id:'t7',  title:'Adrian — confirm trial milestones', type:'meeting', company:'lumen', creator:'abraham', assignee:'abraham', watchers:['adrian'], due:iso(0), priority:'high', status:'todo', description:'3-month trial KPIs need to be in writing before next sync.', subtasks:[], activity:[] },
      { id:'t8',  title:'Lumen pitch deck v3 sign-off', type:'lead', company:'lumen', creator:'abraham', assignee:'adrian', watchers:['abraham'], due:iso(1), priority:'medium', status:'review', description:'Final review of HVAC pitch deck before client outreach.', subtasks:[], activity:[{who:'Abraham',what:'assigned this to Adrian',when:'2d ago'}] },
      { id:'t9',  title:'DraftTrack markup tool QA', type:'admin', company:'drafting', creator:'abraham', assignee:'andres', watchers:[], due:iso(1), priority:'medium', status:'todo', description:'Test all markup tools on Safari + Chrome. Document any issues.', subtasks:[], activity:[{who:'Abraham',what:'assigned this to Andres',when:'2d ago'}] },
      { id:'t10', title:'Schedule monsoon ad shoot', type:'admin', company:'lumen', creator:'abraham', assignee:'adrian', watchers:[], due:iso(3), priority:'medium', status:'todo', description:'Friday morning, blue sky. Confirm location + crew.', subtasks:[], activity:[] },
      { id:'t11', title:'Supabase auth wiring', type:'admin', company:'drafting', creator:'abraham', assignee:'abraham', watchers:[], due:iso(4), priority:'high', status:'hold', description:'DraftTrack client portal — add auth + persistent storage.', subtasks:[], activity:[] },
      { id:'t12', title:'GC outreach v2 script', type:'lead', company:'roofing', creator:'abraham', assignee:'jesus', watchers:['abraham'], due:iso(5), priority:'medium', status:'todo', description:'Hormozi-style warm follow-up. Lead with the ROC + insurance angle.', subtasks:[], activity:[{who:'Abraham',what:'assigned this to Jesus',when:'today'}] },
      { id:'t13', title:'Order shingles, Gilbert job', type:'admin', company:'roofing', creator:'abraham', assignee:'kristine', watchers:[], due:iso(-1), priority:'medium', status:'done', description:'', subtasks:[], activity:[] },
      { id:'t14', title:'Send Adrian operating agreement', type:'admin', company:'lumen', creator:'abraham', assignee:'abraham', watchers:['adrian'], due:iso(-2), priority:'high', status:'done', description:'', subtasks:[], activity:[] },
      { id:'t15', title:'Material handoff — Mesa job', type:'admin', company:'roofing', creator:'alkeith', assignee:'kristine', watchers:['abraham'], due:iso(2), priority:'low', status:'todo', description:'Voice note from Alkeith: confirm metal flashing arrives at yard by Thursday.', subtasks:[], activity:[{who:'Alkeith',what:'created via voice note',when:'1h ago'}] },
    ];
  }

  /* ---------- queries ---------- */
  all() { return this.tasks; }
  find(id) { return this.tasks.find(t => t.id === id); }
  byCompany(companyId) { return this.tasks.filter(t => App.utils.taskInCompany(t, companyId)); }
  byAssignee(userId) { return this.tasks.filter(t => App.utils.isAssignee(t, userId)); }

  /* The shared, cross-person Focus list: every active (not done, not soft-
     cleared) task that's been given a focus position, ordered by it — regardless
     of who it's assigned to. The #N badge a user sees is the index in THIS
     array, not the stored focusSeq. (Visibility is already enforced upstream:
     this.tasks only holds rows the viewer is allowed to see.) */
  focusList() {
    return this.tasks
      .filter(t => t.focusSeq != null && !App.taxonomy.isDone(t) && !t.clearedAt)
      .sort((a, b) => a.focusSeq - b.focusSeq);
  }

  getFiltered({ view, scope, searchQuery, currentUser, activeFilters, currentCompany, role, reportMemberIds }) {
    // Soft-cleared rows (Clear-done-group action) stay in memory so the
    // optimistic-lock save still works, but they never appear in any
    // view — boot-time purge hard-deletes them after the 30-day grace.
    let tasks = this.tasks.filter(t => !t.clearedAt);
    const t0 = App.utils.todayISO(0);
    const clockTaskId = App.DEFAULT_CLOCK_TASK_ID;

    // Company scoping — UI mirror of migration 028 RLS. A specific company
    // narrows to that company; the developer-only '*' sentinel means "all
    // companies" (god mode). The shared clock task is always visible so timers
    // work regardless of company.
    if (currentCompany && currentCompany !== '*') {
      tasks = tasks.filter(t => App.utils.taskInCompany(t, currentCompany) || t.id === clockTaskId);
    }

    // Role row-scope. Worker = tasks assigned to OR created by them (mirrors the
    // tasks SELECT policy after migration 043, so a worker still sees a task they
    // created and delegated to a teammate); Supervisor = own/created or assigned to
    // a direct report. Admin/developer see everything in scope.
    if (role === 'worker') {
      tasks = tasks.filter(t => App.utils.isAssignee(t, currentUser) || t.creator === currentUser || t.id === clockTaskId);
    } else if (role === 'supervisor' && reportMemberIds) {
      tasks = tasks.filter(t =>
        App.utils.isAssignee(t, currentUser) ||
        t.creator === currentUser ||
        App.utils.taskAssignees(t).some(id => reportMemberIds.has(id)) ||
        t.id === clockTaskId
      );
    }

    if (view === 'mine') tasks = tasks.filter(t => App.utils.isAssignee(t, currentUser));
    else if (view === 'hot') tasks = tasks.filter(t => (t.priority === 'critical' || t.priority === 'urgent') && !App.taxonomy.isDone(t));
    else if (view === 'today') tasks = tasks.filter(t => t.due === t0 && !App.taxonomy.isDone(t));
    // `t.due &&`: due === '' must not read as overdue ('' < any ISO date).
    else if (view === 'overdue') tasks = tasks.filter(t => t.due && t.due < t0 && !App.taxonomy.isDone(t));
    else if (view === 'watching') tasks = tasks.filter(t => (t.watchers || []).includes(currentUser));
    else if (view.startsWith('company:')) {
      const c = view.split(':')[1];
      tasks = tasks.filter(t => App.utils.taskInCompany(t, c));
    } else if (view.startsWith('person:')) {
      const p = view.split(':')[1];
      tasks = tasks.filter(t => App.utils.isAssignee(t, p));
    }

    // Scope segment ("My work"): narrows the active view to the viewer's own
    // assignments without leaving it — Urgent stays Urgent, just mine. Counts
    // co-assignments, not just the ones where you're the lead.
    if (scope === 'mine') tasks = tasks.filter(t => App.utils.isAssignee(t, currentUser));

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      tasks = tasks.filter(t => {
        if (t.title.toLowerCase().includes(q)) return true;
        if ((t.description || '').toLowerCase().includes(q)) return true;
        const person = App.directory.person(t.assignee);
        if (person && (
          (person.name || '').toLowerCase().includes(q) ||
          (person.full || '').toLowerCase().includes(q) ||
          (person.email || '').toLowerCase().includes(q)
        )) return true;
        const proj = App.directory.project(t.project);
        const projName = (proj && proj.name) || '';
        if (projName.toLowerCase().includes(q)) return true;
        const company = App.directory.company(t.company);
        if (company && (company.label || '').toLowerCase().includes(q)) return true;
        return false;
      });
    }

    if (activeFilters) {
      const f = activeFilters;
      if (f.assignees && f.assignees.length) {
        tasks = tasks.filter(t => App.utils.taskAssignees(t).some(id => f.assignees.includes(id)));
      }
      if (f.companies && f.companies.length) {
        tasks = tasks.filter(t => f.companies.some(c => App.utils.taskInCompany(t, c)));
      }
      if (f.projectId) tasks = tasks.filter(t => t.project === f.projectId);
      if (f.projects && f.projects.length) tasks = tasks.filter(t => f.projects.includes(t.project));
      if (f.statuses  && f.statuses.length)  tasks = tasks.filter(t => f.statuses.includes(t.status || 'todo'));
      if (f.priorities && f.priorities.length) tasks = tasks.filter(t => f.priorities.includes(t.priority || 'medium'));
      if (f.types && f.types.length) tasks = tasks.filter(t => f.types.includes(t.type || 'admin'));
      if (f.labels && f.labels.length) tasks = tasks.filter(t => f.labels.includes(t.label || 'none'));
      if (f.dueRange && f.dueRange !== 'all') {
        const t1 = App.utils.todayISO(1);
        const t7 = App.utils.todayISO(7);
        const t30 = App.utils.todayISO(30);
        tasks = tasks.filter(t => {
          if (!t.due) return false;
          if (f.dueRange === 'overdue') return t.due < t0 && !App.taxonomy.isDone(t);
          if (f.dueRange === 'today')   return t.due === t0;
          if (f.dueRange === 'tomorrow')return t.due === t1;
          if (f.dueRange === 'week')    return t.due >= t0 && t.due <= t7;
          if (f.dueRange === 'month')   return t.due >= t0 && t.due <= t30;
          return true;
        });
      }
    }
    return tasks;
  }

  /* Generic Monday-style grouping. Returns an ordered list of buckets:
        [{ key, label, color, items[] }, ...]
     - groupBy: 'due' | 'status' | 'assignee' | 'company' | 'priority' | 'type' | 'none'
     - sortBy + sortDir control the order INSIDE each bucket.
     Empty buckets are dropped so the table doesn't show dead sections. */
  groupTasks(tasks, { groupBy = 'due', sortBy = 'priority', sortDir = 'asc' } = {}) {
    const t0 = App.utils.todayISO(0);
    const t1 = App.utils.todayISO(1);
    const t7 = App.utils.todayISO(7);

    const buckets = new Map();
    const ensure = (key, label, color, order) => {
      if (!buckets.has(key)) buckets.set(key, { key, label, color, order, items: [] });
      return buckets.get(key);
    };

    const colorVar = (v) => `var(${v})`;
    const colorFor = (key) => ({
      overdue:  colorVar('--rust'),
      today:    colorVar('--amber'),
      tomorrow: colorVar('--blue'),
      thisWeek: colorVar('--green'),
      later:    colorVar('--ink-3'),
      done:     colorVar('--ink-3'),
    }[key]);

    tasks.forEach(t => {
      if (groupBy === 'due') {
        if (App.taxonomy.isDone(t)) ensure('done', 'Done', colorFor('done'), 6).items.push(t);
        else if (!t.due)         ensure('later', 'No due date', colorFor('later'), 5).items.push(t);
        else if (t.due < t0)     ensure('overdue', 'Overdue', colorFor('overdue'), 0).items.push(t);
        else if (t.due === t0)   ensure('today', 'Due today', colorFor('today'), 1).items.push(t);
        else if (t.due === t1)   ensure('tomorrow', 'Tomorrow', colorFor('tomorrow'), 2).items.push(t);
        else if (t.due <= t7)    ensure('thisWeek', 'This week', colorFor('thisWeek'), 3).items.push(t);
        else                     ensure('later', 'Later', colorFor('later'), 4).items.push(t);
      } else if (groupBy === 'status') {
        const k = t.status || 'todo';
        const s = App.STATUSES[k] || App.STATUSES.todo;
        const colorMap = { todo: '--blue', doing: '--blue', pending: '--ink-3', hold: '--rust', review: '--amber', done: '--green' };
        ensure(k, s.label, colorVar(colorMap[s.cls.replace('status-', '')] || '--ink-3'), Object.keys(App.STATUSES).indexOf(k)).items.push(t);
      } else if (groupBy === 'assignee') {
        const k = t.assignee || 'unassigned';
        const p = App.directory.person(k);
        ensure(k, p ? p.name : 'Unassigned', p ? p.color : 'var(--ink-3)', k).items.push(t);
      } else if (groupBy === 'company') {
        const k = t.company || 'none';
        const c = App.directory.company(k);
        const cMap = { roofing: '--rust', drafting: '--green', lumen: '--blue' };
        ensure(k, c ? c.label : 'No company', colorVar(cMap[k] || '--ink-3'), Object.keys(App.COMPANIES).indexOf(k)).items.push(t);
      } else if (groupBy === 'priority') {
        const k = t.priority || 'medium';
        const p = App.PRIORITIES[k] || App.PRIORITIES.medium;
        ensure(k, p.label, colorVar(`--u-${k}`), p.order).items.push(t);
      } else if (groupBy === 'type') {
        const k = t.type || 'admin';
        const ty = App.TASK_TYPES[k] || App.TASK_TYPES.admin;
        ensure(k, ty.label, colorVar(`--type-${k}`), Object.keys(App.TASK_TYPES).indexOf(k)).items.push(t);
      } else {
        ensure('all', 'All tasks', colorVar('--amber'), 0).items.push(t);
      }
    });

    const cmp = this._comparator(sortBy, sortDir);
    const out = [...buckets.values()].sort((a, b) => a.order - b.order);
    out.forEach(b => b.items.sort(cmp));
    return out;
  }

  _comparator(sortBy, sortDir) {
    const dir = sortDir === 'desc' ? -1 : 1;
    const prioOrd = (t) => (App.PRIORITIES[t.priority] || App.PRIORITIES.medium).order;
    const statusOrd = (t) => Object.keys(App.STATUSES).indexOf(t.status || 'todo');
    const assigneeName = (t) => (App.directory.person(t.assignee) && App.directory.person(t.assignee).name) || t.assignee || '';
    const dueKey = (t) => t.due || '9999-12-31';
    return (a, b) => {
      let c = 0;
      if (sortBy === 'priority') c = prioOrd(a) - prioOrd(b);
      else if (sortBy === 'due')      c = dueKey(a).localeCompare(dueKey(b));
      else if (sortBy === 'title')    c = (a.title || '').localeCompare(b.title || '');
      else if (sortBy === 'assignee') c = assigneeName(a).localeCompare(assigneeName(b));
      else if (sortBy === 'status')   c = statusOrd(a) - statusOrd(b);
      else if (sortBy === 'created')  c = (a.id || '').localeCompare(b.id || '');
      else if (sortBy === 'manual') {
        // Manual (drag) order: ascending by focusSeq; unpositioned rows sort last.
        const av = a.focusSeq == null ? Infinity : a.focusSeq;
        const bv = b.focusSeq == null ? Infinity : b.focusSeq;
        c = av - bv;
      }
      // Stable tiebreaker by due
      if (c === 0) c = dueKey(a).localeCompare(dueKey(b));
      return c * dir;
    };
  }

  groupByDue(tasks) {
    const groups = { overdue: [], today: [], tomorrow: [], thisWeek: [], later: [], done: [] };
    const t0 = App.utils.todayISO(0);
    const t1 = App.utils.todayISO(1);
    const t7 = App.utils.todayISO(7);
    tasks.forEach(t => {
      if (App.taxonomy.isDone(t)) groups.done.push(t);
      else if (t.due < t0) groups.overdue.push(t);
      else if (t.due === t0) groups.today.push(t);
      else if (t.due === t1) groups.tomorrow.push(t);
      else if (t.due <= t7) groups.thisWeek.push(t);
      else groups.later.push(t);
    });
    Object.keys(groups).forEach(k => {
      groups[k].sort((a, b) => {
        const aOrd = (App.PRIORITIES[a.priority] || App.PRIORITIES.medium).order;
        const bOrd = (App.PRIORITIES[b.priority] || App.PRIORITIES.medium).order;
        return aOrd - bOrd || a.due.localeCompare(b.due);
      });
    });
    return groups;
  }

  /* ---------- mutations ---------- */
  add(task) {
    this.tasks.unshift(task);
    this._markDirty(task.id);
    App.EventBus.emit('tasks:changed');
  }

  remove(id) {
    const i = this.tasks.findIndex(t => t.id === id);
    if (i === -1) return false;
    this.tasks.splice(i, 1);
    this._dirty.delete(id);
    App.EventBus.emit('tasks:changed');
    return true;
  }

  update(id, updates) {
    const t = this.find(id);
    if (!t) return;
    Object.assign(t, updates);
    this._markDirty(id);
    App.EventBus.emit('tasks:changed');
  }

  toggleDone(id, userName) {
    const t = this.find(id);
    if (!t) return;
    const becomingDone = !App.taxonomy.isDone(t);
    t.status = becomingDone
      ? App.taxonomy.doneStatus(t.company, t.type)
      : App.taxonomy.defaultStatus(t.company, t.type);
    // Persisted completion timestamp (column completed_at) powers Reports history.
    if (becomingDone) t.completedAt = new Date().toISOString();
    else delete t.completedAt;
    this.pushActivity(t, userName, becomingDone ? 'marked this complete' : 'reopened this task');
    this._markDirty(id);
    App.EventBus.emit('tasks:changed');
    return { becomingDone };
  }

  /* Soft-clear every currently-done task. The rows stay in Supabase for the
     30-day grace window so a misclick is recoverable via a SQL update —
     after that, boot-time `purgeExpiredClearedTasks` deletes them for good.
     Returns the count of tasks cleared (0 if there were none).  */
  clearDoneTasks(userName) {
    const now = new Date().toISOString();
    const done = this.tasks.filter(t => App.taxonomy.isDone(t) && !t.clearedAt);
    if (!done.length) return 0;
    done.forEach(t => {
      t.clearedAt = now;
      this.pushActivity(t, userName, 'cleared from the Done list');
      this._markDirty(t.id);
    });
    App.EventBus.emit('tasks:changed');
    return done.length;
  }

  cyclePriority(id, userName) {
    const t = this.find(id);
    if (!t) return;
    const keys = Object.keys(App.PRIORITIES);
    const i = keys.indexOf(t.priority || 'medium');
    t.priority = keys[(i + 1) % keys.length];
    this.pushActivity(t, userName, `set priority to ${App.PRIORITIES[t.priority].label}`);
    this._markDirty(id);
    App.EventBus.emit('tasks:changed');
  }

  reassign(id, newAssignee, userName) {
    const t = this.find(id);
    if (!t || t.assignee === newAssignee) return null;
    const oldAssignee = t.assignee;
    t.assignee = newAssignee;
    this.pushActivity(t, userName, `reassigned this from ${App.directory.person(oldAssignee).name} to ${App.directory.person(newAssignee).name}`);
    this._markDirty(id);
    App.EventBus.emit('tasks:changed');
    return { oldAssignee, newAssignee };
  }

  // activityText (optional) lets the caller log a specific entry
  // ("changed status Working on it → Stuck") instead of the generic fallback.
  setField(id, field, value, userName, activityText) {
    const t = this.find(id);
    if (!t) return;
    t[field] = value;
    this.pushActivity(t, userName, activityText || `changed ${field}`);
    this._markDirty(id);
    App.EventBus.emit('tasks:changed');
  }

  /* ---------- Focus list (execution order) ---------- */
  // Add a task to the shared Focus list at the bottom. focusSeq is a float
  // sort-key; appending = one past the current max (across ALL focus tasks, not
  // per-assignee) so the existing order is kept.
  addToFocus(id) {
    const t = this.find(id);
    if (!t) return;
    const peers = this.tasks.filter(x => x.focusSeq != null && x.id !== id);
    const max = peers.reduce((m, x) => Math.max(m, x.focusSeq), -Infinity);
    t.focusSeq = (max === -Infinity) ? 0 : max + 1;
    this._markDirty(id);
    App.EventBus.emit('tasks:changed');
  }

  removeFromFocus(id) {
    const t = this.find(id);
    if (!t || t.focusSeq == null) return;
    t.focusSeq = null;
    this._markDirty(id);
    App.EventBus.emit('tasks:changed');
  }

  // Set an explicit float position (drag-to-reorder computes a midpoint).
  setFocusOrder(id, newSeq) {
    const t = this.find(id);
    if (!t) return;
    t.focusSeq = newSeq;
    this._markDirty(id);
    App.EventBus.emit('tasks:changed');
  }

  toggleSubtask(taskId, idx) {
    const t = this.find(taskId);
    if (!t || !t.subtasks || !t.subtasks[idx]) return;
    t.subtasks[idx].d = !t.subtasks[idx].d;
    this._markDirty(taskId);
    App.EventBus.emit('tasks:changed');
  }

  pushActivity(task, who, what) {
    task.activity = task.activity || [];
    // `at` is a real timestamp so the detail view can show elapsed time
    // ("2m ago") instead of a frozen "just now". `when` kept for any legacy
    // reader that still expects the label.
    task.activity.unshift({ who, what, at: new Date().toISOString(), when: 'just now' });
  }

  addActivity(taskId, entry) {
    const t = this.find(taskId);
    if (!t) return;
    t.activity = t.activity || [];
    // Stamp a timestamp if the caller didn't supply one, so relative time works.
    if (!entry.at) entry.at = new Date().toISOString();
    t.activity.unshift(entry);
    this._markDirty(taskId);
    App.EventBus.emit('tasks:changed');
  }
};
