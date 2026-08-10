window.App = window.App || {};

App.TaskDetailView = class TaskDetailView {
  constructor({ taskModel, timeModel, controller, currentUser }) {
    this.taskModel = taskModel;
    this.timeModel = timeModel;
    this.controller = controller;
    this.currentUser = currentUser;

    this.pane = document.getElementById('detailPane');
    this.mainEl = document.getElementById('mainPane');
    // The detail pane is shown as a full-page surface (#taskDetailWrap) rather
    // than a centered popup. We relocate the existing #detailPane node into that
    // wrapper on open so all the render/query code below keeps targeting
    // `this.pane`. _pageOpen guards against repeated mounts on re-render.
    this._pageOpen = false;

    // Id of the task currently open in the staged Edit form, or null. While set,
    // background re-renders are suppressed so unsaved input survives. editDraft
    // holds the staged field values until Save (or is discarded on Cancel).
    this.editingId = null;
    this.editDraft = null;

    this.subscribe();
    this.render();
  }

  subscribe() {
    App.EventBus.on('tasks:changed', () => this.render());
    App.EventBus.on('time:changed', () => this.render());
    App.EventBus.on('selection:changed', () => this.render());
    App.EventBus.on('view:changed', () => this.render());
    App.EventBus.on('comments:changed', () => this.render());
    App.EventBus.on('clock:tick', () => this.tickLive());
  }

  tickLive() {
    const active = this.timeModel.activeFor(this.currentUser);
    const liveEl = this.pane.querySelector('#detail-live-timer');
    if (active && liveEl) {
      liveEl.textContent = App.utils.formatDuration(Date.now() - active.startedAt);
    }
  }

  /* Mount the detail pane into the full-page #taskDetailWrap surface (idempotent
     — called on every re-render). The #detailPane node is moved into the wrapper
     so the rest of this view's innerHTML/querySelector code is unchanged. The
     list pane behind it is hidden so the detail reads as its own page, with the
     topbar + sidebar kept in place (the Home/Reports full-page pattern). */
  _openModal() {
    if (this._pageOpen) return;
    const wrap = document.getElementById('taskDetailWrap');
    if (!wrap) return;
    this._wrap = wrap;

    this.pane.classList.remove('hidden');
    wrap.appendChild(this.pane);
    wrap.classList.remove('hidden');

    // Hide every sibling work-surface behind the detail page. A task can be
    // opened from any view — the list (#listPane) but also the Home / Reports /
    // Projects / Wallboard full-page surfaces (their rows call selectTask) — so
    // all of them must be hidden or they'd stack in-flow above the detail. On
    // close, _togglePanes restores whichever one the current view calls for.
    ['listPane', 'homeWrap', 'reportsWrap', 'projectsWrap', 'wallboardWrap'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    });

    // Esc closes the detail in view mode via the app's global Escape handler
    // (app.js → controller.handleEscape → closeDetail); no local handler needed.
    // Edit mode stops Esc from reaching it so editing exits to the read view.
    this._pageOpen = true;
    this._justOpened = true;
    try { window.scrollTo(0, 0); wrap.scrollTop = 0; } catch (e) { /* noop */ }
  }

  // Placeholder shown on the detail page when a task is selected but its data
  // hasn't loaded yet (rare — the detail normally renders instantly from the
  // in-memory model). Keeps a working "Back to tasks" button.
  _detailSkeletonHtml() {
    const rows = Array.from({ length: 7 }).map(() =>
      `<div class="detail-row"><span class="sk sk-line" style="width:70px;"></span><span class="sk sk-line" style="width:130px;"></span></div>`
    ).join('');
    return `
      <div class="detail-head">
        <button class="detail-back" data-action="close" aria-label="Back to tasks" type="button"><i class="ti ti-arrow-left"></i> Back to tasks</button>
        <div class="detail-head-top">
          <span class="sk sk-pill" style="width:88px;"></span>
        </div>
        <div class="sk sk-line" style="height:24px; width:75%; margin-top:8px;"></div>
      </div>
      <div class="detail-body detail-skeleton" aria-hidden="true">
        <div class="sk sk-line" style="height:38px; margin-bottom:14px;"></div>
        ${rows}
      </div>
    `;
  }

  _closeModal() {
    // Legacy side-panel layout class (no longer used, kept defensive).
    this.mainEl.classList.remove('with-detail');
    if (!this._pageOpen) return;
    // Hide the full-page surface and the detail node (parked inside the hidden
    // wrapper for reuse on the next open).
    if (this._wrap) this._wrap.classList.add('hidden');
    this.pane.classList.add('hidden');
    this._pageOpen = false;
    this._justOpened = false;
    // Restore whichever pane the current view calls for (un-hides #listPane for
    // task views; leaves Home/Reports as-is). Leaves the detail wrapper hidden.
    if (typeof this.controller._togglePanes === 'function') this.controller._togglePanes();
    else { const lp = document.getElementById('listPane'); if (lp) lp.classList.remove('hidden'); }
  }

  render() {
    const selId = this.controller.uiState.selectedTaskId;
    const view = this.controller.uiState.view;

    // Mid-edit: keep the staged form on screen and don't clobber unsaved input
    // on background re-renders (sync polls, time ticks). Drop edit mode only if
    // the selection moved to another task or a time view.
    if (this.editingId) {
      if (this.editingId === selId && !view.startsWith('time:')) return;
      this.editingId = null;
    }

    // Same protection for an open inline (single-field) editor: a background
    // re-render must not wipe the editor before the user hits ✓ / ✗.
    if (this._inlineEdit) {
      if (this._inlineEdit.taskId === selId && !view.startsWith('time:')) return;
      this._inlineEdit = null;
    }

    // Time-tracking views don't show a detail pane
    if (!selId || view.startsWith('time:')) {
      this._closeModal();
      return;
    }

    const t = this.taskModel.find(selId);
    if (!t) {
      // Selected but not in the model. If nothing has loaded yet (e.g. a
      // deep-linked / notification selection during boot), show a skeleton
      // instead of closing; once tasks are loaded, a missing task is gone.
      if (this.taskModel.all().length === 0) {
        this._openModal();
        this.pane.innerHTML = this._detailSkeletonHtml();
        const cb = this.pane.querySelector('[data-action="close"]');
        if (cb) cb.addEventListener('click', () => this.controller.closeDetail());
        return;
      }
      this._closeModal();
      return;
    }

    // Switching to a different task resets composer state so a mention staged
    // for one task can't leak into another task's comment.
    if (this._composerTaskId !== t.id) {
      this._composerTaskId = t.id;
      this._composerMentions = new Set();
    }

    this._openModal();

    try {
    // Fall back gracefully if a task references a person or company that no
    // longer exists (e.g. a removed company or a deleted member). Without these
    // guards a single missing lookup throws while building the template and the
    // detail pane renders blank.
    const creator = App.directory.person(t.creator) || { name: t.creator || 'Unknown', full: t.creator || 'Unknown', color: 'var(--ink-3)' };
    const assignee = App.directory.person(t.assignee) || { name: t.assignee || 'Unassigned', full: t.assignee || 'Unassigned', color: 'var(--ink-3)' };
    // Ordered multi-assignee (lead = index 0). Falls back to the single assignee
    // for rows created before multi-assignee.
    const assigneeIds = (Array.isArray(t.assigneeIds) && t.assigneeIds.length)
      ? t.assigneeIds
      : (t.assignee ? [t.assignee] : []);
    const assignees = assigneeIds.map(id => App.directory.person(id) || { id, name: id || 'Unassigned', full: id || 'Unassigned', color: 'var(--ink-3)' });
    const assigneeLabel = assignees.length
      ? (assignees.length === 1 ? assignees[0].name : `${assignees[0].name} +${assignees.length - 1}`)
      : 'Unassigned';
    const company = App.directory.company(t.company) || { pill: '', label: t.company || '—' };
    const delegated = t.creator !== t.assignee;
    const myActive = this.timeModel.activeFor(this.currentUser);
    const myTimerOnThis = myActive && myActive.taskId === t.id;
    const totalMs = this.timeModel.totalForTask(t.id);

    // Read-only watcher chips — editing watchers lives in the Edit form.
    const watcherIds = t.watchers || [];

    // Each step toggles its done-state on click (or Enter/Space) when the user
    // can write — persisted via controller.toggleSubtask, and the resulting
    // tasks:changed re-render refreshes the icon + progress bar. Read-only
    // (no handler) otherwise. Adding/removing steps still lives in Edit mode.
    const canToggleSteps = App.can('tasks.write');
    const subtasksHtml = (t.subtasks || []).map((s, i) =>
      `<div class="td2-step ${s.d ? 'done' : ''}"${canToggleSteps ? ` data-action="toggle-step" data-idx="${i}" role="checkbox" aria-checked="${s.d ? 'true' : 'false'}" tabindex="0"` : ''}>
         <i class="ti ${s.d ? 'ti-circle-check-filled' : 'ti-circle'}"></i><span>${App.utils.escapeHtml(s.t)}</span>
       </div>`
    ).join('') || `<div class="td2-empty">No steps yet</div>`;
    // Checklist progress (done / total) for the progress bar.
    const subsDone = (t.subtasks || []).filter(s => s.d).length;
    const subsTotal = (t.subtasks || []).length;
    const subsPct = subsTotal ? Math.round((subsDone / subsTotal) * 100) : 0;

    const activityHtml = (t.activity || []).map(a => {
      // Prefer the real timestamp (relative); fall back to the legacy `when`
      // label for seed data / rows written before activity carried a timestamp.
      const ago = App.utils.timeAgo(a.at) || a.when || '';
      return `<div class="td2-feed-item"><i class="ti ti-point-filled td2-feed-dot"></i><span><span class="td2-feed-who">${App.utils.escapeHtml(a.who)}</span> ${App.utils.escapeHtml(a.what)}${ago ? ` · ${App.utils.escapeHtml(ago)}` : ''}</span></div>`;
    }).join('') || `<div class="td2-empty">No activity yet</div>`;

    const recentEntries = this.timeModel.entriesForTask(t.id).slice(0, 5);
    const entriesHtml = recentEntries.length
      ? recentEntries.map(e =>
          `<div class="td2-feed-item"><i class="ti ti-clock td2-feed-dot"></i><span>
             <span class="td2-feed-who">${App.utils.escapeHtml(App.directory.person(e.userId) ? App.directory.person(e.userId).name : e.userId)}</span> logged
             <strong>${App.utils.formatHours(e.durationMs)}</strong>
             · ${App.utils.escapeHtml(App.utils.timeAgo(e.end))}
           </span></div>`
        ).join('')
      : `<div class="td2-empty">No time logged yet</div>`;

    const statusObj = { label: App.taxonomy.statusLabel(t.company, t.type, t.status), cls: (App.STATUSES[t.status] || {}).cls || '' };
    const typeObj = { label: App.taxonomy.typeLabel(t.company, t.type) };
    const statusChip = App.taxonomy.chipStyle('status', t.company, t.status, t.type);
    const typeChip = App.taxonomy.chipStyle('type', t.company, t.type);
    const priObj = App.PRIORITIES[t.priority] || App.PRIORITIES.medium;
    const labelObj = (t.label && t.label !== 'none') ? (App.TASK_LABELS[t.label] || { label: '—' }) : { label: '—' };
    const isDone = App.taxonomy.isDone(t);
    const today = App.utils.todayISO(0);
    const overdue = !!(t.due && t.due < today && !isDone);
    let daysOverdue = 0;
    if (overdue) {
      const d1 = new Date(t.due + 'T00:00:00'), d2 = new Date(today + 'T00:00:00');
      daysOverdue = Math.max(1, Math.round((d2 - d1) / 86400000));
    }
    // Four-state due pill (spec §3): overdue (red) · today (orange) · on-track
    // (black outline) · completed (green). Empty due → a neutral "set due" pill.
    const dueToday = !!(t.due && t.due === today && !isDone);
    let daysUntil = 0;
    if (t.due) {
      const d1 = new Date(t.due + 'T00:00:00'), d2 = new Date(today + 'T00:00:00');
      daysUntil = Math.round((d1 - d2) / 86400000);
    }
    const _shortDate = (d) => { const x = new Date(d + 'T00:00:00'); return isNaN(x.getTime()) ? d : x.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
    const _dayLabel = (d) => { const x = new Date(d + 'T00:00:00'); return isNaN(x.getTime()) ? d : x.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); };
    let dueState, dueInner;
    if (isDone) { dueState = 'done'; dueInner = `<i class="ti ti-circle-check"></i>COMPLETED`; }
    else if (!t.due) { dueState = 'soon'; dueInner = `<i class="ti ti-calendar"></i>No due date`; }
    else if (overdue) { dueState = 'over'; dueInner = `<i class="ti ti-alert-triangle-filled"></i>${daysOverdue} DAY${daysOverdue === 1 ? '' : 'S'} OVERDUE <span class="td2-due-sub">· was due ${App.utils.escapeHtml(_shortDate(t.due))}</span>`; }
    else if (dueToday) { dueState = 'today'; dueInner = `<i class="ti ti-flame"></i>DUE TODAY`; }
    else { dueState = 'soon'; dueInner = `<i class="ti ti-calendar"></i>Due ${App.utils.escapeHtml(_dayLabel(t.due))} <span class="td2-due-sub">· in ${daysUntil} day${daysUntil === 1 ? '' : 's'}</span>`; }

    // Prev/next navigation position within the currently-visible (filtered +
    // sorted) list — reuses the controller's existing selectAdjacentTask so the
    // arrows behave exactly like the j/k shortcuts. Guarded so the stubbed
    // preview controller (no getVisibleTasks) doesn't throw.
    let navTotal = 0, navPos = -1;
    if (typeof this.controller.getVisibleTasks === 'function') {
      const vis = this.controller.getVisibleTasks();
      navTotal = vis.length;
      navPos = vis.findIndex(x => x.id === t.id);
    }
    const canNav = typeof this.controller.selectAdjacentTask === 'function' && navTotal > 1;
    const isWatching = watcherIds.includes(this.currentUser);
    const commentsCount = this._threads().count(t.id);
    const subtaskCount = (t.subtasks || []).length;
    const canDelete = this.controller.canDeleteTask(t);
    // Project folder chip — a picker trigger for writers, read-only otherwise.
    const proj = App.directory.project(t.project);
    const projectChipHtml = proj
      ? (App.can('tasks.write')
          ? `<button class="projtag projtag-btn" data-action="open-project" aria-haspopup="listbox" aria-expanded="false" style="--pc:${App.utils.escapeHtml(proj.color)}"><i class="ti ti-folder"></i>${App.utils.escapeHtml(proj.name)}</button>`
          : `<span class="projtag" style="--pc:${App.utils.escapeHtml(proj.color)}"><i class="ti ti-folder"></i>${App.utils.escapeHtml(proj.name)}</span>`)
      : (App.can('tasks.write')
          ? `<button class="td2-addproj" data-action="open-project" aria-haspopup="listbox" type="button">+ Add</button>`
          : '<span class="detail-val">—</span>');
    // Remember which tab the user is on so a background re-render (a posted
    // comment, a sync poll) doesn't yank them off it. Tabs are
    // Comments / Activity / History; default to Comments.
    if (!['comments', 'activity', 'history'].includes(this._activeTab)) this._activeTab = 'comments';
    const tabActive = (name) => this._activeTab === name ? ' active' : '';

    // Inline per-field editing: Details-card values are click-to-edit for users
    // with write access. `ev(field, baseCls)` returns the class + data attrs that
    // mark a value cell editable; read-only viewers just get the base class.
    // Edits auto-save on selection/blur — there is no confirm step.
    const canWrite = App.can('tasks.write');
    const ev = (field, baseCls = 'td2-field-v') => canWrite
      ? `class="${baseCls} td2-editable tdp-editable" data-edit-field="${field}" title="Click to change · saves automatically" tabindex="0" role="button"`
      : `class="${baseCls}"`;

    // Created row value — a real instant (timestamptz) formatted in the shared HQ
    // zone with time; legacy rows without createdAt fall back to the creator name.
    const createdWhen = t.createdAt
      ? App.utils.formatInstant(t.createdAt, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
      : '';

    // Stuck / blocked-on card (Slice B). task.stuck = { reason, on, at } | null.
    // The blocked-on person + reason + "N days" since flagged drive the card;
    // Unblock clears it, Comment jumps to the composer.
    const stuck = t.stuck || null;
    const stuckHtml = stuck ? (() => {
      const blocker = App.directory.person(stuck.on) || { name: stuck.on || 'Someone', full: stuck.on || 'Someone', color: 'var(--ink-3)' };
      const days = this._daysSince(stuck.at);
      const ageLabel = days <= 0 ? 'today' : `${days} day${days === 1 ? '' : 's'}`;
      return `
        <div class="td2-card td2-stuck">
          <div class="td2-stuck-h"><i class="ti ti-alert-triangle-filled"></i>Stuck</div>
          <div class="td2-stuck-reason">${App.utils.escapeHtml(stuck.reason || '')}</div>
          <div class="td2-stuck-on">
            <span class="td2-stuck-lbl">Blocked on</span>
            <span class="td2-stuck-person">${App.utils.avatarHtml(blocker)}<span class="td2-stuck-name">${App.utils.escapeHtml(blocker.name)}</span></span>
            <span class="td2-stuck-age">${App.utils.escapeHtml(ageLabel)}</span>
          </div>
          <div class="td2-stuck-actions">
            ${canWrite ? `<button class="td2-stuck-btn td2-stuck-btn-primary" data-action="qa-unblock" type="button"><i class="ti ti-lock-open"></i>Unblock</button>` : ''}
            <button class="td2-stuck-btn" data-action="qa-stuck-comment" type="button"><i class="ti ti-message"></i>Comment</button>
          </div>
        </div>`;
    })() : '';

    // First assignee's name for the "Nudge {name}" quick action.
    const nudgeName = assignees.length ? assignees[0].name : '';

    this.pane.innerHTML = `
      <div class="td2" data-tdid="${App.utils.escapeHtml(t.id)}">
      ${canNav ? `
        <button class="td2-nav td2-nav-prev" data-action="nav-prev" aria-label="Previous task" type="button"><i class="ti ti-chevron-left"></i></button>
        <button class="td2-nav td2-nav-next" data-action="nav-next" aria-label="Next task" type="button"><i class="ti ti-chevron-right"></i></button>` : ''}
      <div class="td2-head">
        <div class="td2-back-row">
          <button class="td2-back" data-action="close" aria-label="Back to tasks" type="button"><i class="ti ti-arrow-left"></i> Tasks</button>
        </div>
        <div class="td2-titlebar">
          <h1 class="td2-title${canWrite ? ' is-editable' : ''}"${canWrite ? ' contenteditable="plaintext-only" spellcheck="false" role="textbox" aria-label="Task title" title="Click to rename"' : ''}>${App.utils.escapeHtml(t.title)}</h1>
          <div class="td2-head-actions">
            <button class="td2-btn td2-btn-watch ${isWatching ? 'is-on' : ''}" data-action="toggle-watch" type="button" aria-label="${isWatching ? 'Watching' : 'Watch'}"><i class="ti ti-eye"></i><span class="td2-btn-lbl">${isWatching ? 'Watching' : 'Watch'}</span></button>
            ${App.can('tasks.write') ? `<button class="td2-btn" data-action="new-task" type="button" aria-label="New task"><i class="ti ti-plus"></i><span class="td2-btn-lbl">New task</span></button>` : ''}
            ${App.can('tasks.write') ? `<button class="td2-btn td2-btn-primary ${isDone ? 'is-done' : ''}" data-action="mark-complete" type="button" aria-label="${isDone ? 'Reopen' : 'Mark complete'}"><i class="ti ${isDone ? 'ti-rotate-clockwise' : 'ti-circle-check'}"></i><span class="td2-btn-lbl">${isDone ? 'Reopen' : 'Mark complete'}</span></button>` : ''}
            <button class="td2-btn td2-icon" data-action="overflow" aria-label="More actions" aria-haspopup="true" type="button"><i class="ti ti-dots"></i></button>
            <div class="td2-overflow hidden" id="tdpOverflow">
              <button class="td2-overflow-item" data-action="qa-duplicate" type="button"><i class="ti ti-copy"></i>Duplicate</button>
              ${App.can('tasks.write') ? `<button class="td2-overflow-item" data-action="edit-task" type="button"><i class="ti ti-pencil"></i>Edit all fields</button>` : ''}
              ${canDelete ? `<button class="td2-overflow-item danger" data-action="delete-task" type="button"><i class="ti ti-trash"></i>Delete task</button>` : ''}
            </div>
          </div>
        </div>
        <div class="td2-chiprow">
          <button class="td2-chip td2-chip-status ${statusChip.cls}" style="${statusChip.style}" data-action="status-menu" type="button">${App.utils.escapeHtml(statusObj.label)} <i class="ti ti-chevron-down"></i></button>
          <button class="td2-chip td2-chip-due ${dueState}"${canWrite ? ' data-action="chip-due"' : ''} type="button">${dueInner}</button>
          <button class="td2-chip td2-chip-assignee"${canWrite ? ' data-action="chip-assignee"' : ''} type="button">${App.directory.avatarStack(assignees)}<span class="td2-chip-name">${App.utils.escapeHtml(assigneeLabel)}</span></button>
          <span class="td2-chip-break" aria-hidden="true"></span>
        </div>
      </div>

      ${(myTimerOnThis) ? `
      <div class="td2-banners">
          ${myTimerOnThis ? `
            <div class="td2-banner td2-banner-timer">
              <i class="ti ti-player-record-filled"></i>
              <span>Tracking time on this task</span>
              <span class="td2-live" id="detail-live-timer">${App.utils.formatDuration(Date.now() - myActive.startedAt)}</span>
            </div>
          ` : ''}
      </div>` : ''}

      <div class="td2-brief${t.description ? '' : ' is-empty'}">
        <div class="td2-brief-lbl">Brief${canWrite ? `<button class="td2-brief-edit" data-action="edit-desc" title="Edit brief" aria-label="Edit brief" type="button"><i class="ti ti-pencil"></i></button>` : ''}</div>
        <div class="detail-desc td2-brief-body"${canWrite ? ' data-edit-field="description" tabindex="0" role="button" title="Click to edit · saves on click-away"' : ''}>${App.utils.escapeHtml(t.description || (canWrite ? 'No brief yet. Click to add context, links, and detail.' : 'No brief yet.'))}</div>
      </div>

      <div class="td2-grid">
        <div class="td2-col td2-col-left">
          <div class="td2-card">
            <div class="td2-card-h">Details</div>
            <div class="td2-fields">
              <div class="td2-field"><span class="td2-field-k">Priority</span><span ${ev('priority', `td2-field-v priority-block ${priObj.cls}`)}>${App.utils.escapeHtml(priObj.label)}</span></div>
              <div class="td2-field"><span class="td2-field-k">Company</span><span ${ev('company', 'td2-field-v')}><span class="td2-sq"></span>${App.utils.escapeHtml(company.label)}</span></div>
              <div class="td2-field"><span class="td2-field-k">Type</span><span ${ev('type', 'td2-field-v')}>${App.utils.escapeHtml(typeObj.label)}</span></div>
              <div class="td2-field"><span class="td2-field-k">Label</span><span ${ev('label', 'td2-field-v')}>${App.utils.escapeHtml(labelObj.label)}</span></div>
              <div class="td2-field${proj ? '' : ' td2-field-proj-empty'}"><span class="td2-field-k">Project</span>${projectChipHtml}</div>
              <div class="td2-field"><span class="td2-field-k">Created</span><span class="td2-field-v td2-created-v">${createdWhen ? App.utils.escapeHtml(createdWhen) : App.utils.escapeHtml('by ' + creator.name)}</span></div>
            </div>
          </div>

          <div class="td2-card">
            <div class="td2-card-h">Checklist${subsTotal ? `<span class="td2-count">${subsDone}/${subsTotal}</span>` : ''}</div>
            ${subsTotal ? `<div class="td2-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${subsPct}" aria-label="Checklist progress"><div class="td2-progress-fill${subsDone === subsTotal ? ' full' : ''}" style="width:${subsPct}%;"></div></div>` : ''}
            <div class="td2-steps">${subtasksHtml}</div>
            ${canWrite ? `<button class="td2-addstep" data-action="qa-subtask" type="button"><i class="ti ti-plus"></i>Add step</button>` : ''}
          </div>
        </div>

        <div class="td2-col td2-col-center">
          <div class="td2-card td2-card-conv">
            <div class="td2-tablist" role="tablist">
              <button class="td2-tab${tabActive('comments')}" data-tab="comments" type="button"><i class="ti ti-message"></i>Comments${commentsCount ? ` <span class="td2-tabcount">${commentsCount}</span>` : ''}</button>
              <button class="td2-tab${tabActive('activity')}" data-tab="activity" type="button"><i class="ti ti-bolt"></i>Activity</button>
              <button class="td2-tab${tabActive('history')}" data-tab="history" type="button"><i class="ti ti-history"></i>History</button>
            </div>
            <div class="td2-tabpanel${tabActive('comments')}" data-panel="comments">${this._commentsInner(t)}</div>
            <div class="td2-tabpanel${tabActive('activity')}" data-panel="activity"><div class="td2-feed">${activityHtml}</div></div>
            <div class="td2-tabpanel${tabActive('history')}" data-panel="history"><div class="td2-feed">${entriesHtml}</div></div>
          </div>
        </div>

        <aside class="td2-col td2-col-right">
          ${stuckHtml}
          <div class="td2-card td2-qa-card">
            <div class="td2-card-h">Quick actions</div>
            <div class="td2-qa-list">
              <button class="td2-qa td2-qa-solid td2-clockin" data-action="toggle-timer" type="button" aria-label="${myTimerOnThis ? 'Back to General shift' : 'Clock in on this task'}" title="${myTimerOnThis ? 'Back to General shift' : 'Clock in on this task'}"><i class="ti ${myTimerOnThis ? 'ti-player-pause-filled' : 'ti-player-play-filled'}"></i><span class="td2-qa-lbl">${myTimerOnThis ? 'Back to General shift' : 'Clock in on this task'}</span></button>
              ${(canWrite && nudgeName) ? `<button class="td2-qa td2-qa-nudge${overdue ? ' is-late' : ''}" data-action="qa-nudge" type="button" aria-label="Nudge ${App.utils.escapeHtml(nudgeName)}" title="Nudge ${App.utils.escapeHtml(nudgeName)}"><i class="ti ti-bell-ringing"></i><span class="td2-qa-lbl">Nudge ${App.utils.escapeHtml(nudgeName)}${overdue ? `<span class="td2-qa-late">${daysOverdue}D LATE</span>` : ''}</span></button>` : ''}
              ${canWrite ? `<button class="td2-qa td2-qa-solid" data-action="qa-help" type="button" aria-label="Request help" title="Request help"><i class="ti ti-lifebuoy"></i><span class="td2-qa-lbl">Request help</span></button>` : ''}
              ${(canWrite && !stuck) ? `<button class="td2-qa td2-qa-outline" data-action="qa-stuck" type="button" aria-label="I'm stuck" title="I'm stuck"><i class="ti ti-alert-triangle"></i><span class="td2-qa-lbl">I'm stuck</span></button>` : ''}
              <button class="td2-qa td2-qa-outline" data-action="qa-reassign" type="button" aria-label="Reassign" title="Reassign"><i class="ti ti-user-share"></i><span class="td2-qa-lbl">Reassign</span></button>
              <div class="td2-qa-morewrap">
                <button class="td2-qa td2-qa-more" data-action="qa-more" aria-haspopup="true" type="button" aria-label="More actions" title="More actions"><span class="td2-qa-lbl">More </span><i class="ti ti-chevron-down"></i></button>
                <div class="td2-qa-menu hidden" id="td2QaMore" role="menu">
                  <button data-action="qa-subtask" type="button"><i class="ti ti-subtask"></i>Add subtask</button>
                  <button data-action="qa-logcall" type="button"><i class="ti ti-phone"></i>Log a call</button>
                  <button data-action="qa-note" type="button"><i class="ti ti-note"></i>Add note</button>
                  <button data-action="qa-duplicate" type="button"><i class="ti ti-copy"></i>Duplicate</button>
                </div>
              </div>
            </div>
          </div>

          <div class="td2-card">
            <div class="td2-card-h">Watchers${watcherIds.length ? `<span class="td2-count">${watcherIds.length}</span>` : ''}</div>
            <div class="td2-wstack">
              ${watcherIds.map(w => { const p = App.directory.person(w); return p ? App.utils.avatarHtml(p) : ''; }).join('')}
              <button class="td2-watch-add" data-action="toggle-watch" title="${isWatching ? 'Stop watching' : 'Watch this task'}" aria-label="Toggle watch" type="button"><i class="ti ${isWatching ? 'ti-eye-off' : 'ti-plus'}"></i></button>
            </div>
          </div>
        </aside>
      </div>
      </div>
    `;

    this.bindHandlers(t);

    // Auto-save feedback: the field that just saved gets a quiet green tick +
    // pulse (see .tdp-saved-flash). One-shot — the next render replaces the DOM.
    if (this._justSaved) {
      const f = this._justSaved;
      this._justSaved = null;
      const cell = this.pane.querySelector(`[data-edit-field="${f}"]`);
      if (cell) cell.classList.add('td2-saved-flash');
      if (f === 'status') {
        const chip = this.pane.querySelector('.td2-chip-status');
        if (chip) chip.classList.add('td2-saved-flash');
      }
      if (f === 'assignee') {
        const chip = this.pane.querySelector('.td2-chip-assignee');
        if (chip) chip.classList.add('td2-saved-flash');
      }
      if (f === 'project') {
        const tag = this.pane.querySelector('[data-action="open-project"]');
        if (tag) tag.classList.add('td2-saved-flash');
      }
    }
    } catch (err) {
      // Never leave the pane blank: show a message with a working Close button.
      if (App.observability) App.observability.captureException(err, { source: 'TaskDetailView.render' });
      console.error('[TaskDetailView] render failed', err);
      this.pane.innerHTML = `
        <div class="detail-head">
          <button class="detail-back" data-action="close" aria-label="Back to tasks" type="button"><i class="ti ti-arrow-left"></i> Back to tasks</button>
        </div>
        <div style="padding:20px; font-size:13px; color:var(--ink-2); line-height:1.5;">
          Couldn't open this task's details — it may reference a removed company or person.
        </div>`;
      const closeBtn = this.pane.querySelector('[data-action="close"]');
      if (closeBtn) closeBtn.addEventListener('click', () => this.controller.closeDetail());
    }
  }

  bindHandlers(t) {
    const q = (sel) => this.pane.querySelector(sel);
    const qa = (sel) => this.pane.querySelectorAll(sel);

    q('[data-action="close"]').addEventListener('click', () => this.controller.closeDetail());

    // Enter the staged Edit form, optionally focusing a specific field. The
    // Reassign / Set due / Add subtask quick actions reuse this rather than
    // bespoke popovers — same proven save path, far less surface area.
    const enterEdit = (focusId) => {
      this.editingId = t.id;
      this.editDraft = this._draftFromTask(t);
      this.renderEditMode(t, { focusTitle: focusId === 'edit-title' });
      if (focusId && focusId !== 'edit-title') {
        const el = document.getElementById(focusId);
        if (el) { el.focus(); try { el.showPicker && el.showPicker(); } catch (e) { /* not user-activated */ } }
      }
    };

    const editBtn = q('[data-action="edit-task"]');
    if (editBtn) editBtn.addEventListener('click', () => enterEdit('edit-title'));

    const timerBtn = q('[data-action="toggle-timer"]');
    if (timerBtn) timerBtn.addEventListener('click', () => this.controller.toggleTimerForTask(t.id));

    // Delete lives in the ⋯ overflow menu now (may be absent if not permitted).
    qa('[data-action="delete-task"]').forEach(el => el.addEventListener('click', () => this.controller.deleteTask(t.id)));

    const newTaskBtn = q('[data-action="new-task"]');
    if (newTaskBtn) newTaskBtn.addEventListener('click', () => this.controller.openNewTaskPage());

    const completeBtn = q('[data-action="mark-complete"]');
    if (completeBtn) completeBtn.addEventListener('click', () => {
      if (!App.taxonomy.isDone(t) && App.Motion) App.Motion.check(completeBtn.querySelector('i') || completeBtn);
      this.controller.completeTask(t.id);
    });

    // Watch toggle — header button AND the watchers-card "+" share one action.
    qa('[data-action="toggle-watch"]').forEach(el => el.addEventListener('click', () => this.controller.toggleSelfWatch(t.id)));

    // Tabs — switch active class locally (no re-render) and remember the choice
    // so the next background re-render restores it (see _activeTab in render).
    const setTab = (name) => {
      this._activeTab = name;
      qa('.td2-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
      qa('.td2-tabpanel').forEach(p => p.classList.toggle('active', p.dataset.panel === name));
    };
    qa('.td2-tab').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));

    const focusComment = () => {
      setTab('comments');
      const input = q('#cmInput');
      if (input) input.focus();
    };

    // The "Add note" quick action jumps to the comments composer.
    const qaNote = q('[data-action="qa-note"]');
    if (qaNote) qaNote.addEventListener('click', focusComment);

    // Inline-editable title (contenteditable). Saves on blur / Enter (Enter
    // doesn't insert a newline), Escape reverts. Reuses updateTaskField('title').
    const titleEl = q('.td2-title.is-editable');
    if (titleEl) this._wireTitleEdit(t, titleEl);

    // Reassign quick action + the header assignee chip open the multi-select
    // assignee picker; Set due jumps to the inline date editor; Add subtask
    // stages through the Edit form.
    const openAssignees = (anchor) => this._openAssigneePicker(t, anchor);
    const qaReassign = q('[data-action="qa-reassign"]');
    if (qaReassign) qaReassign.addEventListener('click', () => openAssignees(qaReassign));
    const chipAssignee = q('[data-action="chip-assignee"]');
    if (chipAssignee) chipAssignee.addEventListener('click', (e) => { e.stopPropagation(); openAssignees(chipAssignee); });
    const chipDue = q('[data-action="chip-due"]');
    if (chipDue) chipDue.addEventListener('click', () => this._openInlineEdit(t, 'due'));
    // "Add subtask" (Quick actions) AND "Add step" (Checklist card) share this
    // action, so bind every match, not just the first.
    qa('[data-action="qa-subtask"]').forEach(el => el.addEventListener('click', () => enterEdit('edit-subtask-input')));
    // Checklist steps toggle done-state inline (click or keyboard, role=checkbox)
    // — no need to enter Edit mode. Shares the model's toggleSubtask, so the
    // tasks:changed re-render refreshes the icon + progress bar.
    qa('[data-action="toggle-step"]').forEach(el => {
      const toggle = () => this.controller.toggleSubtask(t.id, parseInt(el.dataset.idx, 10));
      el.addEventListener('click', toggle);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    });
    const qaSetdue = q('[data-action="qa-setdue"]');
    if (qaSetdue) qaSetdue.addEventListener('click', () => this._openInlineEdit(t, 'due'));
    const qaLogcall = q('[data-action="qa-logcall"]');
    if (qaLogcall) qaLogcall.addEventListener('click', () => { this._activeTab = 'comments'; this.controller.addCallLog(t.id); });
    // Duplicate navigates to the copy (createTask selects it); the toast makes
    // that hand-off explicit so a stray click can't silently mint tasks.
    qa('[data-action="qa-duplicate"]').forEach(el => el.addEventListener('click', () => {
      this.controller.duplicateTask(t.id);
      const tv = this.controller.toastView;
      if (tv && tv.show) tv.show({ title: 'Task duplicated', sub: 'You are now viewing the copy.' });
    }));

    // ---- Slice B engagement actions ----
    // Unblock (stuck card) — clears task.stuck.
    const unblockBtn = q('[data-action="qa-unblock"]');
    if (unblockBtn) unblockBtn.addEventListener('click', () => this.controller.unblock(t.id));
    // Comment (stuck card) — jump to the composer.
    const stuckComment = q('[data-action="qa-stuck-comment"]');
    if (stuckComment) stuckComment.addEventListener('click', focusComment);
    // Nudge every assignee (bar the current user).
    const nudgeBtn = q('[data-action="qa-nudge"]');
    if (nudgeBtn) nudgeBtn.addEventListener('click', () => this.controller.nudge(t.id));
    // "I'm stuck" — inline panel (reason + person picker), Confirm → flagStuck.
    const stuckBtn = q('[data-action="qa-stuck"]');
    if (stuckBtn) stuckBtn.addEventListener('click', () => this._openStuckPanel(t, stuckBtn));
    // "Request help" — person picker → requestHelp.
    const helpBtn = q('[data-action="qa-help"]');
    if (helpBtn) helpBtn.addEventListener('click', () => this._openHelpPicker(t, helpBtn));

    // Description: pencil button and the text itself both open the inline
    // editor (saves on click-away, Esc cancels) — no full Edit mode needed.
    const descPencil = q('[data-action="edit-desc"]');
    if (descPencil) descPencil.addEventListener('click', () => this._openDescEdit(t));
    const descText = q('[data-edit-field="description"]');
    if (descText) {
      descText.addEventListener('click', () => this._openDescEdit(t));
      descText.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._openDescEdit(t); }
      });
    }

    // Overflow (⋯) menu toggle. The menu is an inline sibling whose items are
    // wired by this render pass, so it stays a .hidden toggle rather than an
    // App.Menu — but the document dismiss listener is now added per-open and
    // removed on close (the old once-per-lifetime binding leaked).
    const wireInlineToggle = (btnSel, menuSel, closeOnItemClick) => {
      const btn = q(btnSel);
      const menu = q(menuSel);
      if (!btn || !menu) return;
      let onDoc = null;
      const close = () => {
        menu.classList.add('hidden');
        if (onDoc) { document.removeEventListener('click', onDoc); onDoc = null; }
      };
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!menu.classList.contains('hidden')) { close(); return; }
        menu.classList.remove('hidden');
        onDoc = (e2) => {
          if (menu.contains(e2.target) || btn.contains(e2.target)) return;
          close();
        };
        setTimeout(() => document.addEventListener('click', onDoc), 0);
      });
      if (closeOnItemClick) menu.addEventListener('click', close);
    };
    wireInlineToggle('[data-action="overflow"]', '#tdpOverflow', false);

    // Prev/next task side-arrow chevrons reuse the controller's existing
    // selectAdjacentTask — same walk order as the arrow-key / j/k shortcuts.
    qa('[data-action="nav-prev"]').forEach(el => el.addEventListener('click', () => this.controller.selectAdjacentTask && this.controller.selectAdjacentTask(-1)));
    qa('[data-action="nav-next"]').forEach(el => el.addEventListener('click', () => this.controller.selectAdjacentTask && this.controller.selectAdjacentTask(1)));

    // Quick-actions "More" dropdown (Add subtask / Log call / Add note / Duplicate).
    // The items carry the same data-actions bound elsewhere; this only toggles.
    wireInlineToggle('[data-action="qa-more"]', '#td2QaMore', true);

    // Status chip → quick status menu.
    const statusBtn = q('[data-action="status-menu"]');
    if (statusBtn) statusBtn.addEventListener('click', (e) => { e.stopPropagation(); this._openStatusMenu(t, statusBtn); });

    const projBtn = q('[data-action="open-project"]');
    if (projBtn) projBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      App.projectPicker.open({
        anchor: projBtn,
        companyId: t.company,
        currentId: t.project || null,
        onSelect: (projectId) => {
          this._justSaved = 'project';
          this.controller.updateTaskField(t.id, 'project', projectId, this._activityTextFor(t, 'project', projectId));
        },
      });
    });

    // Inline per-field editing: click (or Enter/Space on) a Details value to edit
    // it. Assignee is special — it opens the multi-select picker rather than the
    // single-value inline <select>.
    const openField = (el) => {
      if (el.dataset.editField === 'assignee') this._openAssigneePicker(t, el);
      else this._openInlineEdit(t, el.dataset.editField);
    };
    qa('.tdp-editable').forEach(el => {
      el.addEventListener('click', () => openField(el));
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openField(el); }
      });
    });

    // Comments: lazy-load on first render, then wire the composer.
    if (!this._threads().isLoaded(t.id)) this.controller.loadTaskComments(t.id);
    this._wireComments(t);

    // On first open, move focus into the dialog (not on background re-renders).
    if (this._justOpened) {
      this._justOpened = false;
      const cb = q('[data-action="close"]');
      if (cb) cb.focus();
    }
  }

  /* ---------- inline per-field editing (Details card) ---------- */

  // Swap a single Details value for an inline editor that AUTO-SAVES: selects
  // commit on change (pick a value → saved), free-typed inputs commit on blur
  // or Enter, Escape cancels. No confirm buttons. Only one editor is open at a
  // time — opening another first re-renders to a clean state. While open,
  // render() is suppressed for this task (see the _inlineEdit guard), so a
  // background sync poll can't wipe the editor mid-edit.
  _openInlineEdit(t, field) {
    if (!App.can('tasks.write') || !field) return;
    // Already editing this exact field (e.g. a bubbled click) — leave it be.
    if (this._inlineEdit && this._inlineEdit.taskId === t.id && this._inlineEdit.field === field) return;
    // Close any other open editor by re-rendering to the plain display first.
    if (this._inlineEdit) { this._inlineEdit = null; this.render(); }
    if (field === 'description') { this._openDescEdit(t); return; }

    const cell = this.pane.querySelector(`[data-edit-field="${field}"]`);
    if (!cell) return;

    // Reminder opens the shared calendar + typeable-time popover directly.
    if (field === 'reminderAt') {
      this._inlineEdit = { taskId: t.id, field };
      cell.classList.add('is-editing');
      App.reminderPicker.open({
        anchor: cell,
        value: t.reminderAt || null,
        onCommit: (v) => this._commitInlineEdit(t, 'reminderAt', v == null ? '' : v),
        onCancel: () => { this._inlineEdit = null; this.render(); },
      });
      return;
    }

    this._inlineEdit = { taskId: t.id, field };
    const token = this._inlineEdit;
    cell.classList.add('is-editing');
    cell.innerHTML = `<span class="tdp-inline-edit">${this._inlineEditorHtml(t, field)}</span>`;

    const wrap = cell.querySelector('.tdp-inline-edit');
    const input = cell.querySelector('#tdp-ie-input');
    // Keep clicks AND Enter/Space keydowns inside the editor from bubbling to
    // the cell's own open-editor handlers. The keydown matters: the event's
    // bubble path is fixed at dispatch, so the Enter that commits (re-rendering
    // the pane) still reaches the old cell's keydown handler afterwards — which
    // would silently re-open the editor on the fresh DOM.
    if (wrap) {
      wrap.addEventListener('click', (e) => e.stopPropagation());
      wrap.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });
    }
    if (!input) { this._inlineEdit = null; this.render(); return; }

    // One-shot settle guard: change → blur double-fires on selects, and
    // render() tearing the node down must not commit or cancel twice. The
    // token keeps a QUEUED blur (clicking straight onto another editable
    // cell opens a new editor before this setTimeout runs) from tearing
    // down that new editor — a stale settle only cleans up after itself.
    let settled = false;
    const commit = () => { if (settled) return; settled = true; this._commitInlineEdit(t, field, input.value, token); };
    const cancel = () => {
      if (settled) return; settled = true;
      if (this._inlineEdit === token) { this._inlineEdit = null; this.render(); }
    };

    if (input.tagName === 'SELECT') {
      // Pick an option → saved instantly; click away without picking → close.
      input.addEventListener('change', commit);
      input.addEventListener('blur', () => setTimeout(cancel, 0));
    } else {
      // Free-typed (due date / due time): saved on blur or Enter.
      if (field === 'dueTime') App.timeField.attachMask(input);
      input.addEventListener('blur', () => setTimeout(commit, 0));
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
      else if (e.key === 'Enter' && input.tagName !== 'SELECT') { e.preventDefault(); commit(); }
    });
    input.focus();
    // Pop the options / native calendar open straight away where supported.
    if (input.tagName === 'SELECT' || input.type === 'date') {
      try { input.showPicker(); } catch (e) { /* not user-activated / unsupported */ }
    }
  }

  /* Inline description editor (the pencil / clicking the text). Swaps the text
     for a textarea; saves on click-away or Cmd/Ctrl+Enter, Escape cancels. */
  _openDescEdit(t) {
    if (!App.can('tasks.write')) return;
    if (this._inlineEdit && this._inlineEdit.taskId === t.id && this._inlineEdit.field === 'description') return;
    if (this._inlineEdit) { this._inlineEdit = null; this.render(); }

    const holder = this.pane.querySelector('[data-edit-field="description"]');
    if (!holder) return;
    this._inlineEdit = { taskId: t.id, field: 'description' };
    const token = this._inlineEdit;

    const ta = document.createElement('textarea');
    ta.className = 'taf-desc tdp-desc-input';
    ta.rows = Math.min(12, Math.max(4, String(t.description || '').split('\n').length + 1));
    ta.maxLength = 5000;
    ta.placeholder = 'Add details, links, context…';
    ta.value = t.description || '';
    holder.replaceWith(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    let settled = false;
    const commit = () => {
      if (settled) return; settled = true;
      const value = ta.value.trim().slice(0, 5000);
      const isCurrent = this._inlineEdit === token;
      if (isCurrent) this._inlineEdit = null;
      if (value !== (t.description || '')) {
        this._justSaved = 'description';
        this.controller.updateTaskField(t.id, 'description', value, this._activityTextFor(t, 'description', value));
      } else if (isCurrent) this.render();
    };
    const cancel = () => {
      if (settled) return; settled = true;
      if (this._inlineEdit === token) { this._inlineEdit = null; this.render(); }
    };
    ta.addEventListener('blur', () => setTimeout(commit, 0));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
      else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); commit(); }
    });
  }

  /* Specific activity line for an auto-saved field change, built BEFORE the
     save while `t` still holds the old values ("changed status Working on it
     → Stuck"). Falls back to TaskModel's generic entry when it returns ''. */
  _activityTextFor(t, field, value) {
    switch (field) {
      case 'status': {
        const from = App.taxonomy.statusLabel(t.company, t.type, t.status);
        const to = App.taxonomy.statusLabel(t.company, t.type, value);
        return `changed status ${from} → ${to}`;
      }
      case 'priority':
        return `changed priority to ${(App.PRIORITIES[value] || {}).label || value}`;
      case 'due':
        return value ? `changed the due date to ${this._formatDue(value)}` : 'cleared the due date';
      case 'dueTime':
        return value ? `set the due time to ${App.utils.formatClock(value)}` : 'cleared the due time';
      case 'reminderAt':
        return value ? `set a reminder for ${this._formatReminder(value)}` : 'removed the reminder';
      case 'type':
        return `changed type to ${App.taxonomy.typeLabel(t.company, value)}`;
      case 'label':
        return `changed label to ${(App.TASK_LABELS[value] || {}).label || value}`;
      case 'company':
        return `moved this to ${(App.directory.company(value) || {}).label || value}`;
      case 'project': {
        const p = App.directory.project(value);
        return p ? `filed this under ${p.name}` : 'removed this from its project';
      }
      case 'description':
        return 'updated the description';
      default:
        return '';
    }
  }

  // Status <option> entries for a (company,type) from the live taxonomy (constants fallback).
  // Keeps the current value even if it's now inactive so a save never silently drops it.
  _statusOpts(company, type, selected) {
    const list = App.taxonomy.activeStatuses(company, type);
    const src = (list && list.length) ? list.map(s => [s.key, s.label])
              : Object.entries(App.STATUSES).map(([k, v]) => [k, v.label]);
    if (selected && !src.some(([k]) => k === selected)) {
      src.unshift([selected, App.taxonomy.statusLabel(company, type, selected)]);
    }
    return src;
  }

  // Company [id, label] options for the edit menus, gated on access: only the
  // companies the viewer can reach (uiState.companies) — so 'overall' appears
  // exactly for users granted it — plus the task's current company so an
  // already-set value always renders. Mirrors NewTaskPageView._companyChoices.
  _companyOpts(current) {
    const access = (this.controller.uiState && this.controller.uiState.companies) || [];
    const ids = access.filter(id => id !== '*' && App.directory.company(id));
    if (current && !ids.includes(current)) ids.unshift(current);
    if (!ids.length) return Object.values(App.COMPANIES)
      .filter(c => !c.all).map(c => [c.id, c.label]);
    return ids.map(id => [id, (App.directory.company(id) || { label: id }).label]);
  }

  // Build the editor element (id="tdp-ie-input") for a given field.
  _inlineEditorHtml(t, field) {
    const esc = App.utils.escapeHtml;
    const sel = (entries, selected) =>
      `<select id="tdp-ie-input" class="tdp-ie-input">${entries.map(([k, label]) =>
        `<option value="${esc(k)}" ${k === selected ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
    switch (field) {
      case 'status':    return sel(this._statusOpts(t.company, t.type, t.status), t.status);
      case 'priority':  return sel(Object.entries(App.PRIORITIES).map(([k, v]) => [k, v.label]), t.priority);
      case 'type':      return sel(App.taxonomy.activeTypes(t.company).map(tp => [tp.key, tp.label]), t.type);
      case 'label':     return sel([['none', (App.TASK_LABELS.none && App.TASK_LABELS.none.label) || 'No label'], ...App.taxonomy.activeLabels(t.company).map(l => [l.key, l.label])], t.label || 'none');
      case 'company':   return sel(this._companyOpts(t.company), t.company);
      case 'assignee':  return sel(App.utils.peopleInCompany(t.company, t.assignee).map(p => [p.id, p.name + (p.position ? ` — ${p.position}` : '')]), t.assignee);
      case 'due':       return `<input type="date" id="tdp-ie-input" class="tdp-ie-input picker-input" value="${esc(t.due || '')}" />`;
      // Free-typed 12h time — "9", "230p", "10:30" all work (App.timeField).
      case 'dueTime':   return `<input type="text" id="tdp-ie-input" class="tdp-ie-input" inputmode="text" autocomplete="off" spellcheck="false" placeholder="e.g. 9:30 AM" value="${esc(t.dueTime ? App.utils.formatClock(t.dueTime) : '')}" />`;
      default:          return '';
    }
  }

  // Persist an auto-saved value. assignee uses reassignTask (notifies the new
  // assignee); everything else uses updateTaskField with a specific activity
  // line. A no-op change just restores the display. Clearing the _inlineEdit
  // guard BEFORE saving lets the resulting tasks:changed re-render the card
  // with the saved value; _justSaved drives the green saved-tick on that render.
  // `token` (when given) marks a stale queued commit: the value still saves,
  // but teardown/render is skipped so it can't wipe a newer open editor.
  _commitInlineEdit(t, field, rawValue, token) {
    const isCurrent = !token || this._inlineEdit === token;
    if (isCurrent) this._inlineEdit = null;
    if (field === 'assignee') {
      if (rawValue && rawValue !== t.assignee) {
        this._justSaved = 'assignee';
        this.controller.reassignTask(t.id, rawValue);
      } else if (isCurrent) this.render();
      return;
    }
    let value = rawValue;
    if (field === 'dueTime') {
      const raw = String(rawValue || '').trim();
      value = raw ? App.timeField.parse(raw) : null;
      if (raw && !value) {
        // Unreadable time: keep the old value and say so quietly.
        const tv = this.controller && this.controller.toastView;
        if (tv && tv.show) tv.show({ title: 'Couldn’t read that time', sub: 'Try "9:30 AM" or "14:00".' });
        if (isCurrent) this.render();
        return;
      }
    }
    // Optional date/reminder clear to null; the rest are constrained selects.
    if (field === 'due' || field === 'reminderAt') value = rawValue || null;
    const cur = t[field] == null ? '' : String(t[field]);
    const next = value == null ? '' : String(value);
    if (cur !== next) {
      this._justSaved = field;
      this.controller.updateTaskField(t.id, field, value, this._activityTextFor(t, field, value));
    } else if (isCurrent) this.render();
  }

  // Tiny popover to change a task's status straight from the header chip, without
  // entering full Edit mode. Persists through updateTaskField (which notifies
  // watchers and logs a specific "from → to" activity line). Re-clicking the
  // chip closes it.
  _openStatusMenu(t, anchor) {
    // Re-clicking the chip toggles it shut.
    if (this._tdpStatusHandle) { this._tdpStatusHandle.close('api'); return; }
    this._tdpStatusHandle = App.Menu.open({
      anchor,
      className: 'tdp-status-menu',
      onClose: () => { this._tdpStatusHandle = null; },
      build: (menu, h) => {
        const list = App.taxonomy.activeStatuses(t.company, t.type);
        const entries = (list && list.length) ? list.map(s => [s.key, s.label]) : Object.entries(App.STATUSES).map(([k, v]) => [k, v.label]);
        menu.innerHTML = entries.map(([k, label]) =>
          `<button class="tdp-status-opt ${k === t.status ? 'is-cur' : ''}" data-status="${App.utils.escapeHtml(k)}" type="button">${App.utils.escapeHtml(label)}</button>`
        ).join('');
        menu.querySelectorAll('[data-status]').forEach(b => b.addEventListener('click', (e) => {
          e.stopPropagation();
          const status = b.dataset.status;
          h.close('api');
          if (status && status !== t.status) {
            this._justSaved = 'status';
            this.controller.updateTaskField(t.id, 'status', status, this._activityTextFor(t, 'status', status));
          }
        }));
      },
    });
  }

  /* ---------- multi-assignee ---------- */

  // Inline-editable title via contenteditable. Enter commits (no newline),
  // Escape reverts, blur commits. Saves through updateTaskField('title'), which
  // marks the row dirty and logs activity. Empty titles revert to the original.
  _wireTitleEdit(t, el) {
    const original = t.title || '';
    const commit = () => {
      const next = (el.textContent || '').trim().slice(0, 200);
      if (!next) { el.textContent = original; return; }
      if (next === original) return;
      this._justSaved = 'title';
      this.controller.updateTaskField(t.id, 'title', next, 'renamed this task');
    };
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); el.textContent = original; el.blur(); }
    });
    el.addEventListener('blur', commit);
  }

  // Multi-select assignee picker (add/remove people, lead = first selected).
  // Same interaction vocabulary as the New Task assignee picker: a menu of
  // company members with a check on each selected person; the running order is
  // preserved (click order = priority, lead first). Commit on close via
  // controller.setAssignees, which fans out notifications to newly-added people.
  _openAssigneePicker(t, anchor) {
    if (!App.can('tasks.write')) return;
    // Toggle: re-clicking the trigger closes (and commits) an open menu.
    if (this._assigneeHandle) { this._assigneeHandle.close('api'); return; }

    // Suppress background re-renders while the picker is open (same guard the
    // inline editors use) so a sync poll can't wipe the menu mid-edit.
    this._inlineEdit = { taskId: t.id, field: 'assignee' };
    const token = this._inlineEdit;

    const startIds = (Array.isArray(t.assigneeIds) && t.assigneeIds.length)
      ? t.assigneeIds.slice()
      : (t.assignee ? [t.assignee] : []);
    const selected = startIds.slice(); // ordered working set (lead = index 0)
    const people = App.utils.peopleInCompany(t.company, selected);

    // Multi-select commits on ANY dismissal (away-click, Esc, toggle, reopen):
    // the working set is the user's answer; there is no cancel gesture (parity
    // with the old picker, which committed on away/toggle and had no Esc path).
    const commit = () => {
      if (this._inlineEdit === token) this._inlineEdit = null;
      const changed = selected.length !== startIds.length || selected.some((v, i) => v !== startIds[i]);
      if (changed) {
        this._justSaved = 'assignee';
        this.controller.setAssignees(t.id, selected);
      } else {
        this.render();
      }
    };

    this._assigneeHandle = App.Menu.open({
      anchor,
      className: 'td2-assignee-menu',
      onClose: () => {
        this._assigneeHandle = null;
        if (anchor.classList) anchor.classList.remove('is-editing');
        commit();
      },
      build: (menu) => {
        const renderRows = () => {
          menu.innerHTML = `
            <div class="td2-am-h">Assignees${selected.length ? ` <span class="td2-am-lead">lead: ${App.utils.escapeHtml((App.directory.person(selected[0]) || { name: selected[0] }).name)}</span>` : ''}</div>
            <div class="td2-am-list">
              ${people.map(p => {
                const on = selected.includes(p.id);
                return `<button class="td2-am-item ${on ? 'is-on' : ''}" data-id="${App.utils.escapeHtml(p.id)}" type="button">
                  ${App.utils.avatarHtml(p)}<span class="td2-am-name">${App.utils.escapeHtml(p.full || p.name)}</span>
                  ${on ? '<i class="ti ti-check td2-am-check"></i>' : ''}
                </button>`;
              }).join('') || '<div class="td2-am-empty">No teammates in this company</div>'}
            </div>`;
          menu.querySelectorAll('.td2-am-item').forEach(b => b.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = b.dataset.id;
            const i = selected.indexOf(id);
            if (i === -1) selected.push(id);
            else if (selected.length > 1) selected.splice(i, 1); // keep at least one
            renderRows();
          }));
        };
        renderRows();
      },
    });
    if (anchor.classList) anchor.classList.add('is-editing');
  }

  /* ---------- comments ---------- */

  /* The comment threads (App.CommentStore, owned by the controller). Threads are
     kept off the task row on purpose — see CommentStore's header. The empty
     fallback is for preview harnesses whose stubbed controller has no store. */
  _threads() {
    if (this.controller.comments) return this.controller.comments;
    if (!this._emptyThreads) this._emptyThreads = new App.CommentStore();
    return this._emptyThreads;
  }

  // Inner comments markup (list + composer) for the Activity/Comments/History
  // tab panel. No outer card — the tab panel is the container. `_wireComments`
  // finds #cmInput/#cmSend/#cmMentionMenu within this.pane after render.
  _commentsInner(t) {
    const esc = App.utils.escapeHtml;
    const comments = this._threads().rows(t.id);
    const rows = comments.length
      ? comments.map(c => this._commentRow(c)).join('')
      : (this._threads().isLoaded(t.id)
          ? `<div class="cm-empty">No comments yet. Start the conversation.</div>`
          : `<div class="cm-empty">Loading comments…</div>`);
    const draft = (this._commentDraft && this._commentDraft[t.id]) || '';
    // Composer kind (Slice C). A segmented control chooses how the post is
    // recorded — Comment / Note / Call — writing task_comments.kind (064).
    // Self-contained here so the Slice-B quick-actions panel is untouched.
    const kind = (this._composerKind && this._composerKind[t.id]) || 'comment';
    // Layout matches the locked Task-Detail pic: text box on top, then a tools row
    // (Log call / Note + attach/voice) with Post on the right. Default is a plain
    // comment; "Log call"/"Note" toggle task_comments.kind (migration 064).
    const kindBtn = (k, lbl, icon) =>
      `<button class="td2-cm-kind${kind === k ? ' is-on' : ''}" type="button" data-kind="${k}"><i class="ti ${icon}"></i>${lbl}</button>`;
    return `
      <div class="cm-list">${rows}</div>
      <div class="cm-composer">
        <textarea id="cmInput" class="cm-input" rows="2" placeholder="Write an update or @mention…">${esc(draft)}</textarea>
        <div id="cmMentionMenu" class="cm-mention-menu hidden" role="listbox"></div>
        <div class="cm-actions">
          <div class="td2-cm-tools" role="tablist">
            ${kindBtn('call', 'Log call', 'ti-phone')}
            ${kindBtn('note', 'Note', 'ti-note')}
            <button class="td2-cm-tool" type="button" data-cm-soon="Attachments" aria-label="Attach file" title="Attachments — coming soon"><i class="ti ti-paperclip"></i></button>
            <button class="td2-cm-tool" type="button" data-cm-soon="Voice notes" aria-label="Voice note" title="Voice notes — coming soon"><i class="ti ti-microphone"></i></button>
          </div>
          <button id="cmSend" class="btn btn-primary cm-send" type="button">Post</button>
        </div>
      </div>`;
  }

  // The curated reaction set (Slice C). Fixed + tokened — no open emoji picker,
  // to stay on-brand for a work tool.
  _reactionSet() { return ['👍', '❤️', '🎉', '✅', '👀']; }

  // Aggregate a comment's raw reaction rows ([{memberId, emoji}]) into ordered
  // {emoji, count, mine} groups, following the fixed set order so the row is
  // stable. Only emojis with at least one reaction render as a pill.
  _aggregateReactions(c) {
    const rows = Array.isArray(c.reactions) ? c.reactions : [];
    if (!rows.length) return [];
    const counts = new Map();
    const mine = new Set();
    rows.forEach(r => {
      counts.set(r.emoji, (counts.get(r.emoji) || 0) + 1);
      if (r.memberId === this.currentUser) mine.add(r.emoji);
    });
    const order = this._reactionSet();
    const known = order.filter(e => counts.has(e));
    const extra = Array.from(counts.keys()).filter(e => !order.includes(e)); // legacy/other
    return known.concat(extra).map(e => ({ emoji: e, count: counts.get(e), mine: mine.has(e) }));
  }

  _commentRow(c) {
    const esc = App.utils.escapeHtml;
    const person = App.directory.person(c.authorId) || { name: c.authorId || 'Someone', full: c.authorId || 'Someone', color: 'var(--ink-3)' };
    const ago = (c.createdAt && App.utils.timeAgo(c.createdAt)) || '';
    // Kind tag (migration 064). `kind` is authoritative: 'call' → CALL LOG,
    // 'note' → NOTE. Legacy rows saved before 064 are all kind 'comment', so
    // fall back to the old 📞/📝 body marker (and strip it) to keep them tagged.
    let raw = String(c.body || '');
    let tag = c.kind === 'call' ? 'CALL LOG' : c.kind === 'note' ? 'NOTE' : '';
    if (!tag) {
      if (/^\s*📞/.test(raw)) { tag = 'CALL LOG'; raw = raw.replace(/^\s*📞\s*/, ''); }
      else if (/^\s*📝/.test(raw)) { tag = 'NOTE'; raw = raw.replace(/^\s*📝\s*/, ''); }
    }
    // Escape first, then lightly highlight @mention tokens.
    const body = esc(raw).replace(/@(\w[\w.]*)/g, '<span class="cm-at">@$1</span>');
    const tagHtml = tag
      ? `<span class="td2-cm-tag ${tag === 'CALL LOG' ? 'call' : 'note'}"><i class="ti ${tag === 'CALL LOG' ? 'ti-phone' : 'ti-note'}"></i>${tag}</span>`
      : '';
    const cid = esc(String(c.id || ''));
    // Reaction pills (aggregated) + a hover-reveal add-reaction button whose
    // picker offers the fixed set. Buttons carry data-cid/data-emoji for
    // delegated wiring in _wireComments.
    const groups = this._aggregateReactions(c);
    const pills = groups.map(g =>
      `<button class="td2-cm-react${g.mine ? ' mine' : ''}" type="button" data-cid="${cid}" data-emoji="${esc(g.emoji)}" aria-pressed="${g.mine}"><span class="td2-cm-react-e">${esc(g.emoji)}</span><span class="td2-cm-react-n">${g.count}</span></button>`
    ).join('');
    const picker = this._reactionSet().map(e =>
      `<button class="td2-cm-rpick-b" type="button" data-cid="${cid}" data-emoji="${esc(e)}" title="React ${esc(e)}">${esc(e)}</button>`
    ).join('');
    const reactHtml = `
          <div class="td2-cm-reacts">
            ${pills}
            <div class="td2-cm-addwrap">
              <button class="td2-cm-addreact" type="button" data-react-add="${cid}" aria-label="Add reaction"><i class="ti ti-mood-smile"></i></button>
              <div class="td2-cm-rpick hidden" data-rpick="${cid}" role="menu">${picker}</div>
            </div>
          </div>`;
    return `
      <div class="cm-row">
        <div class="cm-av">${App.utils.avatarHtml(person)}</div>
        <div class="cm-bubble">
          <div class="cm-meta"><span class="cm-who">${esc(person.name)}</span>${tagHtml}${ago ? `<span class="cm-ago">· ${esc(ago)}</span>` : ''}</div>
          <div class="cm-text">${body}</div>${reactHtml}
          <div class="td2-cm-actions"><button class="td2-cm-reply" type="button" data-reply-first="${esc(String(person.name || '').trim().split(/\s+/)[0])}">Reply</button></div>
        </div>
      </div>`;
  }

  // People who can be @mentioned (id + names), from the known directory.
  _mentionCandidates() {
    return App.directory.people().map(x => x.id).map(id => {
      const p = App.directory.person(id) || {};
      const full = p.full || p.name || id;
      return { id, full, first: String(full).trim().split(/\s+/)[0] };
    });
  }

  _wireComments(t) {
    // --- reactions (Slice C) --- wired first so they work even if the composer
    // is absent. The whole pane is rebuilt each render, so these listeners are
    // attached to fresh nodes and never accumulate. Delegated on the list.
    const list = this.pane.querySelector('.cm-list');
    if (list) {
      const closePickers = (except) => {
        this.pane.querySelectorAll('.td2-cm-rpick').forEach(p => { if (p !== except) p.classList.add('hidden'); });
      };
      list.addEventListener('click', (e) => {
        // Reply → prefill the composer with @FirstName and focus it.
        const reply = e.target.closest('.td2-cm-reply');
        if (reply) {
          const input = this.pane.querySelector('#cmInput');
          if (input) {
            const first = reply.dataset.replyFirst || '';
            if (first && !input.value.includes('@' + first)) {
              input.value = (input.value.trim() ? input.value.trim() + ' ' : '') + '@' + first + ' ';
            }
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
          }
          return;
        }
        const pill = e.target.closest('.td2-cm-react, .td2-cm-rpick-b');
        if (pill && pill.dataset.emoji) {
          closePickers();
          this.controller.toggleReaction(t.id, pill.dataset.cid, pill.dataset.emoji);
          return;
        }
        const add = e.target.closest('.td2-cm-addreact');
        if (add) {
          const pick = list.querySelector(`.td2-cm-rpick[data-rpick="${add.dataset.reactAdd}"]`);
          const wasHidden = pick && pick.classList.contains('hidden');
          closePickers();                       // collapse any open picker first
          if (pick && wasHidden) pick.classList.remove('hidden'); // open only if it was closed
          return;
        }
        closePickers();
      });
    }

    const input = this.pane.querySelector('#cmInput');
    const sendBtn = this.pane.querySelector('#cmSend');
    const menu = this.pane.querySelector('#cmMentionMenu');
    if (!input || !sendBtn || !menu) return;
    this._composerMentions = this._composerMentions || new Set();
    this._mentionActive = 0;

    // --- composer kind segmented control (Slice C) --- update state in place
    // (no re-render, to keep composer focus/draft), retitle the send button.
    this._composerKind = this._composerKind || {};
    const kindBtns = Array.from(this.pane.querySelectorAll('.td2-cm-tools .td2-cm-kind'));
    kindBtns.forEach(btn => btn.addEventListener('click', () => {
      const k = btn.dataset.kind;
      // Toggle: clicking the active kind returns to a plain comment.
      const already = this._composerKind[t.id] === k;
      const next = already ? 'comment' : k;
      this._composerKind[t.id] = next;
      kindBtns.forEach(b => b.classList.toggle('is-on', !already && b === btn));
      sendBtn.textContent = 'Post';
      input.focus();
    }));
    // Visual-only tools (attachments / voice notes) — present to match the locked
    // pic; not wired to a feature yet, so acknowledge the tap rather than fail silently.
    this.pane.querySelectorAll('.td2-cm-tools [data-cm-soon]').forEach(btn => btn.addEventListener('click', () => {
      const tv = this.controller && this.controller.toastView;
      if (tv && tv.show) tv.show({ title: btn.getAttribute('data-cm-soon') + ' — coming soon' });
    }));

    const persistDraft = () => {
      this._commentDraft = this._commentDraft || {};
      this._commentDraft[t.id] = input.value;
    };

    const closeMenu = () => { menu.classList.add('hidden'); menu.innerHTML = ''; this._mentionActive = 0; };

    // Insert the highlighted (or clicked) mention at the caret and stay in the
    // composer — Podio flow: @mention + Enter selects, the NEXT Enter posts.
    const applyMention = (el) => {
      const caret2 = input.selectionStart;
      const before = input.value.slice(0, caret2).replace(/@(\w*)$/, '@' + el.dataset.first + ' ');
      const after = input.value.slice(caret2);
      input.value = before + after;
      const pos = before.length;
      input.setSelectionRange(pos, pos);
      this._composerMentions.add(el.dataset.id);
      persistDraft();
      closeMenu();
      input.focus();
    };

    const menuItems = () => Array.from(menu.querySelectorAll('.cm-mention-item'));
    const setActive = (i) => {
      const list = menuItems();
      if (!list.length) return;
      this._mentionActive = ((i % list.length) + list.length) % list.length;
      list.forEach((el, j) => el.classList.toggle('is-active', j === this._mentionActive));
      list[this._mentionActive].scrollIntoView({ block: 'nearest' });
    };

    const renderMenu = () => {
      const caret = input.selectionStart;
      const upto = input.value.slice(0, caret);
      const m = upto.match(/@(\w*)$/);
      if (!m) { closeMenu(); return; }
      const q = m[1].toLowerCase();
      const matches = this._mentionCandidates()
        .filter(c => c.full.toLowerCase().includes(q))
        .slice(0, 6);
      if (!matches.length) { closeMenu(); return; }
      menu.innerHTML = matches.map(c =>
        `<div class="cm-mention-item" role="option" data-id="${App.utils.escapeHtml(c.id)}" data-first="${App.utils.escapeHtml(c.first)}">${App.utils.escapeHtml(c.full)}</div>`).join('');
      menu.classList.remove('hidden');
      menuItems().forEach((el, idx) => {
        el.addEventListener('mousedown', (e) => { e.preventDefault(); applyMention(el); });
        el.addEventListener('mouseenter', () => setActive(idx));
      });
      setActive(0);
    };

    input.addEventListener('input', () => { persistDraft(); renderMenu(); });
    input.addEventListener('keydown', (e) => {
      const menuOpen = !menu.classList.contains('hidden');
      if (menuOpen) {
        // Keyboard-drive the mention menu: arrows move, Enter/Tab select and
        // keep focus in the composer, Escape dismisses.
        if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); setActive(this._mentionActive + 1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); setActive(this._mentionActive - 1); return; }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          const el = menuItems()[this._mentionActive] || menuItems()[0];
          if (el) applyMention(el);
          return;
        }
      }
      // Enter posts; Shift+Enter makes a new line (Cmd/Ctrl+Enter still posts).
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    input.addEventListener('blur', () => setTimeout(closeMenu, 120));

    const send = () => {
      const text = input.value.trim();
      if (!text) return;
      // Derive mentions from the typed text itself, not just picker state, so a
      // hand-typed @name still notifies. For each typed @token, resolve it to a
      // member id by matching the full typed token first (handles duplicate
      // first names), then falling back to a first-name match. Picker-populated
      // ids are unioned in (covers picked-then-edited cases).
      const lower = text.toLowerCase();
      const cands = this._mentionCandidates();
      const ids = new Set();
      const tokenRe = /@(\w[\w.]*)/g;
      let m;
      while ((m = tokenRe.exec(text)) !== null) {
        const tok = m[1].toLowerCase();
        const full = cands.find(c => c.full.toLowerCase() === tok);
        if (full) { ids.add(full.id); continue; }
        const first = cands.find(c => c.first.toLowerCase() === tok);
        if (first) ids.add(first.id);
      }
      // Keep any picker-chosen ids whose @first token still appears in the text.
      Array.from(this._composerMentions).forEach(id => {
        const c = cands.find(x => x.id === id);
        if (c && lower.includes('@' + c.first.toLowerCase())) ids.add(id);
      });
      const mentions = Array.from(ids);
      const kind = (this._composerKind && this._composerKind[t.id]) || 'comment';
      // Reset the composer BEFORE posting: comments:changed can re-render
      // synchronously, and the rebuilt composer (drawn from _commentDraft/kind)
      // must come up empty + back on Comment rather than resurrect prior state.
      input.value = '';
      this._composerMentions = new Set();
      if (this._commentDraft) delete this._commentDraft[t.id];
      if (this._composerKind) delete this._composerKind[t.id];
      closeMenu();
      this.controller.addTaskComment(t.id, text, mentions, kind);
    };
    sendBtn.addEventListener('click', send);
  }

  /* ---------- Slice B: stuck / help pickers ---------- */

  // Whole days elapsed since an ISO timestamp (0 = today). Defensive against
  // bad/missing values.
  _daysSince(iso) {
    if (!iso) return 0;
    const then = new Date(iso).getTime();
    if (isNaN(then)) return 0;
    return Math.max(0, Math.floor((Date.now() - then) / 86400000));
  }

  /* "I'm stuck" inline panel anchored to the trigger: a reason textarea + a
     teammate picker (excluding self). Confirm stays disabled until both are
     filled → controller.flagStuck. Re-clicking the trigger closes it. Suppresses
     background re-renders while open (the _inlineEdit guard) so a sync poll can't
     wipe the half-filled panel. */
  _openStuckPanel(t, anchor) {
    if (!App.can('tasks.write')) return;
    if (this._stuckHandle) { this._stuckHandle.close('api'); return; }

    this._inlineEdit = { taskId: t.id, field: 'stuck' };
    const token = this._inlineEdit;

    const people = App.utils.peopleInCompany(t.company, t.assignee)
      .filter(p => p.id !== this.currentUser);

    let chosen = null;
    let confirmed = false;
    this._stuckHandle = App.Menu.open({
      anchor,
      className: 'td2-stuck-panel',
      onClose: () => {
        this._stuckHandle = null;
        if (this._inlineEdit === token) this._inlineEdit = null;
        // Dismissal without Confirm = cancel; re-render restores the pill row.
        if (!confirmed) this.render();
      },
      build: (panel, h) => {
        panel.innerHTML = `
          <div class="td2-am-h">I'm stuck</div>
          <textarea class="td2-stuck-input" rows="2" maxlength="500" placeholder="What's blocking this?"></textarea>
          <div class="td2-stuck-pick-lbl">Blocked on</div>
          <div class="td2-am-list td2-stuck-people">
            ${people.map(p => `<button class="td2-am-item" data-id="${App.utils.escapeHtml(p.id)}" type="button">
              ${App.utils.avatarHtml(p)}<span class="td2-am-name">${App.utils.escapeHtml(p.full || p.name)}</span>
              <i class="ti ti-check td2-am-check td2-stuck-check" aria-hidden="true"></i>
            </button>`).join('') || '<div class="td2-am-empty">No teammates in this company</div>'}
          </div>
          <div class="td2-stuck-panel-actions">
            <button class="td2-stuck-btn td2-stuck-btn-primary td2-stuck-confirm" type="button" disabled><i class="ti ti-flag"></i>Confirm</button>
          </div>`;

        const ta = panel.querySelector('.td2-stuck-input');
        const confirm = panel.querySelector('.td2-stuck-confirm');
        const refresh = () => {
          confirm.disabled = !(ta.value.trim().length > 0 && !!chosen);
        };
        panel.querySelectorAll('.td2-am-item').forEach(b => b.addEventListener('click', (e) => {
          e.stopPropagation();
          chosen = b.dataset.id;
          panel.querySelectorAll('.td2-am-item').forEach(x => x.classList.toggle('is-on', x === b));
          refresh();
        }));
        ta.addEventListener('input', refresh);
        ta.addEventListener('click', (e) => e.stopPropagation());
        confirm.addEventListener('click', (e) => {
          e.stopPropagation();
          const reason = ta.value.trim();
          if (!reason || !chosen) return;
          confirmed = true;
          h.close('api');
          this.controller.flagStuck(t.id, reason, chosen);
        });
        setTimeout(() => ta.focus(), 0);
      },
    });
  }

  /* "Request help" teammate picker (excluding self). Picking a person calls
     controller.requestHelp and closes. Same menu vocabulary as the assignee
     picker. */
  _openHelpPicker(t, anchor) {
    if (!App.can('tasks.write')) return;
    if (this._helpHandle) { this._helpHandle.close('api'); return; }

    const people = App.utils.peopleInCompany(t.company, t.assignee)
      .filter(p => p.id !== this.currentUser);

    this._helpHandle = App.Menu.open({
      anchor,
      className: 'td2-assignee-menu td2-help-menu',
      onClose: () => { this._helpHandle = null; },
      build: (menu, h) => {
        menu.innerHTML = `
          <div class="td2-am-h">Request help from</div>
          <div class="td2-am-list">
            ${people.map(p => `<button class="td2-am-item" data-id="${App.utils.escapeHtml(p.id)}" type="button">
              ${App.utils.avatarHtml(p)}<span class="td2-am-name">${App.utils.escapeHtml(p.full || p.name)}</span>
            </button>`).join('') || '<div class="td2-am-empty">No teammates in this company</div>'}
          </div>`;
        menu.querySelectorAll('.td2-am-item').forEach(b => b.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = b.dataset.id;
          h.close('api');
          if (id) this.controller.requestHelp(t.id, id);
        }));
      },
    });
  }

  _formatDue(due) {
    if (!due) return '—';
    const d = new Date(due + 'T00:00:00');
    if (isNaN(d.getTime())) return due;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  /* Snapshot the task's editable fields into a mutable draft. The Edit form
     reads and writes only this draft; nothing reaches the model until Save, so
     Cancel discards the draft and the task is untouched. */
  _draftFromTask(t) {
    return {
      title: t.title || '',
      description: t.description || '',
      company: t.company,
      project: t.project || null,
      type: t.type || 'admin',
      label: t.label || 'roof',
      status: t.status || 'todo',
      assignee: t.assignee,
      due: t.due || '',
      dueTime: t.dueTime || '',
      reminderAt: t.reminderAt || '',
      priority: t.priority || 'medium',
      watchers: (t.watchers || []).slice(),
      subtasks: (t.subtasks || []).map(s => ({ t: s.t, d: !!s.d })),
    };
  }

  /* Pull the current scalar input values back into the draft. Called before any
     re-render (type toggle, watcher/subtask change) so unsaved text/selections
     survive, and before Save. The watcher/subtask lists already live on the
     draft and are mutated directly by their handlers. */
  _syncDraftFromDom() {
    const d = this.editDraft;
    if (!d) return;
    const val = (id) => { const el = document.getElementById(id); return el ? el.value : undefined; };
    const set = (key, id) => { const v = val(id); if (v !== undefined) d[key] = v; };
    set('title', 'edit-title');
    set('description', 'edit-desc');
    set('company', 'edit-company');
    set('type', 'edit-type');
    set('label', 'edit-label');
    set('status', 'edit-status');
    set('assignee', 'edit-assignee');
    set('due', 'edit-due');
    set('dueTime', 'edit-dueTime');
    set('reminderAt', 'edit-reminderAt');
    set('priority', 'edit-priority');
  }

  _formatReminder(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(s || ''));
    if (!m) return s || '—';
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  /* Staged Edit form for every editable field. Renders entirely from this.editDraft
     (initialised on entering edit mode), so it can re-render on a type toggle or a
     watcher/subtask change without losing other unsaved input. Save commits the
     draft via the controller; Cancel throws it away. */
  renderEditMode(t, { focusTitle = false } = {}) {
    const d = this.editDraft;
    const company = App.directory.company(d.company) || { pill: '', label: d.company || '—' };
    const opts = (entries, selected) => entries
      .map(([k, label]) => `<option value="${App.utils.escapeHtml(k)}" ${k === selected ? 'selected' : ''}>${App.utils.escapeHtml(label)}</option>`)
      .join('');

    const watcherChips = d.watchers.map(w => {
      const p = App.directory.person(w) || App.utils.unknownPerson(w);
      return `<span class="watcher-chip-detail" data-watcher-id="${App.utils.escapeHtml(w)}">
        ${App.utils.avatarHtml(p)}${App.utils.escapeHtml(p.name)}
        <button class="watcher-remove" data-action="remove-watcher" data-member-id="${App.utils.escapeHtml(w)}" aria-label="Remove ${App.utils.escapeHtml(p.name)}" type="button">×</button>
      </span>`;
    }).join('');
    const addable = App.utils.peopleInCompany(d.company, d.assignee).filter(p => p.id !== d.assignee && !d.watchers.includes(p.id));
    const watcherAdd = addable.length ? `
      <select class="watcher-add-select" data-action="add-watcher">
        <option value="">+ Add watcher…</option>
        ${addable.map(p => `<option value="${App.utils.escapeHtml(p.id)}">${App.utils.escapeHtml(p.full)}</option>`).join('')}
      </select>` : '';

    const subtaskRows = d.subtasks.length ? d.subtasks.map((s, i) =>
      `<div class="edit-subtask-row">
         <div class="subtask ${s.d ? 'done' : ''}" data-action="toggle-subtask" data-idx="${i}" style="cursor:pointer; flex:1;">
           <i class="ti ${s.d ? 'ti-circle-check-filled' : 'ti-circle'}"></i>${App.utils.escapeHtml(s.t)}
         </div>
         <button class="subtask-remove" data-action="remove-subtask" data-idx="${i}" aria-label="Remove subtask" title="Remove" type="button">×</button>
       </div>`
    ).join('') : `<div style="font-size:11.5px; color:var(--ink-3);">No subtasks yet</div>`;

    const sel = (id, entries, selected, extraAttr = '') =>
      `<div class="te-selwrap"><select id="${id}" ${extraAttr}>${opts(entries, selected)}</select><i class="ti ti-chevron-down te-car"></i></div>`;

    this.pane.innerHTML = `
      <div class="te-mode">
        <div class="te-topbar">
          <button class="te-back" data-action="cancel-edit" aria-label="Back to task" type="button"><i class="ti ti-arrow-left"></i> Back to task</button>
          <span class="te-crumb">/</span><span class="te-tag">EDIT TASK</span>
          <span class="te-byline"><span class="pill ${company.pill}">${App.utils.escapeHtml(company.label)}</span></span>
        </div>

        <div class="te-cols">
          <div class="te-sheet">
            <div class="te-titlebox">
              <input type="text" id="edit-title" class="te-title-in" value="${App.utils.escapeHtml(d.title)}" maxlength="200" placeholder="What needs to get done?" aria-label="Task title" />
            </div>

            <div class="te-sec">
              <div class="te-sec-h"><span class="te-n">01</span><span class="te-t">Details</span></div>
              <div class="te-frow">
                <div class="te-f"><label>Company</label>${sel('edit-company', this._companyOpts(d.company), d.company)}</div>
                <div class="te-f"><label>Type</label>${sel('edit-type', App.taxonomy.activeTypes(d.company).map(tp => [tp.key, tp.label]), d.type, 'data-action="type-change"')}</div>
                <div class="te-f"><label>Status</label>${sel('edit-status', this._statusOpts(d.company, d.type, d.status), d.status)}</div>
                <div class="te-f"><label>Label</label>${sel('edit-label', [['none', (App.TASK_LABELS.none && App.TASK_LABELS.none.label) || 'No label'], ...App.taxonomy.activeLabels(d.company).map(l => [l.key, l.label])], d.label || 'none')}</div>
                <div class="te-f"><label>Priority</label>${sel('edit-priority', Object.entries(App.PRIORITIES).map(([k, v]) => [k, v.label]), d.priority)}</div>
                <div class="te-f"><label>Assignee</label><div class="te-selwrap"><select id="edit-assignee">${App.utils.peopleInCompany(d.company, d.assignee).map(p => { const lbl = p.name + (p.position ? ` — ${p.position}` : ''); return `<option value="${App.utils.escapeHtml(p.id)}" ${p.id === d.assignee ? 'selected' : ''}>${App.utils.escapeHtml(lbl)}</option>`; }).join('')}</select><i class="ti ti-chevron-down te-car"></i></div></div>
                <div class="te-f"><label>Due</label><input type="date" id="edit-due" value="${App.utils.escapeHtml(d.due)}" class="te-input picker-input" /></div>
                <div class="te-f"><label>Time <span class="te-opt">Optional</span></label><input type="time" id="edit-dueTime" value="${App.utils.escapeHtml(d.dueTime)}" class="te-input picker-input" /></div>
                <div class="te-f"><label>Reminder <span class="te-opt">Optional</span></label><button type="button" id="edit-reminderAt" class="te-btn rp-trigger ${d.reminderAt ? '' : 'rp-trigger-empty'}" value="${App.utils.escapeHtml(d.reminderAt)}" aria-haspopup="dialog"><i class="ti ti-bell"></i><span class="rp-trigger-lbl">${d.reminderAt ? App.utils.escapeHtml(App.reminderPicker.format(d.reminderAt)) : 'Set a reminder'}</span></button></div>
                <div class="te-f"><label>Project</label>${(() => {
                  const p = App.directory.project(d.project);
                  return `<button type="button" id="edit-project" class="te-btn projtag-btn ${p ? '' : 'projtag-empty'}" data-action="edit-open-project" aria-haspopup="listbox" ${p ? `style="--pc:${App.utils.escapeHtml(p.color)}"` : ''}><i class="ti ${p ? 'ti-folder' : 'ti-folder-plus'}"></i>${p ? App.utils.escapeHtml(p.name) : 'No project'}</button>`;
                })()}</div>
              </div>
            </div>

            <div class="te-sec">
              <div class="te-sec-h"><span class="te-n">02</span><span class="te-t">Description</span></div>
              <textarea id="edit-desc" class="te-desc" rows="5" maxlength="5000" placeholder="Add context, links, scope…">${App.utils.escapeHtml(d.description)}</textarea>
            </div>

            <div class="te-sec">
              <div class="te-sec-h"><span class="te-n">03</span><span class="te-t">Subtasks</span></div>
              <div class="te-subs">${subtaskRows}</div>
              <div class="te-subadd">
                <input type="text" id="edit-subtask-input" maxlength="200" placeholder="Add a step and press Enter" />
                <button class="te-addbtn" data-action="add-subtask" type="button">Add</button>
              </div>
            </div>
          </div>

          <aside class="te-side">
            <div class="te-sec te-sec-side">
              <div class="te-sec-h"><span class="te-t"><i class="ti ti-users"></i> Watchers</span></div>
              <div class="te-watchers">${watcherChips}${watcherAdd}</div>
            </div>
          </aside>
        </div>

        <div class="te-foot">
          <button class="te-fbtn" data-action="cancel-edit" type="button">Cancel</button>
          <button class="te-fbtn te-fbtn-primary" data-action="save-edit" type="button">Save changes</button>
        </div>
      </div>
    `;
    this.bindEditHandlers(t, { focusTitle });
  }

  bindEditHandlers(t, { focusTitle = false } = {}) {
    const exitEdit = () => { this.editingId = null; this.editDraft = null; this.render(); };

    this.pane.querySelectorAll('[data-action="cancel-edit"]').forEach(el =>
      el.addEventListener('click', exitEdit)
    );

    const saveBtn = this.pane.querySelector('[data-action="save-edit"]');
    const save = () => {
      this._syncDraftFromDom();
      const ok = this.controller.updateTaskDetails(t.id, this.editDraft);
      if (!ok) return; // validation failed — stay in edit mode with input preserved
      // Hold the button in a pending state until the change actually SYNCS, then
      // leave edit mode. saveNow resolves once a save that included this edit
      // has settled; without it we exit immediately.
      const restore = (App.Motion && saveBtn) ? App.Motion.busy(saveBtn) : function () {};
      const finish = () => { restore(); exitEdit(); };
      if (this.controller.saveNow) this.controller.saveNow().then(finish, finish);
      else finish();
    };
    if (saveBtn) saveBtn.addEventListener('click', save);

    // Type change re-scopes Status to the new type and resets it to that type's default.
    const typeSel = this.pane.querySelector('[data-action="type-change"]');
    if (typeSel) typeSel.addEventListener('change', (e) => {
      this._syncDraftFromDom();
      this.editDraft.type = e.target.value;
      this.editDraft.status = App.taxonomy.defaultStatus(this.editDraft.company, e.target.value);
      this.renderEditMode(t);
    });

    // Company change re-scopes Type, Status, Label, Assignee to the new company's taxonomy.
    const companySel = this.pane.querySelector('#edit-company');
    if (companySel) companySel.addEventListener('change', (e) => {
      this._syncDraftFromDom();
      const newCo = e.target.value;
      this.editDraft.company = newCo;
      const newTypes = App.taxonomy.activeTypes(newCo);
      if (!newTypes.some(tp => tp.key === this.editDraft.type)) {
        this.editDraft.type = (newTypes[0] && newTypes[0].key) || this.editDraft.type;
      }
      this.editDraft.status = App.taxonomy.defaultStatus(newCo, this.editDraft.type);
      this.renderEditMode(t);
    });

    // Project picker in edit mode: stage the choice on the draft, then re-render
    // so the button reflects it. Scope to the company currently selected.
    const editProjBtn = this.pane.querySelector('[data-action="edit-open-project"]');
    if (editProjBtn) editProjBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._syncDraftFromDom();
      const companyId = (document.getElementById('edit-company') || {}).value || this.editDraft.company;
      App.projectPicker.open({
        anchor: editProjBtn,
        companyId,
        currentId: this.editDraft.project || null,
        onSelect: (id) => { this.editDraft.project = id; this.renderEditMode(t); },
      });
    });

    // Watchers + subtasks mutate the draft in place, then re-render.
    this.pane.querySelectorAll('[data-action="remove-watcher"]').forEach(btn =>
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._syncDraftFromDom();
        this.editDraft.watchers = this.editDraft.watchers.filter(w => w !== btn.dataset.memberId);
        this.renderEditMode(t);
      })
    );
    const addWatcherSel = this.pane.querySelector('[data-action="add-watcher"]');
    if (addWatcherSel) addWatcherSel.addEventListener('change', () => {
      const id = addWatcherSel.value;
      if (!id) return;
      this._syncDraftFromDom();
      if (!this.editDraft.watchers.includes(id)) this.editDraft.watchers.push(id);
      this.renderEditMode(t);
    });
    this.pane.querySelectorAll('[data-action="toggle-subtask"]').forEach(el =>
      el.addEventListener('click', () => {
        const i = parseInt(el.dataset.idx, 10);
        this._syncDraftFromDom();
        if (this.editDraft.subtasks[i]) this.editDraft.subtasks[i].d = !this.editDraft.subtasks[i].d;
        this.renderEditMode(t);
      })
    );
    this.pane.querySelectorAll('[data-action="remove-subtask"]').forEach(el =>
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const i = parseInt(el.dataset.idx, 10);
        this._syncDraftFromDom();
        this.editDraft.subtasks.splice(i, 1);
        this.renderEditMode(t);
      })
    );
    // Add a new subtask to the draft (Add button or Enter in the input). Re-
    // renders and refocuses the input so several can be added in a row.
    const addSubtask = () => {
      const inp = this.pane.querySelector('#edit-subtask-input');
      if (!inp) return;
      const text = inp.value.trim();
      if (!text) return;
      this._syncDraftFromDom();
      this.editDraft.subtasks.push({ t: text.slice(0, 200), d: false });
      this.renderEditMode(t);
      const next = this.pane.querySelector('#edit-subtask-input');
      if (next) next.focus();
    };
    const addSubtaskBtn = this.pane.querySelector('[data-action="add-subtask"]');
    if (addSubtaskBtn) addSubtaskBtn.addEventListener('click', addSubtask);
    const subtaskInput = this.pane.querySelector('#edit-subtask-input');
    if (subtaskInput) subtaskInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); e.stopPropagation(); addSubtask(); }
    });

    this.pane.querySelectorAll('.picker-input').forEach(input =>
      input.addEventListener('click', () => {
        try { input.showPicker(); } catch (e) { /* unsupported or not user-activated */ }
      })
    );

    // Reminder — shared calendar+time popover. The trigger button carries the
    // staged "YYYY-MM-DDTHH:MM" in its .value, so _syncDraftFromDom reads it
    // like any input.
    const editRem = this.pane.querySelector('#edit-reminderAt');
    if (editRem) editRem.addEventListener('click', (e) => {
      e.stopPropagation();
      App.reminderPicker.open({
        anchor: editRem,
        value: editRem.value || null,
        onCommit: (v) => {
          editRem.value = v || '';
          editRem.classList.toggle('rp-trigger-empty', !v);
          const lbl = editRem.querySelector('.rp-trigger-lbl');
          if (lbl) lbl.textContent = v ? App.reminderPicker.format(v) : 'Set a reminder';
        },
      });
    });

    // Keydown on the edit body (replaced each render) so listeners can't stack.
    const editBody = this.pane.querySelector('.detail-body');
    if (editBody) editBody.addEventListener('keydown', (e) => {
      // Escape exits edit mode back to the read view only. Stop it bubbling to
      // the document-level Escape handler (controller.handleEscape), which would
      // otherwise also closeDetail() and kick the user all the way to the list.
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); exitEdit(); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); }
    });

    if (focusTitle) {
      const titleInput = document.getElementById('edit-title');
      if (titleInput) { titleInput.focus(); titleInput.select(); }
    }
  }
};
