# Clock-Aware Check-ins — Design

Date: 2026-07-16
Status: Approved (brainstorm complete)

## Problem

The `checkins` engine (see `2026-07-15-ai-proactive-checkins-design.md`) fires the
**morning** recap at a fixed 08:00 HQ and the **end-of-day** recap at 16:00 HQ,
to **every approved member, every day** — regardless of whether that person is
clocked in, scheduled, or working at all that day. For a part-time / variable-hours
worker this is wrong twice: wrong time of day, and it fires on days off.

Live fact at design time: only **3 of 18** members have clocked in within 14 days
(`info`, `eugenioiromanjuan`, `tagalaingrid07`). A strictly clock-driven rule would
silence the other 15. So the fix must degrade gracefully.

The **stalled** nudge is time-agnostic and unchanged.

## Approach: hybrid, clock-driven with a fixed fallback

Each run classifies every person, then routes their morning/EOD recap:

- **Clocker** — clocked in at least once in the last **14 days**. Morning/EOD follow
  their actual clock. On a day they don't clock in, they get **nothing** (the
  intended "skip days off" behavior).
- **Fixed** — no clock history in 14 days. Keeps today's behavior exactly: morning
  at 08:00 HQ, EOD at 16:00 HQ, every day.

One person clocking in once flips them to clock-driven automatically; a clocker who
stops using timers for 14 days reverts to fixed. No per-person configuration.

## Triggers (engine still wakes every 30 min via pg_cron)

| Recap   | Clocker fires when…                                             | Fixed fires when…     |
|---------|----------------------------------------------------------------|-----------------------|
| morning | first clock-in of the HQ day detected (≤30 min after clock-in) | HQ hour == 8          |
| eod     | clocked out AND no active timer for ≥ `eod_idle_minutes` (90)  | HQ hour == 16         |
| stalled | unchanged (weekly, everyone)                                   | unchanged             |

Still **once per person per day** via the existing `checkin_log` dedupe
(`kind, subject, period=dateKey`), so multiple clock-outs across a day cannot
double-send. Notes:

- **Lunch break:** clock-out then clock back in within 90 min never trips EOD.
- **Forgot to clock out:** the existing auto-clock-out closes the timer, writing a
  `time_entries` row; the 90-min idle window starts from its `end_at`, so EOD still
  lands, just later.
- **Timer still running at day's end:** the person hasn't "ended" — no EOD yet.
  Correct.
- A clocker who never clocks in on a given day gets neither recap that day.

## Data sources (both keyed by member id — confirmed)

- `active_timers(user_id, started_at, …)` — who is clocked in right now.
- `time_entries(user_id, start_at, end_at, …)` — completed shifts.

"Clock activity today" = an `active_timers` row OR a `time_entries` row whose
`start_at` is on the current HQ date. "Clocker" (routing) = any `time_entries.start_at`
or `active_timers.started_at` within the last 14 days.

## Settings / data model

- Add `eod_idle_minutes integer not null default 90` to `checkin_settings`
  (migration `072`). Editable on the Check-ins admin page beside `stalled_days`.
- The 14-day clocker window is a fixed constant (`CLOCKER_WINDOW_DAYS = 14`) — not a knob.
- No new tables.

## Code shape (keep decisions in pure, unit-tested functions)

New pure helpers in `lib/schedule.mjs` (imported by `index.ts`, tested by
`tests/unit/checkin-schedule.test.mjs` with `node --test`):

- `isClocker(clockRows, nowMs, windowDays)` → boolean — any clock activity in window.
- `clockedInToday(clockRows, nowMs)` → boolean — first clock-in of the HQ day happened.
- `eodReady(entries, activeTimer, nowMs, idleMinutes)` → boolean — clocked out and
  idle ≥ threshold (false while a timer is active).

`index.ts` loads the two clock tables once per run, groups rows by `user_id`, and for
each member decides `morning`/`eod` due-ness via the helper (clocker) or `firesNow`
(fixed). Delivery, dedupe, content, and the stalled branch are unchanged.

## Failure behavior

If the clock tables error or a clocker has no data today, that person simply gets no
recap (treated as "not working today") — never a crash, never a broadcast. Same
best-effort bell+email and claim-before-send dedupe as today.

## Testing

- Pure `node --test` cases for `isClocker` (in/out of window, empty), `clockedInToday`
  (active timer, entry today, none), `eodReady` (active timer → false; idle < / ≥
  threshold; lunch-break re-clock-in; auto-clock-out entry).
- Deploy from repo source via Supabase MCP; controlled single-person live check as
  before (temporary secret-gated test hook, then redeploy clean).

## Out of scope

Per-person schedules; night shifts crossing HQ midnight; changing the stalled or
fixed-time behavior; any client change beyond the one `eod_idle_minutes` field.
