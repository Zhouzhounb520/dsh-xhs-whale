import test from 'node:test';
import assert from 'node:assert/strict';
import { XhsClient } from '../lib/xhs.js';
import { FISH_DEFAULTS, validateFishConfig } from '../lib/fish/config.js';
const uid = '111111111111111111111111';

test('profile client keeps only owned token-bearing notes and does not invent a profile token', async () => {
  let body;
  const card = (id, author, token = 'note-token') => ({ id, xsecToken: token, noteCard: { title: id, user: { userId: author } } });
  const xhs = new XhsClient({ xhsUrl: 'http://127.0.0.1:18060' }, '', async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ success: true, data: { data: { feeds: [card('own', uid), card('other', 'other'), card('no-token', uid, '')] } } }));
  });
  const notes = await xhs.profile(uid);
  assert.deepEqual(notes.map(n => n.id), ['own']);
  assert.deepEqual(body, { user_id: uid, tab: 'note' });
  await assert.rejects(xhs.profile('bad-id'), /主页 ID/);
});

test('empty profile returns no notes while malformed profile data still fails', async () => {
  let data = { userBasicInfo: { nickname: 'visitor' }, feeds: null };
  const xhs = new XhsClient({ xhsUrl: 'http://127.0.0.1:18060' }, '', async () => new Response(
    JSON.stringify({ success: true, data: { data } })));
  assert.deepEqual(await xhs.profile(uid), []);
  data = { userBasicInfo: { nickname: 'visitor' } };
  await assert.rejects(xhs.profile(uid), /结构/);
  data = { feeds: null };
  await assert.rejects(xhs.profile(uid), /结构/);
});

test('profile deadline uses the manual-verification pause', async () => {
  let paused = false;
  const xhs = new XhsClient({ xhsUrl: 'http://127.0.0.1:18060' }, '', async () => new Response(
    JSON.stringify({ success: false, details: 'context deadline exceeded' }), { status: 500 }), { onVerification: () => { paused = true; } });
  await assert.rejects(xhs.profile(uid), e => e.code === 'XHS_VERIFICATION_REQUIRED');
  assert.equal(paused, true);
});

test('legacy chance and cooldown are retired; threshold rule preserves enabled and wake settings', () => {
  assert.deepEqual(FISH_DEFAULTS.visit, { enabled: true });
  const cfg = validateFishConfig({ visit: { enabled: true, chance: 0, cooldownHours: 720 } });
  assert.deepEqual(cfg.visit, { enabled: true });
  assert.equal(cfg.night.minWakesPerWindow, 1);
  assert.throws(() => validateFishConfig({ visit: { enabled: 'yes' } }), /回访开关/);
});
