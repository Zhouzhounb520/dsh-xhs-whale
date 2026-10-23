import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, validateConfig, shanghaiDay } from '../lib/store.js';
import { Workflow } from '../lib/workflow.js';
import { DemoModel, DemoXhs } from '../lib/demo.js';
import { normalizeDetail, normalizeFeeds, XhsClient, safeImageUrl } from '../lib/xhs.js';
import { DeepSeek, validateRanking } from '../lib/model.js';
import { startServer } from '../lib/server.js';

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-test-'));
  const store = new Store(dir);
  store.state.config.sendingEnabled = true;
  const xhs = new DemoXhs();
  let sends = 0;
  xhs.send = async () => { sends++; return { success: true }; };
  const model = new DemoModel();
  const workflow = new Workflow(store, { clients: () => ({ xhs, model }), ...options });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { workflow, store, dir, xhs, model, sends: () => sends };
}
async function ready(ctx) {
  const { id } = ctx.workflow.start({ keyword: '测试', skipRead: false });
  await ctx.workflow.task;
  const run = ctx.workflow.run(id);
  assert.equal(run.status, 'completed');
  const note = run.notes[0];
  const draft = await ctx.workflow.draft({ runId: id, noteId: note.id, commentId: note.comments[0].id });
  return { run, note, draft };
}
const approval = d => ({ confirm: true, revision: d.revision, content: d.content });

test('recent-first reads newest detail before older high-score notes; unknown dates go last', async t => {
  const c = setup(t);
  const detail = c.xhs.detail.bind(c.xhs);
  const dates = { 'demo-1': '2025-01-01T00:00:00Z', 'demo-2': null, 'demo-3': '2026-10-21T00:00:00Z', 'demo-4': 'invalid' };
  c.xhs.detail = async note => ({ ...await detail(note), publishedAt: dates[note.id] });
  const read = [];
  const originalRead = c.model.read.bind(c.model);
  c.model.read = async note => { read.push(note.id); return originalRead(note); };
  const { id } = c.workflow.start({ keyword: '测试', candidateLimit: 4, shortlistLimit: 4, deepReadLimit: 1, preferRecent: true });
  await c.workflow.task;
  const run = c.workflow.run(id);
  assert.equal(run.status, 'completed');
  assert.deepEqual(run.notes.map(n => n.id), ['demo-3', 'demo-1', 'demo-2', 'demo-4']);
  assert.deepEqual(read, ['demo-3']);
  assert.equal(c.sends(), 0);
});

test('recent-first shortlist preserves newest search order rather than model score order', async t => {
  const c = setup(t);
  c.model.rank = async notes => notes.map((n, i) => ({ id: n.id, score: 10 + i, reason: 'test' })).reverse();
  const { id } = c.workflow.start({ keyword: '测试', candidateLimit: 3, shortlistLimit: 2, deepReadLimit: 0, preferRecent: true });
  await c.workflow.task;
  assert.deepEqual(c.workflow.run(id).notes.map(n => n.id), ['demo-1', 'demo-2']);
});

test('search → shortlist → deep reading → editable draft, token-free UI, Markdown export', async t => {
  const c = setup(t);
  const { run, draft } = await ready(c);
  assert.equal(run.notes.length, 5);
  assert.equal(run.notes.filter(n => n.reading).length, 3);
  assert.equal(draft.status, 'pending');
  assert.ok(!JSON.stringify(c.workflow.snapshot()).includes('demo-token'));
  assert.match(c.workflow.exportMarkdown(run.id), /原样|阅读清单/);
  assert.equal(c.sends(), 0);
});
test('read-history deduplication and explicit reread', async t => {
  const c = setup(t); await ready(c);
  const next = c.workflow.start({ keyword: '测试' }); await c.workflow.task;
  assert.equal(c.workflow.run(next.id).skippedRead, 3);
  assert.equal(c.workflow.run(next.id).candidates.length, 3);
});
test('overlapping runs and operations are rejected', async t => {
  const c = setup(t);
  let release; c.xhs.login = () => new Promise(resolve => { release = resolve; });
  c.workflow.start({ keyword: '测试' });
  assert.throws(() => c.workflow.start({ keyword: '第二个任务' }), /另一项/);
  await assert.rejects(c.workflow.exclusive(() => c.xhs.qrcode()), /另一项/);
  release({ is_logged_in: true, user_id: 'test-user' });
  await c.workflow.task;
});
test('stop requested during read stops subsequent model/platform actions', async t => {
  const c = setup(t);
  const original = c.xhs.search.bind(c.xhs);
  c.xhs.search = async (...args) => { c.workflow.cancel(c.workflow.activeRun); return original(...args); };
  const { id } = c.workflow.start({ keyword: '测试' }); await c.workflow.task;
  assert.equal(c.workflow.run(id).status, 'cancelled');
  assert.equal(c.workflow.run(id).notes.length, 0);
});
test('unknown target comment cannot generate a reply', async t => {
  const c = setup(t); const { run, note } = await ready(c);
  await assert.rejects(c.workflow.draft({ runId: run.id, noteId: note.id, commentId: 'invented' }), /目标评论/);
});
test('same target returns existing pending draft and cannot generate a duplicate after send', async t => {
  const c = setup(t); const { run, note, draft } = await ready(c);
  const body = { runId: run.id, noteId: note.id, commentId: draft.commentId };
  assert.equal((await c.workflow.draft(body)).id, draft.id);
  await c.workflow.send(draft.id, approval(draft));
  assert.equal((await c.workflow.draft(body)).status, 'sent');
  await assert.rejects(c.workflow.send(draft.id, approval(draft)), /已处理/);
  assert.equal(c.sends(), 1);
});
test('double-click send produces exactly one platform write', async t => {
  const c = setup(t); const { draft } = await ready(c);
  const results = await Promise.allSettled([c.workflow.send(draft.id, approval(draft)), c.workflow.send(draft.id, approval(draft))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(c.sends(), 1);
});
test('edited draft requires fresh approval', async t => {
  const c = setup(t); const { draft } = await ready(c);
  const old = approval(draft);
  c.workflow.editDraft(draft.id, { revision: draft.revision, content: '修改后的草稿' });
  await assert.rejects(c.workflow.send(draft.id, old), /审核/);
  assert.equal(c.sends(), 0);
});
test('account switch is blocked before publishing', async t => {
  const c = setup(t); const { draft } = await ready(c);
  c.xhs.login = async () => ({ is_logged_in: true, user_id: 'other-account' });
  await assert.rejects(c.workflow.send(draft.id, approval(draft)), /账号/);
  assert.equal(c.sends(), 0);
});
test('deleted or unloaded target is blocked', async t => {
  const c = setup(t); const { draft } = await ready(c);
  const original = c.xhs.detail.bind(c.xhs);
  c.xhs.detail = async n => ({ ...(await original(n)), comments: [] });
  await assert.rejects(c.workflow.send(draft.id, approval(draft)), /目标评论/);
  assert.equal(draft.status, 'pending');
  assert.equal(c.sends(), 0);
});
test('send outcome is uncertain on timeout and never auto-retried', async t => {
  const c = setup(t); const { draft } = await ready(c);
  let count = 0; c.xhs.send = async () => { count++; throw new Error('timeout'); };
  await assert.rejects(c.workflow.send(draft.id, approval(draft)), /不确定/);
  assert.equal(draft.status, 'uncertain');
  await assert.rejects(c.workflow.send(draft.id, approval(draft)), /已处理/);
  assert.equal(count, 1);
  c.workflow.resolve(draft.id, { confirm: true, result: 'sent' });
  assert.equal(draft.status, 'sent');
});
test('retired daily cap does not block writes, but the send switch still does', async t => {
  const c = setup(t); const { draft } = await ready(c);
  c.store.state.config.dailySendLimit = 0;
  c.store.state.config.sendingEnabled = false;
  await assert.rejects(c.workflow.send(draft.id, approval(draft)), /开关/);
  assert.equal(c.sends(), 0);
  c.store.state.config.sendingEnabled = true;
  c.store.state.drafts.push(...Array.from({ length: 12 }, (_, i) => ({ id: `old-${i}`, status: 'sent', sentAt: new Date().toISOString() })));
  await c.workflow.send(draft.id, approval(draft));
  assert.equal(c.sends(), 1);
  await assert.rejects(c.workflow.send(draft.id, approval(draft)), /已处理/);
});
test('demo cannot publish even with config switch on', async t => {
  const c = setup(t, { demo: true }); const { draft } = await ready(c);
  await assert.rejects(c.workflow.send(draft.id, approval(draft)), /演示模式/);
  assert.equal(c.sends(), 0);
});
test('restart recovers sending as uncertain and prevents concurrent owners', t => {
  const c = setup(t);
  assert.throws(() => new Store(c.dir), /另一个实例/);
  c.store.state.drafts.push({ id: 'interrupted', status: 'sending' }); c.store.save(); c.store.close();
  const recovered = new Store(c.dir);
  assert.equal(recovered.state.drafts[0].status, 'uncertain'); recovered.close();
});
test('config allowlist excludes secrets, enforces local server and numeric limits', () => {
  assert.throws(() => validateConfig({ xhsUrl: 'https://evil.example' }), /本机/);
  assert.throws(() => validateConfig({ xhsUrl: 'http://localhost:18060@evil.example' }), /本机/);
  assert.throws(() => validateConfig({ imageLimit: -1 }), /之间/);
  const cfg = validateConfig({ dailySendLimit: 0, apiKey: 'secret', __proto__: { polluted: true } });
  assert.equal(cfg.dailySendLimit, undefined); assert.equal(cfg.apiKey, undefined);
  assert.equal(cfg.polluted, undefined);
});
test('Beijing date rolls over at UTC 16:00', () => {
  assert.equal(shanghaiDay('2026-10-20T15:59:59Z'), '2026-10-20');
  assert.equal(shanghaiDay('2026-10-20T16:00:00Z'), '2026-10-21');
});
test('normalizes upstream nested detail and subcomments, rejects mismatched IDs', () => {
  const candidate = { id: 'note-1', token: 'token' };
  const data = { data: { note: { noteId: 'note-1', title: '标题', desc: '正文',
    imageList: [{ urlDefault: 'https://sns-webpic-qc.xhscdn.com/image' }], user: { nickName: '作者' } },
    comments: { list: [{ id: 'c1', content: '一级', userInfo: { userId: 'u1', nickname: '读者' },
      subCommentCount: '2', subComments: [{ id: 'c2', content: '二级', userInfo: { userId: 'u2' } }] }], hasMore: false } } };
  const note = normalizeDetail(data, candidate);
  assert.equal(note.comments[1].parentId, 'c1');
  assert.equal(note.commentsPartial, true);
  assert.equal(note.author.name, '作者');
  assert.equal(note.images.length, 1);
  assert.throws(() => normalizeDetail(data, { id: 'other' }), /不同笔记/);
  assert.equal(safeImageUrl('http://127.0.0.1/private'), '');
  assert.equal(safeImageUrl('https://xhscdn.com.evil.example/a'), '');
});
test('feed parsing filters non-note cards, ranking refuses fabricated IDs', () => {
  const rows = normalizeFeeds({ feeds: [{ id: '1', modelType: 'note', xsecToken: 't', noteCard: { displayTitle: '标题' } },
    { id: '2', modelType: 'live_v2', noteCard: {} }] });
  assert.equal(rows.length, 1);
  assert.throws(() => validateRanking({ items: [{ id: 'invented', score: 20, reason: 'fake' }] }, rows), /无效/);
});
test('DeepSeek request sends images only on vision model and validates output', async () => {
  let body;
  const model = new DeepSeek({ model: 'deepseek-flash', imageLimit: 1 }, 'test-secret', async (_url, request) => {
    body = JSON.parse(request.body);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      summary: '摘要', points: ['要点'], evidence: [], limitations: [], recommendation: '建议',
    }) } }] });
  });
  const note = { title: '标题', body: '内容', type: 'video', comments: [], commentsPartial: true, images: ['https://x.xhscdn.com/a', 'https://x.xhscdn.com/b'], imageCount: 2 };
  const result = await model.read(note, {});
  assert.equal(body.messages[1].content.length, 2);
  assert.equal(result.imagesProvided, 1);
  assert.ok(result.limitations.some(x => x.includes('视频')));
  assert.ok(result.limitations.some(x => x.includes('1/2')));
  model.config.model = 'deepseek-v4-pro';
  await model.read(note, {});
  assert.equal(typeof body.messages[1].content, 'string');
});
test('upstream API errors are sanitized and write endpoint matches comment type', async () => {
  let called;
  const xhs = new XhsClient({ xhsUrl: 'http://127.0.0.1:18060' }, '', async (url, req) => {
    called = { url, body: JSON.parse(req.body) };
    return Response.json({ success: true, data: { success: true } });
  });
  await xhs.send({ commentId: 'c1', content: '回复', target: { author: { id: 'u' } } }, { id: 'n', token: 't' });
  assert.ok(called.url.endsWith('/feeds/comment/reply'));
  assert.equal(called.body.comment_id, 'c1');
  xhs.fetcher = async () => Response.json({ error: 'Cookie=secret' }, { status: 401 });
  await assert.rejects(xhs.login(), e => e.message.includes('鉴权') && !e.message.includes('secret'));
});
test('HTTP app: CSRF, cross-origin guard, key redaction, demo full flow and publish refusal', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-http-test-'));
  const app = await startServer({ port: 0, demo: true, dataDir: dir });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const session = await fetch(`${app.url}/api/session`).then(r => r.json());
  const post = (route, body, extra = {}) => fetch(`${app.url}/api${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-xhs-csrf': session.csrf, ...extra }, body: JSON.stringify(body),
  });
  assert.equal((await fetch(`${app.url}/api/state`)).status, 403);
  assert.equal((await fetch(`${app.url}/api/session`, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await post('/settings', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/settings', { apiKey: 'secret-value' })).status, 200);
  const saved = await fetch(`${app.url}/api/state`, { headers: { 'x-xhs-csrf': session.csrf } }).then(r => r.text());
  assert.ok(!saved.includes('secret-value'));
  const { id } = await post('/runs', { keyword: '阅读' }).then(r => r.json());
  await app.workflow.task;
  const note = app.workflow.run(id).notes[0];
  const d = await post('/drafts', { runId: id, noteId: note.id }).then(r => r.json());
  assert.equal((await post('/drafts/send', { id: d.id, ...approval(d) })).status, 403);
});
