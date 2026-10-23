import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, AppError } from '../lib/store.js';
import { Workflow } from '../lib/workflow.js';
import { DemoXhs, DemoModel } from '../lib/demo.js';
import { XhsClient } from '../lib/xhs.js';
import { Fish } from '../lib/fish/service.js';
import { FISH_DEFAULTS, validateFishConfig } from '../lib/fish/config.js';

const uid = '111111111111111111111111';
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-visit-'));
  const store = new Store(dir); store.state.config.sendingEnabled = true;
  const xhs = new DemoXhs(); xhs.profileCalls = []; xhs.sent = []; xhs.likes = [];
  xhs.profile = async id => { xhs.profileCalls.push(id); return (await xhs.search('作品')).slice(0, 3).map(n => ({ ...n, author: { id, name: '评论者' } })); };
  const detail = xhs.detail.bind(xhs);
  xhs.detail = async c => ({ ...await detail(c), publishedAt: c.id === 'demo-2' ? '2026-10-23T00:00:00Z' : '2026-10-01T00:00:00Z' });
  xhs.send = async (draft, note) => { xhs.sent.push({ draft, note }); return { success: true, comment_id: `sent-${xhs.sent.length}` }; };
  xhs.replyByNotification = async (commentId, content) => xhs.send({ commentId, content }, {});
  xhs.like = async note => { xhs.likes.push(note.id); return { success: true }; };
  const workflow = new Workflow(store, { clients: () => ({ xhs, model: new DemoModel() }) });
  let draws = 0;
  const fish = new Fish({ dataDir: dir, workflow, random: () => { draws++; return 0; } });
  fish.saveConfig({ reply: { strangerPolicy: 'direct' } });
  const item = { id: 'notification', type: 'comment/item', from: { id: uid, name: '评论者' },
    comment: { id: 'c1', text: '小鲸鱼好可爱' }, feed: { id: 'my-note', token: 'note-token', title: '鲸鱼介绍' } };
  fish.saveState({ ...fish.state(), selfId: 'demo-user', inbox: [item] });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, workflow, xhs, fish, item, draws: () => draws };
}

test('confirmed reply offers a visit; visit reads newest work and never publishes by itself', async t => {
  const f = await fixture(t);
  await f.fish.reply({ commentId: 'c1', content: '尾巴都被夸翘起来了', dry: true });
  assert.equal(f.draws(), 0);
  const reply = await f.fish.reply({ commentId: 'c1', content: '尾巴都被夸翘起来了' });
  assert.equal(reply.revisit.eligible, true); assert.equal(f.draws(), 1);
  assert.equal(f.fish.pendingVisits().items.length, 1);
  const result = await f.fish.visit({ commentId: 'c1' });
  assert.equal(result.visited, true);
  assert.equal(result.notes[0].noteId, 'demo-2');
  assert.equal(result.notes.filter(n => n.reading).length, 1);
  assert.deepEqual(f.xhs.profileCalls, [uid]);
  assert.equal(f.xhs.sent.length, 1); assert.equal(f.xhs.likes.length, 0);
  assert.equal(f.fish.pendingVisits().items.length, 0);
  assert.equal((await f.fish.visit({ commentId: 'c1' })).visited, false);
  assert.equal(f.xhs.profileCalls.length, 1);
  const prepared = f.fish.prepareVisit({ runId: result.runId, noteId: 'demo-2', content: '主人，本鲸看到这个，尾巴已经开始摇了，你要不要也来看看？', mentionOwner: true });
  assert.equal(prepared.task.status, 'pending_manual');
  assert.equal(prepared.manualOnly, true);
  assert.equal(prepared.task.mentionOwner, true);
  assert.match(f.fish.state().notices[0].text, /候选列表手动选择主人账号/);
  assert.match(f.fish.state().notices[0].text, /未添加提及/);
  assert.throws(() => f.fish.prepareVisit({ mentionOwner: 'true' }), /布尔值/);
  assert.equal(f.fish.manualVisitTasks().items.length, 1);
  assert.match(f.fish.state().notices[0].text, /手动完成/);
  assert.match(f.fish.readDiary({}).content, /未点赞、未发送/);
  const notices = f.fish.state().notices.length;
  assert.equal(f.fish.prepareVisit({ runId: result.runId, noteId: 'demo-2', content: '重复调用' }).already, true);
  assert.equal(f.fish.state().notices.length, notices);
  await assert.rejects(f.fish.like({ noteId: 'demo-2' }), /不自动点赞/);
  await assert.rejects(f.fish.comment({ noteId: 'demo-2', content: '不应发出', mentionOwner: false }), /手动完成/);
  const draft = await f.workflow.addDraft({ note: f.workflow.note(result.runId, 'demo-2').note, content: '旧草稿也不能自动发' });
  await assert.rejects(f.workflow.send(draft.id, { confirm: true, revision: draft.revision, content: draft.content }), /禁止自动发送/);
  assert.deepEqual(f.xhs.likes, []);
  assert.equal(f.xhs.sent.length, 1);
  assert.throws(() => f.fish.prepareVisit({ runId: result.runId, noteId: 'demo-1', content: '没有精读' }), /已精读/);
  f.fish.saveState({ ...f.fish.state(), selfId: 'different-account' });
  assert.equal(f.fish.manualVisitTasks().items.length, 0);
  assert.throws(() => f.fish.prepareVisit({ runId: result.runId, noteId: 'demo-2', content: '不属于我' }), /账号/);
});

test('same person gets one reserved visit in cooldown, with one draw per comment', async t => {
  const f = await fixture(t);
  await f.fish.reply({ commentId: 'c1', content: '谢谢来捞本鲸' });
  const state = f.fish.state(); state.inbox.push({ ...f.item, id: 'n2', comment: { id: 'c2', text: '再聊一句' } }); f.fish.saveState(state);
  const second = await f.fish.reply({ commentId: 'c2', content: '冒个泡' });
  assert.equal(second.revisit.eligible, false);
  assert.match(second.revisit.reason, /冷却/);
  assert.equal(f.draws(), 1);
  assert.equal(f.fish.pendingVisits().items.length, 1);
});

test('probability zero, draft-only policy, and uncertain send never produce visit work', async t => {
  const f = await fixture(t);
  f.fish.saveConfig({ visit: { chance: 0 } });
  assert.equal((await f.fish.reply({ commentId: 'c1', content: '冒泡' })).revisit.eligible, false);
  assert.equal(f.fish.pendingVisits().items.length, 0);
  const g = await fixture(t); g.fish.saveConfig({ reply: { strangerPolicy: 'draft' } });
  await g.fish.reply({ commentId: 'c1', content: '先写草稿' });
  assert.equal(g.draws(), 0); assert.equal(g.fish.pendingVisits().items.length, 0);
  const h = await fixture(t);
  h.xhs.send = async () => { throw Object.assign(new AppError('结果未确定'), { delivery: 'uncertain' }); };
  await assert.rejects(h.fish.reply({ commentId: 'c1', content: '冒泡' }));
  assert.equal(h.draws(), 0); assert.equal(h.fish.pendingVisits().items.length, 0);
});

test('visit requires a confirmed reply and its own account; wrong authors stop reading', async t => {
  const f = await fixture(t);
  await assert.rejects(f.fish.visit({ commentId: 'c1' }), /已经回复/);
  await f.fish.reply({ commentId: 'c1', content: '冒泡' });
  f.xhs.login = async () => ({ is_logged_in: true, user_id: 'other-account' });
  assert.equal((await f.fish.visit({ commentId: 'c1' })).visited, false);
  assert.equal(f.xhs.profileCalls.length, 0);
  f.xhs.login = async () => ({ is_logged_in: true, user_id: 'demo-user' });
  f.xhs.detail = async c => ({ ...c, author: { id: 'wrong-author' } });
  await assert.rejects(f.fish.visit({ commentId: 'c1' }), /作者/);
  assert.equal(f.workflow.store.state.runs[0].notes.length, 0);
  assert.equal(f.xhs.sent.length, 1);
  assert.equal((await f.fish.visit({ commentId: 'c1' })).visited, false);
});

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

test('visit defaults and settings round-trip without resetting the wake minimum', () => {
  assert.equal(FISH_DEFAULTS.visit.chance, 0.3);
  const cfg = validateFishConfig({ visit: { enabled: true, chance: 0.2, cooldownHours: 48 } });
  assert.deepEqual(cfg.visit, { enabled: true, chance: 0.2, cooldownHours: 48 });
  assert.equal(cfg.night.minWakesPerWindow, 1);
  assert.throws(() => validateFishConfig({ visit: { chance: 2 } }), /概率/);
});
