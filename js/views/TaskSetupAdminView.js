window.App = window.App || {};

/* Settings → Task setup (Phase 3). Admin-only screen to customize the per-company
   task taxonomy — types, per-type statuses, and labels. Renders into the shared
   #timeViewWrap like the other admin surfaces (ApprovalView / ClockDashboardView),
   activated on the 'admin:task-setup' view.

   It loads the RAW taxonomy rows (which carry the DB ids the stripped App.taxonomy
   index doesn't) for rendering + editing, and calls the controller taxonomy ops.
   Each op persists, re-hydrates App.taxonomy and emits 'taxonomy:changed', which
   this view listens for to re-fetch + re-render. */
App.TaskSetupAdminView = class TaskSetupAdminView {
  constructor({ controller }) {
    this.controller = controller;
    this.dataStore = controller.dataStore;
    this.wrap = document.getElementById('timeViewWrap');
    this.company = null;        // concrete company being edited
    this.selectedType = null;   // selected type key — drives the statuses column
    this.raw = null;            // { types, statuses, labels } raw rows (with ids)
    this._busy = false;
    this._modal = null;

    App.EventBus.on('view:changed', (view) => { if (view === 'admin:task-setup') this.refresh(); });
    App.EventBus.on('taxonomy:changed', () => { if (this.visible()) this.refresh(); });
    App.EventBus.on('company:changed', () => { this.company = null; this.selectedType = null; if (this.visible()) this.refresh(); });
  }

  visible() {
    return this.controller.uiState.view === 'admin:task-setup'
      && this.wrap && !this.wrap.classList.contains('hidden');
  }

  /* ---------- data ---------- */
  // 'overall' is excluded: its taxonomy is a computed union of the real
  // companies (see taxonomy.js co('overall')), not an editable per-company set.
  companies() { return (this.controller.uiState.companies || []).filter(c => c !== '*' && c !== 'overall'); }
  resolveCompany() {
    if (this.company && this.companies().includes(this.company)) return this.company;
    const cur = this.controller.uiState.currentCompany;
    this.company = (cur && cur !== '*' && this.companies().includes(cur)) ? cur : (this.companies()[0] || null);
    return this.company;
  }
  _bySort(a, b) { return (a.sort_order - b.sort_order) || String(a.label).localeCompare(String(b.label)); }
  _types(c) { return (this.raw.types || []).filter(t => t.company_id === c && t.active !== false).sort((a, b) => this._bySort(a, b)); }
  _statuses(c, type) { return (this.raw.statuses || []).filter(s => s.company_id === c && s.type_key === type && s.active !== false).sort((a, b) => this._bySort(a, b)); }
  _labels(c) { return (this.raw.labels || []).filter(l => l.company_id === c && l.active !== false).sort((a, b) => this._bySort(a, b)); }

  async refresh() {
    if (!this.wrap) this.wrap = document.getElementById('timeViewWrap');
    if (!this.wrap) return;
    if (!App.can('task-setup.manage')) {
      this.wrap.innerHTML = `<div class="tsetup"><div class="empty"><i class="ti ti-lock"></i><p>Only admins can edit task setup.</p></div></div>`;
      return;
    }
    if (!this.raw) {
      this.wrap.innerHTML = `<div class="tsetup"><div class="tsetup-head"><div><p class="tsetup-sub">Loading…</p></div></div></div>`;
    }
    try {
      this.raw = await this.dataStore.loadTaxonomy();
    } catch (e) {
      this.wrap.innerHTML = `<div class="tsetup"><div class="empty"><p>Couldn’t load task setup. ${this._esc((e && e.message) || '')}</p></div></div>`;
      return;
    }
    if (!this.visible()) return; // navigated away while loading
    this.render();
  }

  /* ---------- render ---------- */
  render() {
    const company = this.resolveCompany();
    if (!company) { this.wrap.innerHTML = `<div class="tsetup"><div class="empty"><p>No editable workspace.</p></div></div>`; return; }
    const types = this._types(company);
    if (!this.selectedType || !types.some(t => t.key === this.selectedType)) {
      this.selectedType = types.length ? types[0].key : null;
    }
    const selType = types.find(t => t.key === this.selectedType);
    const statuses = this.selectedType ? this._statuses(company, this.selectedType) : [];
    const labels = this._labels(company);

    this.wrap.innerHTML = `
      <div class="tsetup">
        <button class="tsetup-back" type="button" data-act="back" aria-label="Go back"><i class="ti ti-arrow-left"></i> Back</button>
        <div class="tsetup-head">
          <div>
            <p class="tsetup-sub">Customize the types, statuses, and labels for each workspace.</p>
          </div>
          <label class="tsetup-company-wrap">Workspace
            <select class="tsetup-company" data-act="company">
              ${this.companies().map(c => `<option value="${this._esc(c)}" ${c === company ? 'selected' : ''}>${this._esc((App.directory.company(c) || {}).label || c)}</option>`).join('')}
            </select>
          </label>
        </div>

        <div class="tsetup-grid">
          <section class="tsetup-col">
            <div class="tsetup-col-head"><span>Types</span>
              <button class="tsetup-add" data-act="add-type"><i class="ti ti-plus"></i> Add type</button>
            </div>
            <div class="tsetup-list">
              ${types.length ? types.map(t => this._typeRow(t)).join('') : `<p class="tsetup-empty">No types yet — add one.</p>`}
            </div>
          </section>

          <section class="tsetup-col">
            <div class="tsetup-col-head">
              <span>Statuses${selType ? ` · ${this._esc(selType.label)}` : ''}</span>
              ${this.selectedType ? `<button class="tsetup-add" data-act="add-status"><i class="ti ti-plus"></i> Add status</button>` : ''}
            </div>
            <div class="tsetup-list">
              ${!this.selectedType
                ? `<p class="tsetup-empty">Select a type to edit its statuses.</p>`
                : (statuses.length ? statuses.map(s => this._statusRow(s)).join('') : `<p class="tsetup-empty">No statuses.</p>`)}
            </div>
          </section>
        </div>

        <section class="tsetup-labels">
          <div class="tsetup-col-head"><span>Labels</span>
            <button class="tsetup-add" data-act="add-label"><i class="ti ti-plus"></i> Add label</button>
          </div>
          <div class="tsetup-chips">
            ${labels.length ? labels.map(l => this._labelChip(l)).join('') : `<p class="tsetup-empty">No labels.</p>`}
          </div>
        </section>
      </div>`;
    this.bindEvents();
  }

  _typeRow(t) {
    const sel = t.key === this.selectedType ? ' is-selected' : '';
    return `<div class="tsetup-row${sel}">
      <button class="tsetup-row-name" data-act="select-type" data-key="${this._esc(t.key)}">
        <span class="tsetup-dot" style="background:${this._esc(t.color || '#8f867b')}"></span>
        <span class="tsetup-lbl">${this._esc(t.label)}</span>
      </button>
      <div class="tsetup-actions">
        <input type="color" class="tsetup-swatch" value="${this._esc(t.color || '#8f867b')}" data-kind="type" data-id="${this._esc(t.id)}" title="Colour">
        <button class="tsetup-iconbtn" data-act="rename-type" data-id="${this._esc(t.id)}" data-name="${this._esc(t.label)}" title="Rename"><i class="ti ti-pencil"></i></button>
        <button class="tsetup-iconbtn" data-act="move-type" data-id="${this._esc(t.id)}" data-dir="-1" title="Move up"><i class="ti ti-chevron-up"></i></button>
        <button class="tsetup-iconbtn" data-act="move-type" data-id="${this._esc(t.id)}" data-dir="1" title="Move down"><i class="ti ti-chevron-down"></i></button>
        <button class="tsetup-iconbtn tsetup-danger" data-act="remove-type" data-id="${this._esc(t.id)}" data-name="${this._esc(t.label)}" title="Remove"><i class="ti ti-x"></i></button>
      </div>
    </div>`;
  }

  _statusRow(s) {
    return `<div class="tsetup-row">
      <span class="tsetup-dot" style="background:${this._esc(s.color || '#8f867b')}"></span>
      <span class="tsetup-lbl">${this._esc(s.label)}</span>
      <div class="tsetup-actions">
        <button class="tsetup-pill${s.is_default ? ' is-on' : ''}" data-act="set-default" data-id="${this._esc(s.id)}" title="Default for new tasks of this type">default</button>
        <button class="tsetup-pill${s.is_done ? ' is-on is-done' : ''}" data-act="set-done" data-id="${this._esc(s.id)}" title="The completed status for this type">done</button>
        <input type="color" class="tsetup-swatch" value="${this._esc(s.color || '#8f867b')}" data-kind="status" data-id="${this._esc(s.id)}" title="Colour">
        <button class="tsetup-iconbtn" data-act="rename-status" data-id="${this._esc(s.id)}" data-name="${this._esc(s.label)}" title="Rename"><i class="ti ti-pencil"></i></button>
        <button class="tsetup-iconbtn" data-act="move-status" data-id="${this._esc(s.id)}" data-dir="-1" title="Move up"><i class="ti ti-chevron-up"></i></button>
        <button class="tsetup-iconbtn" data-act="move-status" data-id="${this._esc(s.id)}" data-dir="1" title="Move down"><i class="ti ti-chevron-down"></i></button>
        <button class="tsetup-iconbtn tsetup-danger" data-act="remove-status" data-id="${this._esc(s.id)}" data-name="${this._esc(s.label)}" title="Remove"><i class="ti ti-x"></i></button>
      </div>
    </div>`;
  }

  _labelChip(l) {
    return `<div class="tsetup-chip">
      <span class="tsetup-dot" style="background:${this._esc(l.color || '#8f867b')}"></span>
      <span class="tsetup-lbl">${this._esc(l.label)}</span>
      <input type="color" class="tsetup-swatch" value="${this._esc(l.color || '#8f867b')}" data-kind="label" data-id="${this._esc(l.id)}" title="Colour">
      <button class="tsetup-iconbtn" data-act="rename-label" data-id="${this._esc(l.id)}" data-name="${this._esc(l.label)}" title="Rename"><i class="ti ti-pencil"></i></button>
      <button class="tsetup-iconbtn" data-act="move-label" data-id="${this._esc(l.id)}" data-dir="-1" title="Move left"><i class="ti ti-chevron-left"></i></button>
      <button class="tsetup-iconbtn" data-act="move-label" data-id="${this._esc(l.id)}" data-dir="1" title="Move right"><i class="ti ti-chevron-right"></i></button>
      <button class="tsetup-iconbtn tsetup-danger" data-act="remove-label" data-id="${this._esc(l.id)}" data-name="${this._esc(l.label)}" title="Remove"><i class="ti ti-x"></i></button>
    </div>`;
  }

  /* ---------- events ---------- */
  bindEvents() {
    const wrap = this.wrap;
    const companySel = wrap.querySelector('select[data-act="company"]');
    if (companySel) companySel.addEventListener('change', (e) => { this.company = e.target.value; this.selectedType = null; this.render(); });

    wrap.querySelectorAll('input.tsetup-swatch[data-id]').forEach((inp) => {
      inp.addEventListener('click', (e) => e.stopPropagation());
      inp.addEventListener('change', () => this._recolor(inp.dataset.kind, inp.dataset.id, inp.value));
    });

    wrap.querySelectorAll('button[data-act]').forEach((el) => {
      el.addEventListener('click', (e) => { e.preventDefault(); this._onAction(el); });
    });
  }

  _onAction(el) {
    const act = el.dataset.act;
    const id = el.dataset.id;
    const name = el.dataset.name;
    const dir = Number(el.dataset.dir);
    switch (act) {
      case 'back': return this.controller.goBack();

      case 'select-type': this.selectedType = el.dataset.key; return this.render();

      case 'add-type': return this._openEditor({ title: 'Add type', withColor: true, onSave: (nm, col) => this.controller.addType(this.company, nm, col) });
      case 'rename-type': return this._openEditor({ title: 'Rename type', name, onSave: (nm) => this.controller.renameType(id, nm) });
      case 'move-type': return this._run(() => this.controller.moveType(id, dir), 'Reordered');
      case 'remove-type': return this._confirmRemove(name, () => this.controller.removeType(id));

      case 'add-status': return this._openEditor({ title: 'Add status', withColor: true, onSave: (nm, col) => this.controller.addStatus(this.company, this.selectedType, nm, col) });
      case 'rename-status': return this._openEditor({ title: 'Rename status', name, onSave: (nm) => this.controller.renameStatus(id, nm) });
      case 'move-status': return this._run(() => this.controller.moveStatus(id, dir), 'Reordered');
      case 'remove-status': return this._confirmRemove(name, () => this.controller.removeStatus(id));
      case 'set-default': return this._run(() => this.controller.setDefaultStatus(id), 'Default set');
      case 'set-done': return this._run(() => this.controller.setDoneStatus(id), 'Done status set');

      case 'add-label': return this._openEditor({ title: 'Add label', withColor: true, onSave: (nm, col) => this.controller.addLabel(this.company, nm, col) });
      case 'rename-label': return this._openEditor({ title: 'Rename label', name, onSave: (nm) => this.controller.renameLabel(id, nm) });
      case 'move-label': return this._run(() => this.controller.moveLabel(id, dir), 'Reordered');
      case 'remove-label': return this._confirmRemove(name, () => this.controller.removeLabel(id));
      default: return undefined;
    }
  }

  _recolor(kind, id, color) {
    const fn = kind === 'type' ? () => this.controller.recolorType(id, color)
      : kind === 'status' ? () => this.controller.recolorStatus(id, color)
        : () => this.controller.recolorLabel(id, color);
    return this._run(fn, 'Colour updated');
  }

  /* ---------- op runner + toast ---------- */
  async _run(fn, okTitle) {
    if (this._busy) return;
    this._busy = true;
    try { await fn(); if (okTitle) this._toast(okTitle); }
    catch (e) { this._toast('Couldn’t save', (e && e.message) || 'Try again.'); }
    finally { this._busy = false; }
  }
  _toast(title, sub) {
    const tv = this.controller.toastView;
    if (tv && tv.show) tv.show({ title, sub });
  }

  /* ---------- modals ---------- */
  _openEditor({ title, name = '', withColor = false, onSave }) {
    this._closeModal();
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal tsetup-modal" data-stop>
        <h3 class="tsetup-modal-title">${this._esc(title)}</h3>
        <label class="tsetup-field">Name
          <input type="text" class="tsetup-input" id="tsetup-name" value="${this._esc(name)}" maxlength="60" autocomplete="off">
        </label>
        ${withColor ? `<label class="tsetup-field tsetup-field-color">Colour <input type="color" id="tsetup-color" value="#8f867b"></label>` : ''}
        <div class="tsetup-modal-actions">
          <button class="btn" data-act="cancel" type="button">Cancel</button>
          <button class="btn btn-primary" data-act="confirm" type="button">Save</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    this._modal = backdrop;
    const nameEl = backdrop.querySelector('#tsetup-name');
    const colorEl = backdrop.querySelector('#tsetup-color');
    const close = () => this._closeModal();
    const submit = () => {
      const nm = (nameEl.value || '').trim();
      if (!nm) { nameEl.focus(); return; }
      const col = colorEl ? colorEl.value : undefined;
      close();
      this._run(() => onSave(nm, col), 'Saved');
    };
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    backdrop.querySelector('[data-act="cancel"]').addEventListener('click', close);
    backdrop.querySelector('[data-act="confirm"]').addEventListener('click', submit);
    nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') close(); });
    setTimeout(() => nameEl.focus(), 30);
  }

  _confirmRemove(name, onConfirm) {
    this._closeModal();
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal tsetup-modal" data-stop>
        <h3 class="tsetup-modal-title">Remove “${this._esc(name)}”?</h3>
        <p class="tsetup-modal-sub">It’ll be hidden from pickers. Existing tasks keep it for their history.</p>
        <div class="tsetup-modal-actions">
          <button class="btn" data-act="cancel" type="button">Cancel</button>
          <button class="btn tsetup-remove-btn" data-act="confirm" type="button">Remove</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    this._modal = backdrop;
    const close = () => this._closeModal();
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    backdrop.querySelector('[data-act="cancel"]').addEventListener('click', close);
    backdrop.querySelector('[data-act="confirm"]').addEventListener('click', () => { close(); this._run(onConfirm, 'Removed'); });
  }

  _closeModal() { if (this._modal) { this._modal.remove(); this._modal = null; } }

  _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
};
