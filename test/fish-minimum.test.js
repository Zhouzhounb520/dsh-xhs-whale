import test from 'node:test';
import assert from 'node:assert/strict';
import { computePlan, windowsOf } from '../lib/fish/clock.js';
import { FISH_DEFAULTS, validateFishConfig } from '../lib/fish/config.js';

const windows = [
  { start: '00:00', end: '02:00', wakes: 3 },
  { start: '12:00', end: '14:00', wakes: 3 },
  { start: '18:00', end: '20:00', wakes: 3 },
  { start: '20:00', end: '22:00', wakes: 3 },
];

test('each daily window gets a real wake even when every discretionary roll skips', () => {
  const cfg = { night: { windows, minWakesPerWindow: 1, skipChance: 1 } };
  let now = new Date('2026-10-22T16:00:00Z'), state = {};
  const wakes = [], skips = [];
  for (let i = 0; i < 20; i++) {
    const plan = computePlan({ cfg, state, now, random: () => 0 });
    if (plan.action === 'done') { state = plan; break; }
    assert.ok(plan.atMs < plan.windowEndMs);
    now = new Date(plan.atMs + 30_000);
    state = { ...plan, fired: true };
    if (plan.action === 'wake') {
      wakes.push(plan.window);
      state.woke = true;
      state.wakes++;
      state.usedCount[plan.window] = (state.usedCount[plan.window] || 0) + 1;
    } else skips.push(plan.window);
  }
  const labels = windowsOf(cfg).map(w => w.label);
  assert.deepEqual(wakes, labels);
  assert.deepEqual(skips, labels);
  assert.equal(state.action, 'done');
  assert.equal(state.wakes, 4);
  assert.equal(Object.keys(state.usedCount).length, 4, 'daily completion retains per-window counts');
  const tomorrow = computePlan({ cfg, state, now: new Date('2026-10-23T16:00:00Z'), random: () => 0 });
  assert.equal(tomorrow.action, 'wake');
  assert.equal(tomorrow.required, true);
  assert.deepEqual(tomorrow.usedCount, {});
});

test('legacy early done or skip cannot suppress a still-unmet minimum', () => {
  const cfg = { night: { windows, skipChance: 1 } };
  for (const action of ['done', 'skip']) {
    const state = { date: '2026-10-23', action, done: true, fired: true, wakes: 0, window: '00:00–02:00' };
    const plan = computePlan({ cfg, state, now: new Date('2026-10-22T16:40:00Z'), random: () => 0 });
    assert.equal(plan.action, 'wake');
    assert.equal(plan.window, '00:00–02:00');
  }
});

test('minimum supports multiple wakes, then permits skipping only that window', () => {
  const cfg = { night: { windows, minWakesPerWindow: 2, skipChance: 1 } };
  const state = { date: '2026-10-23', wakes: 1, usedCount: { '12:00–14:00': 1 } };
  const now = new Date('2026-10-23T04:10:00Z');
  assert.equal(computePlan({ cfg, state, now, random: () => 0 }).action, 'wake');
  state.wakes = 2; state.usedCount['12:00–14:00'] = 2;
  const skipped = computePlan({ cfg, state, now, random: () => 0 });
  assert.equal(skipped.action, 'skip');
  const next = computePlan({ cfg, state: { ...skipped, fired: true }, now, random: () => 0 });
  assert.equal(next.action, 'wake');
  assert.equal(next.window, '18:00–20:00');
});

test('cross-midnight tail is serviced before later daytime windows', () => {
  const cfg = { night: { windows: [{ start: '22:00', end: '02:00', wakes: 1 }, ...windows.slice(1)], skipChance: 1 } };
  const now = new Date('2026-10-22T16:30:00Z');
  const plan = computePlan({ cfg, now, random: () => 0.5 });
  assert.equal(plan.window, '22:00–02:00');
  assert.equal(plan.required, true);
  assert.ok(plan.atMs >= now.getTime() && plan.atMs < plan.windowEndMs);
});

test('minimum is configurable and cannot exceed any window maximum', () => {
  assert.equal(FISH_DEFAULTS.night.minWakesPerWindow, 1);
  const cfg = validateFishConfig({ night: { windows, minWakesPerWindow: 1 } });
  assert.equal(cfg.night.minWakesPerWindow, 1);
  assert.equal(cfg.night.skipChance, 0.3);
  assert.throws(() => validateFishConfig({ night: { minWakesPerWindow: 2 } }), /最低/);
  assert.equal(validateFishConfig({ night: { minWakesPerWindow: 0 } }).night.minWakesPerWindow, 0);
});
