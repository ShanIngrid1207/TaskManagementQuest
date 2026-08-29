window.App = window.App || {};

App.ApprovalView = class ApprovalView {
  constructor({ controller, dataStore }) {
    this.controller = controller;
    this.dataStore = dataStore;
    this.wrap = document.getElementById('timeViewWrap');
    this.subscribe();
  }

  subscribe() {
    App.EventBus.on('view:changed', (view) => {
      if (view === 'approvals') this.render();
    });
  }

  // People who can be picked as a supervisor (have an overseeing role + a member id).
  supervisorOptions(excludeMemberId) {
    const overseeing = ['supervisor', 'admin', 'developer'];
    return (App.PROFILES || [])
      .filter(p => p.member_id && p.member_id !== excludeMemberId && overseeing.includes(p.role))
      .map(p => {
        const person = App.directory.person(p.member_id);
        return { id: p.member_id, name: (person && person.full) || p.full_name || p.email || p.member_id };
      });
  }

  // The "Reports to" multi-picker for one profile: removable chips for the
  // already-chosen supervisors + a "+ Add" dropdown of the remaining eligible
  // people. Capped at 4. Selected ids live in data-sup-ids on the container;
  // the dropdown and chips are re-rendered from it on every change.
  supervisorPickerHtml(profile) {
    const selected = Array.isArray(profile.supervisor_ids)
      ? profile.supervisor_ids
      : (profile.supervisor_id ? [profile.supervisor_id] : []);
    return this.renderSupervisorPicker(this.supervisorOptions(profile.member_id), selected);
  }

  renderSupervisorPicker(options, selected) {
    const MAX = 4;
    const byId = new Map(options.map(o => [o.id, o.name]));
    const chips = selected.map(id => `
      <span class="rep-chip" data-sup="${App.utils.escapeHtml(id)}">
        ${App.utils.escapeHtml(byId.get(id) || id)}
        <button type="button" class="rep-chip-x" data-action="sup-remove" data-sup="${App.utils.escapeHtml(id)}" aria-label="Remove">&times;</button>
      </span>`).join('');
    const remaining = options.filter(o => !selected.includes(o.id));
    const addControl = (selected.length >= MAX || remaining.length === 0)
      ? (selected.length >= MAX ? '<span class="rep-cap">Max 4</span>' : '')
      : `<select class="rep-add" data-action="sup-add">
           <option value="">+ Add…</option>
           ${remaining.map(o => `<option value="${App.utils.escapeHtml(o.id)}">${App.utils.escapeHtml(o.name)}</option>`).join('')}
         </select>`;
    const empty = selected.length ? '' : '<span class="rep-none">— None —</span>';
    return `<div class="reports-multi" data-field="supervisors" data-sup-ids="${App.utils.escapeHtml(JSON.stringify(selected))}">${empty}${chips}${addControl}</div>`;
  }

  render() {
    if (!App.can('roles.manage')) {
      this.wrap.innerHTML = `<div class="empty"><i class="ti ti-lock"></i><div class="empty-title">No access</div><div class="empty-sub">Only admins and construction supervisors can manage users.</div></div>`;
      return;
    }

    const rows = (App.PROFILES || []).map(profile => this.renderRow(profile)).join('');
    this.wrap.innerHTML = `
      <div class="time-page">
        <div class="time-section">
          <div class="approval-head">
            <div class="time-section-title">User approvals</div>
            <div class="approval-head-actions">
              <button class="btn btn-sm btn-primary" data-action="add-person"><i class="ti ti-user-plus"></i>Add person</button>
              <button class="btn btn-sm" data-action="refresh-profiles"><i class="ti ti-refresh"></i>Refresh</button>
            </div>
          </div>
          <div class="approval-scroll">
            <table class="time-table approval-table">
              <thead>
                <tr><th>Person</th><th>Role</th><th>Position</th><th>Company</th><th>Reports to</th><th>Status</th><th>Email</th><th></th></tr>
              </thead>
              <tbody>${rows || '<tr><td colspan="8">No accounts found.</td></tr>'}</tbody>
            </table>
          </div>
        </div>
      </div>
    `;
    this.bind();
  }

  renderRow(profile) {
    // You can't delete your own account — hide the button and RLS blocks it too.
    const isSelf = !!(App.currentAuthUser && App.currentAuthUser.id === profile.id);
    const person = App.directory.person(profile.member_id) || {
      name: profile.full_name || profile.email || 'Member',
      full: profile.full_name || profile.email || 'Member',
      email: profile.email || '',
      color: '#E8A03A',
      avatar_url: profile.avatar_url || null,
    };
    // Assignable roles. If this profile still holds a retired/unknown role
    // (e.g. a pending "member", or one not yet migrated), show it as the
    // current selection so simply saving the row won't silently reassign them.
    const roleEntries = Object.entries(App.ROLES);
    if (profile.role && !App.ROLES[profile.role]) {
      const retiredLabels = { member: 'Member', construction_supervisor: 'Construction supervisor' };
      roleEntries.unshift([profile.role, { label: `${retiredLabels[profile.role] || profile.role} (retired)` }]);
    }
    const roles = roleEntries.map(([id, role]) =>
      `<option value="${App.utils.escapeHtml(id)}" ${profile.role === id ? 'selected' : ''}>${App.utils.escapeHtml(role.label)}</option>`
    ).join('');
    const companyIds = Array.isArray(profile.company_ids) ? profile.company_ids : [];
    // 'overall' (c.all) is NOT a tickable company: it's granted automatically to
    // anyone in 2+ real companies by the profiles_sync_overall trigger
    // (migration 068). Showing a checkbox would just get overridden on save.
    const companyChecks = Object.values(App.COMPANIES).filter(c => !c.all).map(c => `
      <label class="company-chk">
        <input type="checkbox" value="${App.utils.escapeHtml(c.id)}" ${companyIds.includes(c.id) ? 'checked' : ''} />
        <span>${App.utils.escapeHtml(c.label)}</span>
      </label>
    `).join('');
    return `
      <tr data-profile-id="${profile.id}" data-member-id="${profile.member_id || ''}" data-person-name="${App.utils.escapeHtml(person.full)}">
        <td data-label="Person">
          <span style="display:inline-flex;align-items:center;gap:8px;">
            ${App.utils.avatarHtml(person)}
            <span style="font-size:12px;">${App.utils.escapeHtml(person.full)}</span>
          </span>
        </td>
        <td data-label="Role"><select data-field="role">${roles}</select></td>
        <td data-label="Position"><input type="text" class="approval-position-input" data-field="position" value="${App.utils.escapeHtml(profile.position || '')}" placeholder="e.g. Drafting Lead" maxlength="80" /></td>
        <td data-label="Company"><div class="company-multi" data-field="companies">${companyChecks}</div></td>
        <td data-label="Reports to">${this.supervisorPickerHtml(profile)}</td>
        <td data-label="Status">
          <label class="approval-toggle">
            <input type="checkbox" data-field="approved" ${profile.approved ? 'checked' : ''} />
            <span>${profile.approved ? 'Approved' : 'Pending'}</span>
          </label>
        </td>
        <td data-label="Email"><span class="approval-email">${App.utils.escapeHtml(profile.email || '')}</span></td>
        <td class="approval-actions-cell">
          <div class="approval-actions">
            <button class="btn btn-sm btn-primary" data-action="save-access">Save</button>
            ${isSelf ? '' : `<button class="btn btn-sm btn-danger" data-action="delete-user" title="Remove this user's access"><i class="ti ti-trash"></i></button>`}
          </div>
        </td>
      </tr>
    `;
  }

  bind() {
    const addBtn = this.wrap.querySelector('[data-action="add-person"]');
    if (addBtn) addBtn.addEventListener('click', () => this.openAddPerson());

    const refreshBtn = this.wrap.querySelector('[data-action="refresh-profiles"]');
    if (refreshBtn) refreshBtn.addEventListener('click', () => this.reloadAndRender(refreshBtn));

    // Keep the Approved/Pending label in sync as the box is toggled (before save).
    this.wrap.querySelectorAll('[data-field="approved"]').forEach(box => {
      box.addEventListener('change', () => {
        const label = box.parentElement.querySelector('span');
        if (label) label.textContent = box.checked ? 'Approved' : 'Pending';
      });
    });

    // "Reports to" multi-picker: add via the dropdown, remove via a chip ×.
    // Scoped to the surviving <td> so listeners persist across re-renders
    // (renderSupervisorPicker replaces the inner .reports-multi via outerHTML).
    this.wrap.querySelectorAll('td[data-label="Reports to"]').forEach(cell => {
      const box = () => cell.querySelector('[data-field="supervisors"]');
      const readIds = () => { try { return JSON.parse(box().dataset.supIds || '[]'); } catch { return []; } };
      const rerender = (ids) => {
        const excludeMember = cell.closest('[data-profile-id]')?.dataset.memberId || null;
        box().outerHTML = this.renderSupervisorPicker(this.supervisorOptions(excludeMember), ids);
      };
      cell.addEventListener('change', (e) => {
        const sel = e.target.closest('[data-action="sup-add"]');
        if (!sel || !sel.value) return;
        const ids = readIds();
        if (!ids.includes(sel.value)) ids.push(sel.value);
        rerender(ids);
      });
      cell.addEventListener('click', (e) => {
        const rm = e.target.closest('[data-action="sup-remove"]');
        if (!rm) return;
        rerender(readIds().filter(id => id !== rm.dataset.sup));
      });
    });

    this.wrap.querySelectorAll('[data-action="save-access"]').forEach(button => {
      button.addEventListener('click', async () => {
        const row = button.closest('[data-profile-id]');
        const profileId = row.dataset.profileId;
        const role = row.querySelector('[data-field="role"]').value;
        const approved = row.querySelector('[data-field="approved"]').checked;
        let supervisorIds = [];
        try { supervisorIds = JSON.parse(row.querySelector('[data-field="supervisors"]').dataset.supIds || '[]'); } catch { supervisorIds = []; }
        const position = (row.querySelector('[data-field="position"]').value || '').trim() || null;
        const companyIds = Array.from(
          row.querySelectorAll('[data-field="companies"] input[type="checkbox"]:checked')
        ).map(el => el.value);
        button.disabled = true;
        button.textContent = 'Saving';
        try {
          await this.dataStore.updateProfileAccess(profileId, { role, approved, supervisorIds, companyIds, position });
          // Mirror position into App.PEOPLE immediately so the picker reflects it
          // without waiting for a full data reload (team_members trigger runs async).
          const memberId = row.dataset.memberId;
          if (memberId && App.PEOPLE && App.directory.person(memberId)) App.directory.person(memberId).position = position;
          this.controller.toastView.show({ title: 'Access updated', sub: approved ? 'Account approved' : 'Account set to pending' });
          // Reload from the server so the table reflects the saved state without a manual refresh.
          await this.reloadAndRender();
        } catch (err) {
          this.controller.toastView.show({ title: 'Access update failed', sub: (err && err.message) || 'Try again.' });
          button.disabled = false;
          button.textContent = 'Save';
        }
      });
    });

    this.wrap.querySelectorAll('[data-action="delete-user"]').forEach(button => {
      button.addEventListener('click', async () => {
        const row = button.closest('[data-profile-id]');
        const profileId = row.dataset.profileId;
        const memberId = row.dataset.memberId || null;
        const name = row.dataset.personName || 'this user';
        const ok = window.confirm(
          `Delete ${name}?\n\nThey'll be signed out, removed from this list, and their login email freed so it can be used to sign up again. Their past tasks are kept.`
        );
        if (!ok) return;
        button.disabled = true;
        try {
          const result = await this.dataStore.deleteProfile(profileId, memberId);
          this.controller.toastView.show(
            (result && result.emailFreed)
              ? { title: 'User deleted', sub: 'Access revoked and the email is free to reuse.' }
              : { title: 'Access revoked', sub: 'Email stays reserved until the delete-user function is deployed.' }
          );
          await this.reloadAndRender();
        } catch (err) {
          this.controller.toastView.show({ title: 'Delete failed', sub: (err && err.message) || 'Try again.' });
          button.disabled = false;
        }
      });
    });
  }

  openAddPerson() {
    if (this._addModal) return;
    const roles = Object.entries(App.ROLES)
      .map(([id, r]) => `<option value="${App.utils.escapeHtml(id)}" ${id === 'worker' ? 'selected' : ''}>${App.utils.escapeHtml(r.label)}</option>`)
      .join('');
    // 'overall' is auto-granted at 2+ companies (migration 068) — not tickable.
    const companies = Object.values(App.COMPANIES).filter(c => !c.all).map(c => `
      <label class="company-chk">
        <input type="checkbox" value="${App.utils.escapeHtml(c.id)}" />
        <span>${App.utils.escapeHtml(c.label)}</span>
      </label>`).join('');
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.id = 'addPersonModal';
    modal.innerHTML = `
      <div class="modal" data-stop>
        <div class="modal-head">
          <div class="modal-title">Add person</div>
          <button class="icon-btn" data-action="close" aria-label="Close"><i class="ti ti-x"></i></button>
        </div>
        <div class="modal-body">
          <div class="field"><label class="field-label" for="ap-name">Full name</label>
            <input type="text" id="ap-name" placeholder="First Last" maxlength="80" /></div>
          <div class="field" style="margin-top:12px;"><label class="field-label" for="ap-email">Email</label>
            <input type="email" id="ap-email" placeholder="name@company.com" maxlength="254" /></div>
          <div class="field" style="margin-top:12px;"><label class="field-label" for="ap-role">Role</label>
            <select id="ap-role">${roles}</select></div>
          <div class="field" style="margin-top:12px;"><label class="field-label">Company</label>
            <div class="company-multi" id="ap-companies">${companies}</div></div>
          <div class="field" style="margin-top:12px;" id="ap-supervisors-field"><label class="field-label">Reports to</label>
            ${this.renderSupervisorPicker(this.supervisorOptions(null), [])}</div>
          <div class="ap-result hidden" id="ap-result"></div>
          <div class="modal-actions">
            <button class="btn" data-action="close">Cancel</button>
            <button class="btn btn-primary" data-action="submit">Create account</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    this._addModal = modal;

    const close = () => { modal.remove(); this._addModal = null; };
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    modal.querySelectorAll('[data-action="close"]').forEach(el => el.addEventListener('click', close));
    modal.querySelector('[data-action="submit"]').addEventListener('click', () => this.submitAddPerson(modal, close));

    // "Reports to" multi-picker (chips + add), scoped to the stable field wrapper
    // so listeners survive the outerHTML re-render (same pattern as the table cell).
    const supField = modal.querySelector('#ap-supervisors-field');
    if (supField) {
      const box = () => supField.querySelector('[data-field="supervisors"]');
      const readIds = () => { try { return JSON.parse(box().dataset.supIds || '[]'); } catch { return []; } };
      const rerender = (ids) => { box().outerHTML = this.renderSupervisorPicker(this.supervisorOptions(null), ids); };
      supField.addEventListener('change', (e) => {
        const sel = e.target.closest('[data-action="sup-add"]');
        if (!sel || !sel.value) return;
        const ids = readIds();
        if (!ids.includes(sel.value)) ids.push(sel.value);
        rerender(ids);
      });
      supField.addEventListener('click', (e) => {
        const rm = e.target.closest('[data-action="sup-remove"]');
        if (!rm) return;
        rerender(readIds().filter(id => id !== rm.dataset.sup));
      });
    }

    setTimeout(() => { const n = modal.querySelector('#ap-name'); if (n) n.focus(); }, 50);
  }

  async submitAddPerson(modal, close) {
    const name = modal.querySelector('#ap-name').value.trim();
    const email = modal.querySelector('#ap-email').value.trim();
    const role = modal.querySelector('#ap-role').value;
    let supervisorIds = [];
    try { supervisorIds = JSON.parse(modal.querySelector('#ap-supervisors-field [data-field="supervisors"]').dataset.supIds || '[]'); } catch { supervisorIds = []; }
    const companyIds = Array.from(modal.querySelectorAll('#ap-companies input[type="checkbox"]:checked')).map(el => el.value);
    const result = modal.querySelector('#ap-result');

    if (!name) { result.className = 'ap-result error'; result.textContent = 'Enter a full name.'; return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { result.className = 'ap-result error'; result.textContent = 'Enter a valid email.'; return; }

    const btn = modal.querySelector('[data-action="submit"]');
    btn.disabled = true; btn.textContent = 'Creating…';
    try {
      const res = await this.dataStore.createUser({ fullName: name, email, role, companyIds, supervisorIds });
      this.controller.toastView.show({
        title: 'Person added',
        sub: res.emailSent ? 'Account created and emailed.' : 'Account created — email could not be sent.',
      });
      close();
      await this.reloadAndRender();
    } catch (err) {
      result.className = 'ap-result error';
      result.textContent = (err && err.message) || 'Could not add the person.';
      btn.disabled = false; btn.textContent = 'Create account';
    }
  }

  async reloadAndRender(btn) {
    if (btn) { btn.disabled = true; }
    try {
      const profiles = await this.dataStore.loadProfiles();
      App.PROFILES = profiles;
      App.EventBus.emit('people:changed');
    } catch (err) {
      this.controller.toastView.show({ title: 'Could not refresh', sub: (err && err.message) || 'Try again.' });
    }
    this.render();
  }
};
