import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, AppError } from '../lib/store.js';
import { Workflow } from '../lib/workflow.js';
import { DemoXhs, DemoModel } from '../lib/demo.js';
import { Fish } from '../lib/fish/service.js';
import { startFishDaemon } from '../lib/fish/daemon.js';

const uid = '111111111111111111111111';
const other = '222222222222222222222222';
const self = 'demo-user';

function notification(id, { userId = uid, noteId = 'own-1', type = 'comment/item', notificationId = id } = {}) {
  return { id: notificationId, type, time: 1780000000, from: { user_id: userId, nickname: '来访者' },
    comment_id: id, comment_text: '这个细节好可爱', feed_id: noteId, feed_xsec_token: 'token', feed_title: noteId };
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-auto-visit-'));
  const store = new Store(dir); store.state.config.sendingEnabled = true;
  const xhs = new DemoXhs(), model = new DemoModel();
  const calls = [], sent = [], likes = [], reads = [];
  let items = [], accountId = self;
  let profiles = [1, 2, 3, 4].map(n => ({ id: `work-${n}`, token: 'token', title: `作品${n}`, author: { id: uid, name: '来访者' } }));
  const details = new Map();
  xhs.login = async () => ({ is_logged_in: true, user_id: accountId });
  xhs.notifications = async () => ({ items, filtered: 0 });
  xhs.profile = async userId => { calls.push('profile:' + userId); return profiles; };
  xhs.detail = async candidate => {
    calls.push('detail:' + candidate.id);
    if (details.has(candidate.id)) return details.get(candidate.id);
    if (candidate.id.startsWith('own-') || candidate.id === 'someone-elses') return {
      ...candidate, author: { id: candidate.id === 'someone-elses' ? other : self }, commentsPartial: false,
      comments: items.filter(n => n.feed_id === candidate.id).map(n => ({ id: n.comment_id, text: n.comment_text,
        author: { id: n.from.user_id }, parentId: '' })),
    };
    return { ...candidate, author: { id: uid }, publishedAt: `2026-10-0${candidate.id.at(-1)}T00:00:00Z`,
      comments: [], body: '自己缝的鲸鱼挂件，里面也有小扣子。', images: [], imageCount: 0 };
  };
  xhs.previewComment = async () => { calls.push('preview'); return { stage: 'ready', dry: true }; };
  xhs.like = async note => { calls.push('like'); likes.push(note.id); return { success: true }; };
  xhs.send = async (draft, note) => { calls.push('send'); sent.push({ draft, note }); return { success: true, comment_id: 'sent-' + sent.length }; };
  model.rank = async () => { throw new Error('回访最新作品不应按分数筛选'); };
  model.read = async note => { reads.push(note.id); calls.push('read'); return { summary: '鲸鱼挂件，连里面都缝了扣子', points: ['小扣子'] }; };
  model.draft = async note => { calls.push('draft'); assert.ok(note.reading); return '连里面的小扣子都缝了，好细'; };
  const workflow = new Workflow(store, { clients: () => ({ xhs, model }) });
  const fish = new Fish({ dataDir: dir, workflow, random: () => { throw new Error('回访不能抽概率'); } });
  fish.saveConfig({ listen: { allDay: true }, reply: { strangerPolicy: 'draft' } });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, xhs, model, workflow, fish, calls, sent, likes, reads, details,
    setItems(value) { items = value; }, setAccount(value) { accountId = value; }, setProfiles(value) { profiles = value; },
    async scan(value) { items = value; return fish.scanInbox({ force: true }); },
    async qualify() { await this.scan([notification('c1'), notification('c2', { noteId: 'own-2' })]); return fish.pendingVisits().items[0]; } };
}

test('two unique comments accumulate across own posts and scans; others and duplicate notifications do not reset or inflate counts', async t => {
  const f = fixture(t);
  await f.scan([notification('c1')]);
  assert.equal(f.fish.pendingVisits().items.length, 0);
  await f.scan([notification('c1'), notification('other-c1', { userId: other })]);
  assert.equal(f.fish.pendingVisits().items.length, 0);
  await f.scan([notification('c1', { notificationId: 'duplicate-notification' }), notification('c2', { noteId: 'own-2' })]);
  assert.equal(f.fish.state().visitContacts[self + ':' + uid].count, 2);
  assert.equal(f.fish.pendingVisits().items.length, 1);
  await f.fish.scanInbox({ force: true });
  assert.equal(f.fish.state().visitContacts[self + ':' + uid].count, 2);
  const restarted = new Fish({ dataDir: f.dir, workflow: f.workflow });
  assert.equal(restarted.pendingVisits().items.length, 1);
  assert.equal(f.sent.length, 0);
});

test('mentions on another author, self comments and comments not actually loaded never qualify', async t => {
  const f = fixture(t);
  await f.scan([notification('c1', { noteId: 'someone-elses' }), notification('c2', { noteId: 'someone-elses' }),
    notification('self-c1', { userId: self }), notification('self-c2', { userId: self })]);
  assert.equal(f.fish.pendingVisits().items.length, 0);
  assert.deepEqual(f.fish.state().visitContacts, {});
  f.details.set('own-1', { id: 'own-1', author: { id: self }, comments: [] });
  await f.scan([notification('c3'), notification('c4')]);
  assert.equal(f.fish.pendingVisits().items.length, 0);
});

test('visit deeply reads latest date past pinned/first three works, previews, likes and posts once without requiring direct replies', async t => {
  const f = fixture(t), pending = await f.qualify();
  const result = await f.fish.visit({ commentId: pending.commentId });
  assert.equal(result.status, 'sent'); assert.equal(result.liked, true);
  assert.deepEqual(f.reads, ['work-4']);
  assert.deepEqual(f.likes, ['work-4']); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].note.id, 'work-4');
  assert.equal(f.sent[0].draft.content, '连里面的小扣子都缝了，好细');
  assert.deepEqual(f.calls.filter(c => ['read', 'draft', 'preview', 'like', 'send'].includes(c)), ['read', 'draft', 'preview', 'like', 'send']);
  assert.match(f.fish.readDiary({}).content, /已点赞，已留言/);
  assert.equal(f.fish.pendingVisits().items.length, 0);
  assert.equal((await f.fish.visit({ commentId: pending.commentId })).visited, false);
  await f.scan([notification('c3')]);
  const again = await f.fish.visit({ commentId: f.fish.pendingVisits().items[0].commentId });
  assert.equal(again.skipped, true);
  assert.deepEqual(f.reads, ['work-4']); assert.equal(f.sent.length, 1);
});

test('daemon completes a pending automatic visit even when original comments only become drafts', async t => {
  const f = fixture(t); await f.qualify();
  const daemon = startFishDaemon(f.fish, { intervalMs: 1_000_000 });
  t.after(() => daemon.stop());
  await daemon.tick();
  assert.equal(f.sent.length, 1); assert.equal(f.likes.length, 1);
  await daemon.tick(); assert.equal(f.sent.length, 1);
});

test('sending and like switches retain pending tasks without writes; visit switch hides tasks', async t => {
  const f = fixture(t), pending = await f.qualify();
  f.store.state.config.sendingEnabled = false;
  assert.equal((await f.fish.visit({ commentId: pending.commentId })).visited, false);
  f.store.state.config.sendingEnabled = true;
  f.fish.saveConfig({ like: { enabled: false } });
  assert.equal((await f.fish.visit({ commentId: pending.commentId })).visited, false);
  assert.equal(f.fish.pendingVisits().items.length, 1);
  f.fish.saveConfig({ visit: { enabled: false } });
  assert.equal(f.fish.pendingVisits().items.length, 0);
  assert.equal(f.sent.length, 0); assert.equal(f.likes.length, 0);
});

test('preview failure and like failure stop comment publishing', async t => {
  for (const stage of ['previewComment', 'like']) {
    const f = fixture(t), pending = await f.qualify();
    f.xhs[stage] = async () => { throw new AppError('模拟提交前失败'); };
    await assert.rejects(f.fish.visit({ commentId: pending.commentId }), /模拟提交前失败/);
    assert.equal(f.sent.length, 0); assert.equal(f.fish.pendingVisits().items.length, 0);
    assert.equal(f.fish.manualVisitTasks().items[0].status, 'failed');
  }
});

test('uncertain comment preserves confirmed like and cannot be auto retried', async t => {
  const f = fixture(t), pending = await f.qualify();
  let attempts = 0;
  f.xhs.send = async () => { attempts++; throw Object.assign(new AppError('发送超时'), { delivery: 'uncertain' }); };
  await assert.rejects(f.fish.visit({ commentId: pending.commentId }), /结果不确定/);
  assert.equal(f.fish.manualVisitTasks().items[0].status, 'uncertain');
  assert.equal(f.fish.manualVisitTasks().items[0].liked, true);
  assert.equal((await f.fish.visit({ commentId: pending.commentId })).visited, false);
  await f.scan([notification('c3')]);
  assert.equal((await f.fish.visit({ commentId: f.fish.pendingVisits().items[0].commentId })).skipped, true);
  assert.equal(attempts, 1); assert.equal(f.likes.length, 1);
});

test('changed account and wrong profile author cannot inherit trigger or publish', async t => {
  const f = fixture(t), pending = await f.qualify();
  f.setAccount('other-account');
  assert.equal((await f.fish.visit({ commentId: pending.commentId })).visited, false);
  assert.equal(f.sent.length, 0);
  f.setAccount(self);
  f.details.set('work-2', { id: 'work-2', author: { id: other }, publishedAt: '2026-10-02T00:00:00Z' });
  await assert.rejects(f.fish.visit({ commentId: pending.commentId }), /作者/);
  assert.equal(f.likes.length, 0); assert.equal(f.sent.length, 0);
});

test('empty profile is skipped; missing dates never substitute an older post', async t => {
  const f = fixture(t), pending = await f.qualify(); f.setProfiles([]);
  assert.equal((await f.fish.visit({ commentId: pending.commentId })).skipped, true);
  const g = fixture(t), task = await g.qualify();
  g.details.set('work-4', { id: 'work-4', author: { id: uid }, publishedAt: null });
  await assert.rejects(g.fish.visit({ commentId: task.commentId }), /发布时间/);
  assert.equal(g.sent.length, 0); assert.equal(g.likes.length, 0);
});

test('account change during draft generation stops likes and comments', async t => {
  const f = fixture(t), pending = await f.qualify();
  f.model.draft = async () => { f.setAccount(other); return '好细'; };
  await assert.rejects(f.fish.visit({ commentId: pending.commentId }), /回访留言必须/);
  assert.equal(f.likes.length, 0); assert.equal(f.sent.length, 0);
});

test('notifications without note tokens resolve only through verified own profile works', async t => {
  const f = fixture(t);
  f.setProfiles([{ id: 'own-1', token: 'resolved-token', author: { id: self } }]);
  await f.scan([notification('c1'), notification('c2')].map(n => ({ ...n, feed_xsec_token: '' })));
  assert.equal(f.fish.pendingVisits().items.length, 1);
  assert.equal(f.calls.filter(c => c === 'profile:' + self).length, 1);
});

test('exhausted like quota prevents commenting and an unliked visit draft cannot bypass the visit flow', async t => {
  const f = fixture(t), pending = await f.qualify();
  f.fish.saveConfig({ like: { daily: 0 } });
  await assert.rejects(f.fish.visit({ commentId: pending.commentId }), /点赞额度/);
  assert.equal(f.likes.length, 0); assert.equal(f.sent.length, 0);
  const draft = f.store.state.drafts[0];
  await assert.rejects(f.workflow.send(draft.id, { confirm: true, revision: draft.revision, content: draft.content }), /尚未确认点赞/);
  const run = f.workflow.run(draft.runId);
  const ordinary = await f.workflow.addDraft({ note: run.notes[1], content: '不能绕过最新作品限制' });
  await assert.rejects(f.workflow.send(ordinary.id, { confirm: true, revision: ordinary.revision, content: ordinary.content }), /已核验的自动回访/);
});

test('account change during pre-send capability check and verification pause block comment publishing', async t => {
  const f = fixture(t), pending = await f.qualify();
  f.xhs.prepare = async () => { f.setAccount(other); };
  // Workflow must check identity again after an awaited capability check.
  await assert.rejects(f.fish.visit({ commentId: pending.commentId }), /账号/);
  assert.equal(f.sent.length, 0);
  const g = fixture(t), another = await g.qualify();
  g.workflow.store.state.verification = { at: new Date().toISOString() };
  await assert.rejects(g.fish.visit({ commentId: another.commentId }), e => e.code === 'XHS_VERIFICATION_REQUIRED');
  assert.equal(g.likes.length, 0); assert.equal(g.sent.length, 0);
});
