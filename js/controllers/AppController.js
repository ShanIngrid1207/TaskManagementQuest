window.App = window.App || {};

// Normalize a user-set reminder to "YYYY-MM-DDTHH:MM" (datetime-local shape) or
// null to clear. Anything not matching that shape is treated as cleared. Used by
// both createTask and updateTask so create and edit treat reminderAt identically.
function normalizeReminderAt(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value || '')
    ? String(value).slice(0, 16)
    : null;
}

/* AppController — orchestrates everything.
   - Owns UI state (selected task, current view, search query).
   - Receives commands from views, calls model methods.
   - Cross-model coordination (e.g. stopping a timer adds task activity) lives here. */
App.AppController = class AppController {
  constructor({ taskModel, timeModel, notifModel, currentUser, dataStore }) {
    this.taskModel = taskModel;
    this.timeModel = timeModel;
    this.notifModel = notifModel;
    this.currentUser = currentUser;
    this.dataStore = dataStore;

    /* Comment threads live here, NOT on the task rows — a task row is replaced
       wholesale by the 30s sync poll, which used to shear the open thread off
       mid-typing and make every idle poll look like a change. See CommentStore. */
    this.comments = new App.CommentStore({
      load: (dataStore && dataStore.loadComments) ? (id) => dataStore.loadComments(id) : null,
    });

    this.uiState = {
      view: App.can('tasks.view') ? 'all' : 'time:mine',
      // Scope segment ("My work" / "Company"): an orthogonal narrowing applied
      // on top of whatever task view is active, so Urgent/Today/etc. can flip
      // between the viewer's own slice and the whole company's in place.
      scope: 'all',
      searchQuery: '',
      selectedTaskId: null,
      // Transient: true while the full-page New task form is open. Not a real
      // `view` (so it isn't persisted, sidebar-listed, or canView-gated) — it
      // drives #newTaskWrap the way selectedTaskId drives the detail page.
      creatingTask: false,
      layout: 'table',
      // Calendar view state: 'month' | 'week', and the focused anchor date
      // (ISO; null → today at render time).
      calendarMode: 'month',
      calendarAnchor: null,
      calendarSelectedDay: null,
      filters: { assignees: [], companies: [], statuses: [], priorities: [], types: [], projects: [], labels: [], dueRange: 'all' },
      filtersOpen: false,
      sortBy: 'manual',
      sortDir: 'asc',
      groupBy: 'type',
      collapsedGroups: new Set(),
      // Show completed tasks in the manual-order list (default off — the drag
      // list is live work only; toggle reveals done without leaving the view).
      showCompleted: false,
      // Bulk-select mode: when on, list rows toggle selection instead of
      // opening the detail pane, and BulkActionsView shows a bottom action bar.
      bulkMode: false,
      bulkSelected: new Set(),
      // Company scoping: the companies this user may access, and the one
      // currently in focus. Populated by initCompanyContext().
      currentCompany: null,
      companies: [],
    };

    // Views are attached after construction by app.js
    this.toastView = null;
    this.newTaskPage = null;

    // Visible-tasks memo (see getVisibleTasks). Parameter changes are caught by
    // the fingerprint key; task-DATA changes invalidate here — tasks:changed is
    // the single mutation signal every TaskModel write emits.
    this._visibleCache = { key: null, value: null };
    App.EventBus.on('tasks:changed', () => { this._visibleCache.key = null; });

    // Undo: a capped stack of reversible field-changes. Each entry is one user
    // action (a single inline edit, or a whole drag grouped via undoable()).
    // Ctrl+Z pops the last and restores it. Deletes keep their own toast-undo.
    this._undoStack = [];
    this._undoTxn = null;   // active transaction (set inside undoable())
    this._undoing = false;  // guard so restoring doesn't capture itself
  }

  attachViews({ toastView, newTaskPage, profileView, reportProblemView, newFolderView, textPromptView, chatDrawerView }) {
    this.toastView = toastView;
    this.newTaskPage = newTaskPage;
    this.profileView = profileView;
    this.reportProblemView = reportProblemView;
    this.newFolderView = newFolderView;
    this.textPromptView = textPromptView;
    this.chatDrawerView = chatDrawerView;
  }

  openProfile() {
    if (this.profileView) this.profileView.open();
  }

  openReportProblem() {
    if (this.reportProblemView) this.reportProblemView.open();
  }

  toggleChat() { if (this.chatDrawerView) this.chatDrawerView.toggle(); }

  /* ---------- helpers ---------- */
  getTask(id) { return this.taskModel.find(id); }
  getUserName(userId) { return App.directory.person(userId) ? App.directory.person(userId).name : userId; }
  can(permission) { return App.can(permission); }

  // The tasks this user may see right now (active company + role row-scope),
  // mirroring the SidebarView counts so Home/Reports match the rest of the app.
  // includeDone=false drops completed tasks; the clock-shift task is excluded.
  visibleTasks({ includeDone = true } = {}) {
    const role = App.effectiveRole();
    const cur = this.uiState.currentCompany;
    const me = (App.currentProfile && App.currentProfile.member_id) || this.currentUser;
    const clockId = App.DEFAULT_CLOCK_TASK_ID;
    let base = this.taskModel.all().filter(t => !t.clearedAt && t.id !== clockId);
    if (!includeDone) base = base.filter(t => !App.taxonomy.isDone(t));
    if (cur && cur !== '*') base = base.filter(t => App.utils.taskInCompany(t, cur));
    if (role === 'worker') {
      base = base.filter(t => App.utils.isAssignee(t, this.currentUser) || t.creator === this.currentUser);
    } else if (role === 'supervisor' && App.realRole() !== 'developer') {
      const reports = new Set((App.PROFILES || [])
        .filter(p => p.supervisor_id === me).map(p => p.member_id));
      base = base.filter(t =>
        App.utils.isAssignee(t, this.currentUser) ||
        t.creator === this.currentUser ||
        App.utils.taskAssignees(t).some(id => reports.has(id)));
    }
    return base;
  }

  canView(view) {
    if (view === 'home') return App.can('home.view');
    if (view === 'wallboard') return App.can('home.view');
    if (view === 'reports') return App.can('reports.view');
    if (view === 'approvals') return App.can('roles.manage');
    if (view === 'admin:clock') return App.can('clock.admin');
    if (view === 'admin:task-setup') return App.can('task-setup.manage');
    if (view === 'admin:checkins') return App.can('checkins.manage');
    if (view === 'admin:permissions') return App.can('roles.manage');
    if (view === 'admin:reports') return App.can('bug-reports.manage');
    if (view === 'team:hierarchy') return App.can('team.view');
    if (view === 'time:mine') return App.can('time.own') || App.can('clock.use');
    if (view === 'time:analytics') return false; // Reports view retired
    if (view === 'time:resource') return App.can('time.team');
    return App.can('tasks.view');
  }

  /* ---------- company context ---------- */
  // Determine which companies this user can access and pick the active one.
  // Developers bypass scoping entirely (every company). Everyone else is
  // confined to their profiles.company_ids. Mirrors migration 028 RLS.
  initCompanyContext() {
    // Company access follows the real account (a developer keeps all-company
    // access even while previewing another role).
    const role = App.realRole();
    const all = Object.keys(App.COMPANIES || {});
    let companies;
    let fallback;
    if (role === 'developer') {
      // Developers get an "All companies" sentinel ('*') across every company,
      // and default to it. '*' means no company filter (god mode).
      companies = ['*'].concat(all);
      fallback = '*';
    } else {
      const assigned = (App.currentProfile && App.currentProfile.company_ids) || [];
      const mine = all.filter(id => assigned.includes(id));
      // Anyone who spans more than one company also gets an "All companies"
      // option. For them '*' isn't god mode — it just drops the company filter,
      // so they see every company they can access (still RLS-scoped to those).
      // Multi-company users default to "All companies" so they land on
      // everything they can access; single-company users default to that one.
      companies = mine.length > 1 ? ['*'].concat(mine) : mine;
      fallback = mine.length > 1 ? '*' : (mine[0] || null);
    }
    this.uiState.companies = companies;

    let current = null;
    try {
      const stored = localStorage.getItem(this._companyKey());
      if (stored && companies.includes(stored)) current = stored;
    } catch (e) { /* localStorage unavailable */ }
    if (!current) current = fallback;
    this.uiState.currentCompany = current;
  }

  _companyKey() {
    const uid = (App.currentProfile && App.currentProfile.id) || 'anon';
    return `questhq:current-company:${uid}`;
  }

  // Developer-only: preview the app as another role (worker/supervisor/admin),
  // or pass 'developer'/null to return to full god mode. Re-gates every
  // permission-dependent surface and re-renders.
  setViewAs(role) {
    if (App.realRole() !== 'developer') return;
    const next = (!role || role === 'developer') ? null : role;
    if (App.viewAsRole === next) return;
    App.viewAsRole = next;

    // Reflect the effective role on <body> for CSS (column hiding etc.).
    const eff = App.effectiveRole();
    document.body.className = document.body.className.replace(/\brole-\S+/g, '').trim();
    document.body.classList.add('role-' + eff);
    document.body.classList.toggle('viewing-as-role', !!next);

    // The current view may no longer be permitted under the previewed role.
    if (!this.canView(this.uiState.view)) {
      this.uiState.view = App.can('tasks.view') ? 'all' : 'time:mine';
      this._togglePanes();
    }
    if (App.applyRoleChrome) App.applyRoleChrome(this);

    this.uiState.selectedTaskId = null;
    App.EventBus.emit('role:changed', eff);
    App.EventBus.emit('view:changed', this.uiState.view);
    App.EventBus.emit('selection:changed');
    this._syncRoute();
  }

  setCompany(id) {
    if (!this.uiState.companies.includes(id)) return;
    if (this.uiState.currentCompany === id) return;
    this.uiState.currentCompany = id;
    try { localStorage.setItem(this._companyKey(), id); } catch (e) { /* ignore */ }
    this.uiState.selectedTaskId = null;
    App.EventBus.emit('company:changed', id);
    // Reuse the existing re-render path so every list/sidebar refreshes.
    App.EventBus.emit('view:changed', this.uiState.view);
    App.EventBus.emit('selection:changed');
    this._syncRoute();
  }

  /* ---------- UI state ---------- */
  setView(view) {
    if (!this.canView(view)) {
      if (this.toastView) this.toastView.show({ title: 'No access', sub: 'Your role cannot open that view.' });
      return;
    }
    // Navigating anywhere must escape the full-page New-task form. Without this,
    // the top-nav/logo clicks changed the view underneath while the form stayed
    // covering it — the "I want to go home, I can't go home" dead end.
    if (this.uiState.creatingTask) this.closeNewTaskPage();
    if (this.uiState.view === view) return;
    const patch = { view, selectedTaskId: null };
    // All Tasks always OPENS in table view, whatever mode it was left in.
    // Explicit switches after entry (View menu, openCalendarOn) still apply.
    if (view === 'all' && this.uiState.layout !== 'table') patch.layout = 'table';
    // Focus is a shared cross-person list reached via the widget / Sort menu,
    // not tied to any view — so switching views exits Execution-order back to a
    // normal sort. The diff emits sort:changed only when this actually fires.
    if (this.uiState.sortBy === 'focus') patch.sortBy = 'priority';
    // onApply: panes must be visible before view:changed lands — several views
    // gate their render on !wrap.classList.contains('hidden').
    this._commit(patch, { onApply: () => this._togglePanes() });
  }

  // The head-card "My work" / "Company" segment. Unlike setView this never
  // navigates — it narrows the current task view to the viewer's own tasks.
  setScope(scope) {
    if (scope !== 'mine' && scope !== 'all') return;
    this._commit({ scope });
  }

  /* The Panze re-skin (Home + All Tasks only) is gated by a body class so its
     CSS never leaks into Reports / People / detail panels. Toggled from
     _togglePanes() so it also runs on the initial boot / role-change paths,
     not only on user-driven view changes. */
  _applyPanseSkin() {
    const v = this.uiState.view;
    document.body.classList.toggle('panze-home', v === 'home');
    document.body.classList.toggle('panze-tasks', v === 'all');
  }

  /* ---------- last-state persistence ----------
     Persist the lightweight "where was I" UI state (current view + layout) so
     that force-closing and reopening the app restores the last screen instead
     of always dropping the user back on the default All-tasks table. Kept tiny
     and versioned so a future shape change is ignored rather than crashing on
     a stale blob written by an older app version (data-integrity-on-update). */
  _uiStateKey() {
    const uid = (App.currentProfile && App.currentProfile.id) || 'anon';
    return `questhq:ui-state:${uid}`;
  }

  _persistUiState() {
    try {
      localStorage.setItem(this._uiStateKey(), JSON.stringify({
        // v3 (2026-07-28): group-by-Type + the new 'manual' drag sort are the
        // standing defaults. Bumping the version discards older blobs once so
        // existing users pick up the new defaults — in particular the v2 blobs
        // that got stuck on sortBy:'priority' from the old focus-reset bug.
        v: 3,
        view: this.uiState.view,
        scope: this.uiState.scope,
        layout: this.uiState.layout,
        calendarMode: this.uiState.calendarMode,
        sortBy: this.uiState.sortBy,
        sortDir: this.uiState.sortDir,
        groupBy: this.uiState.groupBy,
        showCompleted: this.uiState.showCompleted,
        filters: this.uiState.filters,
      }));
    } catch (e) { /* localStorage unavailable / quota — last-state is best-effort */ }
  }

  // Called once from app.js after all views are wired. Re-checks canView so a
  // view the user could open last session but not now (role change) falls back
  // to the default instead of opening a forbidden screen.
  restoreUiState() {
    // Deliberately bypasses _commit: this is a silent bulk restore that runs
    // before views first render — nothing may emit or route-sync here.
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(this._uiStateKey()) || 'null'); }
    catch (e) { saved = null; }
    if (!saved || saved.v !== 3) return;
    // The layout is deliberately NOT restored: All Tasks must always open in
    // table view (2026-07-04 walkthrough), whatever mode last session ended in.
    // Deep links (#/tasks/kanban) and saved views still set it explicitly.
    if (saved.calendarMode === 'month' || saved.calendarMode === 'week') this.uiState.calendarMode = saved.calendarMode;
    // Restore sort / group / filters so the user's working set survives a reload
    // (the "filters reset every session" complaint). Validated + merged with
    // defaults so a malformed/old entry can't corrupt uiState.
    if (saved.sortBy && App.SORT_OPTIONS[saved.sortBy]) this.uiState.sortBy = saved.sortBy;
    if (saved.sortDir === 'asc' || saved.sortDir === 'desc') this.uiState.sortDir = saved.sortDir;
    if (saved.groupBy && App.GROUP_OPTIONS[saved.groupBy]) this.uiState.groupBy = saved.groupBy;
    if (typeof saved.showCompleted === 'boolean') this.uiState.showCompleted = saved.showCompleted;
    if (saved.filters && typeof saved.filters === 'object') {
      const d = { assignees: [], companies: [], statuses: [], priorities: [], types: [], projects: [], labels: [], dueRange: 'all' };
      for (const k of ['assignees', 'companies', 'statuses', 'priorities', 'types', 'projects', 'labels']) {
        if (Array.isArray(saved.filters[k])) d[k] = saved.filters[k];
      }
      if (typeof saved.filters.dueRange === 'string') d.dueRange = saved.filters.dueRange;
      this.uiState.filters = d;
    }
    if (saved.scope === 'mine' || saved.scope === 'all') this.uiState.scope = saved.scope;
    // Don't restore transient person:/company: filters. Re-opening onto a narrow
    // filtered view that happens to be empty reads as "my tasks vanished" (a real
    // support issue). Only stable workspace views are remembered; narrow filters
    // reset to the default All list on reload.
    const isNarrowFilter = saved.view && (saved.view.startsWith('person:') || saved.view.startsWith('company:'));
    // 'mine' stopped being a navigable view when the scope segment became an
    // in-place filter — carry an old session's My-tasks view over as All+mine.
    const savedView = saved.view === 'mine' ? 'all' : saved.view;
    if (saved.view === 'mine') this.uiState.scope = 'mine';
    if (typeof savedView === 'string' && !isNarrowFilter && this.canView(savedView)) this.setView(savedView);
  }

  /* ---------- browser history (hash routes) ----------
     Every navigation-level change (view, task detail, folder, calendar day,
     new-task page, list layout) maps to a `#/...` hash route so the browser /
     mouse back-forward buttons walk the user's real path, and any route
     survives a refresh (deep-link safe). Supabase auth fragments
     (#access_token=…, #type=recovery) never start with `#/`, so they pass
     through untouched.

     Sync model: mutators call _syncRoute(), which debounces to one pushState
     per tick (a compound move like openCalendarOn = one history entry, no
     phantom intermediate stops). popstate/hashchange re-apply the URL to state
     under the _routing guard so application never pushes; in-app closes push a
     new entry forward, so back/forward and in-app actions share one stack. */
  _routeFromState() {
    const ui = this.uiState;
    const enc = encodeURIComponent;
    if (ui.creatingTask) return '#/new';
    if (ui.selectedTaskId != null) return '#/task/' + enc(String(ui.selectedTaskId));
    if (ui.view === 'all') {
      if (ui.filters && ui.filters.projectId) return '#/folder/' + enc(String(ui.filters.projectId));
      // Execution order is the 'focus' sort over the table layout (not a layout
      // value — see FocusWidgetView / TaskListView), so it rides sortBy here.
      if (ui.sortBy === 'focus') return '#/tasks/execution';
      if (ui.layout === 'calendar') {
        return ui.calendarSelectedDay
          ? '#/tasks/calendar/' + enc(ui.calendarSelectedDay)
          : '#/tasks/calendar';
      }
      return ui.layout === 'table' ? '#/tasks' : '#/tasks/' + enc(ui.layout);
    }
    if (ui.view === 'home') return '#/home';
    return '#/view/' + enc(ui.view);
  }

  // Debounced push: state can change several times in one tick (setView +
  // setLayout + calendar day); only the settled route becomes a history entry.
  _syncRoute() {
    if (!this._historyReady || this._routing) return;
    if (this._routeTimer) return;
    this._routeTimer = window.setTimeout(() => {
      this._routeTimer = null;
      if (this._routing) return;
      const route = this._routeFromState();
      if (route === (window.location.hash || '')) return;
      try { window.history.pushState(null, '', route); } catch (e) { /* pushState throttled/unavailable */ }
    }, 0);
  }

  /* Apply a uiState patch through UiStatePolicy: diff against current state,
     assign only real changes, then persist / emit / route-sync exactly as the
     policy table dictates — one emit per event, only when a value changed.
     opts.onApply runs after the patch lands but before events fire (setView
     uses it for _togglePanes so listeners see the right pane visibility).
     Returns false (and does nothing) when the patch changes nothing. */
  _commit(patch, opts = {}) {
    const plan = App.uiStatePolicy.planCommit(this.uiState, patch);
    if (!plan.dirty) return false;
    Object.assign(this.uiState, plan.changed);
    if (opts.onApply) opts.onApply();
    if (plan.persist) this._persistUiState();
    plan.events.forEach(ev => App.EventBus.emit(ev.name, ev.payload));
    if (plan.route) this._syncRoute();
    return true;
  }

  _parseHashParts(hash) {
    if (!hash || !hash.startsWith('#/')) return null;
    return hash.slice(2).split('/').map(s => {
      try { return decodeURIComponent(s); } catch (e) { return s; }
    });
  }

  // Apply a `#/...` hash to uiState through the normal mutators (so panes,
  // events, and persistence all behave), without pushing new entries.
  _applyRoute(hash) {
    const parts = this._parseHashParts(hash);
    if (!parts) return;
    this._routing = true;
    try {
      const [head, a, b] = parts;
      if (head !== 'new' && this.uiState.creatingTask) this.closeNewTaskPage();
      if (head === 'new') {
        if (!this.uiState.creatingTask) this.openNewTaskPage();
      } else if (head === 'task' && a) {
        // Roles without a task surface (clock-only) can't open a detail page —
        // leave their state alone and let the canonicalize below fix the URL.
        const t = App.can('tasks.view') ? this.taskModel.find(a) : null;
        if (t) {
          // The detail page overlays task surfaces but not the Time screens.
          if (this.uiState.view.startsWith('time:')) this.setView('all');
          if (this.uiState.selectedTaskId !== a) {
            this.uiState.selectedTaskId = a;
            App.EventBus.emit('selection:changed');
          }
        } else if (App.can('tasks.view')) {
          if (this.uiState.selectedTaskId) this.closeDetail();
          this.setView('all');
          if (this.toastView) this.toastView.show({ title: 'Task not found', sub: 'It may have been deleted.' });
        }
      } else {
        if (this.uiState.selectedTaskId) this.closeDetail();
        if (head === 'folder' && a) {
          this.uiState.filters = this.uiState.filters || {};
          this.uiState.filters.projectId = a;
          // Drill-down clears the "My work" scope so the folder isn't narrowed to
          // the viewer's own tasks (mirrors openProject). Deep-link / refresh path.
          this.uiState.scope = 'all';
          this.setView('all');
          App.EventBus.emit('filters:changed');
          App.EventBus.emit('scope:changed');
        } else if (head === 'tasks') {
          if (this.uiState.filters) this.uiState.filters.projectId = null;
          this.setView('all');
          if (a === 'execution') {
            // Execution-order rides the 'focus' sort over the table layout
            // (mirrors FocusWidgetView), not a layout value. Guard the sort so a
            // re-applied identical hash doesn't toggle sortDir.
            this.setLayout('table');
            if (this.uiState.sortBy !== 'focus') this.setSortBy('focus');
          } else {
            // Leaving execution order back to a plain list drops the focus sort.
            if (this.uiState.sortBy === 'focus') this.setSortBy('priority');
            this.setLayout(['table', 'calendar', 'kanban', 'cards'].includes(a) ? a : 'table');
            if (a === 'calendar') {
              const iso = /^\d{4}-\d{2}-\d{2}$/.test(b || '') ? b : null;
              this.uiState.calendarAnchor = iso;
              this.uiState.calendarSelectedDay = iso;
              App.EventBus.emit('calendar:changed');
            }
          }
          App.EventBus.emit('filters:changed');
        } else if (head === 'home') {
          this.setView('home');
        } else if (head === 'view' && a) {
          this.setView(a);
        }
      }
    } finally {
      this._routing = false;
    }
    // Canonicalize in place (permission fallback, unknown route, encoding) —
    // rewrite the current entry rather than minting a new one.
    const canonical = this._routeFromState();
    if (canonical !== (window.location.hash || '')) {
      try { window.history.replaceState(null, '', canonical); } catch (e) { /* ignore */ }
    }
  }

  // Called once from app.js after data + views are ready and the last-session
  // state is restored. A `#/...` deep link in the URL wins over restored state.
  initHistory() {
    if (this._historyReady) return;
    this._historyReady = true;
    const onNav = () => {
      const h = window.location.hash || '';
      if (!h.startsWith('#/')) return;             // auth fragments, #mainPane skip-link
      if (h === this._routeFromState()) return;    // popstate+hashchange double-fire
      this._applyRoute(h);
    };
    window.addEventListener('popstate', onNav);
    window.addEventListener('hashchange', onNav);
    const h = window.location.hash || '';
    if (h.startsWith('#/')) this._applyRoute(h);
    else {
      try { window.history.replaceState(null, '', this._routeFromState()); } catch (e) { /* ignore */ }
    }
  }

  // Always-available Home escape hatch (topbar logo). Closes whatever
  // full-page surface is up first so it works from the new-task page and the
  // task detail too; falls back for roles that can't see Home.
  goHome() {
    if (this.uiState.creatingTask) this.closeNewTaskPage();
    if (this.uiState.selectedTaskId) this.closeDetail();
    if (this.canView('home')) this.setView('home');
    else this.setView(App.can('tasks.view') ? 'all' : 'time:mine');
  }

  setSearchQuery(q) {
    this._commit({ searchQuery: q });
  }

  setLayout(layout) {
    if (!['table', 'calendar', 'kanban', 'cards'].includes(layout)) return;
    this._commit({ layout });
  }

  /* ----- Calendar view controls ----- */
  setCalendarMode(mode) {
    if (mode !== 'month' && mode !== 'week') return;
    // Guard stays: without it, a same-mode call would still clear the selected
    // day via the cascade below.
    if (this.uiState.calendarMode === mode) return;
    this._commit({ calendarMode: mode, calendarSelectedDay: null });
  }

  // Move the calendar by ±1 month (month mode) or ±1 week (week mode). delta is
  // -1 / +1. `unit` overrides the step when needed.
  shiftCalendar(delta) {
    const base = this.uiState.calendarAnchor
      ? new Date(this.uiState.calendarAnchor + 'T00:00:00')
      : new Date();
    if (this.uiState.calendarMode === 'week') {
      base.setDate(base.getDate() + delta * 7);
    } else {
      base.setMonth(base.getMonth() + delta);
    }
    this._commit({ calendarAnchor: App.utils.toISODate(base), calendarSelectedDay: null });
  }

  resetCalendarToToday() {
    this._commit({ calendarAnchor: null, calendarSelectedDay: null });
  }

  selectCalendarDay(iso) {
    this._commit({
      calendarSelectedDay: this.uiState.calendarSelectedDay === iso ? null : iso,
    });
  }

  // Jump straight to the All-tasks Calendar, anchored + pre-selected on a date
  // (used by the Home mini-calendar). The calendar layout already renders from
  // calendarAnchor and lists the selected day's tasks.
  openCalendarOn(iso) {
    this._commit({ calendarAnchor: iso, calendarSelectedDay: iso });
    this.setView('all');
    this.setLayout('calendar');
  }

  /* ----- The filtered task set the list/calendar/export all share ----- */
  _reportMemberIds(role) {
    const me = (App.currentProfile && App.currentProfile.member_id) || this.currentUser;
    return (role === 'supervisor' && App.realRole() !== 'developer')
      ? new Set((App.PROFILES || []).filter(p => p.supervisor_id === me).map(p => p.member_id))
      : null;
  }

  getVisibleTasks() {
    const role = App.effectiveRole();
    const params = {
      view: this.uiState.view,
      scope: this.uiState.scope,
      searchQuery: this.uiState.searchQuery,
      currentUser: this.currentUser,
      activeFilters: this.uiState.filters,
      currentCompany: this.uiState.currentCompany,
      role,
      reportMemberIds: this._reportMemberIds(role),
    };
    // Fingerprint-keyed memo: every caller (list renders, badgeCounts, prev/next
    // task arrows, CSV export) shares one computation per state change instead
    // of re-filtering per call. Any parameter change flips the key; task-data
    // changes invalidate via the tasks:changed listener in the constructor.
    // Callers must NOT mutate the returned array in place (audited 2026-07-08:
    // none do — the execution list sorts a .filter() copy).
    const key = App.utils.fingerprint(params);
    if (this._visibleCache.key === key) return this._visibleCache.value;
    const value = this.taskModel.getFiltered(params);
    this._visibleCache = { key, value };
    return value;
  }

  /* Badge counts for the nav (top-bar Tasks dropdown + mobile drawer), computed
     through the SAME getFiltered pipeline the list views render from — company,
     role scope, "My work" segment, search query and filter-bar filters all
     included — so a badge is always EXACTLY the number of rows a click on that
     nav item shows ("All Tasks is empty but the badge says 7 urgent" reads as
     data loss). No extra done-filter here: getFiltered already excludes done
     rows for hot/today/overdue and includes them where the list renders them. */
  badgeCounts() {
    const role = App.effectiveRole();
    const reportMemberIds = this._reportMemberIds(role);
    const count = (view) => this.taskModel.getFiltered({
      view,
      scope: this.uiState.scope,
      searchQuery: this.uiState.searchQuery,
      currentUser: this.currentUser,
      activeFilters: this.uiState.filters,
      currentCompany: this.uiState.currentCompany,
      role,
      reportMemberIds,
    }).length;
    return {
      all: App.can('tasks.view') ? count('all') : 0,
      mine: count('mine'),
      hot: count('hot'),
      today: count('today'),
      overdue: count('overdue'),
      watching: count('watching'),
    };
  }

  /* How many tasks the current view would show if the transient narrowing
     (search box, "My work" scope, filter bar) were cleared. Drives the honest
     empty state: "0 because nothing exists" is a different situation from
     "0 because your search hides them" — the latter must say so, or a full
     list reads as wiped data. */
  hiddenByNarrowingCount() {
    if (this.getVisibleTasks().length > 0) return 0;
    const role = App.effectiveRole();
    return this.taskModel.getFiltered({
      view: this.uiState.view,
      scope: 'all',
      searchQuery: '',
      currentUser: this.currentUser,
      activeFilters: null,
      currentCompany: this.uiState.currentCompany,
      role,
      reportMemberIds: this._reportMemberIds(role),
    }).length;
  }

  /* One-click recovery from an all-hiding narrowing combo (used by the list
     empty state). Clears the filter bar, the My-work scope and the search box —
     the #searchInput element is app.html chrome (TopbarView only pushes edits
     from it, it never syncs back), so blank it here too. */
  clearNarrowing() {
    this.clearFilters();
    this.setScope('all');
    this.setSearchQuery('');
    const box = document.getElementById('searchInput');
    if (box) box.value = '';
  }

  /* ----- CSV export (respects current view + filters) -----
     Row assembly lives in App.csvExport (unit-tested); this keeps only the
     app-side concerns: which tasks are visible, the download, the toast. */
  exportTasksCsv() {
    const tasks = this.getVisibleTasks();
    App.utils.downloadFile(`quest-hq-tasks-${App.utils.todayISO(0)}.csv`, App.utils.toCsv(App.csvExport.tasksRows(tasks)));
    if (this.toastView) this.toastView.show({ title: 'Exported', sub: `${tasks.length} task${tasks.length === 1 ? '' : 's'} → CSV` });
  }

  exportTimeCsv() {
    const tasks = this.getVisibleTasks();
    const rows = App.csvExport.timeRows(tasks, this.timeModel.entries || []);
    App.utils.downloadFile(`quest-hq-time-${App.utils.todayISO(0)}.csv`, App.utils.toCsv(rows));
    const n = rows.length - 1;
    if (this.toastView) this.toastView.show({ title: 'Exported', sub: `${n} time ${n === 1 ? 'entry' : 'entries'} → CSV` });
  }

  selectTask(id) {
    this._commit({ selectedTaskId: (this.uiState.selectedTaskId === id) ? null : id });
  }

  // Keyboard j/k navigation: move the selection to the next/prev task in the
  // currently-visible (filtered + sorted) order, opening its detail. Wraps at
  // the ends. No-op when there are no visible tasks.
  selectAdjacentTask(delta) {
    const tasks = this.getVisibleTasks();
    if (!tasks.length) return;
    const ids = tasks.map(t => t.id);
    const cur = ids.indexOf(this.uiState.selectedTaskId);
    let next;
    if (cur === -1) next = delta > 0 ? 0 : ids.length - 1;
    else next = (cur + delta + ids.length) % ids.length;
    const id = ids[next];
    this._commit({ selectedTaskId: id });
    // Bring the row into view if it scrolled off.
    const safe = (window.CSS && CSS.escape) ? CSS.escape(String(id)) : String(id);
    const el = document.querySelector(`#listBody [data-id="${safe}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  closeDetail() {
    this._commit({ selectedTaskId: null });
  }

  /* ---------- comments (migration 053) ---------- */
  // Recent comments across visible tasks — powers Home's "Comments & mentions"
  // feed. Cached for 60s so Home re-renders don't re-query; errors degrade to
  // an empty feed (e.g. the table not existing yet) instead of breaking Home.
  async loadRecentComments() {
    const now = Date.now();
    if (this._recentComments && now - this._recentCommentsAt < 60000) return this._recentComments;
    try {
      this._recentComments = this.dataStore.loadRecentComments
        ? await this.dataStore.loadRecentComments(40)
        : [];
    } catch (e) {
      console.warn('[comments] recent load failed:', e);
      this._recentComments = this._recentComments || [];
    }
    this._recentCommentsAt = now;
    return this._recentComments;
  }

  // Lazy-load a task's thread, then re-render the detail. The store handles
  // load-once and in-flight dedupe, so a burst of renders costs one round trip.
  async loadTaskComments(taskId) {
    if (this.comments.isLoaded(taskId)) return;
    await this.comments.ensureLoaded(taskId);
    App.EventBus.emit('comments:changed', taskId);
  }

  /* Keep the thread the user is currently looking at up to date with everyone
     else's. Called from the same 30s sync poll that refreshes tasks; only the
     open thread is worth a query, and it re-renders ONLY when the rows really
     changed — a quiet thread must never disturb someone typing into it. */
  async refreshOpenThread() {
    const taskId = this.uiState.selectedTaskId;
    if (!taskId) return false;
    const changed = await this.comments.refresh(taskId);
    if (changed) App.EventBus.emit('comments:changed', taskId);
    return changed;
  }

  async addTaskComment(taskId, body, mentions, kind) {
    if (!App.can('tasks.write') && !App.can('tasks.comment')) { /* fall through: comment allowed for any viewer of the task */ }
    const text = App.utils.upper(String(body || '').trim());
    if (!text) return;
    const t = this.taskModel.find(taskId);
    if (!t) return;
    const k = ['comment', 'note', 'call'].includes(kind) ? kind : 'comment';
    let saved;
    try {
      saved = await this.dataStore.addComment(taskId, { body: text, mentions: mentions || [], kind: k });
    } catch (e) {
      console.error('[comments] add failed:', e);
      if (this.toastView) this.toastView.show({ title: 'Comment not saved', sub: 'Please try again.' });
      return;
    }
    this.comments.append(taskId, saved);
    this._notifyComment(t, text, mentions || []);
    App.EventBus.emit('comments:changed', taskId);
  }

  // In-app notify mentioned users + the task's participants (assignee/creator/
  // watchers), except the comment's author. Mentions get a distinct label.
  _notifyComment(task, text, mentions) {
    const me = this.currentUser;
    const mentionSet = new Set((mentions || []).filter(Boolean));
    const ids = new Set();
    mentionSet.forEach(id => { if (id !== me) ids.add(id); });
    if (task.creator && task.creator !== me) ids.add(task.creator);
    if (task.assignee && task.assignee !== me) ids.add(task.assignee);
    (task.watchers || []).forEach(w => { if (w && w !== me) ids.add(w); });
    if (!ids.size) return;
    const whoEsc = App.utils.escapeHtml(this.getUserName(me));
    const titleEsc = App.utils.escapeHtml(task.title);
    const snippet = App.utils.escapeHtml(text.length > 80 ? text.slice(0, 77) + '…' : text);
    const inapp = Array.from(ids).map(memberId => ({
      memberId,
      taskId: task.id,
      meta: mentionSet.has(memberId) ? 'Mentioned you' : 'New comment',
      html: `<strong>${whoEsc}</strong> ${mentionSet.has(memberId) ? 'mentioned you' : 'commented'} on <em>${titleEsc}</em>: “${snippet}”`,
    }));
    this._deliver(inapp, [], null);
  }

  _togglePanes() {
    const v = this.uiState.view;
    // Full-page New task form takes over the whole work area: hide every other
    // surface (incl. the detail page, which is normally managed by TaskDetailView)
    // and show #newTaskWrap. Nothing else needs toggling while it's up.
    const newTaskWrap = document.getElementById('newTaskWrap');
    if (newTaskWrap) newTaskWrap.classList.toggle('hidden', !this.uiState.creatingTask);
    if (this.uiState.creatingTask) {
      ['listPane', 'homeWrap', 'reportsWrap', 'wallboardWrap', 'taskDetailWrap', 'timeViewWrap', 'projectsWrap'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
      });
      document.querySelectorAll('.work-toolbar, .head-card-actions, .page-head-widgets').forEach(el => el.classList.add('hidden'));
      return;
    }
    // Home / Reports are full-page surfaces in their own containers — hide the
    // entire list pane (table + toolbar + page head + ops brief) for them.
    const isPageView = v === 'home' || v === 'reports' || v === 'wallboard' || v === 'projects';
    const isTimeView = v.startsWith('time:') || v === 'approvals' || v === 'team:hierarchy' || v.startsWith('admin:');
    this._applyPanseSkin();
    const listPane = document.getElementById('listPane');
    if (listPane) listPane.classList.toggle('hidden', isPageView);
    const homeWrap = document.getElementById('homeWrap');
    const reportsWrap = document.getElementById('reportsWrap');
    if (homeWrap) homeWrap.classList.toggle('hidden', v !== 'home');
    if (reportsWrap) reportsWrap.classList.toggle('hidden', v !== 'reports');
    const projectsWrap = document.getElementById('projectsWrap');
    if (projectsWrap) projectsWrap.classList.toggle('hidden', v !== 'projects');
    const wallboardWrap = document.getElementById('wallboardWrap');
    if (wallboardWrap) wallboardWrap.classList.toggle('hidden', v !== 'wallboard');
    document.body.classList.toggle('wallboard-active', v === 'wallboard');

    document.getElementById('taskViewWrap').classList.toggle('hidden', isTimeView || isPageView);
    document.getElementById('timeViewWrap').classList.toggle('hidden', !isTimeView);
    // Hide the task-table chrome (toolbar buttons + Up next / progress cards +
    // the My work/Company scope toggle) for any non-task surface: Time,
    // Approvals, Hierarchy, Admin, AND the Watching view (which is now a
    // team-supervision dashboard, not a table).
    const hideChrome = isTimeView || v === 'watching';
    document.querySelectorAll('.work-toolbar, .head-card-actions, .page-head-widgets, #scopeSeg').forEach(el => {
      el.classList.toggle('hidden', hideChrome);
    });
    this._animateViewEnter(v);
  }

  /* Play the shared "settle" entrance on whichever top-level surface just
     became visible. Re-adds the class after a forced reflow so the animation
     restarts on every navigation, not just the first. No-op under reduced
     motion (the CSS also neutralises .view-enter, but skipping avoids touching
     the DOM at all). */
  _animateViewEnter(v) {
    if (App.Motion && App.Motion.reduce()) return;
    let id = 'taskViewWrap';
    if (v === 'home') id = 'homeWrap';
    else if (v === 'reports') id = 'reportsWrap';
    else if (v === 'projects') id = 'projectsWrap';
    else if (v === 'wallboard') id = 'wallboardWrap';
    else if (v.startsWith('time:') || v === 'approvals' || v === 'team:hierarchy' || v.startsWith('admin:')) id = 'timeViewWrap';
    const el = document.getElementById(id);
    if (!el || el.classList.contains('hidden')) return;
    el.classList.remove('view-enter');
    void el.offsetWidth; // reflow so re-adding the class restarts the animation
    el.classList.add('view-enter');
  }

  /* ---------- Task taxonomy admin (Settings → Task setup) ----------
     Each op re-fetches the raw rows (which carry the DB `id`s that App.taxonomy's
     stripped index doesn't) so it's self-contained, does its writes RLS-gated, then
     re-hydrates App.taxonomy — which re-applies the global constant maps and emits
     'taxonomy:changed'. Soft-delete = {active:false}. Reorder renumbers active
     siblings 0..n so it's robust even when seeded sort_order values tie. */
  _assertTaxonomyAllowed() {
    if (!App.can('task-setup.manage')) throw new Error('You do not have permission to edit task setup.');
  }
  _slugify(s) {
    return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  }
  _uniqueKey(base, existingKeys) {
    const root = this._slugify(base) || 'item';
    if (!existingKeys.includes(root)) return root;
    let n = 2;
    while (existingKeys.includes(`${root}_${n}`)) n++;
    return `${root}_${n}`;
  }
  async _reloadTaxonomy() {
    const raw = await this.dataStore.loadTaxonomy();
    App.taxonomy.hydrate(raw);          // re-applies globals + emits 'taxonomy:changed'
    App.EventBus.emit('tasks:changed'); // lists/counts recompute against the new labels
  }
  async _renumber(list, updateFn) {
    // list already in the desired order; write sequential sort_order to any that moved.
    for (let k = 0; k < list.length; k++) {
      if ((list[k].sort_order || 0) !== k) await updateFn(list[k].id, { sort_order: k });
    }
  }

  // --- Types ---
  async addType(company, label, color) {
    this._assertTaxonomyAllowed();
    const name = String(label || '').trim();
    if (!name) throw new Error('Type name is required.');
    const raw = await this.dataStore.loadTaxonomy();
    const mine = raw.types.filter(t => t.company_id === company);
    const key = this._uniqueKey(name, mine.map(t => t.key));
    const sort = mine.length ? Math.max(...mine.map(t => t.sort_order || 0)) + 1 : 0;
    await this.dataStore.createTaskType({ company_id: company, key, label: name, color: color || '#8f867b', sort_order: sort, active: true });
    // Seed a minimal usable pipeline so the invariants (>=1 status, one default, one done) hold at once.
    await this.dataStore.createTaskStatus({ company_id: company, type_key: key, key: 'todo', label: 'To do', color: '#8f867b', sort_order: 0, is_default: true, is_done: false, active: true });
    await this.dataStore.createTaskStatus({ company_id: company, type_key: key, key: 'done', label: 'Done', color: '#3f9d5a', sort_order: 1, is_default: false, is_done: true, active: true });
    await this._reloadTaxonomy();
  }
  async renameType(id, label) {
    this._assertTaxonomyAllowed();
    const name = String(label || '').trim();
    if (!name) throw new Error('Type name is required.');
    await this.dataStore.updateTaskType(id, { label: name });
    await this._reloadTaxonomy();
  }
  async recolorType(id, color) {
    this._assertTaxonomyAllowed();
    await this.dataStore.updateTaskType(id, { color });
    await this._reloadTaxonomy();
  }
  async removeType(id) {
    this._assertTaxonomyAllowed();
    const raw = await this.dataStore.loadTaxonomy();
    const row = raw.types.find(t => t.id === id);
    if (!row) return;
    const active = raw.types.filter(t => t.company_id === row.company_id && t.active !== false);
    if (active.length <= 1) throw new Error('Keep at least one task type.');
    await this.dataStore.updateTaskType(id, { active: false });
    await this._reloadTaxonomy();
  }
  async moveType(id, dir) {
    this._assertTaxonomyAllowed();
    const raw = await this.dataStore.loadTaxonomy();
    const row = raw.types.find(t => t.id === id);
    if (!row) return;
    const sibs = raw.types.filter(t => t.company_id === row.company_id && t.active !== false)
      .sort((a, b) => (a.sort_order - b.sort_order) || String(a.label).localeCompare(String(b.label)));
    const i = sibs.findIndex(t => t.id === id);
    const j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= sibs.length) return;
    [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
    await this._renumber(sibs, (rid, patch) => this.dataStore.updateTaskType(rid, patch));
    await this._reloadTaxonomy();
  }

  // --- Statuses (per type) ---
  async addStatus(company, typeKey, label, color) {
    this._assertTaxonomyAllowed();
    const name = String(label || '').trim();
    if (!name) throw new Error('Status name is required.');
    const raw = await this.dataStore.loadTaxonomy();
    const mine = raw.statuses.filter(s => s.company_id === company && s.type_key === typeKey);
    const key = this._uniqueKey(name, mine.map(s => s.key));
    const sort = mine.length ? Math.max(...mine.map(s => s.sort_order || 0)) + 1 : 0;
    await this.dataStore.createTaskStatus({ company_id: company, type_key: typeKey, key, label: name, color: color || '#8f867b', sort_order: sort, is_default: false, is_done: false, active: true });
    await this._reloadTaxonomy();
  }
  async renameStatus(id, label) {
    this._assertTaxonomyAllowed();
    const name = String(label || '').trim();
    if (!name) throw new Error('Status name is required.');
    await this.dataStore.updateTaskStatus(id, { label: name });
    await this._reloadTaxonomy();
  }
  async recolorStatus(id, color) {
    this._assertTaxonomyAllowed();
    await this.dataStore.updateTaskStatus(id, { color });
    await this._reloadTaxonomy();
  }
  async removeStatus(id) {
    this._assertTaxonomyAllowed();
    const raw = await this.dataStore.loadTaxonomy();
    const row = raw.statuses.find(s => s.id === id);
    if (!row) return;
    const sibs = raw.statuses.filter(s => s.company_id === row.company_id && s.type_key === row.type_key && s.active !== false);
    if (sibs.length <= 1) throw new Error('A type must keep at least one status.');
    if (row.is_done) throw new Error('Set another status as “done” before removing this one.');
    if (row.is_default) throw new Error('Set another status as the default before removing this one.');
    await this.dataStore.updateTaskStatus(id, { active: false });
    await this._reloadTaxonomy();
  }
  async moveStatus(id, dir) {
    this._assertTaxonomyAllowed();
    const raw = await this.dataStore.loadTaxonomy();
    const row = raw.statuses.find(s => s.id === id);
    if (!row) return;
    const sibs = raw.statuses.filter(s => s.company_id === row.company_id && s.type_key === row.type_key && s.active !== false)
      .sort((a, b) => (a.sort_order - b.sort_order) || String(a.label).localeCompare(String(b.label)));
    const i = sibs.findIndex(s => s.id === id);
    const j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= sibs.length) return;
    [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
    await this._renumber(sibs, (rid, patch) => this.dataStore.updateTaskStatus(rid, patch));
    await this._reloadTaxonomy();
  }
  async setDoneStatus(id) {
    this._assertTaxonomyAllowed();
    const raw = await this.dataStore.loadTaxonomy();
    const row = raw.statuses.find(s => s.id === id);
    if (!row) return;
    // Clear the current done first — the one-done partial unique index forbids two trues.
    const current = raw.statuses.find(s => s.company_id === row.company_id && s.type_key === row.type_key && s.is_done && s.id !== id);
    if (current) await this.dataStore.updateTaskStatus(current.id, { is_done: false });
    await this.dataStore.updateTaskStatus(id, { is_done: true });
    await this._reloadTaxonomy();
  }
  async setDefaultStatus(id) {
    this._assertTaxonomyAllowed();
    const raw = await this.dataStore.loadTaxonomy();
    const row = raw.statuses.find(s => s.id === id);
    if (!row) return;
    const current = raw.statuses.find(s => s.company_id === row.company_id && s.type_key === row.type_key && s.is_default && s.id !== id);
    if (current) await this.dataStore.updateTaskStatus(current.id, { is_default: false });
    await this.dataStore.updateTaskStatus(id, { is_default: true });
    await this._reloadTaxonomy();
  }

  // --- Labels ---
  async addLabel(company, label, color) {
    this._assertTaxonomyAllowed();
    const name = String(label || '').trim();
    if (!name) throw new Error('Label name is required.');
    const raw = await this.dataStore.loadTaxonomy();
    const mine = raw.labels.filter(l => l.company_id === company);
    const key = this._uniqueKey(name, mine.map(l => l.key));
    const sort = mine.length ? Math.max(...mine.map(l => l.sort_order || 0)) + 1 : 0;
    await this.dataStore.createTaskLabel({ company_id: company, key, label: name, color: color || '#8f867b', sort_order: sort, active: true });
    await this._reloadTaxonomy();
  }
  async renameLabel(id, label) {
    this._assertTaxonomyAllowed();
    const name = String(label || '').trim();
    if (!name) throw new Error('Label name is required.');
    await this.dataStore.updateTaskLabel(id, { label: name });
    await this._reloadTaxonomy();
  }
  async recolorLabel(id, color) {
    this._assertTaxonomyAllowed();
    await this.dataStore.updateTaskLabel(id, { color });
    await this._reloadTaxonomy();
  }
  async removeLabel(id) {
    this._assertTaxonomyAllowed();
    await this.dataStore.updateTaskLabel(id, { active: false });
    await this._reloadTaxonomy();
  }
  async moveLabel(id, dir) {
    this._assertTaxonomyAllowed();
    const raw = await this.dataStore.loadTaxonomy();
    const row = raw.labels.find(l => l.id === id);
    if (!row) return;
    const sibs = raw.labels.filter(l => l.company_id === row.company_id && l.active !== false)
      .sort((a, b) => (a.sort_order - b.sort_order) || String(a.label).localeCompare(String(b.label)));
    const i = sibs.findIndex(l => l.id === id);
    const j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= sibs.length) return;
    [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
    await this._renumber(sibs, (rid, patch) => this.dataStore.updateTaskLabel(rid, patch));
    await this._reloadTaxonomy();
  }

  /* ---------- task actions ---------- */
  toggleTaskDone(id) {
    if (!App.can('tasks.write')) return;
    const task = this.taskModel.find(id);
    const result = this.taskModel.toggleDone(id, this.getUserName(this.currentUser));
    if (!result || !task) return;
    if (result.becomingDone) {
      this._revertToGeneralShiftIfOnTask(id);
      this._notifyTaskChange(task, 'marked this complete');
    } else {
      this._notifyTaskChange(task, 'reopened this task');
    }
  }

  /* Same as toggleTaskDone but fires a celebratory toast when the task moves
     from any state → done (not when it's being re-opened). Used by the
     in-row "Finish" button. */
  completeTask(id) {
    if (!App.can('tasks.write')) return;
    const task = this.taskModel.find(id);
    if (!task) return;
    const result = this.taskModel.toggleDone(id, this.getUserName(this.currentUser));
    if (result && result.becomingDone) {
      this._revertToGeneralShiftIfOnTask(id);
      this._notifyTaskChange(task, 'marked this complete');
      this._celebrateCompletion(task);
    } else if (result) {
      this._notifyTaskChange(task, 'reopened this task');
    }
  }

  /* ---------- detail-page quick actions ---------- */

  // Clone a task into a new draft assigned to the current user. Reuses createTask
  // (RLS + persistence + select-the-new-task) so there's no separate insert path.
  // Watchers are dropped and subtasks reset to not-done so the copy starts clean;
  // assignee is the current user to avoid emailing the original assignee a "created"
  // notice for a copy they didn't ask for.
  duplicateTask(id) {
    if (!App.can('tasks.write')) {
      if (this.toastView) this.toastView.show({ title: 'No access', sub: 'Your role cannot create tasks.' });
      return;
    }
    const t = this.taskModel.find(id);
    if (!t) return;
    this.createTask({
      title: 'Copy of ' + (t.title || 'task'),
      description: t.description || '',
      type: t.type || 'admin',
      label: t.label || 'roof',
      company: t.company,
      due: t.due || App.utils.todayISO(1),
      dueTime: t.dueTime || null,
      reminderAt: null,
      priority: t.priority || 'medium',
      // Per-type taxonomy: the copy starts on its type's default status for this
      // company (a customized taxonomy may not have 'todo' for this type).
      status: App.taxonomy.defaultStatus(t.company, t.type || 'admin'),
      assignee: this.currentUser,
      watchers: [],
      subtasks: (t.subtasks || []).map(s => ({ t: s.t, d: false })),
      notify: { inapp: false, watchers: false, whatsapp: false },
      // History must show this was a duplication, not an original creation —
      // an unexplained copy is how the boss ended up with an accidental dupe.
      activityWhat: `duplicated this from "${t.title || 'task'}"`,
    });
  }

  // Add/remove the current user from a task's watcher list. Persists through the
  // same validated path the Edit form uses; returns the new watching state.
  toggleSelfWatch(id) {
    const t = this.taskModel.find(id);
    if (!t) return false;
    if (!App.can('tasks.write')) {
      if (this.toastView) this.toastView.show({ title: 'No access', sub: 'Your role cannot change this task.' });
      return (t.watchers || []).includes(this.currentUser);
    }
    const watchers = (t.watchers || []).slice();
    const i = watchers.indexOf(this.currentUser);
    const nowWatching = i === -1;
    if (nowWatching) watchers.push(this.currentUser);
    else watchers.splice(i, 1);
    const ok = this.updateTaskDetails(id, {
      title: t.title, description: t.description, company: t.company,
      type: t.type, label: t.label, status: t.status,
      assignee: t.assignee, due: t.due, dueTime: t.dueTime, reminderAt: t.reminderAt,
      priority: t.priority, watchers, subtasks: t.subtasks,
    });
    if (ok && this.toastView) this.toastView.show({ title: nowWatching ? 'Watching this task' : 'Stopped watching' });
    return ok ? nowWatching : (t.watchers || []).includes(this.currentUser);
  }

  // Quick "Log call" — drops a call-kind entry on the task's thread. The kind
  // column (064) carries the CALL tag now, so the body is plain text; the emoji
  // is dropped for new rows (legacy 📞-prefixed rows still tag via fallback).
  addCallLog(id) {
    this.addTaskComment(id, 'Logged a call', [], 'call');
  }

  // Toggle my reaction (emoji) on a comment. Optimistic: flip local state and
  // re-render immediately, then reconcile with the datastore; on failure we
  // revert and toast. One row per (comment, me, emoji) — see migration 064.
  async toggleReaction(taskId, commentId, emoji) {
    // The store flips it and hands back the exact undo, so the optimistic write
    // and its rollback can't drift apart.
    const flip = this.comments.toggleReaction(taskId, commentId, this.currentUser, emoji);
    if (!flip) return;
    App.EventBus.emit('comments:changed', taskId);
    try {
      if (flip.had) await this.dataStore.removeReaction(commentId, emoji);
      else await this.dataStore.addReaction(commentId, emoji);
    } catch (e) {
      console.error('[reactions] toggle failed:', e);
      flip.revert();
      if (this.toastView) this.toastView.show({ title: 'Reaction not saved', sub: 'Please try again.' });
      App.EventBus.emit('comments:changed', taskId);
    }
  }

  // Hard stop: close the current user's timer if it's pointed at this task.
  // Used when the task is going away entirely (delete) — there's nothing to
  // fall back to, so we clock out. stopTimer already toasts the logged time.
  _stopTimerIfOnTask(taskId) {
    const active = this.timeModel.activeFor(this.currentUser);
    if (!active || active.taskId !== taskId) return;
    this.stopTimer(this.currentUser);
  }

  // When a task the user is tracking transitions to Done, don't clock them all
  // the way out — they're still on shift, just not on that task. Drop them back
  // onto the General shift bucket so the clock keeps running.
  _revertToGeneralShiftIfOnTask(taskId) {
    const active = this.timeModel.activeFor(this.currentUser);
    if (!active || active.taskId !== taskId) return;
    this._revertToGeneralShift(this.currentUser, 'done');
  }

  // Switch the user's running timer over to the General shift bucket (logging
  // whatever was on the prior task). Falls back to a full clock-out only when
  // there's no general-shift task to land on, or they're already on it.
  _revertToGeneralShift(userId, reason) {
    if (!App.can('clock.use')) return;
    const clockId = App.DEFAULT_CLOCK_TASK_ID;
    const active = this.timeModel.activeFor(userId);
    if (!active) return;
    // Already on (or toggling off) the General shift bucket itself → clock out.
    if (active.taskId === clockId || !this.taskModel.find(clockId)) {
      this.stopTimer(userId);
      return;
    }
    this.startTimer(userId, clockId, {
      toast: {
        title: 'Back on General shift',
        sub: reason === 'done' ? 'Task done — you’re still clocked in.' : 'You’re still clocked in.',
      },
    });
  }

  // Broadcast a status/priority/completion change to everyone connected to
  // the task (creator, assignee, watchers) except the user who made the
  // change. Covers both directions naturally: supervisor edits → worker
  // pinged; worker edits → supervisor/creator pinged. In-app only — these
  // happen often enough that email would be noise.
  _notifyTaskChange(task, summary) {
    if (!task) return;
    const me = this.currentUser;
    const ids = new Set();
    if (task.creator && task.creator !== me) ids.add(task.creator);
    if (task.assignee && task.assignee !== me) ids.add(task.assignee);
    (task.watchers || []).forEach(w => { if (w && w !== me) ids.add(w); });
    if (!ids.size) return;
    const whoEsc = App.utils.escapeHtml(this.getUserName(me));
    const titleEsc = App.utils.escapeHtml(task.title);
    const summaryEsc = App.utils.escapeHtml(summary);
    const inapp = Array.from(ids).map(memberId => ({
      memberId,
      taskId: task.id,
      meta: 'Task update',
      html: `<strong>${whoEsc}</strong> ${summaryEsc} on <em>${titleEsc}</em>`,
    }));
    this._deliver(inapp, [], null);
  }

  _celebrateCompletion(task) {
    if (!this.toastView) return;
    const name = (App.directory.person(this.currentUser) && App.directory.person(this.currentUser).name) || 'you';
    const cheers = [
      `Congrats, ${name}!`,
      `Nice work, ${name}!`,
      `Boom — ${name} ships!`,
      `Crushed it, ${name}!`,
      `One down, ${name}!`,
    ];
    const title = cheers[Math.floor(Math.random() * cheers.length)];

    // Count "done today" by anyone — gives the toast a motivational counter.
    const today = App.utils.todayISO(0);
    const me = this.currentUser;
    const myDoneToday = this.taskModel.all().filter(t => App.utils.isAssignee(t, me) && App.utils.hqDateOf(t.completedAt) === today).length;
    const tail = myDoneToday > 1 ? `${myDoneToday} finished today` : 'First win of the day';
    this.toastView.show({ title, sub: `${App.utils.escapeHtml(task.title)} · ${tail}`, variant: 'celebrate' });
  }

  cycleTaskPriority(id) {
    if (!App.can('tasks.write')) return;
    const task = this.taskModel.find(id);
    if (!task) return;
    const prev = task.priority;
    this.taskModel.cyclePriority(id, this.getUserName(this.currentUser));
    if (task.priority !== prev) {
      const label = (App.PRIORITIES[task.priority] && App.PRIORITIES[task.priority].label) || task.priority;
      this._notifyTaskChange(task, `set priority to ${label}`);
    }
  }

  /* Add a watcher to a task. Idempotent — if they're already watching,
     this is a no-op rather than a duplicate entry. */
  addWatcher(taskId, memberId) {
    if (!App.can('tasks.write')) return;
    if (!memberId) return;
    const task = this.taskModel.find(taskId);
    if (!task) return;
    const watchers = Array.isArray(task.watchers) ? task.watchers : [];
    if (watchers.includes(memberId)) return;
    this.taskModel.update(taskId, { watchers: [...watchers, memberId] });
    const person = App.directory.person(memberId);
    if (person) {
      this.taskModel.addActivity(taskId, {
        who: this.getUserName(this.currentUser),
        what: `added ${person.name} as a watcher`,
        when: 'just now',
      });
    }
  }

  removeWatcher(taskId, memberId) {
    if (!App.can('tasks.write')) return;
    if (!memberId) return;
    const task = this.taskModel.find(taskId);
    if (!task) return;
    const watchers = Array.isArray(task.watchers) ? task.watchers : [];
    if (!watchers.includes(memberId)) return;
    this.taskModel.update(taskId, { watchers: watchers.filter(w => w !== memberId) });
    const person = App.directory.person(memberId);
    if (person) {
      this.taskModel.addActivity(taskId, {
        who: this.getUserName(this.currentUser),
        what: `removed ${person.name} as a watcher`,
        when: 'just now',
      });
    }
  }

  /* JS-side mirror of migration 017's RLS — used to gate the destructive
     Delete-task affordance in the UI. Workers are explicitly excluded
     server-side, so showing them a button that would 401 is worse than
     not showing it. */
  canDeleteTasks() {
    return ['admin', 'construction_supervisor', 'developer', 'supervisor', 'sales'].includes(App.effectiveRole());
  }

  /* Per-task delete permission. Managers may delete any in-company task; a worker
     may delete ONLY a task they created (migration 044). Gates the detail view's
     Delete button and the deleteTask action so we never show a button that 403s. */
  canDeleteTask(task) {
    if (this.canDeleteTasks()) return true;
    return App.effectiveRole() === 'worker' && !!task && task.creator === this.currentUser;
  }

  /* Hard-delete a single task after a confirm prompt. Optimistic:
     removes from the in-memory model immediately so the list collapses
     instantly, then fires the network DELETE. If the server rejects
     (RLS blocked, network blip), surfaces a toast and the next page
     load will resurrect the task from the source of truth. */
  deleteTask(id) {
    const task = this.taskModel.find(id);
    if (!task) return;
    if (!this.canDeleteTask(task)) {
      const sub = App.effectiveRole() === 'worker'
        ? 'You can only delete tasks you created.'
        : 'Your role cannot delete tasks.';
      if (this.toastView) this.toastView.show({ title: 'No access', sub });
      return;
    }
    const snippet = task.title && task.title.length > 50 ? task.title.slice(0, 50) + '…' : (task.title || 'this task');

    // Undo-able delete: remove from the UI now but DEFER the irreversible DB
    // delete until the Undo window closes. A deep snapshot lets Undo restore the
    // task fully (watchers/subtasks/activity live on the row; time entries aren't
    // touched because we never actually deleted yet). No confirm dialog — the
    // Undo toast is the safety net.
    const snapshot = JSON.parse(JSON.stringify(task));
    this._stopTimerIfOnTask(id);
    if (this.uiState && this.uiState.selectedTaskId === id) this.closeDetail();
    this.taskModel.remove(id);

    const UNDO_MS = 6000;
    let undone = false;
    const timer = setTimeout(() => {
      if (undone) return;
      if (this.dataStore && typeof this.dataStore.deleteTask === 'function') {
        this.dataStore.deleteTask(id).catch(err => {
          console.error('[task] delete failed', err);
          if (this.toastView) {
            this.toastView.show({ title: 'Delete failed', sub: (err && err.message) || 'The task may reappear on refresh.' });
          }
        });
      }
    }, UNDO_MS);

    if (this.toastView) {
      this.toastView.show({
        title: 'Task deleted',
        sub: snippet,
        duration: UNDO_MS,
        action: {
          label: 'Undo',
          onClick: () => {
            if (undone) return;
            undone = true;
            clearTimeout(timer);
            this.taskModel.add(snapshot); // never hit the DB — the row is intact
            if (this.toastView) this.toastView.show({ title: 'Delete undone', sub: snippet });
          },
        },
      });
    }
  }

  /* ---------- bulk select ---------- */
  // Multi-select lets the user act on several tasks at once. Selection state
  // lives in uiState (a Set of ids); the list view paints checkboxes and the
  // BulkActionsView paints the bottom bar. 'bulk:changed' drives both.
  isBulkSelected(id) { return this.uiState.bulkSelected.has(id); }

  enterBulkMode(seedId) {
    if (!App.can('tasks.view')) return;
    this.uiState.bulkMode = true;
    this.uiState.bulkSelected.clear();
    if (seedId != null) this.uiState.bulkSelected.add(seedId);
    // Selecting tasks and reading the detail pane at once is confusing — close it.
    if (this.uiState.selectedTaskId) this.closeDetail();
    App.EventBus.emit('bulk:changed');
    App.EventBus.emit('tasks:changed'); // repaint rows with checkboxes
  }

  exitBulkMode() {
    this.uiState.bulkMode = false;
    this.uiState.bulkSelected.clear();
    App.EventBus.emit('bulk:changed');
    App.EventBus.emit('tasks:changed');
  }

  toggleBulkMode() {
    if (this.uiState.bulkMode) this.exitBulkMode();
    else this.enterBulkMode();
  }

  toggleBulkSelect(id) {
    const sel = this.uiState.bulkSelected;
    if (sel.has(id)) sel.delete(id);
    else sel.add(id);
    App.EventBus.emit('bulk:changed');
    App.EventBus.emit('selection:changed'); // cheap row-highlight refresh
  }

  bulkSelectAllVisible() {
    const ids = this.getVisibleTasks().map(t => t.id);
    const sel = this.uiState.bulkSelected;
    // If everything's already selected, treat the button as "clear".
    if (ids.length && ids.every(id => sel.has(id))) sel.clear();
    else ids.forEach(id => sel.add(id));
    App.EventBus.emit('bulk:changed');
    App.EventBus.emit('tasks:changed');
  }

  _bulkIds() {
    // Only act on selected tasks still visible (and real).
    return [...this.uiState.bulkSelected].filter(id => this.taskModel.find(id));
  }

  bulkComplete() {
    if (!App.can('tasks.write')) return;
    const ids = this._bulkIds().filter(id => {
      const t = this.taskModel.find(id);
      return t && !App.taxonomy.isDone(t);
    });
    if (!ids.length) { this.exitBulkMode(); return; }
    ids.forEach(id => {
      this.taskModel.toggleDone(id, this.getUserName(this.currentUser));
      this._revertToGeneralShiftIfOnTask(id);
    });
    if (this.toastView) {
      this.toastView.show({
        title: `Completed ${ids.length} task${ids.length > 1 ? 's' : ''}`,
        sub: 'Marked done.',
        action: {
          label: 'Undo',
          onClick: () => ids.forEach(id => this.taskModel.toggleDone(id, this.getUserName(this.currentUser))),
        },
      });
    }
    this.exitBulkMode();
  }

  bulkDelete() {
    const deletable = this._bulkIds().filter(id => this.canDeleteTask(this.taskModel.find(id)));
    const blocked = this._bulkIds().length - deletable.length;
    if (!deletable.length) {
      if (this.toastView) this.toastView.show({ title: 'No access', sub: 'None of the selected tasks can be deleted by you.' });
      return;
    }
    // Snapshot for one shared Undo, then defer the irreversible DB delete past
    // the undo window — mirrors single-task deleteTask().
    const snapshots = deletable.map(id => JSON.parse(JSON.stringify(this.taskModel.find(id))));
    deletable.forEach(id => { this._stopTimerIfOnTask(id); this.taskModel.remove(id); });

    const UNDO_MS = 6000;
    let undone = false;
    const timer = setTimeout(() => {
      if (undone) return;
      if (this.dataStore && typeof this.dataStore.deleteTask === 'function') {
        deletable.forEach(id => this.dataStore.deleteTask(id).catch(err => console.error('[task] bulk delete failed', err)));
      }
    }, UNDO_MS);

    if (this.toastView) {
      this.toastView.show({
        title: `Deleted ${deletable.length} task${deletable.length > 1 ? 's' : ''}`,
        sub: blocked ? `${blocked} skipped (no access).` : 'Removed.',
        duration: UNDO_MS,
        action: {
          label: 'Undo',
          onClick: () => {
            if (undone) return;
            undone = true;
            clearTimeout(timer);
            snapshots.forEach(s => this.taskModel.add(s));
          },
        },
      });
    }
    this.exitBulkMode();
  }

  /* ---------- Focus list (execution order) ---------- */
  // Focus is a shared, cross-person execution order, so anyone who can edit
  // tasks can add/reorder it.
  canSetFocusFor(task) {
    return !!task && App.can('tasks.write');
  }

  addToFocus(ids) {
    if (!App.can('tasks.write')) return;
    const list = (Array.isArray(ids) ? ids : [ids]);
    const added = list.filter(id => {
      const t = this.taskModel.find(id);
      if (!t || !this.canSetFocusFor(t) || t.focusSeq != null) return false;
      this.taskModel.addToFocus(id);
      return true;
    });
    if (this.toastView && added.length) {
      this.toastView.show({ title: `Added ${added.length} to Focus`, sub: 'Open Focus to set the order.' });
    }
    if (this.uiState.bulkMode) this.exitBulkMode();
  }

  bulkAddToFocus() {
    if (!App.can('tasks.write')) return;
    this.addToFocus(this._bulkIds());
  }

  removeFromFocus(id) {
    const t = this.taskModel.find(id);
    if (!t || !this.canSetFocusFor(t)) return;
    this._captureUndo(id, 'focusSeq', t.focusSeq, 'reorder');
    this.taskModel.removeFromFocus(id);
  }

  setFocusOrder(id, newSeq) {
    const t = this.taskModel.find(id);
    if (!t || !this.canSetFocusFor(t)) return;
    this._captureUndo(id, 'focusSeq', t.focusSeq, 'reorder');
    this.taskModel.setFocusOrder(id, newSeq);
  }

  /* ---------- Undo (Ctrl+Z) ----------
     Reverses the LAST action. Each reversible field-write is captured with its
     PREVIOUS value; a single inline edit becomes its own one-op entry, while a
     drag (many focusSeq writes + maybe a type change) is grouped into one entry
     via undoable(). Restoring writes straight to the model (no re-capture, no
     re-notify). Task deletes keep their existing 6s toast-undo — not this. */
  undoable(label, fn) {
    const parent = this._undoTxn;
    this._undoTxn = { label, ops: [], seen: new Set() };
    try { fn(); }
    finally {
      const txn = this._undoTxn;
      this._undoTxn = parent;
      if (txn.ops.length) this._pushUndo(txn);
    }
  }

  _captureUndo(id, field, prevValue, label) {
    if (this._undoing) return;
    const key = id + '|' + field;
    if (this._undoTxn) {
      if (!this._undoTxn.seen.has(key)) {
        this._undoTxn.seen.add(key);
        this._undoTxn.ops.push({ id, field, value: prevValue });
      }
    } else {
      this._pushUndo({ label: label || 'change', ops: [{ id, field, value: prevValue }] });
    }
  }

  _pushUndo(txn) {
    this._undoStack.push(txn);
    if (this._undoStack.length > 40) this._undoStack.shift();
  }

  undoLast() {
    const txn = this._undoStack.pop();
    if (!txn) { if (this.toastView) this.toastView.show({ title: 'Nothing to undo' }); return; }
    const name = this.getUserName(this.currentUser);
    this._undoing = true;
    try {
      txn.ops.forEach(op => {
        if (!this.taskModel.find(op.id)) return;
        if (op.field === 'focusSeq') this.taskModel.setFocusOrder(op.id, op.value);
        else this.taskModel.setField(op.id, op.field, op.value, name, 'undo');
      });
    } finally { this._undoing = false; }
    if (this.toastView) this.toastView.show({ title: `Undid ${txn.label}` });
  }

  /* Reveal / hide completed tasks in the manual-order list. */
  toggleShowCompleted() {
    this.uiState.showCompleted = !this.uiState.showCompleted;
    this._persistUiState();
    App.EventBus.emit('tasks:changed');
    App.EventBus.emit('controls:changed');
  }

  /* Soft-clear every done task, after a confirm prompt. Rows stay in
     Supabase for a 30-day grace window (boot-time purge does the real
     delete), so a fat-finger is recoverable by SQL update. */
  clearDoneTasks() {
    if (!App.can('tasks.write')) return;
    const doneCount = this.taskModel.all().filter(t => App.taxonomy.isDone(t) && !t.clearedAt).length;
    if (!doneCount) return;
    const msg = `Clear ${doneCount} done task${doneCount > 1 ? 's' : ''}? They'll be hidden everywhere and permanently deleted in 30 days.`;
    if (!window.confirm(msg)) return;
    const cleared = this.taskModel.clearDoneTasks(this.getUserName(this.currentUser));
    if (cleared && this.toastView) {
      this.toastView.show({
        title: `Cleared ${cleared} task${cleared > 1 ? 's' : ''}`,
        sub: 'They’ll be permanently deleted in 30 days.',
      });
    }
  }

  // activityText (optional, from the detail view's auto-save path) makes the
  // logged activity specific; TaskModel.setField falls back to a generic entry.
  updateTaskField(id, field, value, activityText) {
    if (!App.can('tasks.write')) return;
    const task = this.taskModel.find(id);
    if (!task) return;
    // Auto-caps the free-text fields on save (title, description). Constrained
    // fields (status, priority, due, project, …) carry keys/ISO values and must
    // be left untouched.
    if (field === 'title' || field === 'description') value = App.utils.upper(value);
    const prev = task[field];
    if (prev !== value) this._captureUndo(id, field, prev, `change ${field}`);
    this.taskModel.setField(id, field, value, this.getUserName(this.currentUser), activityText);
    const doneKey = App.taxonomy.doneStatus(task.company, task.type);
    if (field === 'status' && value === doneKey && prev !== doneKey) {
      this._revertToGeneralShiftIfOnTask(id);
    }
    if ((field === 'status' || field === 'priority') && prev !== value) {
      const dict = field === 'status' ? App.STATUSES : App.PRIORITIES;
      const label = (dict && dict[value] && dict[value].label) || value;
      this._notifyTaskChange(task, `changed ${field} to ${label}`);
    }
  }

  /* Create a project folder, refresh App.projects, and notify views. Returns
     the new id (or null if not permitted). Company must be one the caller can
     write to; RLS enforces it server-side regardless. */
  async createProject({ name, companyId, color }) {
    if (!App.can('tasks.write')) return null;
    const clean = App.utils.upper(String(name || '').trim());
    if (!clean) return null;
    const id = App.utils.slugId(clean);
    await this.dataStore.createProject({
      id,
      company_id: companyId,
      name: clean,
      color: color || '#8f867b',
      status: 'active',
    });
    App.projects = await this.dataStore.loadProjects();
    App.EventBus.emit('projects:changed');
    return id;
  }

  /* Set a folder's lifecycle status — 'complete' completes it (files it under
     the company's Completed group), 'active' reopens it. NOTE: the projects
     table's status check constraint only accepts
     lead/active/hold/complete/cancelled — 'done' is NOT valid and silently
     fails the update, so completion must use 'complete'. Refreshes App.projects
     and notifies views. RLS enforces the company window regardless. */
  async setProjectStatus(projectId, status) {
    if (!App.can('tasks.write')) return;
    if (!projectId || !status) return;
    await this.dataStore.updateProject(projectId, { status });
    App.projects = await this.dataStore.loadProjects();
    App.EventBus.emit('projects:changed');
  }

  /* Delete a folder. Its tasks are unfiled (project_id -> NULL), never deleted
     (migration 055 re-points the FK to ON DELETE SET NULL). Refreshes
     App.projects, drops the folder scope if the list is pinned to it, and
     notifies views. RLS enforces the company window regardless. */
  async deleteProject(projectId) {
    if (!App.can('tasks.write')) return;
    if (!projectId) return;
    await this.dataStore.deleteProject(projectId);
    App.projects = await this.dataStore.loadProjects();
    if (this.uiState.filters && this.uiState.filters.projectId === projectId) {
      this.uiState.filters.projectId = null;
      App.EventBus.emit('filters:changed');
    }
    App.EventBus.emit('projects:changed');
    if (this.toastView) this.toastView.show({ title: 'Project deleted', sub: 'Its tasks were kept and unfiled.' });
  }

  /* Grid "New folder" button. Company defaults to the sidebar's current
     company; if that's "All"/absent and the user has several, ask which. */
  async promptNewFolder() {
    if (!App.can('tasks.write')) return;
    // Resolve the company up front so the modal only shows a picker when the
    // choice is genuinely ambiguous (multi-company user with "All" active).
    let companyId = this.uiState.currentCompany;
    let options = null;
    if (!companyId || companyId === '*') {
      const ids = (this.uiState.companies || []).filter(c => c !== '*');
      companyId = ids[0] || '';
      if (ids.length > 1) options = ids;
    }

    const result = this.newFolderView
      ? await this.newFolderView.open({ companies: options, defaultCompany: companyId })
      : null;
    if (!result) return; // cancelled / dismissed
    const name = (result.name || '').trim();
    if (name) companyId = result.companyId || companyId;
    if (!name || !companyId) return;

    const id = await this.createProject({ name, companyId });
    // Confirm the creation with a toast that can jump straight into the new
    // folder (createProject already animates the card rising in).
    if (id && this.toastView) {
      this.toastView.show({
        title: 'Project created',
        sub: App.utils.upper(name),
        action: { label: 'Open', onClick: () => this.openProject(id) },
      });
    }
  }

  /* Scope the task list to a single folder (project detail). Sets a single-value
     projectId filter and switches to the list; the list renders a folder header. */
  openProject(projectId) {
    // Opening a folder is an explicit "show me THIS folder" drill-down, so drop
    // the "My work" scope — otherwise a folder full of a teammate's tasks reads
    // as empty under My-work. Reset to 'all' (rather than ignoring scope) so the
    // visible scope segment stays honest.
    this._commit({ filters: { ...(this.uiState.filters || {}), projectId: projectId || null }, scope: 'all' });
    this.setView('all');
  }

  clearProjectScope() {
    if (!this.uiState.filters) return;
    this._commit({ filters: { ...this.uiState.filters, projectId: null } });
  }

  /* Batch-save every editable detail field from the task detail pane's Edit
     mode (title, description, company, type, status, assignee, due,
     dueTime, priority, watchers, subtasks). The whole set is staged in the view
     and only reaches here on Save, so Cancel — which never calls this — leaves
     the task untouched; a refresh shows the saved values (taskModel.update marks
     the row dirty for the next sync). Returns true on success; on a validation
     problem it toasts and returns false so the view keeps the user's input. */
  updateTaskDetails(id, fields) {
    if (!App.can('tasks.write')) return false;
    const task = this.taskModel.find(id);
    if (!task) return false;

    let title, description, due, dueTime;
    try {
      title = App.utils.upper(App.validate.nonEmpty(fields.title, 'Title', { field: 'title', max: App.validate.LIMITS.title }));
      description = App.utils.upper(String(fields.description == null ? '' : fields.description).trim().slice(0, App.validate.LIMITS.description));
      due = App.validate.isoDate(fields.due, { field: 'due', required: true });
      dueTime = fields.dueTime ? App.validate.isoTime(fields.dueTime, { field: 'dueTime' }) : null;
    } catch (err) {
      if (this.toastView) this.toastView.show({ title: 'Couldn’t save', sub: (err && err.message) || 'Check the fields and try again.' });
      return false;
    }

    // The remaining fields come from constrained <select>s / staged lists; fall
    // back to the task's current value when a field wasn't provided.
    const company = fields.company || task.company;
    // project may be null (unfiled); only fall back when the field is absent.
    const project = (fields.project !== undefined) ? fields.project : (task.project || null);
    const type = fields.type || task.type || 'admin';
    const label = fields.label || task.label || 'roof';
    const priority = fields.priority || task.priority || 'medium';
    const status = fields.status || task.status || 'todo';
    const assignee = fields.assignee || task.assignee;
    const watchers = Array.isArray(fields.watchers) ? [...new Set(fields.watchers)] : (task.watchers || []);
    const subtasks = Array.isArray(fields.subtasks)
      ? fields.subtasks.map(s => ({ t: App.utils.upper(s.t), d: !!s.d }))
      : (task.subtasks || []);
    // User-set reminder ("YYYY-MM-DDTHH:MM" local, or null to clear). Anything
    // not matching the datetime-local shape is treated as cleared.
    const reminderAt = normalizeReminderAt(fields.reminderAt);

    const prevStatus = task.status, prevPriority = task.priority, prevAssignee = task.assignee;

    this.taskModel.update(id, {
      title, description, company, project, type, label, due, dueTime, reminderAt, priority, status, assignee, watchers, subtasks,
    });

    // Done has a side effect the inline path also applies: drop a running timer
    // on this task back to General shift rather than clocking fully out.
    const doneKey = App.taxonomy.doneStatus(company, type);
    if (status === doneKey && prevStatus !== doneKey) this._revertToGeneralShiftIfOnTask(id);

    // Notify watchers of the meaningful changes (mirrors updateTaskField/reassign).
    if (status !== prevStatus) {
      const label = (App.STATUSES[status] && App.STATUSES[status].label) || status;
      this._notifyTaskChange(task, `changed status to ${label}`);
    }
    if (priority !== prevPriority) {
      const label = (App.PRIORITIES[priority] && App.PRIORITIES[priority].label) || priority;
      this._notifyTaskChange(task, `changed priority to ${label}`);
    }
    if (assignee !== prevAssignee) this._notifyTaskChange(task, 'reassigned this task');

    this.taskModel.addActivity(id, {
      who: this.getUserName(this.currentUser),
      what: 'edited this task',
      when: 'just now',
    });
    if (this.toastView) this.toastView.show({ title: 'Task updated', sub: '' });
    return true;
  }

  toggleSubtask(taskId, idx) {
    if (!App.can('tasks.write')) return;
    this.taskModel.toggleSubtask(taskId, idx);
  }

  reassignTask(id, newAssignee) {
    if (!App.can('tasks.write')) return;
    const result = this.taskModel.reassign(id, newAssignee, this.getUserName(this.currentUser));
    if (!result) return;
    // Focus is a shared cross-person order, so a reassigned task keeps its place.
    if (newAssignee !== this.currentUser) {
      const task = this.taskModel.find(id);
      const creatorName = this.getUserName(this.currentUser);
      const person = App.directory.person(newAssignee) || App.directory.personFallback(newAssignee);
      const titleEsc = App.utils.escapeHtml(task.title);
      this._deliver(
        [{
          memberId: newAssignee,
          taskId: id,
          meta: 'Reassigned',
          html: `<strong>${App.utils.escapeHtml(creatorName)}</strong> reassigned <em>${titleEsc}</em> to you`,
        }],
        person.email ? [person.email] : [],
        { subject: `Quest HQ — ${task.title}`, html: this._emailBody(`<strong>${App.utils.escapeHtml(creatorName)}</strong> reassigned <strong>${titleEsc}</strong> to you.`, task) }
      );
      this.toastView.show({
        title: `Reassigned to ${person.name}`,
        sub: person.email ? `Notifying ${person.email}` : 'In-app notification sent',
      });
    }
  }

  /* Multi-assignee reassignment (task detail Reassign picker). Accepts an
     ordered id list (lead = index 0), writes assigneeIds + mirrors
     assignee = ids[0], saves via the model's dirty path, and fans out the same
     in-app + email notification to every NEWLY-added assignee — reusing
     createTask's fan-out shape and its save-before-notify ordering so a worker
     assigning to a teammate doesn't trip the notification FK/RLS race. Watchers
     stay exclusive with assignees (anyone made an assignee is removed from
     watchers). A no-op (same ordered set) does nothing. */
  async setAssignees(id, idsArray) {
    if (!App.can('tasks.write')) {
      if (this.toastView) this.toastView.show({ title: 'No access', sub: 'Your role cannot change this task.' });
      return;
    }
    const task = this.taskModel.find(id);
    if (!task) return;

    // Normalise: unique, order-preserving, non-empty.
    const ids = [];
    (idsArray || []).forEach(x => { if (x && !ids.includes(x)) ids.push(x); });
    if (!ids.length) return; // a task must keep at least one assignee

    const prevIds = (Array.isArray(task.assigneeIds) && task.assigneeIds.length)
      ? task.assigneeIds
      : (task.assignee ? [task.assignee] : []);
    // No change (same people, same order) — nothing to do.
    if (prevIds.length === ids.length && prevIds.every((v, i) => v === ids[i])) return;

    const lead = ids[0];
    // Keep watcher/assignee exclusivity: a person can't be both.
    const watchers = (task.watchers || []).filter(w => !ids.includes(w));

    const names = ids.map(x => (App.directory.person(x) ? App.directory.person(x).name : x)).join(' + ');
    this.taskModel.update(id, { assigneeIds: ids, assignee: lead, watchers });
    this.taskModel.addActivity(id, {
      who: this.getUserName(this.currentUser),
      what: ids.length > 1 ? `assigned this to ${names}` : `reassigned this to ${names}`,
      at: new Date().toISOString(),
      when: 'just now',
    });

    // Fan out to every NEWLY-added assignee (not those already on the task, and
    // never yourself). Mirrors createTask's inapp + email construction.
    const added = ids.filter(x => !prevIds.includes(x) && x !== this.currentUser);
    const creatorName = this.getUserName(this.currentUser);
    const titleEsc = App.utils.escapeHtml(task.title);
    const inapp = [];
    const emails = [];
    added.forEach(x => {
      inapp.push({
        memberId: x,
        taskId: task.id,
        meta: 'Task assigned',
        html: `<strong>${App.utils.escapeHtml(creatorName)}</strong> assigned <em>${titleEsc}</em> to you`,
      });
      if (App.directory.person(x) && App.directory.person(x).email) emails.push(App.directory.person(x).email);
    });

    // Save BEFORE delivering (see createTask for the FK/RLS-race rationale).
    const saved = this.saveNow ? await this.saveNow() : true;
    if (saved && added.length) {
      this._deliver(inapp, emails, {
        subject: `Quest HQ — ${task.title}`,
        html: this._emailBody(`<strong>${App.utils.escapeHtml(creatorName)}</strong> assigned <strong>${titleEsc}</strong> to ${App.utils.escapeHtml(names)}.`, task),
      });
    }
    if (this.toastView) {
      this.toastView.show({
        title: ids.length > 1 ? `Assigned to ${names}` : `Reassigned to ${names}`,
        sub: added.length ? (emails.length ? `Notifying ${names}` : 'In-app notification sent') : 'Assignees updated',
      });
    }
  }

  /* ---------- Task Detail engagement actions (Slice B) ---------- */

  /* Flag a task STUCK on a reason + a blocked-on person. Mutates task.stuck
     ({ reason, on, at }), logs activity, saves, then notifies the blocked-on
     person (in-app + email) that they're blocking this task. Reuses the
     save-before-notify ordering (setAssignees/createTask) so the notification
     FK/RLS check sees a saved task. */
  async flagStuck(taskId, reason, blockedOnId) {
    if (!App.can('tasks.write')) {
      if (this.toastView) this.toastView.show({ title: 'No access', sub: 'Your role cannot change this task.' });
      return;
    }
    const task = this.taskModel.find(taskId);
    if (!task) return;
    const cleanReason = String(reason || '').trim().slice(0, 500);
    if (!cleanReason || !blockedOnId) return;

    const stuck = { reason: cleanReason, on: blockedOnId, at: new Date().toISOString() };
    this.taskModel.update(taskId, { stuck });
    const blockedName = this.getUserName(blockedOnId);
    this.taskModel.addActivity(taskId, {
      who: this.getUserName(this.currentUser),
      what: `flagged this stuck — blocked on ${blockedName}`,
      at: new Date().toISOString(),
      when: 'just now',
    });

    const fromName = this.getUserName(this.currentUser);
    const titleEsc = App.utils.escapeHtml(task.title);
    const person = App.directory.person(blockedOnId) || { name: blockedOnId, email: '' };

    const saved = this.saveNow ? await this.saveNow() : true;
    if (saved && blockedOnId !== this.currentUser) {
      this._deliver(
        [{
          memberId: blockedOnId,
          taskId,
          meta: 'Blocking a task',
          html: `<strong>${App.utils.escapeHtml(fromName)}</strong> is stuck on <em>${titleEsc}</em> — waiting on you: “${App.utils.escapeHtml(cleanReason)}”`,
        }],
        person.email ? [person.email] : [],
        { subject: `Quest HQ — you're blocking ${task.title}`, html: this._emailBody(`<strong>${App.utils.escapeHtml(fromName)}</strong> flagged <strong>${titleEsc}</strong> as stuck, blocked on you:<br/>“${App.utils.escapeHtml(cleanReason)}”`, task) }
      );
    }
    if (this.toastView) {
      this.toastView.show({
        title: 'Flagged as stuck',
        sub: blockedOnId !== this.currentUser
          ? (person.email ? `Notifying ${person.name}` : `${person.name} notified in-app`)
          : `Blocked on ${person.name}`,
      });
    }
  }

  /* Clear a task's stuck state (Unblock). No notification. */
  async unblock(taskId) {
    if (!App.can('tasks.write')) {
      if (this.toastView) this.toastView.show({ title: 'No access', sub: 'Your role cannot change this task.' });
      return;
    }
    const task = this.taskModel.find(taskId);
    if (!task || !task.stuck) return;
    this.taskModel.update(taskId, { stuck: null });
    this.taskModel.addActivity(taskId, {
      who: this.getUserName(this.currentUser),
      what: 'marked this unblocked',
      at: new Date().toISOString(),
      when: 'just now',
    });
    if (this.saveNow) await this.saveNow();
    if (this.toastView) this.toastView.show({ title: 'Unblocked' });
  }

  /* Nudge every assignee (excluding the current user) with a short reminder.
     No schema change — logs activity, saves, then fans out in-app + email. */
  async nudge(taskId) {
    const task = this.taskModel.find(taskId);
    if (!task) return;
    const assigneeIds = (Array.isArray(task.assigneeIds) && task.assigneeIds.length)
      ? task.assigneeIds
      : (task.assignee ? [task.assignee] : []);
    const targets = Array.from(new Set(assigneeIds.filter(id => id && id !== this.currentUser)));
    if (!targets.length) {
      if (this.toastView) this.toastView.show({ title: 'Nobody to nudge', sub: 'No other assignees on this task.' });
      return;
    }

    const fromName = this.getUserName(this.currentUser);
    const titleEsc = App.utils.escapeHtml(task.title);
    const names = targets.map(id => this.getUserName(id)).join(' + ');
    this.taskModel.addActivity(taskId, {
      who: fromName,
      what: `nudged ${names}`,
      at: new Date().toISOString(),
      when: 'just now',
    });

    const inapp = [];
    const emails = [];
    targets.forEach(id => {
      inapp.push({
        memberId: id,
        taskId,
        meta: 'Nudge',
        html: `<strong>${App.utils.escapeHtml(fromName)}</strong> sent a reminder about <em>${titleEsc}</em>`,
      });
      if (App.directory.person(id) && App.directory.person(id).email) emails.push(App.directory.person(id).email);
    });

    const saved = this.saveNow ? await this.saveNow() : true;
    if (saved) {
      this._deliver(inapp, emails, {
        subject: `Quest HQ — reminder: ${task.title}`,
        html: this._emailBody(`<strong>${App.utils.escapeHtml(fromName)}</strong> sent a reminder about <strong>${titleEsc}</strong>.`, task),
      });
    }
    if (this.toastView) {
      this.toastView.show({
        title: `Nudged ${names}`,
        sub: emails.length ? `Notifying ${names}` : 'In-app reminder sent',
      });
    }
  }

  /* Request help from a teammate: add them as a watcher (if not already), save,
     then notify them (in-app + email) that help was requested on this task. */
  async requestHelp(taskId, helperId) {
    if (!App.can('tasks.write')) {
      if (this.toastView) this.toastView.show({ title: 'No access', sub: 'Your role cannot change this task.' });
      return;
    }
    const task = this.taskModel.find(taskId);
    if (!task || !helperId) return;

    const watchers = (task.watchers || []).slice();
    if (!watchers.includes(helperId)) {
      watchers.push(helperId);
      this.taskModel.update(taskId, { watchers });
    }
    const fromName = this.getUserName(this.currentUser);
    const titleEsc = App.utils.escapeHtml(task.title);
    const person = App.directory.person(helperId) || { name: helperId, email: '' };
    this.taskModel.addActivity(taskId, {
      who: fromName,
      what: `asked ${person.name} for help`,
      at: new Date().toISOString(),
      when: 'just now',
    });

    const saved = this.saveNow ? await this.saveNow() : true;
    if (saved && helperId !== this.currentUser) {
      this._deliver(
        [{
          memberId: helperId,
          taskId,
          meta: 'Help requested',
          html: `<strong>${App.utils.escapeHtml(fromName)}</strong> asked for your help on <em>${titleEsc}</em>`,
        }],
        person.email ? [person.email] : [],
        { subject: `Quest HQ — help requested: ${task.title}`, html: this._emailBody(`<strong>${App.utils.escapeHtml(fromName)}</strong> requested your help on <strong>${titleEsc}</strong>.`, task) }
      );
    }
    if (this.toastView) {
      this.toastView.show({
        title: `Help requested from ${person.name}`,
        sub: person.email ? `Notifying ${person.name}` : `${person.name} notified in-app`,
      });
    }
  }

  /* Deliver notifications (in-app + best-effort email) to recipients other than
     the current user. In-app failures surface a toast; email is best-effort. */
  async _deliver(inappRecipients, emails, emailContent) {
    try {
      if (inappRecipients && inappRecipients.length) {
        await this.dataStore.sendNotifications(inappRecipients);
      }
    } catch (err) {
      console.error('[notify] in-app delivery failed', err, 'cause:', err && err.cause);
      if (this.toastView) {
        const friendly = (err && err.message) || 'Recipients may not see this until reload.';
        const cause = err && err.cause && err.cause.message;
        this.toastView.show({
          title: 'Notification delivery failed',
          sub: cause ? `${friendly} — ${cause}` : friendly,
        });
      }
    }
    const unique = Array.from(new Set((emails || []).filter(Boolean)));
    if (unique.length && emailContent) {
      // Email is best-effort: a rejected promise here must not bubble to the
      // global unhandledrejection handler. `skipped` = email isn't configured
      // (expected, silent); a real failure tells the user the in-app notice
      // still went through so they know the assignee was reached.
      try {
        const res = await this.dataStore.sendEmail({ to: unique, subject: emailContent.subject, html: emailContent.html });
        if (res && res.ok === false && !res.skipped) {
          console.warn('[notify] email delivery failed:', res.error);
          if (this.toastView) {
            this.toastView.show({
              title: 'Email not sent',
              sub: 'The in-app notification was delivered, but the email failed.',
            });
          }
        }
      } catch (err) {
        console.warn('[notify] email delivery threw', err);
      }
    }
  }

  _emailBody(intro, task) {
    const when = task.dueTime
      ? `${App.utils.escapeHtml(task.due)} at ${App.utils.escapeHtml(App.utils.formatClockTz(task.dueTime))}`
      : App.utils.escapeHtml(task.due || 'no due date');
    return `
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#23180D;line-height:1.5;">
        <p>${intro}</p>
        <p style="margin:12px 0;padding:12px 14px;background:#FFF9EF;border:1px solid #E2D3BC;border-radius:6px;">
          <strong>${App.utils.escapeHtml(task.title)}</strong><br/>
          Due: ${when}
          ${task.description ? `<br/>${App.utils.escapeHtml(task.description)}` : ''}
        </p>
        <p style="color:#6E5B45;font-size:12px;">Sent from Quest HQ.</p>
      </div>
    `;
  }

  // Open the full-page New task form. `creatingTask` drives _togglePanes to show
  // #newTaskWrap; the page view renders on the newtask:changed event. We remember
  // the view to return to so Cancel/Create restores it.
  openNewTaskPage(prefill) {
    if (!App.can('tasks.write')) {
      this.toastView.show({ title: 'No access', sub: 'Your role cannot create tasks.' });
      return;
    }
    if (this.uiState.creatingTask) return; // already open
    this._returnView = this.uiState.view;
    this._newTaskPrefill = prefill || {};
    this.uiState.creatingTask = true;
    // Tear down any open detail page first so its internal _pageOpen flag resets
    // (selection:changed → TaskDetailView._closeModal). _togglePanes then shows
    // #newTaskWrap because creatingTask is already true.
    if (this.uiState.selectedTaskId) {
      this.uiState.selectedTaskId = null;
      App.EventBus.emit('selection:changed');
    }
    this._togglePanes();
    App.EventBus.emit('newtask:changed', true);
    this._syncRoute();
  }

  // Close the New task page and restore whatever surface was showing before.
  closeNewTaskPage() {
    if (!this.uiState.creatingTask) return;
    this.uiState.creatingTask = false;
    this._newTaskPrefill = null;
    this._togglePanes();
    App.EventBus.emit('newtask:changed', false);
    this._syncRoute();
  }

  async createTask(payload) {
    if (!App.can('tasks.write')) {
      if (this.toastView) {
        this.toastView.show({ title: 'No access', sub: 'Your role cannot create tasks.' });
      }
      return;
    }
    // Resolve ordered assignees (lead = index 0) and claim the work-order number.
    const assigneeIds = Array.isArray(payload.assigneeIds) && payload.assigneeIds.length
      ? payload.assigneeIds
      : (payload.assignee ? [payload.assignee] : []);
    const lead = assigneeIds[0] || payload.assignee;
    const woNumber = (this.dataStore && this.dataStore.assignWoNumber)
      ? await this.dataStore.assignWoNumber(payload.company)
      : null;
    const task = {
      id: App.utils.uid('t'),
      title: App.utils.upper(payload.title),
      description: App.utils.upper(payload.description),
      type: payload.type || 'admin',
      label: payload.label || 'roof',
      company: payload.company,
      project: payload.project || null,
      due: payload.due,
      dueTime: payload.dueTime || null,
      reminderAt: normalizeReminderAt(payload.reminderAt),
      priority: payload.priority,
      status: payload.status,
      creator: this.currentUser,
      assignee: lead,
      assigneeIds,
      woNumber,
      reminderOffset: payload.reminderOffset || null,
      watchers: payload.watchers || [],
      subtasks: Array.isArray(payload.subtasks)
        ? payload.subtasks.map(s => ({ t: App.utils.upper(s.t), d: !!s.d }))
        : [],
      activity: [{
        who: this.getUserName(this.currentUser),
        // activityWhat lets a caller that wraps createTask (duplicateTask) write
        // an honest first history entry instead of the generic "created" one.
        what: payload.activityWhat || (lead === this.currentUser
          ? 'created this task'
          : `assigned this to ${App.directory.person(lead) ? App.directory.person(lead).name : lead}`),
        at: new Date().toISOString(),
        when: 'just now',
      }],
    };
    this.taskModel.add(task);

    const creatorName = this.getUserName(this.currentUser);
    const creatorEmail = App.directory.person(this.currentUser) ? App.directory.person(this.currentUser).email : '';
    const leadName = App.directory.person(lead) ? App.directory.person(lead).name : lead;
    const leadEmail = App.directory.person(lead) ? App.directory.person(lead).email : '';
    const titleEsc = App.utils.escapeHtml(task.title);
    const delegated = assigneeIds.some(id => id !== this.currentUser);
    const assigneeNames = assigneeIds.map(id => (App.directory.person(id) ? App.directory.person(id).name : id)).join(' + ');

    const inapp = [];
    const emails = [];
    if (creatorEmail) emails.push(creatorEmail);

    // Fan out to EVERY assignee (not just the lead): in-app if enabled, and email
    // whenever they have an address on file. _deliver de-dupes, so the creator /
    // assignee overlap still yields a single email. Never notify yourself about
    // your own create.
    assigneeIds.forEach(id => {
      if (id === this.currentUser) return;
      if (payload.notify.inapp) {
        inapp.push({
          memberId: id,
          taskId: task.id,
          meta: 'Task assigned',
          html: `<strong>${App.utils.escapeHtml(creatorName)}</strong> assigned <em>${titleEsc}</em> to you`,
        });
      }
      if (App.directory.person(id) && App.directory.person(id).email) emails.push(App.directory.person(id).email);
    });

    (payload.watchers || []).forEach(w => {
      if (payload.notify.watchers) {
        inapp.push({
          memberId: w,
          taskId: task.id,
          meta: 'Watching',
          html: `You're now watching <em>${titleEsc}</em> (assigned to ${App.utils.escapeHtml(leadName)})`,
        });
      }
      if (App.directory.person(w) && App.directory.person(w).email) emails.push(App.directory.person(w).email);
    });

    // Persist the new task to Supabase BEFORE delivering its in-app notifications.
    // Each notification row carries task_id (a FK to tasks.id), and — crucially for
    // a worker assigning to a teammate — the ONLY policy that lets a worker insert a
    // notification for someone else is migration 040's creator_can_notify_member,
    // which checks that the referenced task already exists with them as creator. The
    // task's real save is debounced (~350ms), so delivering first hits a not-yet-
    // saved task: the FK trips, sendNotifications retries with task_id nulled, and
    // that strips the worker's only permission → RLS rejects the notification.
    // Saving first (awaitable saveNow, wired in app.js) closes the race. If the save
    // itself fails (e.g. RLS), skip delivery — it would only fail too, and doSave has
    // already surfaced the underlying error.
    const saved = this.saveNow ? await this.saveNow() : true;

    if (saved) {
      this._deliver(inapp, emails, {
        subject: `Quest HQ — ${task.title}`,
        html: this._emailBody(`<strong>${App.utils.escapeHtml(creatorName)}</strong> created the task <strong>${titleEsc}</strong> (assigned to ${App.utils.escapeHtml(assigneeNames)}).`, task),
      });

      // "View" opens the freshly-created task's detail — one click to see what
      // they just made (the task is already selected in state, so re-emitting
      // selection:changed opens the pane even if setView('all') is a no-op).
      const viewAction = {
        label: 'View',
        onClick: () => {
          this.uiState.selectedTaskId = task.id;
          this.setView('all');
          App.EventBus.emit('selection:changed');
        },
      };
      if (delegated) {
        this.toastView.show({
          title: `Task assigned to ${assigneeNames}`,
          sub: leadEmail ? `Notifying ${assigneeNames}` : 'In-app notification sent',
          action: viewAction,
        });
      } else {
        const watcherCount = (payload.watchers || []).length;
        this.toastView.show({
          title: 'Task created',
          sub: watcherCount ? `${watcherCount} watcher${watcherCount > 1 ? 's' : ''} notified` : 'Tap View to open it',
          action: viewAction,
        });
      }
      if (payload.notify.whatsapp) {
        this.toastView.show({ title: 'WhatsApp queued', sub: 'Ping will fire if marked urgent.' });
      }
    }

    // The task lives in the local model regardless of the save outcome, so always
    // surface it — a failed save stays dirty and retries on the next change/reconnect.
    if (this.uiState.view.startsWith('time:')) {
      this.setView('all');
    }
    this.uiState.selectedTaskId = task.id;
    App.EventBus.emit('selection:changed');
    this._syncRoute();
  }

  /* ---------- timer actions ---------- */
  startTimer(userId, taskId, opts = {}) {
    if (!App.can('clock.use')) return;
    // Snapshot the task label onto the timer so the team boards can still name
    // it if the task row isn't loadable for whoever's viewing (RLS scope).
    const task = this.taskModel.find(taskId);
    const { priorEntry } = this.timeModel.startTimer(userId, taskId, {
      taskTitle: task ? task.title : null,
      taskCompany: task ? task.company : null,
    });
    if (priorEntry) {
      this.taskModel.addActivity(priorEntry.taskId, {
        who: this.getUserName(userId),
        what: `clocked ${App.utils.formatHours(priorEntry.durationMs)} on this task`,
        when: 'just now',
      });
    }
    if (task) {
      this.taskModel.addActivity(taskId, {
        who: this.getUserName(userId),
        what: 'clocked in on this task',
        when: 'just now',
      });
    }
    this.toastView.show(opts.toast || {
      title: 'Clocked in',
      sub: task ? `Tracking time on "${task.title}"` : 'Timer started',
    });
  }

  stopTimer(userId) {
    if (!App.can('clock.use')) return;
    const entry = this.timeModel.stopTimer(userId);
    if (!entry) return;
    this.taskModel.addActivity(entry.taskId, {
      who: this.getUserName(userId),
      what: `clocked ${App.utils.formatHours(entry.durationMs)} on this task`,
      when: 'just now',
    });
    this.toastView.show({
      title: 'Clocked out',
      sub: `${App.utils.formatHours(entry.durationMs)} logged`,
    });
  }

  /* ---------- team-watching: ping a direct report ---------- */
  async pingTeamMember(memberId, info = {}) {
    if (!memberId || memberId === this.currentUser) return;
    const person = App.directory.person(memberId) || { full: memberId, name: memberId };
    const fromName = (App.directory.person(this.currentUser) && App.directory.person(this.currentUser).full) || 'Your supervisor';

    const reasons = [];
    if (info.overdue > 0) reasons.push(`${info.overdue} overdue task${info.overdue > 1 ? 's' : ''}`);
    if (info.stale) reasons.push('no recent updates');
    const reason = reasons.length ? reasons.join(' · ') : 'a quick status check';

    const meta = `From ${fromName}`;
    const html = `<strong>Status check requested.</strong><br>${fromName} is asking about ${reason}.`;

    if (!this.dataStore || typeof this.dataStore.sendNotifications !== 'function') {
      if (this.toastView) this.toastView.show({ title: 'Ping unavailable', sub: 'No data store wired up.' });
      return;
    }

    // Verify the recipient has a profile row whose member_id matches — the
    // notifications table FKs to team_members(id), and the worker's poll
    // queries by their profile.member_id. If the profile is missing or the
    // slug doesn't line up, the insert will succeed but the worker will
    // never see it.
    const recipientProfile = (App.PROFILES || []).find(p => p.member_id === memberId);
    if (!recipientProfile) {
      if (this.toastView) {
        this.toastView.show({
          title: `Can't ping ${person.name || person.full}`,
          sub: 'They haven’t signed up yet, or their account isn’t linked to this team slot.',
        });
      }
      return;
    }

    try {
      await this.dataStore.sendNotifications([{ memberId, meta, html }]);
      if (this.toastView) {
        this.toastView.show({
          title: 'Pinged ' + (person.name || person.full),
          sub: 'They’ll see it within 30s of opening the app.',
        });
      }
    } catch (err) {
      console.error('[ping] sendNotifications failed', err);
      if (this.toastView) {
        this.toastView.show({
          title: 'Ping failed',
          sub: (err && err.message) || 'The notification could not be saved.',
        });
      }
    }
  }

  toggleTimerForTask(taskId) {
    if (!App.can('clock.use')) return;
    const active = this.timeModel.activeFor(this.currentUser);
    if (active && active.taskId === taskId) {
      // Pausing the task you're tracking drops you back to General shift
      // (still on the clock) so you can do other things first, rather than
      // clocking you out entirely. Use the topbar Clock widget to clock out.
      this._revertToGeneralShift(this.currentUser, 'pause');
    } else {
      this.startTimer(this.currentUser, taskId);
    }
  }

  toggleGlobalClock() {
    if (!App.can('clock.use')) return;
    const active = this.timeModel.activeFor(this.currentUser);
    if (active) {
      this.stopTimer(this.currentUser);
      return;
    }
    let target = App.can('tasks.view') && this.uiState.selectedTaskId
      ? this.taskModel.find(this.uiState.selectedTaskId)
      : this.taskModel.all().find(t => App.utils.isAssignee(t, this.currentUser) && !App.taxonomy.isDone(t));
    if (!target) target = this.taskModel.find(App.DEFAULT_CLOCK_TASK_ID);
    if (!target) {
      this.toastView.show({ title: 'Clock task missing', sub: 'Ask an admin to restore the General shift task.' });
      return;
    }
    this.startTimer(this.currentUser, target.id);
  }

  /* ---------- notifications ---------- */
  markAllNotifsRead() {
    this.notifModel.markAllRead();
  }

  /* A check-in notification's CTA was clicked: mark it read and deep-link to the
     mode's target (morning → execution order, eod → task table). Stalled has no
     route (checkinCta.route === null) and is handled by openNotification instead
     — it opens the linked task. Pushes a real history entry so Back works. */
  openCheckin(notifId) {
    const n = this.notifModel.find(notifId);
    this.notifModel.markRead(notifId);
    const cta = App.utils.checkinCta(n && n.meta);
    const route = cta && cta.route;
    if (!route) return;
    try { window.history.pushState(null, '', route); } catch (e) { /* pushState throttled/unavailable */ }
    this._applyRoute(route);
  }

  openNotification(notifId, taskId) {
    this.notifModel.markRead(notifId);
    if (taskId) {
      this.uiState.selectedTaskId = taskId;
      if (this.uiState.view.startsWith('time:')) {
        this.setView('all');
      } else {
        App.EventBus.emit('selection:changed');
      }
      this._syncRoute();
    }
  }

  /* ---------- filters ---------- */
  toggleFilters() {
    this._commit({ filtersOpen: !this.uiState.filtersOpen });
  }

  toggleFilterValue(group, value) {
    const arr = this.uiState.filters[group];
    if (!Array.isArray(arr)) return;
    const next = arr.includes(value) ? arr.filter(x => x !== value) : [...arr, value];
    this._commit({ filters: { ...this.uiState.filters, [group]: next } });
  }

  setFilterDueRange(range) {
    this._commit({ filters: { ...this.uiState.filters, dueRange: range || 'all' } });
  }

  /* Single-select company filter behind the Tasks board's top chip row. Table-
     local (drives the `companies` filter group), so it does NOT change the app-
     wide company scope (setCompany). 'all' / falsy clears it. */
  setCompanyScopeFilter(id) {
    this._commit({
      filters: { ...this.uiState.filters, companies: (id && id !== 'all') ? [id] : [] },
    });
  }

  clearFilters() {
    // Full replacement (drops projectId too) — matches the pre-seam behavior;
    // the route policy now also heals the stale #/folder hash this used to leave.
    this._commit({ filters: { assignees: [], companies: [], statuses: [], priorities: [], types: [], projects: [], labels: [], dueRange: 'all' } });
  }

  activeFilterCount() {
    const f = this.uiState.filters || {};
    return (f.assignees || []).length
      + (f.companies  || []).length
      + (f.statuses   || []).length
      + (f.priorities || []).length
      + (f.types      || []).length
      + (f.projects   || []).length
      + (f.labels     || []).length
      + ((f.dueRange && f.dueRange !== 'all') ? 1 : 0);
  }

  /* ---------- saved views (named filter+sort+group+layout presets) ---------- */
  _savedViewsKey() {
    const uid = (App.currentProfile && App.currentProfile.member_id) || this.currentUser || 'anon';
    return `questhq:saved-views:${uid}`;
  }

  getSavedViews() {
    try {
      const arr = JSON.parse(localStorage.getItem(this._savedViewsKey()) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  _writeSavedViews(arr) {
    try { localStorage.setItem(this._savedViewsKey(), JSON.stringify(arr)); } catch (e) { /* quota */ }
    App.EventBus.emit('savedviews:changed');
  }

  // Snapshot the current filters + sort + group + layout under a name.
  saveCurrentView(name) {
    const clean = String(name || '').trim();
    if (!clean) return;
    const views = this.getSavedViews();
    views.push({
      id: App.utils.uid('sv'),
      name: clean.slice(0, 40),
      filters: JSON.parse(JSON.stringify(this.uiState.filters)),
      sortBy: this.uiState.sortBy,
      sortDir: this.uiState.sortDir,
      groupBy: this.uiState.groupBy,
      layout: this.uiState.layout,
    });
    this._writeSavedViews(views);
  }

  // Apply a saved view: restore its state; _commit re-renders only the
  // surfaces whose state actually changed.
  applySavedView(id) {
    const v = this.getSavedViews().find(x => x.id === id);
    if (!v) return;
    const patch = {};
    if (v.filters && typeof v.filters === 'object') patch.filters = JSON.parse(JSON.stringify(v.filters));
    if (v.sortBy && App.SORT_OPTIONS[v.sortBy]) patch.sortBy = v.sortBy;
    if (v.sortDir === 'asc' || v.sortDir === 'desc') patch.sortDir = v.sortDir;
    if (v.groupBy && App.GROUP_OPTIONS[v.groupBy]) patch.groupBy = v.groupBy;
    if (['table', 'calendar', 'kanban', 'cards'].includes(v.layout)) patch.layout = v.layout;
    if (this.uiState.collapsedGroups.size) patch.collapsedGroups = new Set();
    this._commit(patch);
  }

  deleteSavedView(id) {
    this._writeSavedViews(this.getSavedViews().filter(x => x.id !== id));
  }

  /* ---------- sort + group ---------- */
  setSortBy(key) {
    if (!App.SORT_OPTIONS[key]) return;
    if (this.uiState.sortBy === key) {
      this._commit({ sortDir: this.uiState.sortDir === 'asc' ? 'desc' : 'asc' });
    } else {
      this._commit({ sortBy: key, sortDir: 'asc' });
    }
  }

  setGroupBy(key) {
    if (!App.GROUP_OPTIONS[key]) return;
    if (this.uiState.groupBy === key) return;
    const patch = { groupBy: key };
    // Fresh-instance contract: only include the reset when groups are actually
    // collapsed, so group:collapsed-changed doesn't fire for an empty→empty swap.
    if (this.uiState.collapsedGroups.size) patch.collapsedGroups = new Set();
    this._commit(patch);
  }

  toggleGroupCollapsed(key) {
    const next = new Set(this.uiState.collapsedGroups);
    if (next.has(key)) next.delete(key); else next.add(key);
    this._commit({ collapsedGroups: next });
  }

  /* ---------- misc ---------- */
  handleEscape() {
    if (this.uiState.creatingTask) {
      this.closeNewTaskPage();
    } else if (this.uiState.bulkMode) {
      this.exitBulkMode();
    } else if (this.uiState.selectedTaskId) {
      this.closeDetail();
    }
  }
};
