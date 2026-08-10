/* Bootstrap - wires the three layers together.
   1. Construct models, hydrate from Supabase
   2. Construct controller
   3. Construct views
   4. Persist to Supabase on any model change
   5. Start the 1-second clock tick */
document.addEventListener('DOMContentLoaded', async () => {
  if (App.authReady) await App.authReady;
  App.currentProfile = App.currentProfile || {};
  App.CURRENT_USER = App.currentProfile.member_id || App.CURRENT_USER;

  if (!App.can('app.use') && !App.can('clock.use') && !App.can('roles.manage')) {
    renderRoleGate();
    return;
  }

  const taskModel = new App.TaskModel();
  const timeModel = new App.TimeModel();
  const notifModel = new App.NotificationModel();

  const dataStore = App.previewMode
    ? {
        load: async () => null,
        save: async () => ({ conflicts: [] }),
        loadProfiles: async () => App.PROFILES || [],
        loadNotifications: async () => [],
        // Comments live in-memory in preview/offline mode (no Supabase table).
        loadComments: async (taskId) => (App._previewComments && App._previewComments[taskId]) || [],
        loadRecentComments: async (limit = 40) => Object.values(App._previewComments || {})
          .flat()
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
          .slice(0, limit),
        addComment: async (taskId, { body, mentions }) => {
          App._previewComments = App._previewComments || {};
          const list = App._previewComments[taskId] || (App._previewComments[taskId] = []);
          const c = {
            id: App.utils.uid('c'), taskId, authorId: App.CURRENT_USER,
            body: String(body || ''), mentions: Array.isArray(mentions) ? mentions : [],
            createdAt: new Date().toISOString(),
          };
          list.push(c);
          return c;
        },
        updateProfileAccess: async (id, updates) => {
          const p = (App.PROFILES || []).find(pr => pr.id === id);
          if (p) {
            p.role = updates.role;
            p.approved = !!updates.approved;
            if ('supervisorId' in updates) p.supervisor_id = updates.supervisorId || null;
            if ('companyIds' in updates) p.company_ids = Array.isArray(updates.companyIds) ? updates.companyIds : [];
          }
          return p || {};
        },
        sendNotifications: async () => {},
        sendEmail: async () => ({ ok: false, skipped: true }),
        getBriefing: async () => ({ ok: false, error: 'AI briefing is not available in preview mode.' }),
        getWeeklyDigest: async () => ({ ok: false, error: 'AI digest is not available in preview mode.' }),
        projectRollup: async () => ({ ok: false, error: 'AI project rollup is not available in preview mode.' }),
        draftTask: async () => ({ ok: false, error: 'AI drafting is not available in preview mode.' }),
        chat: async () => ({ ok: false, error: 'AI chat is not available in preview mode.' }),
        deleteProfile: async (id) => {
          App.PROFILES = (App.PROFILES || []).filter(pr => pr.id !== id);
          return { emailFreed: true };
        },
        createUser: async () => {
          throw new Error('Adding people is not available in preview/offline mode.');
        },
      }
    : new App.SupabaseDataStore({
        supabase: App.supabase,
        currentUser: App.CURRENT_USER,
        role: App.currentProfile.role || 'member',
      });

  if (App.previewMode) {
    taskModel.seedDefaults();
    if (typeof timeModel.seedDefaults === 'function') timeModel.seedDefaults();
    // Demo roles + reporting lines so role-gated views (worker, supervisor, hierarchy)
    // can be exercised in preview via ?preview=1&role=...&member=...
    const previewRoles = {
      abraham:  { role: 'admin',                   company_ids: ['roofing', 'drafting', 'lumen'] },
      alkeith:  { role: 'construction_supervisor', company_ids: ['roofing'] },
      jesus:    { role: 'supervisor',              company_ids: ['roofing'] },
      kristine: { role: 'worker', supervisor_id: 'jesus',   company_ids: ['roofing'] },
      andres:   { role: 'worker', supervisor_id: 'alkeith', company_ids: ['drafting'] },
      adrian:   { role: 'member', approved: false,          company_ids: ['lumen'] },
    };
    App.PROFILES = Object.values(App.PEOPLE).map(p => {
      const cfg = previewRoles[p.id] || { role: 'sales' };
      return {
        id: 'preview-' + p.id,
        email: p.email,
        full_name: p.full,
        approved: cfg.approved !== undefined ? cfg.approved : true,
        role: cfg.role,
        email_verified: true,
        member_id: p.id,
        supervisor_id: cfg.supervisor_id || null,
        company_ids: Array.isArray(cfg.company_ids) ? cfg.company_ids : (cfg.company_id ? [cfg.company_id] : []),
        created_at: new Date().toISOString(),
      };
    });
    // Mirror the previewed member's company_ids onto the active profile so the
    // company switcher / scoping works in preview (the auth-guard stub omits it).
    const mineCfg = previewRoles[App.currentProfile.member_id];
    if (mineCfg && !App.currentProfile.company_ids) {
      App.currentProfile.company_ids = Array.isArray(mineCfg.company_ids) ? mineCfg.company_ids : [];
    }
    // Preview/offline: no Supabase — build the taxonomy from the constants.
    App.taxonomy.hydrate(null);
  } else {
    try {
      const saved = await dataStore.load();
      if (saved.people && Object.keys(saved.people).length) App.PEOPLE = saved.people;
      App.PROFILES = saved.profiles || [];
      App.projects = saved.projects || {};
      taskModel.hydrate(saved.tasks);
      timeModel.hydrate(saved.timeEntries, saved.activeTimers);
      notifModel.hydrate(saved.notifications);
      // Per-company task taxonomy (types/statuses/labels). Falls back to the
      // hardcoded constants if the DB returned nothing.
      App.taxonomy.hydrate(saved.taxonomy);
    } catch (err) {
      console.error('[app] Supabase load failed', err);
      renderFatalDataError(err);
      return;
    }
    // Best-effort: hard-delete cleared tasks past their 30-day grace.
    // Fire-and-forget so a slow delete doesn't block first paint; RLS
    // gates this to roles allowed by migration 017.
    if (dataStore.purgeExpiredClearedTasks) {
      dataStore.purgeExpiredClearedTasks().then(n => {
        if (n) console.info(`[app] purged ${n} expired cleared task(s)`);
      });
    }
  }

  // A user's display name + photo live on their PROFILE, but the task list
  // and pickers read from the team_members roster (App.PEOPLE). Non-managers
  // can't write team_members (RLS), so the roster can lag behind the profile.
  // Overlay profile name/avatar onto App.PEOPLE so the chosen display name and
  // photo show everywhere, regardless of whether team_members was synced.
  overlayProfilesOntoPeople();

  const controller = new App.AppController({
    taskModel,
    timeModel,
    notifModel,
    currentUser: App.CURRENT_USER,
    dataStore,
  });

  // Resolve the user's accessible companies + active company before any view
  // renders, so the first paint is already company-scoped.
  controller.initCompanyContext();

  // Expose models on App for console debugging (read-only contract — don't
  // mutate from console in production, but inspect freely).
  App.taskModel = taskModel;
  App.timeModel = timeModel;
  App.notifModel = notifModel;
  App.controller = controller;
  App.dataStore = dataStore;

  const toastView = new App.ToastView('toastContainer');
  const newTaskPage = new App.NewTaskPageView({ controller, currentUser: App.CURRENT_USER });
  const profileView = new App.ProfileView({ controller });
  const reportProblemView = new App.ReportProblemView({ controller, dataStore });
  const newFolderView = new App.NewFolderView();
  const textPromptView = new App.TextPromptView();
  const chatDrawerView = new App.ChatDrawerView({ controller, dataStore });
  controller.attachViews({ toastView, newTaskPage, profileView, reportProblemView, newFolderView, textPromptView, chatDrawerView });

  // Last-resort handlers: any error that escaped its own try/catch ends up
  // here as a clean toast instead of an unhandled rejection in the console.
  // We never display raw error.message unless App.errors.userMessage decides
  // it's safe (AppError.expose === true), so DB internals stay hidden. The
  // same error is also forwarded to observability — Sentry sees the real
  // error object (with stack), the user sees a clean toast.
  const surfaceUnhandled = (err) => {
    try {
      console.error('[unhandled]', err);
      if (App.observability) App.observability.captureException(err, { source: 'global-handler' });
      toastView.show({
        title: 'Something went wrong',
        sub: (App.errors && App.errors.userMessage) ? App.errors.userMessage(err) : 'Please try again.',
      });
    } catch { /* swallow — never let the error handler throw */ }
  };
  window.addEventListener('error', (e) => surfaceUnhandled(e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => surfaceUnhandled(e.reason));

  new App.TopbarView({ timeModel, notifModel, controller, currentUser: App.CURRENT_USER });
  new App.SidebarView({ taskModel, timeModel, controller, currentUser: App.CURRENT_USER });
  new App.BottomNavView({ controller });
  new App.TaskListView({ taskModel, timeModel, controller, currentUser: App.CURRENT_USER });
  new App.TaskDetailView({ taskModel, timeModel, controller, currentUser: App.CURRENT_USER });
  App.projectPicker = new App.ProjectPickerView({ controller });
  App.projectsView = new App.ProjectsView({ controller, taskModel });
  new App.FilterBarView({ controller });
  new App.BulkActionsView({ controller });
  new App.ResizeHandleView({ controller });
  new App.ToolbarMenuView({ controller });
  App.uiScale = new App.UiScaleView();
  new App.ProgressWidgetView({ taskModel, currentUser: App.CURRENT_USER });
  new App.UpNextWidgetView({ taskModel, timeModel, controller, currentUser: App.CURRENT_USER });
  // FocusWidgetView (the "Showing execution order" strip) retired: inline drag on
  // the Category Sequence Board replaces its purpose. Source kept for the flat
  // execution layout.

  // Reminder engine — scans tasks every minute, synthesizes in-app
  // notifications when a due-date threshold is crossed (keyed by priority).
  const reminderEngine = new App.ReminderEngine({
    taskModel,
    notifModel,
    currentUser: App.CURRENT_USER,
  });
  reminderEngine.start();
  App.reminderEngine = reminderEngine;
  new App.TimeView({ taskModel, timeModel, controller, currentUser: App.CURRENT_USER });
  new App.HomeView({ controller });
  new App.ReportsView({ controller });
  new App.WallboardView({ controller });
  new App.ApprovalView({ controller, dataStore });
  new App.ClockDashboardView({ taskModel, timeModel, controller });
  new App.HierarchyView({ controller });
  new App.TaskSetupAdminView({ controller });
  new App.CheckinSettingsView({ controller });
  new App.PermissionsAdminView({ controller });
  new App.ReportsAdminView({ controller, dataStore });

  applyRoleChrome(controller);

  // Data is loaded and the views have rendered — drop the boot skeleton if it
  // wasn't already replaced (e.g. clock-only users whose task list never renders).
  const bootSkeleton = document.getElementById('listSkeleton');
  if (bootSkeleton) bootSkeleton.remove();

  // Expose the role as a body class so CSS can scope per-role tweaks
  // (e.g. hide the Assignee column for workers/members). Uses the effective
  // role so a developer previewing another role gets that role's chrome.
  document.body.classList.add('role-' + App.effectiveRole());

  // Preview-only: ?view= lets you deep-link an initial view for screenshots/testing.
  // Otherwise, restore the view/layout the user left off on last session.
  if (App.previewMode) {
    const pv = new URLSearchParams(window.location.search).get('view');
    if (pv) controller.setView(pv);
  } else {
    controller.restoreUiState();
  }

  // Real browser history: back/forward walks the user's path, #/… deep links
  // restore on refresh. Must run after restoreUiState so a deep link wins.
  controller.initHistory();

  // Data + views are ready and the last view is restored — fade out the boot loader.
  if (App.hideAppLoader) App.hideAppLoader();

  // Watch for a new deploy (env.json `release` change) and reload the tab when
  // one lands, holding off while the user is mid-edit so input isn't lost.
  if (App.UpdateWatcher) App.UpdateWatcher.start();

  // Delta save: only the tasks/time-entries that actually changed are written,
  // via upserts (never delete-and-reinsert). Conflicts (a newer server version)
  // are reconciled by taking the server's copy.
  //
  // The scheduling machinery (350ms debounce, single-flight coalescing, and the
  // saveNow generation barrier) lives in PersistenceEngine — see that file for
  // the invariants. app.js only supplies the app-specific pieces: what a
  // snapshot contains, how conflicts reconcile, and how failures re-flag.
  const engine = new App.PersistenceEngine({
    debounceMs: 350,
    // Snapshot-and-clear: takeDirty()/takeUnsavedEntries() clear the dirty sets
    // synchronously, so edits made DURING the awaited write re-dirty the models
    // and ride the coalesced follow-up run. Notifications: upsert only the rows
    // that actually changed (dirty ids) so a save doesn't clobber read/meta/html
    // state another device may have updated.
    takeSnapshot: () => ({
      tasks: taskModel.takeDirty(),
      timeEntries: timeModel.takeUnsavedEntries(),
      activeTimers: timeModel.activeTimers,
      notifications: notifModel.takeDirty(),
    }),
    write: (snapshot) => dataStore.save(snapshot),
    onSuccess: (result) => {
      if (result && result.conflicts && result.conflicts.length) {
        // Conflict reconciliation (fix #4). The datastore returns a FIELD-MERGED
        // task: server row as base with local edits re-applied. We apply it AND
        // keep it dirty so the coalesced retry re-saves it — this time the known
        // version is the server's latest, so the lock passes (it converges, no
        // infinite conflict loop). applyServer() alone would clear the dirty
        // flag and drop the local edits, so we use applyServerKeepDirty().
        result.conflicts.forEach(t => {
          if (t && t._conflictMerged) {
            delete t._conflictMerged;
            taskModel.applyServerKeepDirty(t);
          } else {
            taskModel.applyServer(t);
          }
        });
        if (controller.toastView) {
          controller.toastView.show({
            title: 'Task updated elsewhere',
            sub: `Merged ${result.conflicts.length} task${result.conflicts.length > 1 ? 's' : ''} with the latest version.`,
          });
        }
      }
    },
    onFailure: (err, snapshot) => {
      console.error('[app] Supabase save failed', err, 'cause:', err && err.cause);
      // Re-flag the changes so the next save retries them instead of losing them.
      taskModel.markDirty(snapshot.tasks.map(t => t.id));
      timeModel.markUnsavedEntries(snapshot.timeEntries.map(e => e.id));
      notifModel.markDirty(snapshot.notifications.map(n => n.id));
      if (controller.toastView) {
        // Reassure first (the changes are re-flagged above and WILL retry), then
        // include the underlying Supabase message so the cause (RLS, constraint,
        // network) isn't hidden behind friendly text.
        let failToast;
        if (!navigator.onLine) {
          failToast = controller.toastView.show({
            title: "You're offline",
            sub: 'Your changes are kept and will sync automatically when you reconnect.',
          });
        } else {
          const friendly = (err && err.message) || 'Save failed';
          const cause = err && err.cause && err.cause.message;
          failToast = controller.toastView.show({
            title: "Couldn't save — your changes are kept",
            sub: `Retrying shortly. ${cause ? `${friendly} — ${cause}` : friendly}`,
          });
        }
        // Shake the toast so a failed/offline save is impossible to miss.
        if (App.Motion) App.Motion.shake(failToast);
      }
    },
  });

  App.EventBus.on('tasks:changed', () => engine.schedule());
  App.EventBus.on('time:changed', () => engine.schedule());
  App.EventBus.on('notifs:changed', () => engine.schedule());

  // Let the controller force an immediate, awaitable save. createTask uses this to
  // persist a new task BEFORE it notifies the assignee — a worker's permission to
  // insert that notification (migration 040) requires the task row to already exist.
  // saveNow's generation barrier resolves only once a save that snapshotted the
  // just-created task has actually completed (not merely the save that happened
  // to be in flight when saveNow was called).
  controller.saveNow = () => engine.saveNow();

  // Network resilience: show an offline banner while disconnected and flush any
  // queued changes the moment we're back online. Dirty tasks/entries are
  // re-flagged by the engine's onFailure above when a save fails mid-outage, so
  // this reconnect flush picks them up rather than losing them.
  new App.ConnectionView({ toastView, onReconnect: () => engine.flush() });

  // Close the current user's timer if it's been running past the max shift.
  // Runs on boot AND on a recurring interval so a timer that crosses 12h while
  // the app is left open auto-closes on its own, not only on the next reload.
  const checkStaleTimer = () => {
    const staleEntry = timeModel.autoCloseStaleForUser(App.CURRENT_USER, App.MAX_SHIFT_MS);
    if (staleEntry && controller.toastView) {
      controller.toastView.show({ title: 'Auto clocked-out', sub: 'Your timer ran past 12h and was closed automatically.' });
    }
  };
  checkStaleTimer();
  // The 12h cap doesn't need second-level precision; a per-minute check is plenty.
  setInterval(checkStaleTimer, 60 * 1000);

  // Poll for notifications addressed to this user by other people (assignments,
  // watcher pings) since there's no realtime subscription. Newly arrived
  // notifications also pop a toast so the user sees them without having to
  // open the bell — IDs seen on boot are excluded so the first poll after
  // page load doesn't dump a wall of toasts for older unread items.
  if (!App.previewMode && App.can('tasks.view')) {
    const seenNotifIds = new Set(notifModel.all().map(n => n.id));
    // Surface a *persistent* sync outage once (not every 30s tick) so the user
    // knows their list may be stale; announce recovery once it clears. A single
    // transient blip stays silent.
    let pollFailStreak = 0;
    let pollWarned = false;
    setInterval(async () => {
      let ok = true;
      // Tasks have no realtime subscription, so re-pull them here too: a task
      // created/edited by someone else won't appear until the next poll
      // otherwise. Merged non-destructively so unsaved local edits survive.
      try {
        if (dataStore.loadTasks) {
          const freshTasks = await dataStore.loadTasks(taskModel.dirtyIds());
          taskModel.mergeServer(freshTasks);
        }
      } catch (e) { ok = false; console.warn('[app] task poll failed', e); }
      // Comment threads are NOT part of the task row, so the pull above can't
      // carry them — refresh the open one explicitly. It re-renders only if the
      // rows actually changed, so this never disturbs someone mid-comment.
      try {
        await controller.refreshOpenThread();
      } catch (e) { ok = false; console.warn('[app] comment refresh failed', e); }
      try {
        const fresh = await dataStore.loadNotifications();
        const arrivals = fresh.filter(n => !seenNotifIds.has(n.id) && !n.read);
        // Non-destructive merge (NOT hydrate): keeps just-created local rows that
        // haven't saved yet and preserves read-state set on this device, while
        // pulling in notifications created elsewhere. Mirrors the task poll above.
        notifModel.merge(fresh);
        fresh.forEach(n => seenNotifIds.add(n.id));
        App.EventBus.emit('notifs:refreshed');
        arrivals.slice(0, 3).forEach(n => {
          toastView.show({
            title: n.meta || 'New notification',
            sub: App.utils.stripHtml ? App.utils.stripHtml(n.html) : (n.html || '').replace(/<[^>]+>/g, ''),
          });
        });
        if (arrivals.length > 3) {
          toastView.show({
            title: `+${arrivals.length - 3} more notifications`,
            sub: 'Open the bell icon to see them all.',
          });
        }
      } catch (e) { ok = false; console.warn('[app] notification poll failed', e); }

      if (ok) {
        if (pollWarned) toastView.show({ title: 'Back in sync', sub: 'Reconnected to the server.' });
        pollFailStreak = 0;
        pollWarned = false;
      } else if (++pollFailStreak >= 3 && !pollWarned) {
        pollWarned = true;
        toastView.show({ title: 'Sync paused', sub: "Can't reach the server. Your work is safe; still retrying every 30s." });
      }
    }, 30000);
  }

  // Interactive onboarding tour — role-aware, auto-shown once per NEW account.
  // Existing users skip it (migration 014 backfills them as onboarded), and
  // anyone can replay it via the avatar menu (see TopbarView).
  App.tour = new App.TourView();
  // Per-user localStorage key — fallback for when migration 015 hasn't been
  // run yet so the DB column doesn't exist. Survives reloads on this device
  // even if the Supabase write fails.
  const tourLocalKey = () => `qhq.onboarded.${App.currentAuthUser && App.currentAuthUser.id || 'anon'}`;
  const markOnboarded = async () => {
    if (App.previewMode) return;
    try { window.localStorage.setItem(tourLocalKey(), '1'); } catch (e) {}
    try {
      await App.supabase.from('profiles').update({ onboarded: true }).eq('id', App.currentAuthUser.id);
      if (App.currentProfile) App.currentProfile.onboarded = true;
    } catch (e) { /* column may not exist until migration 015 runs — local flag still set */ }
  };
  const shouldAutoStartTour = async () => {
    if (App.previewMode) return true; // always available while previewing
    try { if (window.localStorage.getItem(tourLocalKey()) === '1') return false; } catch (e) {}
    // Treat anyone whose profile was created more than 10 minutes ago as
    // already-onboarded — they're a returning user, not a fresh signup. Auto-
    // persist the flag so this check doesn't have to run again next reload.
    const createdAt = App.currentProfile && App.currentProfile.created_at;
    if (createdAt) {
      const ageMs = Date.now() - new Date(createdAt).getTime();
      if (ageMs > 10 * 60 * 1000) { markOnboarded(); return false; }
    }
    try {
      const { data } = await App.supabase.from('profiles').select('onboarded').eq('id', App.currentAuthUser.id).maybeSingle();
      return !(data && data.onboarded);
    } catch (e) { return false; } // no onboarded column yet → don't nag
  };
  App.startTour = () => App.tour.start({ onFinish: markOnboarded });

  const forceTour = new URLSearchParams(window.location.search).get('tour') === '1';
  window.setTimeout(async () => {
    if (forceTour || await shouldAutoStartTour()) App.startTour();
  }, 600);

  document.addEventListener('keydown', (e) => {
    // '?' opens the shortcuts cheat-sheet from anywhere (even out of a field is
    // handled below); Escape always closes any open overlay/menu/detail.
    if (e.key === 'Escape') {
      if (App.closeShortcutsHelp && App.closeShortcutsHelp()) { e.preventDefault(); return; }
      controller.handleEscape();
      return;
    }
    const typing = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' ||
                   e.target.tagName === 'SELECT' || e.target.isContentEditable;
    // '/' focuses search — the one shortcut we want even while not typing.
    if (e.key === '/' && !typing) {
      const search = document.getElementById('searchInput');
      if (search) { e.preventDefault(); search.focus(); search.select(); }
      return;
    }
    if (typing) return;
    // Ctrl/Cmd+Z (no Shift) undoes the last task action. Handled before the
    // modifier early-return below; while typing we already returned so native
    // text undo still works in inputs.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      controller.undoLast();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === '?') {
      e.preventDefault();
      if (App.toggleShortcutsHelp) App.toggleShortcutsHelp();
    } else if (e.key === 'n' || e.key === 'N') {
      if (controller.uiState.creatingTask) return;
      if (!App.can('tasks.write')) return;
      e.preventDefault();
      controller.openNewTaskPage();
    } else if (e.key === 't' || e.key === 'T') {
      e.preventDefault();
      controller.toggleGlobalClock();
    } else if (e.key === 'j') {
      e.preventDefault();
      controller.selectAdjacentTask(1);
    } else if (e.key === 'k') {
      e.preventDefault();
      controller.selectAdjacentTask(-1);
    } else if (e.key === 'ArrowRight') {
      // Right/Left step to the next/prev task, but only while a task detail is
      // open (so arrow keys aren't hijacked on the list or elsewhere).
      if (!controller.uiState.selectedTaskId) return;
      e.preventDefault();
      controller.selectAdjacentTask(1);
    } else if (e.key === 'ArrowLeft') {
      if (!controller.uiState.selectedTaskId) return;
      e.preventDefault();
      controller.selectAdjacentTask(-1);
    } else if (e.key === 'c' || e.key === 'C') {
      if (controller.uiState.selectedTaskId && App.can('tasks.write')) {
        e.preventDefault();
        controller.completeTask(controller.uiState.selectedTaskId);
      }
    } else if (e.key === 'x' || e.key === 'X') {
      // Toggle the focused task into/out of a bulk selection.
      const id = controller.uiState.selectedTaskId;
      if (id == null) return;
      e.preventDefault();
      if (!controller.uiState.bulkMode) controller.enterBulkMode(id);
      else controller.toggleBulkSelect(id);
    }
  });

  // ---- Floating quick-add button (mobile) ----
  const fab = document.getElementById('fab');
  if (fab) {
    fab.addEventListener('click', () => controller.openNewTaskPage());
    App.syncFab = () => fab.classList.toggle('hidden', !App.can('tasks.write'));
    App.syncFab();
  }

  // ---- Keyboard shortcuts help overlay (desktop) ----
  App.toggleShortcutsHelp = () => {
    if (document.getElementById('shortcutsOverlay')) { App.closeShortcutsHelp(); return; }
    const rows = [
      ['New task', 'N'], ['Focus search', '/'], ['Next task', 'J'], ['Previous task', 'K'],
      ['Complete selected', 'C'], ['Select (bulk)', 'X'], ['Clock in / out', 'T'],
      ['Close / cancel', 'Esc'], ['This help', '?'],
    ];
    const overlay = document.createElement('div');
    overlay.id = 'shortcutsOverlay';
    overlay.className = 'shortcuts-overlay';
    overlay.innerHTML = `
      <div class="shortcuts-card" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <h2><i class="ti ti-keyboard"></i> Keyboard shortcuts</h2>
        ${rows.map(([label, key]) => `<div class="shortcuts-row"><span>${label}</span><kbd>${key}</kbd></div>`).join('')}
      </div>`;
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) App.closeShortcutsHelp(); });
    document.body.appendChild(overlay);
  };
  App.closeShortcutsHelp = () => {
    const o = document.getElementById('shortcutsOverlay');
    if (o) { o.remove(); return true; }
    return false;
  };

  setInterval(() => App.EventBus.emit('clock:tick'), 1000);

  // ---- Durable save on exit (fix #2) ----
  // beforeunload can't reliably await an async fetch — the page tears down and
  // the in-flight request is abandoned. The reliable trigger is the
  // `visibilitychange -> hidden` transition: it fires on tab switch, app
  // backgrounding, and (on mobile, where beforeunload often never fires) just
  // before the page is frozen/discarded, and the browser keeps the tab alive
  // long enough for an awaited fetch to complete. We flush there as the PRIMARY
  // durable path. beforeunload stays as a best-effort secondary for the
  // desktop close/reload case.
  //
  // We deliberately do NOT use navigator.sendBeacon / keepalive fetch here:
  // constructing a correct PostgREST write by hand (REST URL, anon key, the live
  // session auth token, snake_case row mapping, AND the optimistic-lock
  // `updated_at` predicate) duplicates fragile logic that lives in
  // SupabaseDataStore, and a beacon can't read back the lock result to reconcile
  // conflicts. The visibilitychange flush — which reuses the normal awaited save
  // path — is the robust fix; beacon would trade correctness for marginal
  // coverage of the hard-kill case.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      engine.cancelPending();
      // Awaited internally by the single-flight lock; the hidden tab stays alive
      // long enough for this to land. flush() coalesces with any in-flight save.
      engine.flush().catch(err => console.warn('[app] visibility flush save failed', err));
    }
  });
  window.addEventListener('beforeunload', () => {
    engine.cancelPending();
    // Best-effort only — the fetch may be cut short by the unload. The
    // visibilitychange handler above is the durable path.
    engine.flush().catch(err => console.warn('[app] final Supabase save failed', err));
  });
});

// Merge profile display-name + avatar into the in-memory people roster.
function overlayProfilesOntoPeople() {
  const apply = (prof) => {
    if (!prof || !prof.member_id) return;
    if (!App.PEOPLE) App.PEOPLE = {};
    const person = App.PEOPLE[prof.member_id];
    if (!person) {
      // No team_members row backs this profile (member_id drift — its slug was
      // pruned or never created). Synthesize the roster entry from the profile
      // so the chosen display name resolves everywhere App.PEOPLE is read
      // (assignee chips, getUserName), not just the profile-sourced boards.
      App.PEOPLE[prof.member_id] = App.utils.personFromProfile(prof);
      return;
    }
    if (prof.full_name) {
      person.full = prof.full_name;
      person.name = prof.full_name.split(/\s+/)[0] || prof.full_name;
    }
    if (prof.avatar_url) person.avatar_url = prof.avatar_url;
  };
  (App.PROFILES || []).forEach(apply);
  apply(App.currentProfile); // own profile, even when the full list isn't loaded
}
App.overlayProfilesOntoPeople = overlayProfilesOntoPeople;

App.applyRoleChrome = applyRoleChrome;
function applyRoleChrome(controller) {
  const search = document.querySelector('.search');
  const notifWrap = document.getElementById('notifBtn') && document.getElementById('notifBtn').parentElement;
  const newTaskBtn = document.getElementById('newTaskBtn');
  const filterBtn = document.getElementById('filterBtn');
  const quickAdd = document.querySelector('.quick-add');
  const layoutSwitcher = document.getElementById('viewBtn');
  const isWorker = App.effectiveRole() === 'worker';

  if (search) search.classList.toggle('hidden', !App.can('tasks.view'));
  if (notifWrap) notifWrap.classList.toggle('hidden', !App.can('tasks.view'));
  if (newTaskBtn) newTaskBtn.classList.toggle('hidden', !App.can('tasks.write'));
  if (filterBtn) filterBtn.classList.toggle('hidden', !App.can('tasks.view'));
  if (quickAdd) quickAdd.classList.toggle('hidden', !App.can('tasks.write'));
  if (App.syncFab) App.syncFab();
  // Workers use a fixed Time | Task layout, so the table/timeline/kanban switcher is hidden.
  if (layoutSwitcher) layoutSwitcher.classList.toggle('hidden', isWorker || !App.can('tasks.view'));

  if (App.can('clock.use') && !App.can('tasks.view')) {
    controller.setView('time:mine');
  }
}

function renderRoleGate() {
  // This replaces document.body below (removing #appLoader); stop the ticker first.
  if (App.LoaderView) App.LoaderView.stop();
  const profile = App.currentProfile || {};
  const roleLabel = (App.ROLES[profile.role] || { label: 'Member' }).label;
  document.body.innerHTML = `
    <div style="min-height:100vh;display:grid;place-items:center;background:#0E0E10;color:#F5F1E6;font-family:Inter,system-ui,sans-serif;padding:24px;">
      <div style="max-width:520px;background:#131315;border:1px solid #2A2A2E;border-radius:10px;padding:24px;box-shadow:0 24px 48px rgba(0,0,0,.5);">
        <div style="font-family:'Instrument Serif',serif;font-size:30px;margin-bottom:8px;">Access pending</div>
        <div style="color:#B8B2A4;line-height:1.5;">Your account is currently <strong>${App.utils.escapeHtml(roleLabel)}</strong>. An admin or construction supervisor needs to assign your role before you can use Quest HQ.</div>
        <button id="roleGateSignOut" style="margin-top:18px;padding:10px 14px;border:0;border-radius:6px;background:#E8A03A;color:#1A1208;font-weight:700;cursor:pointer;">Sign out</button>
      </div>
    </div>
  `;
  const signOutBtn = document.getElementById('roleGateSignOut');
  if (signOutBtn) signOutBtn.addEventListener('click', () => App.signOut());
}

function renderFatalDataError(err) {
  // This replaces document.body below (removing #appLoader); stop the ticker first.
  if (App.LoaderView) App.LoaderView.stop();
  const message = App.utils.escapeHtml((err && err.message) || 'Unable to load Quest HQ data from Supabase.');
  document.body.innerHTML = `
    <div style="min-height:100vh;display:grid;place-items:center;background:#F6F1E8;color:#23180D;font-family:Inter,system-ui,sans-serif;padding:24px;">
      <div style="max-width:520px;background:#FFF9EF;border:1px solid #E2D3BC;border-radius:8px;padding:22px;box-shadow:0 16px 40px rgba(46,31,17,.12);">
        <div style="font-weight:800;font-size:18px;margin-bottom:8px;">Supabase data unavailable</div>
        <div style="font-size:14px;line-height:1.5;color:#6E5B45;">${message}</div>
        <button id="fatalRetry" style="margin-top:16px;padding:10px 14px;border:0;border-radius:6px;background:#8D3F1F;color:white;font-weight:700;cursor:pointer;">Retry</button>
      </div>
    </div>
  `;
  const retryBtn = document.getElementById('fatalRetry');
  if (retryBtn) retryBtn.addEventListener('click', () => window.location.reload());
}
