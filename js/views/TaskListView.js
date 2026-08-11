window.App = window.App || {};

App.TaskListView = class TaskListView {
  constructor({ taskModel, timeModel, controller, currentUser }) {
    this.taskModel = taskModel;
    this.timeModel = timeModel;
    this.controller = controller;
    this.currentUser = currentUser;

    this.wrap = document.getElementById('taskViewWrap');
    this.body = document.getElementById('listBody');
    this.pageEyebrow = document.getElementById('pageEyebrow');
    this.pageTitle = document.getElementById('pageTitle');

    // Task ids whose subtask drawer is expanded in the table. Held here (not on
    // the task) so it survives the frequent full re-renders without persisting.
    this.expandedRows = new Set();

    // ONE delegated listener serves every layout's task rows/cards: zero
    // re-attach cost across re-renders, one place for shared row behavior.
    // Layout-specific controls (calendar nav/cells, kanban columns, group
    // headers, team cards) bind in their adapters and stopPropagation, so
    // they never reach this handler.
    this.body.addEventListener('click', (e) => this._onRowClick(e));

    this.bindStaticButtons();
    this.subscribe();
    this.render();
  }

  /* The shared row-action vocabulary, delegated from #listBody. Anything not in
     the known set falls through to the layout's own bindings; clicks outside a
     [data-id] row (calendar cells, team cards) are ignored entirely. */
  _onRowClick(e) {
    const actionEl = e.target.closest('[data-action]');
    // Subtask drawer checkboxes live in a sibling drawer keyed by data-for.
    if (actionEl && actionEl.dataset.action === 'toggle-subtask') {
      const drawer = actionEl.closest('.subtask-drawer');
      if (!drawer) return;
      e.stopPropagation();
      this.controller.toggleSubtask(drawer.dataset.for, parseInt(actionEl.dataset.idx, 10));
      return;
    }
    const rowEl = e.target.closest('[data-id]');
    if (!rowEl) return;
    const id = rowEl.dataset.id;
    if (actionEl) {
      const action = actionEl.dataset.action;
      const known = {
        'bulk-toggle': 1, 'toggle-done': 1, 'open-status': 1, 'open-priority': 1,
        'toggle-timer': 1, 'finish-task': 1, 'toggle-subtasks': 1, 'open-project': 1,
        'open-quick': 1, 'remove-focus': 1,
      };
      if (!known[action]) return; // layout-specific — its adapter's binding handles it
      e.stopPropagation();
      if (action === 'bulk-toggle') this.controller.toggleBulkSelect(id);
      else if (action === 'toggle-done') { if (actionEl.checked && App.Motion) App.Motion.pop(actionEl); this.controller.toggleTaskDone(id); }
      else if (action === 'open-status') this._openStatusMenu(id, actionEl);
      else if (action === 'open-priority') this._openStatusMenu(id, actionEl, 'priority');
      else if (action === 'toggle-timer') this.controller.toggleTimerForTask(id);
      else if (action === 'finish-task') { if (!actionEl.classList.contains('is-done') && App.Motion) App.Motion.check(actionEl.querySelector('i')); this.controller.completeTask(id); }
      else if (action === 'toggle-subtasks') this._toggleSubtaskDrawer(id, rowEl, actionEl);
      else if (action === 'open-project') { const t = this.taskModel.find(id); if (t) this._openProjectMenu(t, actionEl); }
      else if (action === 'open-quick') this._openQuickSheet(id);
      else if (action === 'remove-focus') this.controller.removeFromFocus(id);
      return;
    }
    // Row-body click: select (bulk-toggle in bulk mode). Drag clicks don't select.
    if (rowEl.classList.contains('dragging')) return;
    if (this.controller.uiState.bulkMode) { this.controller.toggleBulkSelect(id); return; }
    this.controller.selectTask(id);
  }

  bindStaticButtons() {
    document.getElementById('newTaskBtn').addEventListener('click', () => this.controller.openNewTaskPage());
    document.getElementById('filterBtn').addEventListener('click', () => this.controller.toggleFilters());
    const selectBtn = document.getElementById('selectBtn');
    if (selectBtn) {
      selectBtn.addEventListener('click', () => this.controller.toggleBulkMode());
      App.EventBus.on('bulk:changed', () => selectBtn.classList.toggle('active', !!this.controller.uiState.bulkMode));
    }
    document.querySelectorAll('#layoutSwitcher [data-layout]').forEach(btn => {
      btn.addEventListener('click', () => this.controller.setLayout(btn.dataset.layout));
    });
    const clearDoneBtn = document.getElementById('clearDoneBtn');
    if (clearDoneBtn) clearDoneBtn.addEventListener('click', () => this.controller.clearDoneTasks());
    // Column-filter wiring is table-specific — TableLayout.mount() owns it.
  }

  /* "Clear done" lives in the toolbar (outside the table). Show it only when
     the current view actually contains done tasks and the user can write. */
  _syncClearDoneBtn() {
    const btn = document.getElementById('clearDoneBtn');
    if (!btn) return;
    const hasDone = App.can('tasks.write') &&
      this.getFilteredTasks().some(t => App.taxonomy.isDone(t));
    btn.hidden = !hasDone;
  }

  subscribe() {
    App.EventBus.on('tasks:changed', () => { if (this.visible()) this.render(); });
    App.EventBus.on('time:changed', () => { if (this.visible()) this.renderList(); });
    App.EventBus.on('selection:changed', () => { if (this.visible()) this._syncSelectionHighlight(); });
    App.EventBus.on('search:changed', () => { if (this.visible()) this.renderList(); });
    App.EventBus.on('layout:changed', () => { if (this.visible()) this.render(); });
    App.EventBus.on('calendar:changed', () => { if (this.visible() && this.controller.uiState.layout === 'calendar') this.renderList(); });
    App.EventBus.on('view:changed', (view) => {
      this.applyHeader(view);
      if (this.visible()) this.render();
    });
    App.EventBus.on('company:changed', () => { if (this.visible()) this.render(); });
    App.EventBus.on('role:changed', () => { if (this.visible()) this.render(); });
    App.EventBus.on('filters:changed', () => { if (this.visible()) this.renderList(); });
    App.EventBus.on('scope:changed',   () => { if (this.visible()) this.renderList(); });
    App.EventBus.on('sort:changed',    () => { if (this.visible()) this.renderList(); });
    App.EventBus.on('group:changed',   () => { if (this.visible()) this.renderList(); });
    App.EventBus.on('group:collapsed-changed', () => { if (this.visible()) this.renderList(); });
  }

  visible() {
    return !this.wrap.classList.contains('hidden');
  }

  applyHeader(view) {
    const titles = {
      'all':       { eyebrow: 'This week',          title: 'All tasks' },
      'mine':      { eyebrow: 'Assigned to you',    title: 'My tasks' },
      'hot':       { eyebrow: 'Critical + Urgent',  title: 'Urgent tasks' },
      'today':     { eyebrow: 'Today',              title: 'Due today' },
      'overdue':   { eyebrow: 'Past due',           title: 'Overdue' },
      'watching':  { eyebrow: 'Tasks you\'re watching', title: 'Watching' },
      'time:mine':      { eyebrow: 'Time tracking', title: 'My time' },
      'time:resource':  { eyebrow: 'Time tracking', title: 'Team workload' },
      'approvals':      { eyebrow: 'Admin', title: 'Approvals' },
      'admin:clock':    { eyebrow: 'Admin', title: 'Clock dashboard' },
      'admin:reports':  { eyebrow: 'Admin', title: 'Problem reports' },
      // The head-card is shared with the task list and otherwise goes stale
      // ("All tasks") on the admin Task-setup page. Give it its own label; the
      // map is re-applied on every view change, so other views self-heal.
      'admin:task-setup': { eyebrow: 'Admin', title: 'Task setup' },
      'team:hierarchy': { eyebrow: 'Org', title: 'Team hierarchy' },
    };
    let t = titles[view];
    if (!t && view.startsWith('company:')) {
      const id = view.split(':')[1];
      const c = App.directory.company(id);
      t = { eyebrow: 'Company', title: (c && c.label) || id };
    }
    if (!t && view.startsWith('person:')) {
      const id = view.split(':')[1];
      const p = App.directory.person(id);
      t = { eyebrow: 'Assigned to', title: (p && p.name) || id };
    }
    if (t) {
      this.pageEyebrow.textContent = t.eyebrow;
      this.pageTitle.textContent = t.title;
    }
  }

  render() {
    if (!App.can('tasks.view')) return;
    this.renderStats();
    this.syncLayoutSwitcher();
    this.renderList();
  }

  syncLayoutSwitcher() {
    const active = this.controller.uiState.layout;
    document.querySelectorAll('#layoutSwitcher [data-layout]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.layout === active);
    });
    const header = document.querySelector('#taskViewWrap .list-header');
    if (header) header.classList.toggle('hidden', active !== 'table');
  }

  renderStats() {
    const tasks = this.taskModel.all();
    const today = App.utils.todayISO(0);
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('stat-open', tasks.filter(t => !App.taxonomy.isDone(t)).length);
    set('stat-today', tasks.filter(t => t.due === today && !App.taxonomy.isDone(t)).length);
    set('stat-review', tasks.filter(t => t.status === 'review').length);
    set('stat-done', tasks.filter(t => App.taxonomy.isDone(t)).length);
  }

  // The filtered task set, shared with the calendar + CSV export so all three
  // always agree on what's visible. (Supervisor scoping etc. lives in the
  // controller method.)
  getFilteredTasks() {
    return this.controller.getVisibleTasks();
  }

  renderList() {
    this._syncClearDoneBtn();
    // Preserve the scroll position across full rebuilds so a background poll
    // merge or a timer toggle doesn't jump the user back to the top.
    const pane = this.body.closest('.list-pane');
    const scrollTop = pane ? pane.scrollTop : 0;
    const out = this._renderListInner();
    if (pane && scrollTop) pane.scrollTop = scrollTop;
    return out;
  }

  /* Which Layout (CONTEXT.md) presents the visible tasks right now. Watching is
     a *view* (not a layout); "execution order" rides the sort key — both beat
     the layout switcher. */
  _layoutKey() {
    if (this.controller.uiState.view === 'watching') return 'watching';
    const l = this.controller.uiState.layout;
    if (l === 'kanban' || l === 'cards' || l === 'calendar') return l;
    // Manual order ('focus' sort) now renders as drag-reorderable rows INSIDE
    // the table (see TableLayout), not a standalone layout.
    return 'table';
  }

  _renderListInner() {
    // Reflect bulk-select mode on <body> so CSS can reveal the row checkboxes.
    document.body.classList.toggle('is-bulk', !!this.controller.uiState.bulkMode);
    // The prototype "qt" skin (css/tasks.css) is scoped to the Table layout via
    // #taskViewWrap.qt-skin. Drop it for every other layout so their CSS isn't
    // scoped away; the table adapter re-adds it.
    this.wrap.classList.remove('qt-skin');
    // Tear down any Focus-list drag listeners from the previous render — the
    // #listBody element is reused, so they'd otherwise stack and double-fire.
    if (this._focusCleanup) { this._focusCleanup(); this._focusCleanup = null; }
    // Dispatch to the active layout adapter (App.TaskListLayouts — one file per
    // layout under js/views/tasklist/). unmount/mount fire on layout SWITCHES,
    // not on every re-render.
    const adapter = App.TaskListLayouts[this._layoutKey()];
    if (this._activeAdapter && this._activeAdapter !== adapter && this._activeAdapter.unmount) this._activeAdapter.unmount(this);
    if (adapter !== this._activeAdapter && adapter.mount) adapter.mount(this);
    this._activeAdapter = adapter;
    return adapter.render(this, this.getFilteredTasks());
  }

  /* Selecting a task only changes which row is highlighted — toggle the class
     in place instead of rebuilding the whole list (which lost scroll position
     and thrashed the DOM on every click). The detail pane is opened separately
     by TaskDetailView's own selection:changed handler. */
  _syncSelectionHighlight() {
    const id = this.controller.uiState.selectedTaskId;
    this.body.querySelectorAll('[data-id].selected').forEach(el => el.classList.remove('selected'));
    if (id != null) {
      const safe = (window.CSS && CSS.escape) ? CSS.escape(String(id)) : String(id);
      const el = this.body.querySelector(`[data-id="${safe}"]`);
      if (el) el.classList.add('selected');
    }
    // Repaint bulk-selection state in place (toggleBulkSelect emits
    // selection:changed rather than re-rendering the whole list).
    const sel = this.controller.uiState.bulkSelected;
    this.body.querySelectorAll('[data-id]').forEach(el => {
      const on = sel.has(el.dataset.id);
      el.classList.toggle('bulk-selected', on);
      const cb = el.querySelector('.bulk-check');
      if (cb) cb.setAttribute('aria-pressed', String(on));
    });
  }




  renderKanbanCard(t) {
    const person = App.directory.person(t.assignee) || App.directory.personFallback(t.assignee);
    const company = App.directory.company(t.company) || App.directory.companyFallback(t.company);
    const tyLabel = App.taxonomy.typeLabel(t.company, t.type);
    const lblLabel = (t.label && t.label !== 'none') ? App.taxonomy.labelLabel(t.company, t.label) : null;
    const priority = App.PRIORITIES[t.priority] || App.PRIORITIES.medium;
    const due = App.utils.formatDue(t.due);
    const selected = this.controller.uiState.selectedTaskId === t.id;
    const isDone = App.taxonomy.isDone(t);
    const subs = Array.isArray(t.subtasks) ? t.subtasks : [];
    const subDone = subs.filter(s => s.d).length;

    const card = document.createElement('div');
    card.className = 'kanban-card' + (selected ? ' selected' : '') + (isDone ? ' done' : '');
    card.dataset.id = t.id;
    card.innerHTML = `
      <div class="kanban-card-head">
        <span class="type-text">${App.utils.escapeHtml(tyLabel)}${lblLabel ? ` · ${App.utils.escapeHtml(lblLabel)}` : ''}</span>
        <span class="priority-dot ${priority.cls}" title="${priority.label}"></span>
      </div>
      <div class="kanban-card-title">${App.utils.escapeHtml(t.title)}</div>
      <div class="kanban-card-meta">
        <span class="pill ${company.pill}">${App.utils.escapeHtml(company.label)}</span>
        <span class="due-cell ${due.cls}">${due.text}${t.dueTime ? ` · ${App.utils.formatClockTz(t.dueTime)}` : ''}</span>
      </div>
      <div class="kanban-card-foot">
        ${App.utils.avatarHtml(person)}
        <span class="kanban-card-assignee">${App.utils.escapeHtml(person.name)}</span>
        ${subs.length ? `<span class="kanban-subtask-badge" title="${subDone}/${subs.length} subtasks done"><i class="ti ti-checklist"></i>${subDone}/${subs.length}</span>` : ''}
      </div>
    `;
    // Click-to-select is handled by the delegated _onRowClick (card has data-id).
    App.utils.makeActivatable(card, null, `Open task: ${t.title}`);
    return card;
  }


  renderRow(t) {
    const person = App.directory.person(t.assignee) || App.directory.personFallback(t.assignee);
    const type = App.TASK_TYPES[t.type] || App.TASK_TYPES.admin;
    const company = App.directory.company(t.company) || App.directory.companyFallback(t.company);
    const status = App.STATUSES[t.status] || App.STATUSES.todo;
    const stLabel = App.taxonomy.statusLabel(t.company, t.type, t.status);
    const stChip = App.taxonomy.chipStyle('status', t.company, t.status, t.type);
    const tyLabel = App.taxonomy.typeLabel(t.company, t.type);
    const tyChip = App.taxonomy.chipStyle('type', t.company, t.type);
    const priority = App.PRIORITIES[t.priority] || App.PRIORITIES.medium;
    const due = App.utils.formatDue(t.due);
    const selected = this.controller.uiState.selectedTaskId === t.id;
    const isDone = App.taxonomy.isDone(t);
    const myActive = this.timeModel.activeFor(this.currentUser);
    const myTimerOnThis = myActive && myActive.taskId === t.id;

    // Subtasks: a collapsible drawer hangs under the row. The title cell gets a
    // chevron + "done/total" badge when there are any.
    const subs = Array.isArray(t.subtasks) ? t.subtasks : [];
    const subCount = subs.length;
    const subDone = subs.filter(s => s.d).length;
    const expanded = this.expandedRows.has(t.id);

    const bulkSel = this.controller.isBulkSelected(t.id);
    const row = document.createElement('div');
    row.className = 'list-row' + (selected ? ' selected' : '') + (bulkSel ? ' bulk-selected' : '');
    row.dataset.id = t.id;
    row.innerHTML = `
      <button type="button" class="bulk-check" data-action="bulk-toggle" aria-label="Select task" aria-pressed="${bulkSel}"><i class="ti ti-check"></i></button>
      <input type="checkbox" ${isDone ? 'checked' : ''} data-action="toggle-done" ${App.can('tasks.write') ? '' : 'disabled'} />
      <span class="row-dot ${priority.cls}" title="${priority.label}"></span>
      <div class="task-title-cell ${isDone ? 'done' : ''}">
        ${subCount ? `<button class="subtask-toggle${expanded ? ' expanded' : ''}" data-action="toggle-subtasks" aria-label="Toggle subtasks" title="${subDone}/${subCount} subtasks done"><i class="ti ti-chevron-right"></i></button>` : '<span class="subtask-spacer" aria-hidden="true"></span>'}
        <span class="tt-text">${App.utils.escapeHtml(t.title)}</span>
        ${subCount ? `<span class="subtask-badge">${subDone}/${subCount}</span>` : ''}
        ${(() => {
          const proj = App.directory.project(t.project);
          if (proj) return `<button class="projtag projtag-btn" data-action="open-project" data-current="${App.utils.escapeHtml(t.project)}" title="Change project" aria-haspopup="listbox" aria-expanded="false" style="--pc:${App.utils.escapeHtml(proj.color)}"><i class="ti ti-folder"></i>${App.utils.escapeHtml(proj.name)}</button>`;
          if (App.can('tasks.write')) return `<button class="projtag projtag-btn projtag-empty" data-action="open-project" data-current="" title="Add to project" aria-haspopup="listbox" aria-expanded="false"><i class="ti ti-folder-plus"></i>Project</button>`;
          return '';
        })()}
      </div>
      <div class="status-cell">${App.can('tasks.write')
        ? `<button class="status-sel status-${t.status || 'todo'}" style="${stChip.style}" data-action="open-status" data-current="${t.status || 'todo'}" title="Change status" aria-haspopup="listbox" aria-expanded="false">
            <span class="status-dot"></span><span class="status-sel-label">${App.utils.escapeHtml(stLabel)}</span><i class="status-sel-caret ti ti-chevron-down" aria-hidden="true"></i>
          </button>`
        : `<span class="status-sel status-${t.status || 'todo'}" style="${stChip.style}"><span class="status-dot"></span><span class="status-sel-label">${App.utils.escapeHtml(stLabel)}</span></span>`}</div>
      <div class="priority-cell">${App.can('tasks.write')
        ? `<button class="priority-block ${priority.cls}" data-action="open-priority" data-current="${t.priority || 'medium'}" title="Change priority" aria-haspopup="listbox" aria-expanded="false">${priority.label}<i class="priority-caret ti ti-chevron-down" aria-hidden="true"></i></button>`
        : `<span class="priority-block ${priority.cls}">${priority.label}</span>`}</div>
      <div class="type-cell"><span class="type-text type-${t.type || 'admin'}" style="${tyChip.style}">${App.utils.escapeHtml(tyLabel)}</span></div>
      <div class="label-cell"><span class="co-chip co-${t.company || 'roofing'}"><span class="co-dot"></span>${App.utils.escapeHtml(company.label)}</span></div>
      <div class="meta-cell" style="display:flex; align-items:center; gap:6px;">
        ${App.utils.avatarHtml(person)}${App.utils.escapeHtml(person.name)}
      </div>
      <div class="due-cell ${due.cls}">${due.text}${t.dueTime ? `<span class="due-time">${App.utils.formatClockTz(t.dueTime)}</span>` : ''}</div>
      <button class="timer-btn ${myTimerOnThis ? 'active' : ''} ${App.can('clock.use') ? '' : 'hidden'}" data-action="toggle-timer" title="${myTimerOnThis ? 'Pause — back to General shift' : 'Start timer'}">
        <i class="ti ${myTimerOnThis ? 'ti-player-pause-filled' : 'ti-player-play'}"></i>
      </button>
      <button class="finish-btn ${isDone ? 'is-done' : ''} ${App.can('tasks.write') ? '' : 'hidden'}" data-action="finish-task" title="${isDone ? 'Mark as not done' : 'Finish this task'}" aria-label="${isDone ? 'Mark as not done' : 'Finish this task'}">
        <i class="ti ${isDone ? 'ti-check' : 'ti-circle-check'}"></i>
      </button>
      <button type="button" class="quick-actions-btn ${App.can('tasks.write') ? '' : 'hidden'}" data-action="open-quick" aria-label="Quick actions" aria-haspopup="dialog"><i class="ti ti-dots-vertical"></i></button>
    `;

    // Row clicks (actions + select) are handled by the delegated _onRowClick.

    // Swipe-to-reveal actions: wrap the row in a horizontal scroll-snap
    // container with Done/Delete buttons that the user swipes left to expose
    // (touch only; the wrapper is inert on desktop). Native scrolling — far
    // more reliable than JS gesture tracking.
    const node = this._wrapSwipe(row, t);

    if (!subCount) return node;

    // Drawer sits as a sibling right after the row inside the group body.
    const drawer = document.createElement('div');
    drawer.className = 'subtask-drawer' + (expanded ? '' : ' hidden');
    drawer.dataset.for = t.id;
    drawer.innerHTML = subs.map((s, i) =>
      `<label class="subtask-line ${s.d ? 'done' : ''}">
        <input type="checkbox" ${s.d ? 'checked' : ''} data-action="toggle-subtask" data-idx="${i}" ${App.can('tasks.write') ? '' : 'disabled'} />
        <span>${App.utils.escapeHtml(s.t)}</span>
      </label>`
    ).join('');
    // Drawer checkbox clicks are handled by the delegated _onRowClick
    // (toggle-subtask resolves the task id from the drawer's data-for).

    const frag = document.createDocumentFragment();
    frag.appendChild(node);
    frag.appendChild(drawer);
    return frag;
  }

  // Wrap a task row in a horizontal scroll-snap container with Done / Delete
  // action buttons revealed by swiping left. CSS keeps the wrapper inert
  // (display:contents) on non-touch devices, so desktop is unaffected. Returns
  // the row unchanged when the user can't act on it (nothing to reveal).
  _wrapSwipe(row, t) {
    if (!App.can('tasks.write')) return row;
    const canDelete = this.controller.canDeleteTask(t);
    const isDone = App.taxonomy.isDone(t);
    const wrap = document.createElement('div');
    wrap.className = 'swipe-wrap';
    const actions = document.createElement('div');
    actions.className = 'swipe-actions';
    actions.innerHTML =
      `<button type="button" class="swipe-act swipe-done" data-swipe="done" aria-label="${isDone ? 'Reopen task' : 'Mark done'}">
         <i class="ti ${isDone ? 'ti-rotate' : 'ti-circle-check'}"></i><span>${isDone ? 'Reopen' : 'Done'}</span>
       </button>` +
      (canDelete
        ? `<button type="button" class="swipe-act swipe-del" data-swipe="del" aria-label="Delete task">
             <i class="ti ti-trash"></i><span>Delete</span>
           </button>`
        : '');
    wrap.appendChild(row);
    wrap.appendChild(actions);
    actions.addEventListener('click', (e) => {
      const b = e.target.closest('[data-swipe]');
      if (!b) return;
      e.stopPropagation();
      // Snap the row closed before acting (the delete re-render removes it
      // anyway; the complete keeps it, so reset the scroll position).
      try { wrap.scrollTo({ left: 0, behavior: 'smooth' }); } catch (_) { wrap.scrollLeft = 0; }
      if (b.dataset.swipe === 'done') {
        if (!App.taxonomy.isDone(t) && App.Motion) App.Motion.check(b.querySelector('i'));
        this.controller.completeTask(t.id);
      }
      else if (b.dataset.swipe === 'del') {
        // Collapse the row out (fade + slide + shrink) before the model delete
        // re-renders, so the removal is seen. The Undo toast still fires.
        if (App.Motion) App.Motion.collapseOut(wrap, () => this.controller.deleteTask(t.id));
        else this.controller.deleteTask(t.id);
      }
    });
    return wrap;
  }

  _toggleSubtaskDrawer(taskId, row, toggleBtn) {
    const willExpand = !this.expandedRows.has(taskId);
    if (willExpand) this.expandedRows.add(taskId);
    else this.expandedRows.delete(taskId);
    // The drawer is a sibling of the row's .swipe-wrap, so row.nextElementSibling
    // points at .swipe-actions (inside the wrap), not the drawer. Find the drawer
    // by its data-for id so it toggles immediately, wrapped or not.
    const safe = (window.CSS && CSS.escape) ? CSS.escape(String(taskId)) : String(taskId);
    const drawer = this.body.querySelector(`.subtask-drawer[data-for="${safe}"]`);
    if (drawer) drawer.classList.toggle('hidden', !willExpand);
    if (toggleBtn) toggleBtn.classList.toggle('expanded', willExpand);
  }

  // ---- Empty states --------------------------------------------------------
  // Copy is tailored to the active view: a "good" empty (nothing overdue) reads
  // as reassurance with no CTA, while a "blank slate" empty (no tasks at all)
  // offers a New task button when the user can create.
  _emptyConfig() {
    const view = this.controller.uiState.view;
    const byView = {
      all:     { icon: 'ti-clipboard-list', title: 'No tasks yet',          sub: 'Create the first task and it shows up here.',           cta: true },
      mine:    { icon: 'ti-coffee',         title: 'Nothing on your plate', sub: 'No tasks are assigned to you right now.',               cta: true },
      hot:     { icon: 'ti-flame',          title: 'Nothing urgent',        sub: 'No critical or urgent tasks. All calm.' },
      today:   { icon: 'ti-sun',            title: 'Nothing due today',     sub: "You're clear for the day." },
      overdue: { icon: 'ti-circle-check',   title: 'Nothing overdue',       sub: 'Everything is on schedule.' },
    };
    if (byView[view]) return byView[view];
    // Narrow filters get a "Show all tasks" escape hatch so an empty filtered
    // view never strands the user thinking their tasks disappeared.
    if (view.startsWith('person:'))  return { icon: 'ti-user',     title: 'No tasks assigned', sub: 'This person has no tasks in the current scope.', cta: true, backToAll: true };
    if (view.startsWith('company:')) return { icon: 'ti-building', title: 'No tasks here',     sub: 'No tasks for this company yet.',                cta: true, backToAll: true };
    return { icon: 'ti-checks', title: 'Nothing here', sub: 'No tasks match this view.' };
  }

  _renderEmpty({ icon, title, sub, cta, backToAll }) {
    // Honest empty state: if tasks EXIST here but the search box / filter bar /
    // "My work" scope hide them all, say so — "Nothing scheduled" over a full
    // list reads as wiped data (the it-didn't-get-saved panic). One click clears
    // the narrowing and brings everything back.
    let clearNarrowing = false;
    const hidden = this.controller.hiddenByNarrowingCount
      ? this.controller.hiddenByNarrowingCount() : 0;
    if (hidden > 0) {
      icon = 'ti-filter-off';
      title = `${hidden} task${hidden === 1 ? ' is' : 's are'} hidden`;
      sub = 'Your search, filters or "My work" scope hide everything in this view.';
      clearNarrowing = true;
      cta = false;
      backToAll = false;
    }
    const showCta = cta && App.can('tasks.write');
    this.body.className = '';
    this.body.innerHTML = `<div class="empty">
      <i class="ti ${icon}"></i>
      <div class="empty-title">${App.utils.escapeHtml(title)}</div>
      <div class="empty-sub">${App.utils.escapeHtml(sub)}</div>
      <div class="empty-actions">
        ${clearNarrowing ? `<button class="btn btn-primary empty-clear" type="button" data-action="empty-clear-narrowing"><i class="ti ti-filter-off"></i>Clear search & filters</button>` : ''}
        ${backToAll ? `<button class="btn empty-back" type="button" data-action="empty-show-all"><i class="ti ti-list-check"></i>Show all tasks</button>` : ''}
        ${showCta ? `<button class="btn btn-primary empty-cta" type="button" data-action="empty-new-task"><i class="ti ti-plus"></i>New task</button>` : ''}
      </div>
    </div>`;
    const newBtn = this.body.querySelector('[data-action="empty-new-task"]');
    if (newBtn) newBtn.addEventListener('click', () => this.controller.openNewTaskPage());
    const allBtn = this.body.querySelector('[data-action="empty-show-all"]');
    if (allBtn) allBtn.addEventListener('click', () => this.controller.setView('all'));
    const clearBtn = this.body.querySelector('[data-action="empty-clear-narrowing"]');
    if (clearBtn) clearBtn.addEventListener('click', () => this.controller.clearNarrowing());
  }

  // ---- Inline status menu --------------------------------------------------
  _openProjectMenu(t, trigger) {
    App.projectPicker.open({
      anchor: trigger,
      companyId: t.company,
      currentId: t.project || null,
      onSelect: (projectId) => this.controller.updateTaskField(t.id, 'project', projectId),
    });
  }

  /* The status/priority chooser — field is 'status' (default) or 'priority',
     the same popover drives both. App.Menu owns the choreography (fixed
     positioning + flip, click-away, Esc, close-on-scroll, aria-expanded,
     focus return); this site owns the option list + keyboard item nav. */
  _openStatusMenu(taskId, trigger, field = 'status') {
    // Re-clicking the open trigger toggles it shut.
    if (this._statusMenuHandle && this._statusMenuTrigger === trigger) {
      this._statusMenuHandle.close('api');
      return;
    }
    const dict = field === 'priority' ? App.PRIORITIES : App.STATUSES;
    const current = trigger.dataset.current || (field === 'priority' ? 'medium' : 'todo');
    const handle = App.Menu.open({
      anchor: trigger,
      className: 'status-menu',
      // Fixed popover over a scrolling list: close rather than chase the anchor.
      repositionOnScroll: false,
      onClose: () => { this._statusMenuHandle = null; this._statusMenuTrigger = null; },
      build: (el, h) => {
        el.setAttribute('role', 'listbox');
        el.setAttribute('aria-label', field === 'priority' ? 'Set priority' : 'Set status');
        el.style.minWidth = Math.max(trigger.getBoundingClientRect().width, 168) + 'px';
        el.innerHTML = Object.entries(dict).map(([k, v]) =>
          `<button class="status-menu-item" role="option" data-key="${k}" aria-selected="${k === current}">
            <span class="status-dot ${v.cls}"></span>
            <span class="status-menu-label">${App.utils.escapeHtml(v.label)}</span>
            <i class="ti ti-check status-menu-check"></i>
          </button>`
        ).join('');
        const apply = (key) => { h.close('api'); this.controller.updateTaskField(taskId, field, key); };
        el.querySelectorAll('.status-menu-item').forEach(item => {
          item.addEventListener('click', (e) => { e.stopPropagation(); apply(item.dataset.key); });
        });
        el.addEventListener('keydown', (e) => {
          const items = [...el.querySelectorAll('.status-menu-item')];
          const idx = items.indexOf(document.activeElement);
          if (e.key === 'ArrowDown')      { e.preventDefault(); (items[idx + 1] || items[0]).focus(); }
          else if (e.key === 'ArrowUp')   { e.preventDefault(); (items[idx - 1] || items[items.length - 1]).focus(); }
          else if (e.key === 'Home')      { e.preventDefault(); items[0].focus(); }
          else if (e.key === 'End')       { e.preventDefault(); items[items.length - 1].focus(); }
          else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (idx >= 0) apply(items[idx].dataset.key); }
          else if (e.key === 'Tab')       { h.close('api'); }
          // Escape is handled by App.Menu.
        });
        const sel = el.querySelector('[aria-selected="true"]') || el.querySelector('.status-menu-item');
        if (sel) sel.focus();
      },
    });
    this._statusMenuHandle = handle;
    this._statusMenuTrigger = trigger;
  }

  // ---- Mobile quick-actions bottom sheet -----------------------------------
  // A thumb-friendly menu on each task card. Surfaces the two actions that
  // aren't already reachable from the card — Reassign and Set due — plus
  // Status / Mark done / Clock for one consolidated menu. App.Menu's 'sheet'
  // presentation owns the backdrop / Esc / dismissal choreography; the sub-
  // screens (root, status, reassign, due) render into the handle's element.
  _openQuickSheet(taskId) {
    if (this._quickSheetHandle) this._quickSheetHandle.close('api');
    this._quickSheetTaskId = taskId;
    this._quickSheetHandle = App.Menu.open({
      present: 'sheet',
      className: 'quick-sheet',
      onClose: () => { this._quickSheetHandle = null; this._quickSheetTaskId = null; },
      build: (el) => { el.setAttribute('aria-label', 'Task quick actions'); },
    });
    this._quickSheetEl = this._quickSheetHandle.el;
    this._renderQuickRoot();
  }

  _closeQuickSheet() {
    if (this._quickSheetHandle) this._quickSheetHandle.close('api');
  }

  _renderQuickRoot() {
    const t = this.taskModel.find(this._quickSheetTaskId);
    if (!t) return this._closeQuickSheet();
    const myActive = this.timeModel.activeFor(this.currentUser);
    const onThis = myActive && myActive.taskId === t.id;
    const isDone = App.taxonomy.isDone(t);
    const el = this._quickSheetEl;
    el.innerHTML = `
      <div class="quick-sheet-title">${App.utils.escapeHtml(t.title)}</div>
      <button type="button" class="quick-sheet-item" data-q="status"><i class="ti ti-circle-dot"></i><span>Change status</span></button>
      <button type="button" class="quick-sheet-item" data-q="done"><i class="ti ti-circle-check"></i><span>${isDone ? 'Mark not done' : 'Mark done'}</span></button>
      ${App.can('clock.use') ? `<button type="button" class="quick-sheet-item" data-q="clock"><i class="ti ${onThis ? 'ti-player-pause' : 'ti-player-play'}"></i><span>${onThis ? 'Clock out' : 'Clock in'}</span></button>` : ''}
      <button type="button" class="quick-sheet-item" data-q="reassign"><i class="ti ti-user"></i><span>Reassign</span></button>
      <button type="button" class="quick-sheet-item" data-q="due"><i class="ti ti-calendar"></i><span>Set due date</span></button>
      <div class="quick-sheet-foot"><button type="button" class="quick-sheet-item quick-sheet-cancel" data-q="cancel"><span>Cancel</span></button></div>
    `;
    el.querySelectorAll('[data-q]').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      this._onQuickRootAction(b.dataset.q);
    }));
  }

  _onQuickRootAction(q) {
    const id = this._quickSheetTaskId;
    if (q === 'cancel') return this._closeQuickSheet();
    if (q === 'done') { this.controller.completeTask(id); return this._closeQuickSheet(); }
    if (q === 'clock') { this.controller.toggleTimerForTask(id); return this._closeQuickSheet(); }
    if (q === 'status') return this._renderQuickStatus();
    if (q === 'reassign') return this._renderQuickReassign();
    if (q === 'due') return this._renderQuickDue();
  }

  _renderQuickStatus() {
    const el = this._quickSheetEl;
    const t = this.taskModel.find(this._quickSheetTaskId);
    const list = t ? App.taxonomy.activeStatuses(t.company, t.type) : [];
    const entries = (list && list.length) ? list : Object.entries(App.STATUSES).map(([k, v]) => ({ key: k, label: v.label }));
    el.innerHTML = `
      <div class="quick-sheet-title">Set status</div>
      ${entries.map(s => {
        const c = t ? App.taxonomy.chipStyle('status', t.company, s.key, t.type) : { cls: '', style: '' };
        return `<button type="button" class="quick-sheet-item" data-status="${s.key}"><span class="status-dot ${c.cls}" style="${c.style}"></span><span>${App.utils.escapeHtml(s.label)}</span></button>`;
      }).join('')}
      <div class="quick-sheet-foot"><button type="button" class="quick-sheet-item" data-q="back"><span>Back</span></button></div>
    `;
    el.querySelectorAll('[data-status]').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      this.controller.updateTaskField(this._quickSheetTaskId, 'status', b.dataset.status);
      this._closeQuickSheet();
    }));
    el.querySelector('[data-q="back"]').addEventListener('click', () => this._renderQuickRoot());
  }

  _renderQuickReassign() {
    const t = this.taskModel.find(this._quickSheetTaskId);
    const people = App.utils.peopleInCompany(t.company, this.currentUser) || [];
    const el = this._quickSheetEl;
    el.innerHTML = `
      <div class="quick-sheet-title">Reassign to</div>
      ${people.map(p =>
        `<button type="button" class="quick-sheet-item" data-assignee="${p.id}">${App.utils.avatarHtml(p)}<span>${App.utils.escapeHtml(p.name)}${p.id === t.assignee ? ' · current' : ''}</span></button>`
      ).join('')}
      <div class="quick-sheet-foot"><button type="button" class="quick-sheet-item" data-q="back"><span>Back</span></button></div>
    `;
    el.querySelectorAll('[data-assignee]').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      this.controller.reassignTask(this._quickSheetTaskId, b.dataset.assignee);
      this._closeQuickSheet();
    }));
    el.querySelector('[data-q="back"]').addEventListener('click', () => this._renderQuickRoot());
  }

  _renderQuickDue() {
    const t = this.taskModel.find(this._quickSheetTaskId);
    const el = this._quickSheetEl;
    el.innerHTML = `
      <div class="quick-sheet-title">Set due date</div>
      <div class="quick-sheet-due"><input type="date" value="${t.due || ''}" aria-label="Due date" /></div>
      <div class="quick-sheet-foot">
        <button type="button" class="quick-sheet-item" data-q="back"><span>Back</span></button>
        <button type="button" class="quick-sheet-item quick-sheet-primary" data-action="due-save"><span>Save</span></button>
      </div>
    `;
    el.querySelector('[data-action="due-save"]').addEventListener('click', (e) => {
      e.stopPropagation();
      const v = el.querySelector('input[type="date"]').value;
      this.controller.updateTaskField(this._quickSheetTaskId, 'due', v || null);
      this._closeQuickSheet();
    });
    el.querySelector('[data-q="back"]').addEventListener('click', () => this._renderQuickRoot());
  }
};

