// supabase/functions/checkins/lib/schedule.mjs
// Pure HQ-time scheduling helpers for the checkins engine. HQ = America/Phoenix,
// fixed UTC-7 (no DST): HQ wall-clock = UTC shifted back 7 hours. No I/O.

export const MODE_HOUR = { morning: 8, eod: 16, stalled: 9 };

// UTC instant -> HQ calendar parts. Subtract 7h, then read UTC fields.
export function hqParts(nowMs) {
  const d = new Date(nowMs - 7 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const pad = (n) => String(n).padStart(2, '0');
  return { y, m, d: day, hour: d.getUTCHours(), minute: d.getUTCMinutes(),
    dateKey: `${y}-${pad(m)}-${pad(day)}` };
}

// HQ-Monday of the week containing dateKey (YYYY-MM-DD), via UTC math.
export function weekKey(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const dt = new Date(Date.UTC(y || 1970, (m || 1) - 1, d || 1));
  const dow = dt.getUTCDay();             // 0 Sun .. 6 Sat
  const diff = dow === 0 ? -6 : 1 - dow;  // shift back to Monday
  dt.setUTCDate(dt.getUTCDate() + diff);
  return dt.toISOString().slice(0, 10);
}

export function firesNow(mode, nowMs) {
  const hour = MODE_HOUR[mode];
  if (hour == null) return false;
  return hqParts(nowMs).hour === hour;
}

// --- Clock-aware timing (part-time / variable-hours workers) -----------------
// A "clocker" has recent clock activity, so their morning/EOD recaps follow their
// actual clock-in/out instead of the fixed 8am/4pm. Someone with no recent clock
// activity is treated as "fixed" and keeps firesNow() timing. All pure, no I/O.

const DAY_MS = 24 * 60 * 60 * 1000;
export const CLOCKER_WINDOW_DAYS = 14;

// Accept ms numbers or ISO strings; NaN for anything unparseable.
function toMs(v) {
  if (v == null) return NaN;
  return typeof v === 'number' ? v : Date.parse(v);
}

// Any clock activity within `windowDays` of now → route this person clock-first.
export function isClocker(timestamps, nowMs, windowDays = CLOCKER_WINDOW_DAYS) {
  const cutoff = nowMs - windowDays * DAY_MS;
  return (timestamps || []).some((t) => {
    const ms = toMs(t);
    return !Number.isNaN(ms) && ms >= cutoff;
  });
}

// Did a clock-in land on the current HQ calendar day? (fires the morning recap)
export function clockedInToday(startTimestamps, nowMs) {
  const today = hqParts(nowMs).dateKey;
  return (startTimestamps || []).some((t) => {
    const ms = toMs(t);
    return !Number.isNaN(ms) && hqParts(ms).dateKey === today;
  });
}

// Clocked out for the day: no active timer, worked today, and the most recent
// clock-out today was at least `idleMinutes` ago. A lunch break (short gap, or a
// re-clock-in that leaves a timer active) never trips it. (fires the EOD recap)
export function eodReady(endTimestamps, hasActiveTimer, nowMs, idleMinutes) {
  if (hasActiveTimer) return false;
  const today = hqParts(nowMs).dateKey;
  const endsToday = (endTimestamps || [])
    .map(toMs)
    .filter((ms) => !Number.isNaN(ms) && hqParts(ms).dateKey === today);
  if (!endsToday.length) return false;
  const lastEnd = Math.max(...endsToday);
  return nowMs - lastEnd >= idleMinutes * 60 * 1000;
}
