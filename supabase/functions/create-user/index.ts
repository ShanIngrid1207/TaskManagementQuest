// Supabase Edge Function: create-user
// -----------------------------------------------------------------------------
// Admin-created accounts. Creates an Auth login with a fixed default password,
// relies on the on_auth_user_created trigger (handle_new_user) to create the
// matching profiles + team_members rows, then approves the profile with the
// chosen role/company/supervisor and emails the person their credentials.
//
// The browser can't create Auth users (needs the service-role key), so this runs
// server-side. The Quest HQ client invokes it with
// supabase.functions.invoke('create-user').
//
// ⚠️ This version writes profiles.supervisor_ids[] (multiple supervisors,
// migration 073). DEPLOY ONLY AFTER 073 is applied — the column must exist or
// the profile promote fails. The client sends { supervisorIds: string[] };
// legacy { supervisorId } is still accepted.
//
// DEPLOY (one-time):
//   supabase secrets set DEFAULT_NEW_USER_PASSWORD="<your default>"
//   supabase secrets set APP_URL="https://your-app.vercel.app"      (for the email link)
//   (RESEND_API_KEY, EMAIL_FROM, ALLOWED_ORIGINS already set for notify-email/delete-user.
//    SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
//   supabase functions deploy create-user
//
// HARDENING (mirrors delete-user/notify-email):
//   - JWT verification on by default; caller must be approved AND a manager role
//     (admin / developer — construction_supervisor kept inert for parity).
//   - Service-role key, Resend key, and default password never leave the server.
//   - Payload size capped; inputs validated; duplicate email rejected.
// -----------------------------------------------------------------------------

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MAX_PAYLOAD_BYTES = 16 * 1024;
// Matches delete-user's gate and the client App.can('roles.manage') (admin/developer).
// construction_supervisor is retired (no live user holds it) but kept for parity.
const MANAGER_ROLES = new Set(["admin", "construction_supervisor", "developer"]);
const ASSIGNABLE_ROLES = new Set(["worker", "sales", "supervisor", "admin", "developer"]);
const KNOWN_COMPANIES = new Set(["roofing", "drafting", "lumen"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const RESEND_ENDPOINT = "https://api.resend.com/emails";

function corsHeadersFor(req: Request): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  const allowList = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (allowList.length === 0) {
    console.error("[create-user] ALLOWED_ORIGINS is not set — refusing cross-origin responses.");
    return headers;
  }
  const origin = req.headers.get("Origin") ?? "";
  if (allowList.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
  });
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

interface CreatePayload {
  fullName?: unknown;
  email?: unknown;
  role?: unknown;
  companyIds?: unknown;
  supervisorIds?: unknown;
  supervisorId?: unknown; // legacy single-supervisor callers
}

const MAX_SUPERVISORS = 4;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeadersFor(req) });
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const defaultPassword = Deno.env.get("DEFAULT_NEW_USER_PASSWORD");
    if (!supabaseUrl || !serviceKey) return json(req, { error: "Service credentials are not available." }, 503);
    if (!defaultPassword) return json(req, { error: "Default password is not configured." }, 503);

    // -------- caller authorization (robust to new JWT signing keys) ----------
    const authHeader = req.headers.get("Authorization") ?? "";
    const callerJwt = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!callerJwt) return json(req, { error: "Missing authorization." }, 401);

    const admin = createClient(supabaseUrl, serviceKey);
    const { data: callerUser, error: callerErr } = await admin.auth.getUser(callerJwt);
    if (callerErr || !callerUser?.user) return json(req, { error: "Not signed in." }, 401);

    const { data: callerProfile, error: profErr } = await admin
      .from("profiles").select("approved, role").eq("id", callerUser.user.id).single();
    if (profErr || !callerProfile) return json(req, { error: "Not authorized." }, 403);
    const callerRole = typeof callerProfile.role === "string" ? callerProfile.role.trim() : "";
    if (!callerProfile.approved || !MANAGER_ROLES.has(callerRole)) {
      return json(req, { error: "Not authorized to add people." }, 403);
    }

    // -------- input ----------------------------------------------------------
    const lenHeader = req.headers.get("content-length");
    if (lenHeader && Number(lenHeader) > MAX_PAYLOAD_BYTES) return json(req, { error: "Payload too large." }, 413);
    const raw = await req.text();
    if (raw.length > MAX_PAYLOAD_BYTES) return json(req, { error: "Payload too large." }, 413);

    let payload: CreatePayload;
    try { payload = JSON.parse(raw); } catch { return json(req, { error: "Invalid JSON body." }, 400); }

    const fullName = typeof payload.fullName === "string" ? payload.fullName.trim() : "";
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    const role = typeof payload.role === "string" ? payload.role.trim() : "";
    // Multiple supervisors (migration 073). Prefer the array; fall back to the
    // legacy single supervisorId. De-duped, trimmed, capped at MAX_SUPERVISORS.
    const supervisorIds = (Array.isArray(payload.supervisorIds)
      ? payload.supervisorIds
      : (typeof payload.supervisorId === "string" ? [payload.supervisorId] : []))
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .map((s) => s.trim());
    const uniqueSupervisorIds = [...new Set(supervisorIds)].slice(0, MAX_SUPERVISORS);
    const companyIds = Array.isArray(payload.companyIds)
      ? [...new Set(payload.companyIds.filter((c): c is string => typeof c === "string"))]
          .filter((c) => KNOWN_COMPANIES.has(c))
      : [];

    if (!fullName || fullName.length > 80) return json(req, { error: "A full name is required." }, 400);
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) return json(req, { error: "A valid email is required." }, 400);
    if (!ASSIGNABLE_ROLES.has(role)) return json(req, { error: "Pick a valid role." }, 400);

    // -------- reject duplicate ----------------------------------------------
    const existing = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
    if (existing.data) return json(req, { error: "That email already has an account." }, 409);

    // -------- create the Auth login (trigger creates profile + team_member) --
    const created = await admin.auth.admin.createUser({
      email,
      password: defaultPassword,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (created.error || !created.data?.user) {
      const msg = (created.error?.message ?? "").toLowerCase();
      if (msg.includes("already") && msg.includes("registered")) {
        return json(req, { error: "That email already has an account." }, 409);
      }
      console.error("[create-user] createUser failed", created.error);
      return json(req, { error: "Could not create the login." }, 500);
    }
    const newId = created.data.user.id;

    // -------- approve + set role/company/supervisor on the profile -----------
    // handle_new_user() (the on_auth_user_created trigger) just inserted the
    // profile (approved=false, role='worker') and the team_members row. Promote
    // it; the sync triggers (045/039) propagate company_ids/full_name and flip
    // team_members.active to true.
    // Write supervisor_ids (migration 073); the DB sync trigger derives the
    // scalar supervisor_id = supervisor_ids[1]. Requires 073 to be applied.
    const updated = await admin.from("profiles")
      .update({ approved: true, role, full_name: fullName, company_ids: companyIds, supervisor_ids: uniqueSupervisorIds })
      .eq("id", newId)
      .select("member_id")
      .maybeSingle();
    if (updated.error || !updated.data) {
      console.error("[create-user] profile promote failed", updated.error);
      // Best-effort cleanup so a half-created account doesn't linger.
      await admin.auth.admin.deleteUser(newId).catch(() => {});
      return json(req, { error: "Login created but could not be set up. Ensure the new-user trigger (migration 029) is installed." }, 500);
    }
    const memberId = (updated.data as { member_id: string | null }).member_id;

    // -------- welcome email (non-fatal) -------------------------------------
    let emailSent = false;
    const apiKey = Deno.env.get("RESEND_API_KEY");
    const from = Deno.env.get("EMAIL_FROM") ?? "Quest HQ <onboarding@resend.dev>";
    const appUrl = Deno.env.get("APP_URL") ?? "";
    if (apiKey) {
      try {
        const linkLine = appUrl
          ? `<p>Sign in here: <a href="${esc(appUrl)}">${esc(appUrl)}</a></p>`
          : "";
        const html =
          `<p>Hi ${esc(fullName)},</p>` +
          `<p>An account has been created for you on Quest HQ.</p>` +
          `<p><strong>Email:</strong> ${esc(email)}<br/>` +
          `<strong>Temporary password:</strong> ${esc(defaultPassword)}</p>` +
          linkLine +
          `<p>Please change your password after signing in (Profile &rarr; New password).</p>`;
        const res = await fetch(RESEND_ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from, to: [email], subject: "Your Quest HQ account", html }),
        });
        emailSent = res.ok;
        if (!res.ok) console.error("[create-user] email send rejected", res.status);
      } catch (e) {
        console.error("[create-user] email send threw", e);
      }
    }

    return json(req, { ok: true, profileId: newId, memberId, emailSent });
  } catch (err) {
    console.error("[create-user] uncaught", err);
    return json(req, { error: "Internal error." }, 500);
  }
});
