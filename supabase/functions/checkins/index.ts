// supabase/functions/checkins/index.ts
// checkins — scheduled (pg_cron) Edge Function that sends AI-written, one-way
// check-ins (morning recap, end-of-day recap, weekly-capped stalled nudge) to
// the in-app bell + email. Runs under the service role; gated by a shared
// secret (x-checkins-secret; Verify JWT must be OFF). Deployed from repo source
// (index.ts + lib/*.mjs) via the Supabase MCP — never a paste bundle.
//
// Secrets: CHECKINS_SECRET, GROQ_API_KEY, RESEND_API_KEY, EMAIL_FROM
//   (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { firesNow, hqParts, weekKey, isClocker, clockedInToday, eodReady, CLOCKER_WINDOW_DAYS } from "./lib/schedule.mjs";
import { stalledByPerson, taskAssignees } from "./lib/stalled.mjs";
import {
  morningContext, eodContext, shapeMessage,
  fallbackMorning, fallbackEod, stalledText, MODE_SUBJECT,
  MODE_ROUTE, MODE_CTA_LABEL,
} from "./lib/content.mjs";

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const RESEND_ENDPOINT = "https://api.resend.com/emails";
const MAX_TASKS = 2000;

function esc(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

// Build the email CTA href. APP_URL is a PROJECT-WIDE secret shared with
// create-user, which uses it as the SITE ROOT (the sign-in link). The bell's
// hash routes only resolve on the SPA entry (app.html), so normalize whatever
// APP_URL holds — bare root, trailing slash, or already app.html — to the
// app.html base, then append the mode's `#/...` route.
function appHref(base: string, route: string): string {
  let b = base.trim().replace(/\/+$/, "");        // drop trailing slash(es)
  if (!/app\.html$/i.test(b)) b += "/app.html";   // ensure the SPA entry point
  return b + route;                                // route already starts with '#'
}

// Ask Groq to reword `fallback` around `contextLines`; degrade to the fallback.
async function wording(groqKey: string | undefined, sys: string, contextLines: string[], fallback: string): Promise<string> {
  if (!groqKey) return fallback;
  try {
    const res = await fetch(GROQ_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${groqKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GROQ_MODEL, temperature: 0.4, max_tokens: 220,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: contextLines.join("\n") || "(no items)" },
        ],
      }),
    });
    if (!res.ok) { console.error("[checkins] groq rejected", res.status); return fallback; }
    const data = await res.json().catch(() => ({}));
    return shapeMessage(data?.choices?.[0]?.message?.content ?? "", fallback).text;
  } catch (e) {
    console.error("[checkins] groq threw", e);
    return fallback;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });

  const secret = Deno.env.get("CHECKINS_SECRET");
  if (!secret || req.headers.get("x-checkins-secret") !== secret) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return new Response(JSON.stringify({ error: "server misconfigured" }), { status: 500 });

  const db = createClient(supabaseUrl, serviceKey);
  const groqKey = Deno.env.get("GROQ_API_KEY");
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("EMAIL_FROM") ?? "Quest HQ <onboarding@resend.dev>";
  // Absolute app base for the email CTA button (e.g. https://<prod>/app.html).
  // Unset → the button is omitted and the email degrades to text (never a broken
  // link). The in-app bell renders its own CTA and needs nothing here.
  const appUrl = Deno.env.get("APP_URL");
  const now = Date.now();
  const { dateKey } = hqParts(now);

  // Settings gate. Recaps (morning/eod) are now per-person clock-driven, so their
  // firing can't be decided globally up front; only stalled keeps a fixed window.
  const setRes = await db.from("checkin_settings").select("*").eq("id", 1).single();
  const cfg = setRes.data ?? { morning_enabled: false, eod_enabled: false, stalled_enabled: false, stalled_days: 3, eod_idle_minutes: 90 };
  const idleMinutes = Number(cfg.eod_idle_minutes) > 0 ? Number(cfg.eod_idle_minutes) : 90;
  const doRecaps = !!(cfg.morning_enabled || cfg.eod_enabled);
  const doStalled = !!cfg.stalled_enabled && firesNow("stalled", now);
  // Nothing could fire on this tick: no recap modes on AND stalled not in its window.
  if (!doRecaps && !doStalled) return new Response(JSON.stringify({ ok: true, scanned: 0, sent: 0, errors: [] }), { headers: { "Content-Type": "application/json" } });

  // Recipients: members with an email/id.
  const memRes = await db.from("team_members").select("id, email");
  const emailById = new Map<string, string>();
  const memberIds: string[] = [];
  (memRes.data ?? []).forEach((m: any) => { memberIds.push(m.id); if (m.email) emailById.set(m.id, String(m.email).trim()); });

  // Clock data (only needed for recaps): who's a clocker, who clocked in today,
  // and who has clocked out for the day. Keyed by member id (user_id == member id).
  const startsByUser = new Map<string, number[]>();  // clock-in instants (active + entries)
  const endsByUser = new Map<string, number[]>();     // clock-out instants (entry end_at)
  const activeNow = new Set<string>();                 // currently clocked in
  if (doRecaps) {
    // Push a parsed timestamp onto a per-user list, skipping junk/nulls.
    const push = (map: Map<string, number[]>, id: string, v: string | null) => {
      const ms = v ? Date.parse(v) : NaN;
      if (!id || Number.isNaN(ms)) return;
      const list = map.get(id) ?? [];
      list.push(ms);
      map.set(id, list);
    };
    const [atRes, teRes] = await Promise.all([
      db.from("active_timers").select("user_id, started_at"),
      db.from("time_entries").select("user_id, start_at, end_at")
        .gte("start_at", new Date(now - CLOCKER_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()),
    ]);
    // Clock-table read failures degrade to "no clock data" (clockers just get no
    // recap this tick) rather than crashing or blasting — logged, not fatal.
    if (atRes.error) console.error("[checkins] active_timers load failed", atRes.error);
    if (teRes.error) console.error("[checkins] time_entries load failed", teRes.error);
    (atRes.data ?? []).forEach((r: any) => { if (r.user_id) { activeNow.add(r.user_id); push(startsByUser, r.user_id, r.started_at); } });
    (teRes.data ?? []).forEach((r: any) => { push(startsByUser, r.user_id, r.start_at); push(endsByUser, r.user_id, r.end_at); });
  }

  // All tasks (RLS bypassed; we filter per person in code).
  const taskRes = await db.from("tasks")
    .select("id, title, company_id, due, status, completed_at, updated_at, assignee_id, assignee_ids")
    .limit(MAX_TASKS);
  if (taskRes.error) { console.error("[checkins] task load failed", taskRes.error); return new Response(JSON.stringify({ error: "task load failed" }), { status: 500 }); }
  const tasks = taskRes.data ?? [];

  const errors: string[] = [];
  let sent = 0;

  // Deliver one message: claim dedupe row, then bell + email (best-effort).
  async function deliver(kind: string, person: string, period: string, subject: string, body: string, taskId: string | null) {
    const claim = await db.from("checkin_log")
      .upsert({ kind, subject: person, period }, { onConflict: "kind,subject,period", ignoreDuplicates: true })
      .select();
    if (claim.error) { errors.push(`log ${kind}/${person}: ${claim.error.message}`); return; }
    if (!claim.data || claim.data.length === 0) return; // already sent this period

    const html = String(body).split("\n").map((l) => `<p>${esc(l)}</p>`).join("");
    const notif = await db.from("notifications").insert({
      id: crypto.randomUUID(), member_id: person, task_id: taskId,
      meta: `Check-in · ${subject}`, html, read: false,
    });
    if (notif.error) errors.push(`notif ${kind}/${person}: ${notif.error.message}`);

    if (apiKey && emailById.has(person)) {
      // Deep-link CTA button (email-only; the bell renders its own). `kind` is
      // the mode; omit the button if APP_URL / the mode's route is missing.
      const route = MODE_ROUTE[kind];
      const label = MODE_CTA_LABEL[kind];
      const btn = (appUrl && route && label)
        ? `<p style="margin:16px 0"><a href="${esc(appHref(appUrl, route))}" style="display:inline-block;background:#ED4E0D;color:#ffffff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px;font-family:Arial,sans-serif;font-size:14px">${esc(label)} &rarr;</a></p>`
        : "";
      try {
        const r = await fetch(RESEND_ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from, to: [emailById.get(person)], subject, html: `${html}${btn}<p style="color:#888;font-size:12px">Quest HQ check-in</p>` }),
        });
        if (!r.ok) errors.push(`email ${kind}/${person}: ${r.status}`);
      } catch (e) { errors.push(`email ${kind}/${person}: ${String(e)}`); }
    }
    sent++;
  }

  // Is a recap due for this person on this tick? Clockers follow their clock;
  // everyone else keeps the fixed 8am/4pm window (firesNow).
  function recapDue(mode: "morning" | "eod", person: string): boolean {
    const starts = startsByUser.get(person) ?? [];
    if (isClocker(starts, now)) {
      return mode === "morning"
        ? clockedInToday(starts, now)
        : eodReady(endsByUser.get(person) ?? [], activeNow.has(person), now, idleMinutes);
    }
    return firesNow(mode, now);
  }

  // --- Recap modes (morning / eod): one message per person per day. ---
  const recapModes = ([["morning", cfg.morning_enabled], ["eod", cfg.eod_enabled]] as const)
    .filter(([, on]) => on).map(([m]) => m);
  for (const mode of recapModes) {
    for (const person of memberIds) {
      if (!recapDue(mode, person)) continue;
      const mine = tasks.filter((t: any) => taskAssignees(t).includes(person));
      const ctx = mode === "morning" ? morningContext(mine, { today: dateKey }) : eodContext(mine, { today: dateKey });
      // Skip a person with nothing to say (no open work / no activity).
      if (!ctx.lines.length && (mode === "morning" ? ctx.counts.total === 0 : ctx.counts.done === 0 && ctx.counts.open === 0)) continue;
      const fallback = mode === "morning" ? fallbackMorning(ctx) : fallbackEod(ctx);
      const sys = mode === "morning"
        ? "You write a 2-sentence morning check-in for a worker from the task lines given. State what's overdue or due today and end on a brief, plain statement — do NOT ask a question (the app shows a 'Set today's focus' button). Plain text, no markdown, no emojis. Only reference the given tasks."
        : "You write a 2-sentence end-of-day check-in from the task lines given. Note what got done and what slipped, then end on a brief, plain statement — do NOT ask a question (the app shows a 'Review today' button). Plain text, no markdown, no emojis.";
      const body = await wording(groqKey, sys, ctx.lines, fallback);
      await deliver(mode, person, dateKey, MODE_SUBJECT[mode], body, null);
    }
  }

  // --- Stalled mode: one grouped message per person per week. ---
  if (doStalled) {
    const period = weekKey(dateKey);
    const byPerson = stalledByPerson(tasks, { nowMs: now, stalledDays: cfg.stalled_days ?? 3 });
    for (const [person, items] of byPerson) {
      const fallback = stalledText(items);
      const sys = "You write a short, friendly nudge listing a worker's stalled tasks (given as lines) and ask if they're still moving. Keep the task titles. Plain text, no markdown, no emojis.";
      const body = await wording(groqKey, sys, items.map((x: any) => `- ${x.title}`), fallback);
      await deliver("stalled", person, period, MODE_SUBJECT.stalled, body, items[0]?.id ?? null);
    }
  }

  return new Response(JSON.stringify({ ok: true, scanned: tasks.length, sent, errors: errors.slice(0, 20) }), { headers: { "Content-Type": "application/json" } });
});
