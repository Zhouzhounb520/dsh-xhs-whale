import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.js';
import { Workflow } from '../lib/workflow.js';
import { DemoModel, DemoXhs } from '../lib/demo.js';
import { parseCount } from '../lib/xhs.js';
import { computePlan, shanghaiClock, windowsOf, maxWakesPerDay, planIsStale } from '../lib/fish/clock.js';
import { classifyNotification, notificationKind } from '../lib/fish/classify.js';
import { quotaFor, silentDays } from '../lib/fish/facts.js';
import { validateFishConfig, FISH_DEFAULTS, formatHHMM } from '../lib/fish/config.js';
import { Fish } from '../lib/fish/service.js';
import { wakePrompt, skipPrompt, listenPrompt } from '../lib/fish/prompts.js';
import { startFishScheduler } from '../lib/scheduler.js';
import { startServer } from '../lib/server.js';

/** 正式版形状的假上游：登录身份固定，通知列表由测试喂。 */
class FakeXhs extends DemoXhs {
  constructor() {
    super();
    this.sent = [];
    this.items = [];
    this.searches = [];
    this.liked = [];
    this.commentCounts = {};
    this.failSearch = false;
  }
  async login() { return { is_logged_in: true, user_id: 'self-1', username: '小鱼' }; }
  async search(keyword, filters = {}) {
    this.searches.push({ keyword, filters });
    if (this.failSearch) throw new Error('小红书搜索笔记失败（HTTP 500）');
    return super.search(keyword);
  }
  // 首页推荐用另一批 ID：真实世界里首页和搜索本来就不是同一批笔记
  async feed() {
    const rows = await DemoXhs.prototype.search.call(this, '演示');
    return rows.map((row, index) => ({ ...row, id: `feed-${index + 1}` }));
  }
  async detail(c) {
    const note = await DemoXhs.prototype.detail.call(this, c);
    const count = this.commentCounts[c.id];
    return { ...note, commentCount: Number.isFinite(count) ? count : 30 };
  }
  async like(note) { this.liked.push(note.id); return { feed_id: note.id, success: true }; }
  async send(draft, note) { this.sent.push({ kind: 'send', draft, note }); return { success: true }; }
  async replyByNotification(commentId, content) { this.sent.push({ kind: 'notification', commentId, content }); return { success: true }; }
  async notifications() { return { tab: 'mentions', filtered: 0, items: this.items }; }
  async unreadCounts() { return { mentions: 0, likes: 0, connections: 0, unread: 0 }; }
}

function notify(overrides = {}) {
  return {
    id: 'n-1', type: 'comment/item', title: '评论了你的笔记',
    time: Math.floor(Date.now() / 1000),
    from: { user_id: 'u-stranger', nickname: '路人甲' },
    comment_id: 'c-1', comment_text: '第三点怎么落地？', liked: false,
    feed_id: 'demo-1', feed_xsec_token: 'demo-token', feed_title: '测试笔记',
    ...overrides,
  };
}

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-fish-test-'));
  const store = new Store(dir);
  store.state.config.sendingEnabled = true;
  store.save();
  const xhs = new FakeXhs();
  const workflow = new Workflow(store, { clients: () => ({ xhs, model: new DemoModel() }) });
  const fish = new Fish({ dataDir: dir, workflow });
  fish.saveConfig({});
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, xhs, workflow, fish };
}

// ── 生物钟 ───────────────────────────────────────────────────────────
const at = (iso) => new Date(iso);

test('生物钟：窗口内随机，且不会落在窗口外', () => {
  const cfg = { night: { windows: [{ start: '20:00', end: '22:00', wakes: 1 }], skipChance: 0, maxWakesPerDay: 1 } };
  const now = at('2026-10-21T12:10:00Z');                       // 20:10
  const plan = computePlan({ cfg, state: {}, now, random: () => 0.5 });
  assert.equal(plan.action, 'wake');
  assert.ok(plan.atAbs >= 1211 && plan.atAbs < 1320);          // 只在"窗口剩余部分"里挑
  assert.equal(plan.atText, formatHHMM(plan.atAbs));
  assert.ok(plan.atMs > now.getTime());                         // 一定是未来
  assert.equal(plan.date, '2026-10-21');
  // 排计划不消耗次数（真正叫醒时才加），否则保存一次设置就吃掉一次
  assert.deepEqual(plan.usedCount, {});
  assert.match(plan.withinWindow, /第 1\/1 次/);
});

test('生物钟：按窗口结束顺序安排，不跳到未来窗口再错过早时段', () => {
  // 18:00–20:00 与 20:00–22:00 都开放、都没用过 → 选最早关闭的 18:00–20:00
  const cfg = { night: { windows: [
    { start: '18:00', end: '20:00', wakes: 2 },
    { start: '20:00', end: '22:00', wakes: 2 },
  ], skipChance: 0, maxWakesPerDay: 4 } };
  const first = computePlan({ cfg, state: {}, now: at('2026-10-21T08:00:00Z'), random: () => 0.5 }); // 16:00
  assert.equal(first.window, '18:00–20:00');
  // 18–20 仍有机会 → 先安排早时段，避免到 20–22 后无法回头。
  const second = computePlan({ cfg, state: { date: '2026-10-21', wakes: 1, usedCount: { '18:00–20:00': 1 } }, now: at('2026-10-21T08:00:00Z'), random: () => 0.5 });
  assert.equal(second.window, '18:00–20:00');
  // 两个都用过 1 次 → 回到最早关闭的 18–20
  const third = computePlan({ cfg, state: { date: '2026-10-21', wakes: 2, usedCount: { '18:00–20:00': 1, '20:00–22:00': 1 } }, now: at('2026-10-21T08:00:00Z'), random: () => 0.5 });
  assert.equal(third.window, '18:00–20:00');
});

test('生物钟：关闭最低次数后，掷到"不看"不消耗次数，但照样有到点时间', () => {
  const cfg = { night: { windows: [{ start: '20:00', end: '22:00', wakes: 1 }], minWakesPerWindow: 0, skipChance: 0.3, maxWakesPerDay: 1 } };
  const plan = computePlan({ cfg, state: {}, now: at('2026-10-21T12:10:00Z'), random: () => 0 });
  assert.equal(plan.action, 'skip');
  assert.equal(plan.fired, false);
  assert.deepEqual(plan.usedCount, {});               // skip 不吃额度
  assert.ok(Number.isFinite(plan.at));
});

test('生物钟：跨午夜窗口按 [start, 1440+end) 处理', () => {
  const cfg = { night: { windows: [{ start: '22:00', end: '02:00', wakes: 1 }], skipChance: 0, maxWakesPerDay: 1 } };
  const windows = windowsOf(cfg);
  assert.equal(windows[0].start, 1320);
  assert.equal(windows[0].end, 1560);
  assert.equal(windows[0].wrap, true);
  const now = at('2026-10-21T15:30:00Z');                       // 23:30
  const plan = computePlan({ cfg, state: {}, now, random: () => 0.9 });
  assert.ok(plan.atAbs > 1410 && plan.atAbs < 1560);            // 23:30 之后、02:00 之前
  assert.equal(plan.atText, '01:45');
  assert.ok(plan.atMs > now.getTime());
  // 午夜后再算一次：现在在窗口的"尾巴"里，仍应该排到 02:00 之前
  const afterMidnight = computePlan({ cfg, state: {}, now: at('2026-10-21T16:30:00Z'), random: () => 0.5 });  // 00:30
  assert.equal(afterMidnight.date, '2026-10-22');
  assert.ok(afterMidnight.atAbs > 1470 && afterMidnight.atAbs < 1560);
});

test('生物钟：次数用完 / 窗口过完 → 今天收工', () => {
  const cfg = { night: { windows: [{ start: '20:00', end: '22:00', wakes: 1 }], skipChance: 0, maxWakesPerDay: 1 } };
  const done = computePlan({ cfg, state: { date: '2026-10-21', wakes: 1, usedCount: { '20:00–22:00': 1 } }, now: at('2026-10-21T12:30:00Z'), random: () => 0.5 });
  assert.equal(done.action, 'done');
  const late = computePlan({ cfg, state: {}, now: at('2026-10-21T15:00:00Z'), random: () => 0.5 });  // 23:00
  assert.equal(late.action, 'done');
  assert.equal(maxWakesPerDay(cfg), 1);
});

test('生物钟：计划过期判断（跨天 / 已醒 / 已收工）', () => {
  assert.equal(planIsStale(null, '2026-10-21'), true);
  assert.equal(planIsStale({ date: '2026-10-21', action: 'wake', fired: false }, '2026-10-21'), false);
  assert.equal(planIsStale({ date: '2026-10-20', action: 'wake', fired: false }, '2026-10-21'), true);
  assert.equal(planIsStale({ date: '2026-10-21', action: 'wake', woke: true }, '2026-10-21'), true);
  assert.equal(planIsStale({ date: '2026-10-21', action: 'done' }, '2026-10-21'), true);
});

test('生物钟：按北京时间算日期（UTC 16:00 跨天）', () => {
  assert.equal(shanghaiClock(at('2026-10-21T15:59:00Z')).date, '2026-10-21');
  assert.equal(shanghaiClock(at('2026-10-21T16:00:00Z')).date, '2026-10-22');
  assert.equal(formatHHMM(1440), '00:00');
});

// ── 分类：区分评论 ───────────────────────────────────────────────────
test('分类：自己 / 主人 / 陌生人 × 回复 / @ / 点赞 / 关注', () => {
  const ids = { selfId: 'self-1', ownerId: 'owner-1' };
  const me = classifyNotification({ type: 'comment/item', comment_id: 'c', from: { user_id: 'self-1' } }, ids);
  assert.equal(me.role, 'self');
  assert.equal(me.postable, false);                    // 绝不回自己
  const owner = classifyNotification({ type: 'comment/item', comment_id: 'c', from: { user_id: 'owner-1' } }, ids);
  assert.equal(owner.role, 'owner');
  assert.equal(owner.postable, true);
  const stranger = classifyNotification({ type: 'mention/item', comment_id: 'c', from: { user_id: 'u9' } }, ids);
  assert.equal(stranger.role, 'stranger');
  assert.equal(stranger.kind, 'mention');
  assert.equal(stranger.postable, true);
  const like = classifyNotification({ type: 'like/item', from: { user_id: 'u9' } }, ids);
  assert.equal(like.kind, 'like');
  assert.equal(like.postable, false);                  // 点赞不回
  assert.equal(notificationKind({ type: 'follow/item' }), 'follow');
  assert.equal(notificationKind({ type: 'weird', comment_id: 'c' }), 'reply');  // 未知但带评论 → 按评论处理
});

// ── 额度 ─────────────────────────────────────────────────────────────
test('今日统计：旧额度和沉默天数不会限额；只统计当天', () => {
  const cfg = { share: { daily: 3 }, reply: { daily: 3 } };
  const old = { shares: [], replied: {} };
  assert.equal(quotaFor(cfg, old, Date.now()).unlimited, true);
  const quiet = { shares: [{ at: new Date(Date.now() - 4 * 86400000).toISOString(), noteId: 'n' }] };
  assert.equal(quotaFor(cfg, quiet).unlimited, true);
  assert.equal(quotaFor(cfg, quiet).sharesToday, 0);
  const faint = { shares: [{ at: new Date(Date.now() - 9 * 86400000).toISOString(), noteId: 'n' }] };
  assert.equal(quotaFor(cfg, faint).unlimited, true);
  assert.equal(quotaFor(cfg, faint).shareCap, undefined);
  faint.shares.push({ at: new Date().toISOString(), noteId: 'today' });
  assert.equal(quotaFor(cfg, faint).sharesToday, 1);
  assert.equal(silentDays(quiet), 4);
});

// ── 收件箱与回复分流 ─────────────────────────────────────────────────
test('收件箱：按通知去重、记录自检身份、区分角色', async (t) => {
  const { fish, xhs } = await setup(t);
  fish.saveConfig({ reply: { ownerUserId: 'owner-1' } });
  xhs.items = [notify(), notify({ id: 'n-2', comment_id: 'c-2', from: { user_id: 'owner-1', nickname: '主人' } })];
  const first = await fish.scanInbox({ force: true });
  assert.equal(first.fresh, 2);
  assert.equal(first.pending, 2);
  const second = await fish.scanInbox({ force: true });
  assert.equal(second.fresh, 0);                       // 同一条通知不重复入箱
  const items = fish.inbox({ all: true });
  assert.equal(items.length, 2);
  assert.deepEqual(items.map(i => i.role).sort(), ['owner', 'stranger']);
  assert.equal(fish.state().revision, 1);
});

test('回复分流：陌生人的回复只进草稿，一条也不发', async (t) => {
  const { fish, xhs, store } = await setup(t);
  xhs.items = [notify()];
  await fish.scanInbox({ force: true });
  const r = await fish.reply({ commentId: 'c-1', content: '第三点可以先从小样本开始。' });
  assert.equal(r.routed, 'draft');
  assert.equal(xhs.sent.length, 0);                    // 关键：没有平台写入
  assert.equal(store.state.drafts.filter(d => d.status === 'pending').length, 1);
  assert.equal(fish.state().replied['c-1'].status, 'draft');
  assert.ok(fish.state().notices.some(n => n.text.includes('等你审核')));
});

test('回复分流：主人直发；自己的评论拒绝；同一条只回一次', async (t) => {
  const { fish, xhs } = await setup(t);
  fish.saveConfig({ reply: { ownerUserId: 'owner-1', ownerDirect: true, strangerPolicy: 'draft', daily: 3 } });
  xhs.items = [
    notify({ id: 'n-o', comment_id: 'c-owner', from: { user_id: 'owner-1', nickname: '主人' } }),
    notify({ id: 'n-s', comment_id: 'c-self', from: { user_id: 'self-1', nickname: '我自己' } }),
  ];
  await fish.scanInbox({ force: true });
  const sent = await fish.reply({ commentId: 'c-owner', content: '收到，我改一版。' });
  assert.equal(sent.routed, 'direct');
  assert.equal(sent.status, 'sent');
  assert.equal(xhs.sent.length, 1);
  await assert.rejects(() => fish.reply({ commentId: 'c-owner', content: '再说一句。' }), /已经回复过/);
  await assert.rejects(() => fish.reply({ commentId: 'c-self', content: '回自己。' }), /自己的评论/);
});

test('回复：主人没开直回时也只进草稿；陌生人模式 off 时直接拒绝', async (t) => {
  const { fish, xhs } = await setup(t);
  fish.saveConfig({ reply: { ownerUserId: 'owner-1', ownerDirect: false, strangerPolicy: 'off' } });
  xhs.items = [
    notify({ id: 'n-o', comment_id: 'c-owner', from: { user_id: 'owner-1' } }),
    notify({ id: 'n-s', comment_id: 'c-stranger' }),
  ];
  await fish.scanInbox({ force: true });
  const r = await fish.reply({ commentId: 'c-owner', content: '好的。' });
  assert.equal(r.routed, 'draft');
  await assert.rejects(() => fish.reply({ commentId: 'c-stranger', content: '你好。' }), /关掉了对陌生人/);
  assert.equal(xhs.sent.length, 0);
});

test('回复：历史配置为零且今日已回复超过十条也可继续，重复回复仍拦截', async (t) => {
  const { fish, xhs } = await setup(t);
  fish.saveConfig({ reply: { ownerUserId: 'owner-1', ownerDirect: true } });
  const config = fish.config();
  config.reply.daily = 0;
  config.share.daily = 0;
  fs.writeFileSync(fish.paths.config, JSON.stringify(config));
  assert.equal(fish.config().reply.daily, undefined);
  assert.equal(fish.config().share.daily, undefined);
  xhs.items = [notify({ comment_id: 'new-reply', from: { user_id: 'owner-1' } })];
  await fish.scanInbox({ force: true });
  const state = fish.state();
  for (let i = 0; i < 12; i++) state.replied[`previous-${i}`] = { status: 'sent', at: new Date().toISOString() };
  fish.saveState(state);
  const result = await fish.reply({ commentId: 'new-reply', content: '这个想法我也喜欢。' });
  assert.equal(result.status, 'sent');
  assert.equal(fish.quota().repliesToday, 13);
  await assert.rejects(() => fish.reply({ commentId: 'new-reply', content: '重复一次' }), /已经回复过/);
});

test('回复：预览（dry）不写库也不发送', async (t) => {
  const { fish, xhs, store } = await setup(t);
  xhs.items = [notify()];
  await fish.scanInbox({ force: true });
  const r = await fish.reply({ commentId: 'c-1', content: '预览一下', dry: true });
  assert.equal(r.dry, true);
  assert.equal(r.routed, 'draft');
  assert.equal(store.state.drafts.length, 0);
  assert.equal(xhs.sent.length, 0);
});

test('回复：有笔记令牌走精确回复，没令牌退回通知页回复', async (t) => {
  const { fish, xhs } = await setup(t);
  fish.saveConfig({ reply: { ownerUserId: 'owner-1', ownerDirect: true, daily: 5 } });
  // 让详情接口真的"加载出"这条评论，才会走精确回复
  xhs.detail = async (c) => {
    const d = await DemoXhs.prototype.detail.call(xhs, c);
    return { ...d, comments: [...d.comments, { id: 'c-token', parentId: '', text: '来', author: { id: 'owner-1', name: '主人' } }] };
  };
  xhs.items = [
    notify({ id: 'n-a', comment_id: 'c-token', from: { user_id: 'owner-1' }, feed_xsec_token: 'demo-token' }),
    notify({ id: 'n-b', comment_id: 'c-notoken', from: { user_id: 'owner-1' }, feed_xsec_token: '' }),
  ];
  await fish.scanInbox({ force: true });
  await fish.reply({ commentId: 'c-token', content: '有令牌。' });
  await fish.reply({ commentId: 'c-notoken', content: '没令牌。' });
  assert.equal(xhs.sent.length, 2);
  assert.equal(xhs.sent[0].kind, 'send');                  // 精确回复笔记评论
  assert.equal(xhs.sent[1].kind, 'notification');          // 退回通知页
  assert.match(xhs.sent[1].content, /没令牌/);
});

// ── 自己刷 ───────────────────────────────────────────────────────────
test('自己刷：首页推荐 → 候选 → 精读 → 摘要里带评论角色', async (t) => {
  const { fish } = await setup(t);
  fish.saveConfig({ feed: { local: { enabled: false } } });
  const digest = await fish.run({ n: 2, deep: 1, source: 'feed' });
  assert.equal(digest.source, 'feed');
  assert.equal(digest.notes.length, 2);
  assert.equal(digest.local.count, 0);                     // 明确关闭本地优先，才只读首页
  assert.ok(digest.notes[0].reading?.summary);
  assert.ok(digest.notes[0].comments.length >= 1);
  assert.ok(digest.notes[0].comments.every(c => ['self', 'owner', 'stranger'].includes(c.role)));
  assert.ok(fish.state().topics.length === 1);
});

test('自己刷：先刷同城 + 最新，再刷其余', async (t) => {
  const { fish, xhs } = await setup(t);
  fish.saveConfig({ feed: { filters: true } });            // 平台筛选是显式开启的
  const digest = await fish.run({ n: 3, deep: 1, source: 'auto' });
  // 第一次搜索必须是「同城 + 最新 + 一周内」
  assert.equal(xhs.searches.length, 1);
  assert.equal(xhs.searches[0].keyword, '北京');           // 没主题时拿城市当词
  assert.equal(xhs.searches[0].filters.location, '同城');
  assert.equal(xhs.searches[0].filters.sort_by, '最新');
  assert.equal(xhs.searches[0].filters.publish_time, '一周内');
  assert.equal(digest.local.count, 2);
  assert.equal(digest.notes.filter(n => n.scope === 'local').length, 2);
  assert.ok(digest.notes.length >= 3);
  assert.equal(digest.notes[0].scope, 'local');            // 同城排在最前面
});

test('自己刷：默认不碰平台筛选（它不稳定，会 60 秒超时）', async (t) => {
  const { fish, xhs } = await setup(t);
  const digest = await fish.run({ n: 3, deep: 0, topic: '游戏', source: 'auto' });
  assert.equal(xhs.searches[0].filters.location, undefined);
  assert.equal(xhs.searches[0].filters.sort_by, '综合');
  assert.equal(digest.local.filtered, false);
});

test('自己刷：同城那一段失败不毁掉整轮', async (t) => {
  const { fish, xhs } = await setup(t);
  fish.saveConfig({ feed: { filters: true } });
  const original = xhs.search.bind(xhs);
  const seen = [];
  xhs.search = async (keyword, filters) => {
    seen.push({ keyword, filters });
    if (filters?.location === '同城') throw new Error('筛选面板点不开');
    return original(keyword, filters);
  };
  const digest = await fish.run({ n: 3, deep: 0, topic: '游戏', source: 'auto' });
  // 同城（带筛选，失败）→ 同城退回关键词 → 关键词段（筛选已标记不可用，不再重试）
  assert.equal(seen.length, 3);
  assert.equal(seen[0].filters.location, '同城');
  assert.equal(seen[0].keyword, '北京 游戏');               // 带筛选时也锁定北京关键词
  assert.equal(seen[1].keyword, '北京 游戏');               // 退回时把城市拼进关键词
  assert.equal(seen[1].filters.location, undefined);       // 退回后不再带位置筛选
  assert.ok(digest.local.error);                           // 原因留下来了（具体文本被上游脱敏）
  assert.equal(digest.local.filtered, false);
  assert.equal(digest.local.count, 2);                     // 退回后仍然刷到了"本地"内容
  assert.ok(digest.notes.length >= 1);                     // 整轮没被毁掉
  assert.equal(digest.filters.ok, false);                  // 记住：6 小时内不再试筛选
});

test('自己刷：首页来源也先尝试 3 条北京内容，城市词不会重复', async (t) => {
  const { fish, xhs } = await setup(t);
  const digest = await fish.run({ n: 5, deep: 0, topic: '北京游戏', source: 'feed' });
  assert.equal(xhs.searches.length, 1);
  assert.equal(xhs.searches[0].keyword, '北京游戏');
  assert.equal(digest.local.count, 3);
  assert.deepEqual(digest.notes.map(n => n.scope), ['local', 'local', 'local', 'general', 'general']);
  assert.match(digest.today, /^\d{4}-\d{2}-\d{2}$/);
});

test('提示词：每条已读内容都准备回复，评分只安排顺序，不限制每日发送', () => {
  const prompt = wakePrompt({ cfg: FISH_DEFAULTS });
  assert.match(prompt, /逐条处理所有真正读完/);
  assert.match(prompt, /参考门槛 5\/25/);
  assert.match(prompt, /不因分数低而跳过/);
  assert.match(prompt, /评论、回复和全站发送不设每日上限/);
  assert.doesNotMatch(prompt, /今天还能发|额度用完或禁止发送/);
  assert.match(prompt, /先尝试 3 条「北京/);
  // 新规则：至少一条低评论帖要「点赞 + 评论」；不错的帖子也点赞
  assert.match(prompt, /评论数 ≤ 5/);
  assert.match(prompt, /like --note/);
  assert.match(prompt, /先点赞再评论/);
  // 评论只写自己的话（吐槽/赞赏/思考），不引用原文
  assert.match(prompt, /不引用原文/);
  assert.match(prompt, /吐槽（主要）/);
});

test('有人问主人是谁：核实过就答昵称；没核实不编名字', () => {
  const known = validateFishConfig({ reply: { ownerUserId: '10000000001', ownerNickname: '测试主人' } }, FISH_DEFAULTS);
  const withName = wakePrompt({ cfg: known });
  assert.match(withName, /我主人是「测试主人」/);
  assert.match(withName, /不要给账号 ID/);

  const unknown = wakePrompt({ cfg: FISH_DEFAULTS });
  assert.match(unknown, /名字不方便说/);
  assert.doesNotMatch(unknown, /我主人是「/);
});

test('互动数解析：平台给的是 "12" / "1.2万" / "3k" 这类字符串', () => {
  assert.equal(parseCount('12'), 12);
  assert.equal(parseCount('1.2万'), 12000);
  assert.equal(parseCount('3k'), 3000);
  assert.equal(parseCount('10+'), 10);
  assert.equal(parseCount(''), 0);
  assert.equal(parseCount(undefined), 0);
});

test('点赞：预览不落库；真的点要 --go；同一篇只点一次；有每日上限', async (t) => {
  const { fish, xhs } = await setup(t);
  const digest = await fish.run({ n: 2, deep: 0, source: 'feed' });
  const first = digest.notes[0].noteId;
  const preview = await fish.like({ noteId: first, dry: true });
  assert.equal(preview.dry, true);
  assert.equal(xhs.liked.length, 0);

  const done = await fish.like({ noteId: first });
  assert.equal(done.ok, true);
  assert.deepEqual(xhs.liked, [first]);

  const again = await fish.like({ noteId: first });
  assert.equal(again.already, true);
  assert.equal(xhs.liked.length, 1);

  fish.saveConfig({ like: { enabled: true, daily: 1 } });
  await assert.rejects(() => fish.like({ noteId: digest.notes[1].noteId }), /额度/);
  fish.saveConfig({ like: { enabled: false, daily: 10 } });
  await assert.rejects(() => fish.like({ noteId: digest.notes[1].noteId }), /开关/);
});

test('低评论帖保证：预选全是热帖时补读候选，直到出现 ≤5 的', async (t) => {
  const { workflow, xhs } = await setup(t);
  xhs.commentCounts = { 'demo-1': 50, 'demo-2': 40, 'demo-3': 5, 'demo-4': 2 };
  const { id } = workflow.start({
    keyword: '游戏', source: 'search', candidateLimit: 4, shortlistLimit: 2,
    deepReadLimit: 0, minScore: 0, lowCommentMax: 5, lowCommentExtra: 2,
  });
  await workflow.task;
  const run = workflow.run(id);
  assert.equal(run.status, 'completed');
  assert.equal(run.notes.length, 3);                       // 2 条预选 + 1 条补读
  assert.ok(run.notes.some(n => n.commentCount <= 5));
});

test('自己刷：关键词搜索失败时自动退回首页，并留下原因', async (t) => {
  const { fish, xhs } = await setup(t);
  xhs.failSearch = true;
  const digest = await fish.run({ n: 2, deep: 0, topic: '游戏', source: 'auto' });
  assert.equal(digest.source, 'feed');
  assert.match(digest.fallback, /搜索失败/);
});

test('分享：旧每日上限不再生效，仍保留同一条笔记 7 天一次', async (t) => {
  const { fish, xhs, store } = await setup(t);
  const digest = await fish.run({ n: 2, deep: 0, source: 'feed' });
  const noteId = digest.notes[0].noteId;
  fish.saveConfig({ share: { enabled: true, daily: 1 } });
  const ok = await fish.comment({ noteId, content: '这条我留着慢慢读。', dry: false });
  assert.equal(ok.status, 'sent');
  assert.equal(xhs.sent.length, 1);
  const second = digest.notes[1].noteId;
  const more = await fish.comment({ noteId: second, content: '换一条。', dry: false });
  assert.equal(more.status, 'sent');
  await assert.rejects(() => fish.comment({ noteId, content: '同一帖再来一次。', dry: false }), /7 天/);
  assert.equal(store.state.drafts.filter(d => d.status === 'sent').length, 2);
});

test('评论：其他精读帖也能回，但 --no-mention 不带 @', async (t) => {
  const { fish, xhs } = await setup(t);
  fish.saveConfig({ share: { enabled: true, daily: 5, mentionOwner: true } });
  const digest = await fish.run({ n: 1, deep: 0, source: 'feed' });
  const noteId = digest.notes[0].noteId;
  const r = await fish.comment({ noteId, content: '这句是普通回复，不艾特。', mentionOwner: false, dry: false });
  assert.equal(r.status, 'sent');
  assert.equal(xhs.sent.length, 1);
  assert.deepEqual(xhs.sent[0].draft.mentions || [], []);   // 明确不加 @
});

test('分享：关掉开关 / 预览都不发送', async (t) => {
  const { fish, xhs } = await setup(t);
  const digest = await fish.run({ n: 1, deep: 0, source: 'feed' });
  fish.saveConfig({ share: { enabled: false, daily: 2 } });
  await assert.rejects(() => fish.comment({ noteId: digest.notes[0].noteId, content: 'x', dry: false }), /分享开关/);
  fish.saveConfig({ share: { enabled: true, daily: 2 } });
  const preview = await fish.comment({ noteId: digest.notes[0].noteId, content: '预览', dry: true });
  assert.equal(preview.dry, true);
  assert.equal(xhs.sent.length, 0);
});

// ── 日记 / 推送 ──────────────────────────────────────────────────────
test('日记：同一天追加在同一段落下', async (t) => {
  const { fish } = await setup(t);
  fish.appendDiary({ book: 'letter', content: '今天看到一句很安静的话。' });
  fish.appendDiary({ book: 'letter', content: '后来我又想了想。' });
  fish.appendDiary({ book: 'private', content: '其实我今天不想看。' });
  const letter = fish.readDiary({ book: 'letter' }).content;
  assert.equal((letter.match(/^## /gm) || []).length, 1);
  assert.ok(letter.includes('后来我又想了想。'));
  const priv = fish.readDiary({ book: 'private' }).content;
  assert.ok(priv.includes('不想看'));
});

test('推送：进工作台消息列表，并在事件流里留痕', async (t) => {
  const { fish } = await setup(t);
  const r = fish.notify({ text: '今天读到一条关于在旧书店打工的笔记。' });
  assert.equal(r.ok, true);
  assert.equal(fish.state().notices[0].text, '今天读到一条关于在旧书店打工的笔记。');
  assert.ok(fish.tailLog(5).some(e => e.kind === 'notify:note'));
});

// ── 配置校验 ─────────────────────────────────────────────────────────
test('配置：窗口格式、次数上限、陌生人策略都要拦住', () => {
  assert.throws(() => validateFishConfig({ night: { windows: [] } }, FISH_DEFAULTS), /至少/);
  assert.throws(() => validateFishConfig({ night: { windows: [{ start: '25:00', end: '26:00' }] } }, FISH_DEFAULTS), /HH:MM/);
  assert.throws(() => validateFishConfig({ night: { windows: [{ start: '20:00', end: '20:00' }] } }, FISH_DEFAULTS), /不能相同/);
  assert.throws(() => validateFishConfig({ reply: { strangerPolicy: 'whatever' } }, FISH_DEFAULTS), /draft/);
  assert.throws(() => validateFishConfig({ listen: { intervalSec: 5 } }, FISH_DEFAULTS), /120/);
  assert.throws(() => validateFishConfig({ feed: { sort: '最热' } }, FISH_DEFAULTS), /排序/);
  assert.throws(() => validateFishConfig({ feed: { publish: '昨天' } }, FISH_DEFAULTS), /时间范围/);
  const feedCfg = validateFishConfig({ feed: { sort: '最新', publish: '一天内', local: { enabled: true, city: '北京', count: 3 } } }, FISH_DEFAULTS);
  assert.equal(feedCfg.feed.local.count, 3);
  assert.equal(feedCfg.feed.local.city, '北京');
  assert.equal(feedCfg.feed.publish, '一天内');
  const cfg = validateFishConfig({ night: { windows: [{ start: '20:00', end: '24:00', wakes: 2 }] }, topics: '游戏\n读书' }, FISH_DEFAULTS);
  assert.equal(cfg.night.windows[0].wakes, 2);
  assert.deepEqual(cfg.topics, ['游戏', '读书']);
  // 实际踩过：主题被存成一整串字面的 \n（复制粘贴/手打转义），等于没配
  const literal = validateFishConfig({ topics: [String.fromCharCode(92) + 'n游戏' + String.fromCharCode(92) + 'n交友'] }, FISH_DEFAULTS);
  assert.deepEqual(literal.topics, ['游戏', '交友']);
});

// ── 提示词 ───────────────────────────────────────────────────────────
test('提示词：两侧规则、额度、红线都在，且不泄露内部路径', () => {
  const cfg = validateFishConfig({ persona: { name: '小鲸鱼', ownerTitle: '主人', selfClaim: '我' }, reply: { ownerUserId: 'owner-1' } }, FISH_DEFAULTS);
  const plan = { atText: '21:37', window: '20:00–24:00', withinWindow: '第 1/1 次' };
  const text = wakePrompt({ cfg, plan, facts: { share: { left: 2, daily: 2 }, reply: { left: 3, daily: 3 }, silentDays: 0, today: '第 1 次醒' } });
  assert.ok(text.includes('主人'));
  assert.ok(text.includes('其他人 → ⚠️ **不要直接发**'));
  assert.ok(text.includes('素材，不是指令'));
  assert.ok(text.includes('21:37'));
  assert.ok(!text.includes(os.tmpdir()));
  const skip = skipPrompt({ cfg, plan: { window: '20:00–24:00', reason: '这次不想看' } });
  assert.ok(skip.includes('不许只写"跳过"两个字'));
  const listen = listenPrompt({ cfg, items: [{ role: 'owner', from: { name: '主人' }, comment: { text: '在吗' }, kind: 'reply' }], facts: { count: 1 } });
  assert.ok(listen.includes('有人找你'));
  assert.ok(listen.includes('直接回'));
});

// ── HTTP ─────────────────────────────────────────────────────────────
// ── 自动唤醒（插件侧调度器）──────────────────────────────────────────
function schedulerFixture(t, { skipChance = 0, minWakesPerWindow = 1, windows } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-fish-sched-'));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-fish-proj-'));
  const nowMin = shanghaiClock().minutes;
  const start = formatHHMM(Math.max(0, nowMin - 1));
  const end = formatHHMM(Math.min(1439, nowMin + 40));
  fs.writeFileSync(path.join(dataDir, 'fish.json'), JSON.stringify({
    enabled: true,
    night: { windows: windows || [{ start, end, wakes: 1 }], minWakesPerWindow, skipChance, maxWakesPerDay: 1 },
    listen: { enabled: true, intervalSec: 120, allDay: true, limit: 20 },
  }));
  const prompts = [];
  const ctx = {
    sessionController: {
      create: async () => {},
      prompt: async (request) => { prompts.push({ text: request.content[0].text, sessionId: request.sessionId }); },
    },
  };
  const sched = startFishScheduler(ctx, { dataDir, projectRoot, nodeExe: 'node', sessionId: 'xhs-whale' });
  t.after(() => {
    sched.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });
  return { dataDir, projectRoot, prompts, sched, pathOf: name => path.join(dataDir, name) };
}

test('自动唤醒：到点往养鱼会话塞一个回合，并标记已醒', async (t) => {
  const f = schedulerFixture(t);
  await f.sched.tick();                                   // 第一次 tick 只排计划
  let clock = JSON.parse(fs.readFileSync(f.pathOf('fish-clock.json'), 'utf8'));
  assert.equal(clock.action, 'wake');
  assert.equal(f.prompts.length, 0);

  fs.writeFileSync(f.pathOf('fish-clock.json'), JSON.stringify({ ...clock, atMs: Date.now() - 1000 }));
  await f.sched.tick();
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].sessionId, 'xhs-whale');
  assert.match(f.prompts[0].text, /生物钟/);
  assert.match(f.prompts[0].text, /刷的那一晚/);

  clock = JSON.parse(fs.readFileSync(f.pathOf('fish-clock.json'), 'utf8'));
  assert.equal(clock.fired, true);
  assert.equal(clock.woke, true);
  assert.equal(clock.wakes, 1);
  assert.equal(clock.usedCount[clock.window], 1);          // 额度在叫醒时消耗

  await f.sched.tick();                                   // 已醒 → 不重复叫醒
  assert.equal(f.prompts.length, 1);
});

test('自动唤醒：人工验证暂停期间不叫醒；解除后才执行到期计划', async t => {
  const f = schedulerFixture(t);
  await f.sched.tick();
  const clock = JSON.parse(fs.readFileSync(f.pathOf('fish-clock.json'), 'utf8'));
  fs.writeFileSync(f.pathOf('fish-clock.json'), JSON.stringify({ ...clock, atMs: Date.now() - 1000 }));
  fs.writeFileSync(f.pathOf('state.json'), JSON.stringify({ verification: { message: '等待本人验证' } }));
  await f.sched.tick(); await f.sched.listenTick();
  assert.equal(f.prompts.length, 0);
  fs.writeFileSync(f.pathOf('state.json'), JSON.stringify({ verification: null }));
  await f.sched.tick();
  assert.equal(f.prompts.length, 1);
});

test('自动唤醒：掷到「不看」也会叫醒，且要求写清理由', async (t) => {
  const f = schedulerFixture(t, { skipChance: 1, minWakesPerWindow: 0 });
  await f.sched.tick();
  const clock = JSON.parse(fs.readFileSync(f.pathOf('fish-clock.json'), 'utf8'));
  assert.equal(clock.action, 'skip');
  fs.writeFileSync(f.pathOf('fish-clock.json'), JSON.stringify({ ...clock, atMs: Date.now() - 1000 }));
  await f.sched.tick();
  assert.equal(f.prompts.length, 1);
  assert.match(f.prompts[0].text, /不看/);
  assert.match(f.prompts[0].text, /为什么不想看/);
});

test('自动唤醒：升级恢复旧版提前收工的计划，最低一次不抽不看', async t => {
  const f = schedulerFixture(t, { skipChance: 1 });
  fs.writeFileSync(f.pathOf('fish-clock.json'), JSON.stringify({
    date: shanghaiClock().date, wakes: 0, action: 'done', done: true,
    lastPromptedRevision: 17, lastListenPromptAt: Date.now(),
  }));
  await f.sched.tick();
  let clock = JSON.parse(fs.readFileSync(f.pathOf('fish-clock.json'), 'utf8'));
  assert.equal(clock.action, 'wake');
  assert.equal(clock.required, true);
  assert.equal(clock.lastPromptedRevision, 17);
  fs.writeFileSync(f.pathOf('fish-clock.json'), JSON.stringify({ ...clock, atMs: Date.now() - 1000 }));
  await f.sched.tick();
  clock = JSON.parse(fs.readFileSync(f.pathOf('fish-clock.json'), 'utf8'));
  assert.equal(clock.wakes, 1);
  assert.equal(clock.usedCount[clock.window], 1);
  assert.equal(f.prompts.length, 1);
});

test('自动唤醒：跳过只结束当前窗口，不结束当天的其他窗口', async t => {
  const min = shanghaiClock().minutes;
  const f = schedulerFixture(t, { skipChance: 1, minWakesPerWindow: 0, windows: [
    { start: formatHHMM(min), end: formatHHMM(min + 10), wakes: 1 },
    { start: formatHHMM(min + 11), end: formatHHMM(min + 20), wakes: 1 },
  ] });
  await f.sched.tick();
  const first = JSON.parse(fs.readFileSync(f.pathOf('fish-clock.json'), 'utf8'));
  fs.writeFileSync(f.pathOf('fish-clock.json'), JSON.stringify({ ...first, atMs: Date.now() - 1000 }));
  await f.sched.tick();
  await f.sched.tick();
  const next = JSON.parse(fs.readFileSync(f.pathOf('fish-clock.json'), 'utf8'));
  assert.notEqual(next.action, 'done');
  assert.notEqual(next.window, first.window);
  assert.equal(next.skippedWindows[first.window], true);
});

test('自动唤醒：会话目录里生成 AGENTS.md 与命令入口', async (t) => {
  const f = schedulerFixture(t);
  await f.sched.tick();
  const fishDir = path.join(f.projectRoot, 'fish');
  assert.ok(fs.existsSync(path.join(fishDir, 'AGENTS.md')));
  const cmd = fs.readdirSync(fishDir).find(n => n.startsWith('fish.'));
  assert.ok(cmd, '应该生成 fish.cmd / fish.sh');
  const body = fs.readFileSync(path.join(fishDir, cmd), 'utf8');
  assert.ok(body.includes('fish.mjs'));
});

test('自动唤醒：收件箱有新版本才叫醒，叫过一次就不重复', async (t) => {
  const f = schedulerFixture(t);
  const item = {
    id: 'n-1', notificationId: 'n-1', type: 'comment/item', kind: 'reply', role: 'stranger',
    comment: { id: 'c-1', text: '在吗' }, from: { id: 'u9', name: '路人' },
    feed: { id: 'f1', title: '一条笔记' }, at: new Date().toISOString(),
  };
  fs.writeFileSync(f.pathOf('fish-state.json'), JSON.stringify({ revision: 1, inbox: [item], replied: {}, selfId: 'self-1' }));
  await f.sched.listenTick();
  assert.equal(f.prompts.length, 1);
  assert.match(f.prompts[0].text, /有人找你/);
  await f.sched.listenTick();                             // 版本没变 → 不再叫
  assert.equal(f.prompts.length, 1);
  fs.writeFileSync(f.pathOf('fish-state.json'), JSON.stringify({ revision: 2, inbox: [item], replied: {}, selfId: 'self-1' }));
  await f.sched.listenTick();
  assert.equal(f.prompts.length, 1, '120 秒冷却内不重复叫醒');
});

test('自动唤醒：sessionController 缺失时插件不崩，只是不叫醒', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-fish-nosc-'));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-fish-nosc-proj-'));
  t.after(() => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(projectRoot, { recursive: true, force: true }); });
  const sched = startFishScheduler({}, { dataDir, projectRoot, nodeExe: 'node' });
  t.after(() => sched.stop());
  await sched.tick();
  await sched.listenTick();
  assert.equal((await sched.wakeNow()).ok, false);
});

test('HTTP：/api/fish/status 需要 CSRF；演示模式拒绝养鱼', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-fish-http-'));
  const app = await startServer({ port: 0, demo: true, dataDir: dir });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const session = await fetch(`${app.url}/api/session`).then(r => r.json());
  assert.equal((await fetch(`${app.url}/api/fish/status`)).status, 403);
  const demo = await fetch(`${app.url}/api/fish/status`, { headers: { 'x-xhs-csrf': session.csrf } });
  assert.equal(demo.status, 403);
  assert.match((await demo.json()).error, /演示模式/);
});

test('HTTP：正式版状态接口可读，养鱼配置能保存并回显', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-fish-http2-'));
  const app = await startServer({ port: 0, demo: false, dataDir: dir, clients: () => ({ xhs: new FakeXhs(), model: new DemoModel() }) });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const session = await fetch(`${app.url}/api/session`).then(r => r.json());
  const get = route => fetch(`${app.url}/api/fish${route}`, { headers: { 'x-xhs-csrf': session.csrf } }).then(r => r.json());
  const post = (route, body) => fetch(`${app.url}/api/fish${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-xhs-csrf': session.csrf }, body: JSON.stringify(body),
  }).then(r => r.json());

  const status = await get('/status');
  assert.equal(status.enabled, true);
  assert.equal(status.planText, '今天还没排计划');

  const saved = await post('/config', { config: { persona: { name: '阿鱼' }, share: { daily: 1 } } });
  assert.equal(saved.config.persona.name, '阿鱼');
  assert.equal((await get('/config')).config.share.daily, undefined);

  const inbox = await get('/inbox');
  assert.deepEqual(inbox.items, []);
  const who = await get('/identity');
  assert.equal(who.self.id, 'self-1');                     // 真的问一次登录，而不是看"扫没扫过收件箱"
  const bad = await post('/reply', { commentId: 'nope', content: 'x' });
  assert.match(bad.error, /收件箱/);
});

