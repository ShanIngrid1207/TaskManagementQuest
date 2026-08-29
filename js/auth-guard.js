/* Guards app.html:
   - No session   -> return to login
   - Not approved -> return to login so pending state can render
   - Approved     -> allow app bootstrap and wire sign-out */
window.App = window.App || {};

App.authReady = (async function () {
  const loginUrl = App.routes ? App.routes.login : window.location.origin + '/';

  // Dev-only UI preview mode: ?preview=1 skips Supabase entirely and boots
  // with seeded data. Gated to localhost / loopback only — on any deployed
  // origin this becomes a no-op so it can't be used as an auth-bypass.
  const params = new URLSearchParams(window.location.search);
  const host = window.location.hostname;
  const isLocal = (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost')
  );
  if (params.get('preview') === '1' && isLocal) {
    App.previewMode = true;
    // Optional ?role= and ?member= let you preview role-gated views (worker, supervisor, etc.).
    const previewRole = params.get('role') || 'admin';
    const previewMember = params.get('member') || 'abraham';
    App.currentSession = { user: { id: 'preview-user', email: 'preview@local' } };
    App.currentAuthUser = App.currentSession.user;
    App.currentProfile = {
      id: 'preview-user',
      email: previewMember + '@local',
      full_name: 'Preview ' + previewRole,
      approved: true,
      role: previewRole,
      email_verified: true,
      member_id: previewMember,
      supervisor_id: null,
      supervisor_ids: [],
    };
    App.signOut = function () { window.location.href = window.location.pathname; };
    return;
  }

  // Wait for runtime config (env.json -> Supabase client) before any auth call.
  if (App.configReady) await App.configReady;

  if (!App.supabase || !App.supabase.auth) {
    const detail = App.supabaseLoadError || 'Check Supabase configuration.';
    document.body.innerHTML = `<div style="padding:24px;font-family:Inter,system-ui,sans-serif;">Auth service is unavailable. ${detail.replace(/[<>&]/g, '')}</div>`;
    throw new Error('Supabase auth is unavailable');
  }

  const { data: sessionData } = await App.supabase.auth.getSession();
  if (!sessionData.session) {
    window.location.replace(loginUrl);
    return;
  }

  const user = sessionData.session.user;
  const { data: profile, error } = await App.supabase
    .from('profiles')
    .select('id, email, full_name, approved, role, email_verified, member_id, created_at, avatar_url, company_ids')
    .eq('id', user.id)
    .single();

  if (error || !profile) {
    window.location.replace(loginUrl);
    return;
  }

  if (!profile.approved) {
    window.location.replace(loginUrl);
    return;
  }

  App.currentSession = sessionData.session;
  App.currentAuthUser = user;
  App.currentProfile = profile;

  App.signOut = async function () {
    await App.supabase.auth.signOut();
    window.location.replace(loginUrl);
  };

  App.supabase.auth.onAuthStateChange((_event, session) => {
    if (!session) window.location.replace(loginUrl);
  });

  const wire = () => {
    const btn = document.getElementById('signOutBtn');
    const avatar = document.getElementById('userAvatar');
    if (btn) btn.addEventListener('click', App.signOut);
    // Avatar click is handled by TopbarView (opens the user menu). We only
    // paint the avatar here.

    const name = profile.full_name || user.email || '';
    if (avatar) {
      avatar.title = user.email || name || 'Account';
      const meta = user.user_metadata || {};
      const avatarSrc = profile.avatar_url || meta.avatar_url || '';
      if (avatarSrc) {
        avatar.style.background = 'transparent';
        // Build the <img> via DOM API rather than string interpolation —
        // avatarSrc is user-controlled (profiles.avatar_url is editable
        // by the row owner), so building HTML with `<img src="${url}">`
        // would let a malicious value like `"><script>...` break out of
        // the attribute. Setting img.src as a DOM attribute is XSS-safe.
        const img = document.createElement('img');
        img.src = avatarSrc;
        img.alt = '';
        img.style.cssText = 'width:100%;height:100%;border-radius:50%;object-fit:cover;';
        avatar.replaceChildren(img);
      } else {
        const initials = name.trim().split(/\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase();
        if (initials) avatar.textContent = initials;
      }
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
