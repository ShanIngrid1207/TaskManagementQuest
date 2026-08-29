window.App = window.App || {};

/* HierarchyView — supervisor org chart.
   Renders into the shared timeViewWrap container on the 'team:hierarchy' view.
   Hierarchy is derived from profiles:
     - explicit per-user override: profile.supervisor_ids (team_member ids; a
       person may report to several supervisors and appears under each)
     - role default: workers/members with no supervisor form a shared "Unassigned"
       pool that every supervisor oversees.
   Managers (admin / construction supervisor / developer) see the full chart;
   a plain supervisor sees only their own direct reports plus the unassigned pool. */
App.HierarchyView = class HierarchyView {
  constructor({ controller }) {
    this.controller = controller;
    this.wrap = document.getElementById('timeViewWrap');
    this.subscribe();
  }

  subscribe() {
    App.EventBus.on('view:changed', (view) => { if (view === 'team:hierarchy') this.render(); });
    App.EventBus.on('people:changed', () => { if (this.isActive()) this.render(); });
  }

  isActive() {
    return this.controller.uiState.view === 'team:hierarchy' && !this.wrap.classList.contains('hidden');
  }

  person(memberId) {
    return App.directory.person(memberId) || App.directory.personFallback(memberId);
  }

  roleLabel(role) {
    return (App.ROLES[role] || { label: role || 'Member' }).label;
  }

  companyChips(companyIds) {
    if (!Array.isArray(companyIds) || !companyIds.length) return '';
    return companyIds
      .map(id => App.directory.company(id))
      .filter(Boolean)
      .map(co => `<span class="pill ${co.pill}">${App.utils.escapeHtml(co.label)}</span>`)
      .join(' ');
  }

  render() {
    if (!App.can('team.view')) {
      this.wrap.innerHTML = `<div class="empty"><i class="ti ti-lock"></i><div class="empty-title">No access</div><div class="empty-sub">Only supervisors and admins can view the team hierarchy.</div></div>`;
      return;
    }

    const overseeing = ['supervisor', 'construction_supervisor', 'admin', 'developer'];
    const poolRoles = ['worker', 'sales', 'member'];
    const profiles = (App.PROFILES || []).filter(p => p.member_id);
    const me = App.currentProfile || {};
    const isManager = App.can('roles.manage');

    // A person reporting to N supervisors appears under EACH of them (migration 073).
    const directReports = (memberId) => profiles
      .filter(p => App.utils.reportsTo(p, memberId))
      .sort((a, b) => this.person(a.member_id).full.localeCompare(this.person(b.member_id).full));
    const hasSupervisor = (p) => Array.isArray(p.supervisor_ids) ? p.supervisor_ids.length > 0 : !!p.supervisor_id;
    const unassignedPool = profiles
      .filter(p => !hasSupervisor(p) && poolRoles.includes(p.role))
      .sort((a, b) => this.person(a.member_id).full.localeCompare(this.person(b.member_id).full));

    const sections = [];
    if (isManager) {
      profiles
        .filter(p => overseeing.includes(p.role))
        .sort((a, b) => this.person(a.member_id).full.localeCompare(this.person(b.member_id).full))
        .forEach(s => sections.push({
          name: this.person(s.member_id).full,
          color: this.person(s.member_id).color,
          avatar_url: this.person(s.member_id).avatar_url,
          role: this.roleLabel(s.role),
          companyIds: Array.isArray(s.company_ids) ? s.company_ids : [],
          reports: directReports(s.member_id),
        }));
    } else {
      sections.push({
        name: `${this.person(me.member_id).full} (You)`,
        color: this.person(me.member_id).color,
        avatar_url: this.person(me.member_id).avatar_url,
        role: this.roleLabel(me.role),
        companyIds: Array.isArray(me.company_ids) ? me.company_ids : [],
        reports: directReports(me.member_id),
      });
    }
    sections.push({
      name: 'Unassigned',
      role: 'Workers & members without a supervisor',
      reports: unassignedPool,
      pool: true,
    });

    const totalReports = sections.reduce((sum, s) => sum + s.reports.length, 0);

    this.wrap.innerHTML = `
      <div class="time-page">
        <div class="time-section">
          <div class="time-section-title">Team hierarchy</div>
          <div class="org-sub">${isManager ? 'Full chain of command across the team.' : 'People reporting to you, plus unassigned staff you oversee.'} · ${totalReports} ${totalReports === 1 ? 'person' : 'people'}</div>
          <div class="org-chart">
            ${sections.map(s => this.renderNode(s)).join('')}
          </div>
        </div>
      </div>
    `;
  }

  renderNode(section) {
    const reports = section.reports.length
      ? section.reports.map(p => this.renderReport(p)).join('')
      : `<div class="org-empty">No direct reports</div>`;
    const avatar = section.pool
      ? `<span class="avatar-xs org-pool-icon"><i class="ti ti-users"></i></span>`
      : App.utils.avatarHtml({ avatar_url: section.avatar_url, color: section.color, full: section.name });
    const co = section.pool ? '' : this.companyChips(section.companyIds);
    return `
      <div class="org-node ${section.pool ? 'org-node-pool' : ''}">
        <div class="org-super">
          ${avatar}
          <div class="org-super-meta">
            <div class="org-super-name">${App.utils.escapeHtml(section.name)}</div>
            <div class="org-super-sub">
              <span class="org-super-role">${App.utils.escapeHtml(section.role)}</span>
              ${co}
            </div>
          </div>
          <span class="org-count">${section.reports.length}</span>
        </div>
        <div class="org-reports">${reports}</div>
      </div>
    `;
  }

  renderReport(profile) {
    const person = this.person(profile.member_id);
    const co = this.companyChips(profile.company_ids);
    return `
      <div class="org-report">
        ${App.utils.avatarHtml(person)}
        <span class="org-report-name">${App.utils.escapeHtml(person.full)}</span>
        <span class="org-report-meta">
          <span class="org-report-role">${App.utils.escapeHtml(this.roleLabel(profile.role))}</span>
          ${co || '<span class="org-report-co-empty">No co.</span>'}
        </span>
        <span class="org-report-email">${App.utils.escapeHtml(person.email || '')}</span>
      </div>
    `;
  }
};
