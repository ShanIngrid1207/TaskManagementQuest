-- 072: eod_idle_minutes — how long a clocker must be clocked out (no active timer)
-- before the end-of-day recap fires. Lets a lunch break not trip EOD. Only applies
-- to clock-driven workers; fixed-time members still get EOD at 16:00 HQ.
-- See docs/superpowers/specs/2026-07-16-checkins-clock-aware-design.md.

alter table public.checkin_settings
  add column if not exists eod_idle_minutes integer not null default 90;
