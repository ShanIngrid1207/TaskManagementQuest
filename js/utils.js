window.App = window.App || {};

App.utils = {
  /* Make a non-button element behave like a button for keyboard / AT users:
     role=button, focusable, and Enter/Space activate it. Pass a handler to run
     directly, or omit it to synthesize a click (so an existing delegated click
     handler fires). Optional label sets aria-label. */
  makeActivatable(el, handler, label) {
    if (!el) return;
    el.setAttribute('role', 'button');
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    if (label) el.setAttribute('aria-label', label);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        if (handler) handler(e); else el.click();
      }
    });
  },

  initials(name) {
    return String(name || '').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  },

  /* Uppercase a free-text field value on save. The user types normally; this is
     applied at the save seams (createTask, updateTaskDetails, updateTaskField for
     title/description, addTaskComment, createProject) so task/project titles,
     descriptions, subtasks and notes are stored ALL CAPS. Non-strings pass
     through untouched (null/undefined stay as-is), and it's idempotent — safe to
     apply to an already-uppercased value (e.g. a duplicated task). */
  upper(v) {
    return typeof v === 'string' ? v.toUpperCase() : v;
  },

  /* Trap Tab focus inside `container` (so it can't escape into the page behind a
     modal) and restore focus to whatever was focused before, when released.
     Returns a release() function to call on close. */
  trapFocus(container) {
    const prev = document.activeElement;
    const sel = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    const focusable = () => [...container.querySelectorAll(sel)]
      .filter(el => el.offsetWidth || el.offsetHeight || el === document.activeElement);
    const onKey = (e) => {
      if (e.key !== 'Tab') return;
      const f = focusable();
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    container.addEventListener('keydown', onKey);
    return function release() {
      container.removeEventListener('keydown', onKey);
      if (prev && typeof prev.focus === 'function') prev.focus();
    };
  },

  /* Returns a self-contained <span class="avatar-xs ..."> element for
     the given person. Prefers the uploaded avatar_url over the colored
     initials fallback. Pass `extraClass` to merge additional classes
     onto the span (defaults to none). All callers should use this in
     place of hand-rolled `<span class="avatar-xs" style="background:
     ${color}">${initials}</span>` so uploaded photos appear everywhere
     the same way. */
  avatarHtml(person, extraClass = '') {
    const cls = `avatar-xs${extraClass ? ' ' + extraClass : ''}`;
    if (!person) {
      return `<span class="${cls}" style="background:var(--ink-3);">?</span>`;
    }
    if (person.avatar_url) {
      // avatar_url is escaped to be safe inside an attribute even if
      // the migration-022 CHECK constraint were ever bypassed.
      return `<span class="${cls}" style="background:transparent; padding:0;"><img src="${App.utils.escapeHtml(person.avatar_url)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;" /></span>`;
    }
    const bg = person.color ? App.utils.safeColor(person.color) : 'var(--ink-3)';
    return `<span class="${cls}" style="background:${bg};">${App.utils.escapeHtml(App.utils.initials(person.full || person.name || ''))}</span>`;
  },

  /* A minimal stand-in for someone who has tracked time but isn't in
     App.PEOPLE (left the roster, demo seed, or the current developer account).
     Centralises the synthesized shape so every board agrees on the fields —
     notably `id`, which earlier hand-rolled copies sometimes omitted, breaking
     any later totalForUser(p.id, ...) call. */
  unknownPerson(id) {
    return { id, name: id, full: id, color: '#E8A03A' };
  },

  /* The set of people to show on a team time board: the approved roster
     (activePeople) unioned with anyone who has actual activity in the window —
     a live timer now, or a completed entry since `sinceMs` — so their hours
     always surface even if they're not on the (company-scoped, approval-
     filtered) roster. People with activity but absent from App.PEOPLE are
     synthesized via unknownPerson() so they still appear and count.

     Shared by TimeView.renderResource and ClockDashboardView.render; keep the
     union semantics here so the two boards can't drift. */
  rosterWithActivity(timeModel, sinceMs) {
    const activityIds = new Set();
    timeModel.allActive().forEach(t => activityIds.add(t.userId));
    timeModel.entries.forEach(e => { if (e.start >= sinceMs) activityIds.add(e.userId); });
    const roster = App.utils.activePeople([...activityIds]);
    const rosterIds = new Set(roster.map(p => p.id));
    const orphans = [...activityIds]
      .filter(id => !rosterIds.has(id))
      .map(id => App.directory.person(id) || App.utils.unknownPerson(id));
    return [...roster, ...orphans];
  },

  /* Synthesize the standard person shape (matching SupabaseDataStore._mapPeople)
     from an approved profile, for when no team_members row backs its member_id
     (linkage drift — the profile's slug was generated from the sign-up email but
     the matching roster row was pruned or never created). Lets an approved user
     still appear on boards/pickers; a later roster sync / migration 035 fills in
     the real team_members row. */
  personFromProfile(profile) {
    const full = (profile.full_name && profile.full_name.trim())
      || (profile.email ? profile.email.split('@')[0] : profile.member_id);
    return {
      id: profile.member_id,
      name: String(full).split(' ')[0] || full,
      full,
      email: profile.email || '',
      color: App.utils.safeColor(profile.color),
      avatar_url: profile.avatar_url || null,
      company_ids: Array.isArray(profile.company_ids) ? profile.company_ids : [],
      active: profile.approved !== false, // synthesized only from approved profiles
    };
  },

  /* People eligible to appear in assignment pickers and team dashboards.

     Source of truth is the set of APPROVED profiles (the real users), NOT the
     team_members roster — the roster drifts: it keeps leftover demo seeds and
     members whose profile was removed, and it MISSES approved users whose
     profiles.member_id points at a slug with no matching roster row. Building
     from profiles fixes both: each approved profile maps to its team_members
     row for display, or a synthesized person when that row is missing, so an
     approved user is never silently dropped.

     When profiles aren't loaded (non-manager sessions don't fetch them) we fall
     back to the roster's own `active` flag (migration 039) — which mirrors
     "backed by an approved profile" — so deleted/unapproved accounts stay out
     of the picker for workers too, not just managers. Pass `includeIds` (e.g. a
     task's current assignee) to keep an existing selection visible even if it's
     no longer backed by an approved profile. */
  activePeople(includeIds) {
    const byId = App.PEOPLE || {};
    const all = Object.values(byId);
    const profiles = App.PROFILES || [];
    if (!profiles.length) {
      const keepIds = Array.isArray(includeIds) ? includeIds : (includeIds ? [includeIds] : []);
      const keepSet = new Set(keepIds.filter(Boolean));
      return all.filter(p => p.active !== false || keepSet.has(p.id));
    }

    const seen = new Set();
    const list = [];
    profiles
      .filter(p => p.approved !== false && p.member_id)
      .forEach(p => {
        if (seen.has(p.member_id)) return;
        seen.add(p.member_id);
        list.push(byId[p.member_id] || App.utils.personFromProfile(p));
      });

    const keep = Array.isArray(includeIds) ? includeIds : (includeIds ? [includeIds] : []);
    keep.forEach(id => {
      if (id && !seen.has(id)) {
        seen.add(id);
        list.push(byId[id] || App.utils.unknownPerson(id));
      }
    });

    return list.length ? list : all;
  },

  /* Active people who belong to a given company, for company-scoped pickers
     (e.g. assignee/watcher lists in the New task modal). Builds on
     activePeople() and intersects with profiles whose company_ids include the
     company. Falls back to activePeople() when profiles aren't loaded
     (non-manager sessions) so the picker never renders empty. Pass includeIds
     to keep an existing selection visible.
     '*' is the "All companies" scope (the developer default, and the
     multi-company "drop the filter" option) — it means no company filter, so
     return the full active roster rather than intersecting on a literal '*'
     that no profile's company_ids ever contains. */
  /* Does `companyId` (a scope/filter) select this task? '*' or empty means
     no company filter. A real company also matches Overall tasks (they span
     every company). When the scope IS 'overall', only Overall tasks match. */
  taskInCompany(task, companyId) {
    if (!companyId || companyId === '*') return true;
    const c = task && task.company;
    return c === companyId || c === 'overall';
  },

  /* Every assignee on a task, in order — index 0 is the accountable lead and is
     also mirrored into the single `assignee` field (migration 060). Rows written
     before 060 carry only `assignee`, so fall back to it. */
  taskAssignees(task) {
    if (!task) return [];
    if (Array.isArray(task.assigneeIds) && task.assigneeIds.length) return task.assigneeIds;
    return task.assignee ? [task.assignee] : [];
  },

  /* Is this person assigned to the task AT ALL (lead or not)? Every list, scope
     and filter must ask THIS, not `task.assignee === id` — the latter sees only
     the lead, which hid co-assigned tasks from the people they were assigned to
     even though RLS (060) let them read and open the row. */
  isAssignee(task, userId) {
    if (!task || !userId) return false;
    return this.taskAssignees(task).includes(userId);
  },

  /* Does this profile report to `memberId`? A person may report to MULTIPLE
     supervisors (migration 073): supervisor_ids[] holds team_members ids and
     EVERY one of them oversees the person. Rows written before 073 carry only
     the scalar supervisor_id (the primary), so fall back to it. Every "is this
     my report?" seam must ask THIS, never `profile.supervisor_id === id`. */
  reportsTo(profile, memberId) {
    if (!profile || !memberId) return false;
    if (Array.isArray(profile.supervisor_ids)) return profile.supervisor_ids.includes(memberId);
    return profile.supervisor_id === memberId;
  },

  peopleInCompany(companyId, includeIds) {
    const base = this.activePeople(includeIds);
    // 'overall' spans all companies → full roster, same as the '*' no-filter path.
    if (!companyId || companyId === '*' || companyId === 'overall') return base;
    const profiles = App.PROFILES || [];
    // Managers have the full profiles list → scope by profiles.company_ids.
    // Workers don't → scope by the company_ids now mirrored onto the roster
    // (migration 045), carried on each person object. Either way we end up with
    // the set of member_ids that belong to this company.
    const inCompany = new Set(
      profiles.length
        ? profiles
            .filter(p => p.member_id && Array.isArray(p.company_ids) && p.company_ids.includes(companyId))
            .map(p => p.member_id)
        : base
            .filter(p => Array.isArray(p.company_ids) && p.company_ids.includes(companyId))
            .map(p => p.id)
    );
    const keep = Array.isArray(includeIds) ? includeIds : (includeIds ? [includeIds] : []);
    keep.forEach(id => { if (id) inCompany.add(id); });
    const list = base.filter(p => inCompany.has(p.id));
    return list.length ? list : base;
  },

  /* Offset (ms) of a timezone from UTC at a given instant — recomputed per
     instant so daylight-saving is handled. Returns (zone-wall-clock-as-UTC −
     actual-UTC). */
  zoneOffsetMs(ms, tz) {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p = {};
    dtf.formatToParts(new Date(ms)).forEach(part => { p[part.type] = part.value; });
    const hour = p.hour === '24' ? 0 : Number(p.hour);
    const asUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
    return asUTC - ms;
  },

  /* Convert an HQ wall-clock (App.HQ_TIMEZONE) Y/M/D H:M into a real epoch ms,
     so a due/reminder time means the same instant for every viewer regardless of
     their device zone. One pass is exact for a fixed-offset zone (Arizona, −7);
     correct for DST zones except within the ~1h that straddles a switch. Falls
     back to local wall-clock if the zone id is somehow invalid. */
  hqWallClockToMs(y, m, d, hh = 0, mm = 0) {
    const guess = Date.UTC(y, m - 1, d, hh, mm);
    try {
      return guess - App.utils.zoneOffsetMs(guess, App.HQ_TIMEZONE);
    } catch (e) {
      return new Date(y, m - 1, d, hh, mm).getTime();
    }
  },

  /* The CURRENT calendar date in the HQ zone (App.HQ_TIMEZONE), so Today /
     Tomorrow / Overdue / due-today are judged on HQ (Phoenix) time for EVERY
     user — not the device's local date. ±offset days are applied with UTC math
     so the shift can't drift across a local-zone boundary. Falls back to the
     device-local date if Intl rejects the zone id. */
  todayISO(offset = 0) {
    let y, m, d;
    try {
      const p = {};
      new Intl.DateTimeFormat('en-CA', {
        timeZone: App.HQ_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(new Date()).forEach(part => { p[part.type] = part.value; });
      y = Number(p.year); m = Number(p.month); d = Number(p.day);
    } catch (e) {
      const local = new Date();
      y = local.getFullYear(); m = local.getMonth() + 1; d = local.getDate();
    }
    const shifted = new Date(Date.UTC(y, m - 1, d + offset));
    const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(shifted.getUTCDate()).padStart(2, '0');
    return `${shifted.getUTCFullYear()}-${mm}-${dd}`;
  },

  // Format a Date object as a local YYYY-MM-DD string (NOT UTC — matches
  // todayISO so calendar day math lines up with how due dates are stored).
  toISODate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  },

  // Format a real instant (ISO timestamp string or Date) as the HQ-timezone
  // YYYY-MM-DD, matching todayISO so "completed today" / cycle-time day math
  // lines up with how due dates are stored. completed_at is a timestamptz, so we
  // must reduce it to a calendar day in the shared HQ zone, not the viewer's.
  hqDateOf(instant) {
    if (!instant) return '';
    const d = instant instanceof Date ? instant : new Date(instant);
    if (isNaN(d.getTime())) return '';
    try {
      const p = {};
      new Intl.DateTimeFormat('en-CA', {
        timeZone: App.HQ_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(d).forEach(part => { p[part.type] = part.value; });
      return `${p.year}-${p.month}-${p.day}`;
    } catch (e) {
      return App.utils.toISODate(d);
    }
  },

  formatDuration(ms) {
    if (!ms || ms < 0) ms = 0;
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = n => String(n).padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  },

  formatHours(ms) {
    const hours = (ms || 0) / (60 * 60 * 1000);
    if (hours < 0.1) return '0h';
    if (hours < 1) return `${Math.round(hours * 60)}m`;
    return `${hours.toFixed(1)}h`;
  },

  // Accepts a ms timestamp, a Date, or an ISO string (activity entries store
  // an ISO string in `at`). Returns '' for missing/unparseable input so callers
  // can fall back to a legacy label.
  timeAgo(timestamp) {
    if (timestamp == null || timestamp === '') return '';
    const ms = typeof timestamp === 'number'
      ? timestamp
      : (timestamp instanceof Date ? timestamp.getTime() : Date.parse(timestamp));
    if (Number.isNaN(ms)) return '';
    const diff = Date.now() - ms;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  },

  /* Build the meta line for an inbox notification: the category label plus a
     live relative time computed from the row's created_at. Older notifications
     baked the time directly into `meta` (e.g. "Task update · just now"), which
     froze every row at "just now" forever — strip that legacy suffix so the
     real timeAgo value wins. Non-time suffixes (e.g. "Reminder · High") are
     kept. Falls back to "just now" when no timestamp is available. */
  notifMeta(meta, createdAt) {
    const base = String(meta == null ? '' : meta)
      .replace(/\s*·\s*just now\s*$/i, '')
      .trim();
    const rel = this.timeAgo(createdAt) || 'just now';
    return base ? `${base} · ${rel}` : rel;
  },

  /* Map a check-in notification's stored `meta` to its call-to-action, or null
     when the notification isn't a check-in. The `checkins` edge function writes
     meta as `Check-in · <subject>`; we read the subject back and resolve the
     per-mode label + deep-link route. `route === null` means "no route — act on
     the notification's own task" (stalled mode carries the task id).

     ⚠️ The subject strings MUST stay in lockstep with MODE_SUBJECT in
     supabase/functions/checkins/lib/content.mjs. That module is Deno-only, so
     there is no shared import — a wording change there is a change here too. */
  checkinCta(meta) {
    const m = String(meta == null ? '' : meta).match(/^Check-in\s+·\s+(.+?)\s*$/);
    if (!m) return null;
    const BY_SUBJECT = {
      'Your morning check-in':      { mode: 'morning', label: "Set today's focus",   route: '#/tasks/execution' },
      'Your end-of-day check-in':   { mode: 'eod',     label: 'Review today',        route: '#/tasks' },
      'Tasks that have gone quiet': { mode: 'stalled', label: 'Review stalled tasks', route: null },
    };
    return BY_SUBJECT[m[1]] || null;
  },

  /* Format a true point-in-time (a real instant: clock-in moment, time-entry
     timestamp — anything stored as timestamptz) in the shared display timezone
     from App.timezone(), so every viewer sees the SAME wall-clock reading for the
     same moment regardless of their device's local zone. Accepts a ms timestamp,
     a Date, or an ISO string. Pass Intl.DateTimeFormat options (e.g.
     { month:'short', day:'numeric', hour:'numeric', minute:'2-digit',
       timeZoneName:'short' }); include timeZoneName so the zone (e.g. "MDT") is
     visible and the time isn't silently ambiguous.

     Do NOT use this for due dates or reminders — those are wall-clock text and
     must stay on local parsing (see formatDue / TaskDetailView reminder format).
     Falls back to the browser's local zone if App.timezone() is somehow invalid. */
  formatInstant(when, options = {}) {
    const ms = typeof when === 'number'
      ? when
      : (when instanceof Date ? when.getTime() : Date.parse(when));
    if (Number.isNaN(ms)) return '';
    try {
      return new Intl.DateTimeFormat('en-US', { ...options, timeZone: App.timezone() }).format(new Date(ms));
    } catch (e) {
      // Bad/unsupported IANA id -> don't blow up a render; show local instead.
      return new Intl.DateTimeFormat('en-US', options).format(new Date(ms));
    }
  },

  formatDue(iso) {
    const t0 = App.utils.todayISO(0);
    const t1 = App.utils.todayISO(1);
    if (iso === t0) return { text: 'Today', cls: 'due-today' };
    if (iso === t1) return { text: 'Tomorrow', cls: '' };
    const d = new Date(iso);
    if (iso < t0) {
      return { text: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), cls: 'due-overdue' };
    }
    return { text: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), cls: '' };
  },

  formatClock(hhmm) {
    if (!hhmm) return '';
    const parts = String(hhmm).split(':');
    const h = Number(parts[0]);
    const m = Number(parts[1] || 0);
    if (Number.isNaN(h)) return '';
    const period = h >= 12 ? 'PM' : 'AM';
    const hr = ((h + 11) % 12) + 1;
    return `${hr}:${String(m).padStart(2, '0')} ${period}`;
  },

  /* Short label for the HQ display zone (e.g. "MST") from App.timezone().
     Arizona has no DST so it's constant; computed via Intl so it stays correct
     if the HQ zone ever changes. */
  tzAbbrev() {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: App.timezone(), timeZoneName: 'short' })
        .formatToParts(new Date());
      const tz = parts.find(p => p.type === 'timeZoneName');
      return tz ? tz.value : '';
    } catch (e) {
      return '';
    }
  },

  /* formatClock + the HQ zone label, for scheduled wall-clock times (task due
     times). These aren't real instants so we don't convert them — we just tag
     them with the HQ zone so a remote worker knows the deadline is HQ time.
     Empty in -> empty out. */
  formatClockTz(hhmm) {
    const t = App.utils.formatClock(hhmm);
    if (!t) return t;
    const abbr = App.utils.tzAbbrev();
    return abbr ? `${t} ${abbr}` : t;
  },

  escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  },

  // Allowlist sanitizer for the notification html column. Legit notifications
  // are built by AppController as "<strong>name</strong> reassigned <em>task</em> ..."
  // so we keep <strong>/<em>/<b>/<i> with no attributes and escape everything
  // else as text. The DB also has a CHECK constraint blocking <script> /
  // javascript: / on*= patterns — this is the render-side belt-and-braces.
  sanitizeNotificationHtml(s) {
    const allowed = new Set(['STRONG', 'EM', 'B', 'I']);
    const doc = new DOMParser().parseFromString(String(s == null ? '' : s), 'text/html');
    const walk = (node) => {
      let out = '';
      node.childNodes.forEach((child) => {
        if (child.nodeType === 3) {
          out += App.utils.escapeHtml(child.nodeValue);
        } else if (child.nodeType === 1 && allowed.has(child.tagName)) {
          const tag = child.tagName.toLowerCase();
          out += `<${tag}>${walk(child)}</${tag}>`;
        } else if (child.nodeType === 1) {
          out += walk(child);
        }
      });
      return out;
    };
    return walk(doc.body);
  },

  // Return color only if it's a 3- or 6-digit hex literal; otherwise fall back
  // to the amber accent. Used wherever a user-controlled color value is
  // interpolated into a style="..." attribute. (The DB constraint on
  // team_members.color is the primary defense; this stops a stale row or
  // a hand-edited App.PEOPLE entry from breaking out of the attribute.)
  safeColor(c) {
    return /^#([0-9A-Fa-f]{3}){1,2}$/.test(String(c || '')) ? c : '#E8A03A';
  },

  uid(prefix = '') {
    return prefix + Date.now() + Math.random().toString(36).slice(2, 6);
  },

  // Stable-ish text id for a new project folder: slug of the name + a short
  // random suffix so two "Mesa ADU" folders don't collide.
  slugId(name) {
    const base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'folder';
    return `${base}-${Math.random().toString(36).slice(2, 7)}`;
  },

  /* ---------- CSV export helpers ---------- */
  // One CSV field. Quotes when the value contains a comma/quote/newline, and is
  // injection-safe: a value starting with = + - @ (or a control char) gets a
  // leading apostrophe so Excel/Sheets treat it as text, not a formula.
  csvCell(val) {
    let s = (val === null || val === undefined) ? '' : String(val);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  },

  // rows: array of arrays → CSV string (CRLF line breaks for Excel).
  toCsv(rows) {
    return rows.map(r => r.map(c => App.utils.csvCell(c)).join(',')).join('\r\n');
  },

  // Trigger a client-side file download. Prepends a UTF-8 BOM so Excel reads
  // accented characters correctly.
  downloadFile(filename, content, mime = 'text/csv;charset=utf-8') {
    const blob = new Blob(['﻿' + content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  /* Stable string key for memo caches: JSON-safe values plus Sets (serialized
     as sorted arrays so membership, not insertion order, defines equality). */
  fingerprint(value) {
    return JSON.stringify(value, (k, v) => (v instanceof Set ? [...v].sort() : v));
  },
};
