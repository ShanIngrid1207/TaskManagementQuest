// tests/unit/checkin-schedule.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hqParts, weekKey, firesNow, MODE_HOUR,
  isClocker, clockedInToday, eodReady, CLOCKER_WINDOW_DAYS,
} from '../../supabase/functions/checkins/lib/schedule.mjs';

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
// 2026-07-15 18:00 UTC = 11:00 HQ (UTC-7), dateKey 2026-07-15.
const NOW = Date.UTC(2026, 6, 15, 18, 0);
const TODAY_9HQ = Date.UTC(2026, 6, 15, 16, 0);   // 09:00 HQ, today
const YESTERDAY_9HQ = Date.UTC(2026, 6, 14, 16, 0); // 09:00 HQ, 2026-07-14

// 2026-07-15 is a Wednesday. 15:00 UTC = 08:00 HQ (UTC-7).
const AUG_MORNING = Date.UTC(2026, 6, 15, 15, 30); // 08:30 HQ
const AUG_EOD = Date.UTC(2026, 6, 15, 23, 5);      // 16:05 HQ
const AUG_NOON = Date.UTC(2026, 6, 15, 19, 0);     // 12:00 HQ

test('hqParts converts UTC to HQ wall clock and date', () => {
  const p = hqParts(AUG_MORNING);
  assert.equal(p.hour, 8);
  assert.equal(p.minute, 30);
  assert.equal(p.dateKey, '2026-07-15');
});

test('hqParts rolls the date back across the UTC-7 midnight boundary', () => {
  // 2026-07-15 03:00 UTC = 2026-07-14 20:00 HQ.
  const p = hqParts(Date.UTC(2026, 6, 15, 3, 0));
  assert.equal(p.dateKey, '2026-07-14');
  assert.equal(p.hour, 20);
});

test('weekKey returns the HQ-Monday of the week', () => {
  // Wed 2026-07-15 -> Monday 2026-07-13.
  assert.equal(weekKey('2026-07-15'), '2026-07-13');
  // Sunday 2026-07-19 -> Monday 2026-07-13 (Sunday belongs to the week that started Mon 13).
  assert.equal(weekKey('2026-07-19'), '2026-07-13');
});

test('firesNow matches each mode to its HQ hour band', () => {
  assert.equal(firesNow('morning', AUG_MORNING), true);
  assert.equal(firesNow('eod', AUG_MORNING), false);
  assert.equal(firesNow('eod', AUG_EOD), true);
  assert.equal(firesNow('morning', AUG_NOON), false);
  assert.equal(MODE_HOUR.stalled, 9);
});

test('CLOCKER_WINDOW_DAYS default is 14', () => {
  assert.equal(CLOCKER_WINDOW_DAYS, 14);
});

test('isClocker: any activity inside the window makes a clocker', () => {
  assert.equal(isClocker([NOW - 3 * DAY], NOW, 14), true);        // 3 days ago
  assert.equal(isClocker([NOW - 20 * DAY], NOW, 14), false);      // 20 days ago
  assert.equal(isClocker([], NOW, 14), false);                    // never clocked in
  assert.equal(isClocker([null, 'not-a-date'], NOW, 14), false);  // junk ignored
  // ISO strings parse too
  assert.equal(isClocker([new Date(NOW - DAY).toISOString()], NOW, 14), true);
});

test('clockedInToday: true only when a clock-in lands on the HQ date', () => {
  assert.equal(clockedInToday([TODAY_9HQ], NOW), true);
  assert.equal(clockedInToday([YESTERDAY_9HQ], NOW), false);
  assert.equal(clockedInToday([], NOW), false);
  // an active timer started today counts (its started_at is in the list)
  assert.equal(clockedInToday([YESTERDAY_9HQ, TODAY_9HQ], NOW), true);
});

test('eodReady: false while a timer is still active', () => {
  assert.equal(eodReady([NOW - 120 * MIN], true, NOW, 90), false);
});

test('eodReady: needs clock-out today AND idle >= threshold', () => {
  // stopped 30 min ago, threshold 90 -> still "on a break"
  assert.equal(eodReady([NOW - 30 * MIN], false, NOW, 90), false);
  // stopped 100 min ago -> done for the day
  assert.equal(eodReady([NOW - 100 * MIN], false, NOW, 90), true);
});

test('eodReady: uses the LATEST clock-out today (lunch then afternoon)', () => {
  // out at 3h ago (lunch), out again 20 min ago -> latest is 20 min -> not ready
  assert.equal(eodReady([NOW - 180 * MIN, NOW - 20 * MIN], false, NOW, 90), false);
});

test('eodReady: auto-clock-out entry from earlier today still lands EOD', () => {
  assert.equal(eodReady([NOW - 200 * MIN], false, NOW, 90), true);
});

test('eodReady: no clock-out today -> no EOD (day off / only older work)', () => {
  assert.equal(eodReady([YESTERDAY_9HQ], false, NOW, 90), false);
  assert.equal(eodReady([], false, NOW, 90), false);
});
