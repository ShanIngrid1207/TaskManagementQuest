// js/views/CheckinSettingsView.js
window.App = window.App || {};

/* Settings → Check-ins. Boss-only (checkins.manage) page that toggles the three
   proactive check-in modes for the whole team and sets the stalled threshold.
   Renders into the shared #timeViewWrap like the other admin surfaces; activated
   on the 'admin:checkins' view. Writes the single checkin_settings row that the
   scheduled `checkins` Edge Function reads. */
App.CheckinSettingsView = class CheckinSettingsView {
  constructor({ controller }) {
    this.controller = controller;
    this.dataStore = controller.dataStore;
    this.wrap = document.getElementById('timeViewWrap');
    this.cfg = null;
    this._busy = false;
    App.EventBus.on('view:changed', (view) => { if (view === 'admin:checkins') this.refresh(); });
  }

  visible() {
    return this.controller.uiState.view === 'admin:checkins'
      && this.wrap && !this.wrap.classList.contains('hidden');
  }

  _esc(s) { return App.utils.escapeHtml(String(s ?? '')); }

  async refresh() {
    if (!this.wrap) this.wrap = document.getElementById('timeViewWrap');
    if (!this.wrap) return;
    if (!App.can('checkins.manage')) {
      this.wrap.innerHTML = `<div class="tsetup"><div class="empty"><i class="ti ti-lock"></i><p>Only admins can manage check-ins.</p></div></div>`;
      return;
    }
    try { this.cfg = await this.dataStore.getCheckinSettings(); }
    catch (e) { this.wrap.innerHTML = `<div class="tsetup"><div class="empty"><p>Couldn’t load check-in settings. ${this._esc((e && e.message) || '')}</p></div></div>`; return; }
    if (!this.visible()) return;
    this.render();
  }

  _row(key, title, desc) {
    const on = !!this.cfg[key];
    return `<label class="ci-row">
      <span class="ci-row-t"><span class="ci-row-title">${title}</span><span class="ci-row-desc">${desc}</span></span>
      <input type="checkbox" data-ci="${key}" ${on ? 'checked' : ''} />
    </label>`;
  }

  render() {
    this.wrap.innerHTML = `<div class="tsetup ci-wrap">
      <div class="tsetup-head"><h2 class="tsetup-title">Check-ins</h2></div>
      <p class="tsetup-sub">Proactive AI messages to your team, delivered to the notification bell and by email. Everything is off until you switch it on.</p>
      ${this._row('morning_enabled', 'Morning recap', 'When they clock in (or 8am for people who don’t use the clock): their day plus “what are you tackling today?”')}
      ${this._row('eod_enabled', 'End-of-day recap', 'When they clock out for the day (or 4pm for non-clock users): what they finished, what slipped, confirm the day.')}
      ${this._row('stalled_enabled', 'Stalled-task nudge', 'Weekly: a nudge listing tasks that have gone quiet.')}
      <label class="ci-days">Stalled after
        <input type="number" min="1" max="90" data-ci-days value="${this.cfg.stalled_days || 3}" /> days
      </label>
      <label class="ci-days">End-of-day fires after a clocker is idle
        <input type="number" min="15" max="480" step="15" data-ci-idle value="${this.cfg.eod_idle_minutes || 90}" /> min
      </label>
      <div class="ci-actions"><button class="btn btn-primary" data-ci-save type="button">Save</button><span class="ci-status" data-ci-status></span></div>
    </div>`;
    this.wrap.querySelector('[data-ci-save]').addEventListener('click', () => this._save());
  }

  async _save() {
    if (this._busy) return;
    this._busy = true;
    const status = this.wrap.querySelector('[data-ci-status]');
    status.textContent = 'Saving…';
    const patch = {
      morning_enabled: this.wrap.querySelector('[data-ci="morning_enabled"]').checked,
      eod_enabled: this.wrap.querySelector('[data-ci="eod_enabled"]').checked,
      stalled_enabled: this.wrap.querySelector('[data-ci="stalled_enabled"]').checked,
      stalled_days: this.wrap.querySelector('[data-ci-days]').value,
      eod_idle_minutes: this.wrap.querySelector('[data-ci-idle]').value,
    };
    try { this.cfg = await this.dataStore.saveCheckinSettings(patch); status.textContent = 'Saved.'; }
    catch (e) { status.textContent = `Couldn’t save. ${this._esc((e && e.message) || '')}`; }
    this._busy = false;
  }
};
