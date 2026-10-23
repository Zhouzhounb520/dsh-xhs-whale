import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, AppError } from '../lib/store.js';
import { Workflow } from '../lib/workflow.js';
import { DemoModel, DemoXhs } from '../lib/demo.js';
import { XhsClient } from '../lib/xhs.js';
import { Fish } from '../lib/fish/service.js';
import { validateFishConfig, FISH_DEFAULTS } from '../lib/fish/config.js';

const owner = { id: '111111111111111111111111', name: '测试主人', red_id: '10000000001', avatar: 'https://sns-avatar-qc.xhscdn.com/avatar/owner' };
const reply = data => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const client = fetcher => new XhsClient({ xhsUrl: 'http://127.0.0.1:18060' }, '', fetcher);
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-comment-'));
  const store = new Store(dir);
  store.state.config.sendingEnabled = true;
  const xhs = new DemoXhs();
  const workflow = new Workflow(store, { clients: () => ({ xhs, model: new DemoModel() }) });
  const fish = new Fish({ dataDir: dir, workflow });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { id } = workflow.start({ keyword: '测试' });
  await workflow.task;
  const note = workflow.run(id).notes[0];
  return { store, workflow, xhs, fish, note };
}

test('capability probe supports legacy plain-text 404 but never degrades a real mention', async () => {
  const xhs = client(async () => new Response('404 page not found', { status: 404 }));
  await xhs.prepare({ mentions: [] });
  assert.equal(xhs.checkedComments, false);
  await assert.rejects(xhs.prepare({ mentions: [owner] }), /不支持真实 @/);
});

test('direct reply dry run checks the actual target editor and never creates a draft', async t => {
  const { fish, xhs, store, note } = await fixture(t);
  fish.saveConfig({ reply: { strangerPolicy: 'direct' } });
  fish.saveState({ ...fish.state(), inbox: [{
    id: 'reply-preview', notificationId: 'reply-preview', type: 'comment/item',
    from: { id: 'other', name: '读者' }, comment: { id: 'target-comment', text: '你好' },
    feed: { id: note.id, token: note.token, title: note.title },
  }] });
  let calls = 0;
  xhs.previewComment = async (draft, target) => {
    calls++;
    assert.equal(draft.commentId, 'target-comment');
    assert.equal(target.id, note.id);
    assert.deepEqual(draft.mentions, []);
    return { dry: true, stage: 'ready', certainty: 'not_sent', success: true };
  };
  const before = store.state.drafts.length;
  const result = await fish.reply({ commentId: 'target-comment', content: '你好呀', dry: true });
  assert.equal(result.preparation.stage, 'ready');
  assert.equal(calls, 1);
  assert.equal(store.state.drafts.length, before);
  xhs.previewComment = async () => { throw new Error('editor unavailable'); };
  await assert.rejects(fish.reply({ commentId: 'target-comment', content: '你好呀', dry: true }), /editor unavailable/);
  assert.equal(store.state.drafts.length, before);
});

test('checked delivery distinguishes pre-submit failure from ambiguous writes and hides raw details', async () => {
  for (const [stage, certainty, delivery] of [['input','not_sent','not_sent'], ['submit','not_sent','uncertain'], ['confirm','uncertain','uncertain']]) {
    const xhs = client(async () => reply({ success:false, stage, certainty, reason:'secret-token' }));
    await assert.rejects(xhs.request('/feeds/comment/checked', {}), e => {
      assert.equal(e.delivery, delivery); assert.equal(e.stage, stage);
      assert.ok(!e.message.includes('secret-token')); return true;
    });
  }
});

test('checked preview and send keep mention metadata separate from plain text', async () => {
  const requests=[];
  const xhs=client(async (url, init) => {
    if(url.endsWith('/capabilities')) return reply({checked_comments:1,real_mentions:1});
    requests.push(JSON.parse(init.body));
    return reply(requests.at(-1).dry ? {success:true,dry:true,stage:'ready'} : {success:true,dry:false,stage:'confirm',certainty:'sent',comment_id:'new-comment',mention_verified:true});
  });
  const draft={content:'有具体内容的评论',account:{id:'self'},mentions:[owner]};
  await xhs.previewComment(draft,{id:'note',token:'private'});
  await xhs.send(draft,{id:'note',token:'private'});
  assert.deepEqual(requests.map(r=>r.dry),[true,false]);
  assert.deepEqual(requests[0].mentions,[owner]);
  assert.equal(requests[0].content,draft.content);
});

test('known pre-submit failure is unsent and does not consume publishing quota', async t => {
  const c=await fixture(t);
  const d=await c.workflow.addDraft({note:c.note,content:'测试正文'});
  c.xhs.send=async()=>{throw Object.assign(new AppError('编辑器未激活'),{delivery:'not_sent',stage:'activate'});};
  await assert.rejects(c.workflow.send(d.id,{confirm:true,revision:d.revision,content:d.content}),/编辑器/);
  assert.equal(d.status,'not_sent'); assert.equal(d.sentAt,undefined); assert.equal(d.failureStage,'activate');
  const next=await c.workflow.addDraft({note:c.note,content:'新草稿'});
  assert.notEqual(next.id,d.id);
});

test('uncertain comment stays blocked; no automatic second write', async t => {
  const c=await fixture(t); let calls=0;
  const d=await c.workflow.addDraft({note:c.note,content:'测试正文'});
  c.xhs.send=async()=>{calls++;throw Object.assign(new AppError('提交后无法核验'),{delivery:'uncertain',stage:'confirm'});};
  const approval={confirm:true,revision:d.revision,content:d.content};
  await assert.rejects(c.workflow.send(d.id,approval));
  await assert.rejects(c.workflow.send(d.id,approval));
  assert.equal(calls,1);assert.equal(d.status,'uncertain');assert.ok(d.sentAt);
});

test('a draft edited during capability probe is not published', async t => {
  const c=await fixture(t);let sends=0;
  const d=await c.workflow.addDraft({note:c.note,content:'测试正文'});
  c.xhs.prepare=async()=>c.workflow.editDraft(d.id,{revision:d.revision,content:'已修改'});
  c.xhs.send=async()=>{sends++;return {success:true};};
  await assert.rejects(c.workflow.send(d.id,{confirm:true,revision:d.revision,content:d.content}),/核验期间发生变化/);
  assert.equal(sends,0);assert.equal(d.status,'pending');
});

test('owner resolution binds exact public ID, classifies owner by profile ID, and previews without sending', async t => {
  const c=await fixture(t);let calls=0,preview;
  c.fish.saveConfig({reply:{ownerUserId:owner.red_id},share:{enabled:true,mentionOwner:true}});
  c.xhs.resolveOwner=async q=>{calls++;assert.equal(q,owner.red_id);return owner;};
  c.xhs.previewComment=async(d,n)=>{preview={d,n};return {success:true,dry:true,stage:'ready',mention_prepared:true};};
  const result=await c.fish.comment({noteId:c.note.id,content:'测试正文',dry:true});
  assert.equal(calls,1);assert.equal(c.fish.ids().ownerId,owner.id);
  assert.equal(result.preparation.stage,'ready');assert.equal(preview.d.mentions[0].avatar,owner.avatar);
  assert.equal(c.store.state.drafts.length,0);
});

test('mismatched owner result is rejected and changing public ID clears cached identity', async t => {
  const c=await fixture(t);
  c.fish.saveConfig({reply:{ownerUserId:'wrong'}});
  c.xhs.resolveOwner=async()=>owner;
  await assert.rejects(c.fish.resolveOwner(),/不一致/);
  const prior=validateFishConfig({reply:{ownerUserId:owner.red_id,ownerProfileId:owner.id,ownerNickname:owner.name,ownerAvatar:owner.avatar}},FISH_DEFAULTS);
  const next=validateFishConfig({reply:{ownerUserId:'new'}},prior);
  assert.equal(next.reply.ownerProfileId,''); assert.equal(next.reply.ownerAvatar,'');
});

test('owner changed while resolving cannot inherit a previous account binding', async t => {
  const c=await fixture(t);
  c.fish.saveConfig({reply:{ownerUserId:owner.red_id}});
  c.xhs.resolveOwner=async()=>{c.fish.saveConfig({reply:{ownerUserId:'different'}});return owner;};
  await assert.rejects(c.fish.resolveOwner(),/核实期间改变/);
  assert.equal(c.fish.config().reply.ownerProfileId,'');
});

test('checked comment login overlay triggers the existing manual verification pause', async () => {
  let paused=false;
  const xhs=new XhsClient({xhsUrl:'http://127.0.0.1:18060'},'',async()=>reply({success:false,stage:'navigate',certainty:'not_sent',needs_verification:true}),{onVerification:()=>{paused=true;}});
  await assert.rejects(xhs.request('/feeds/comment/checked',{}), e=>e.delivery==='not_sent' && /人工验证/.test(e.message));
  assert.equal(paused,true);
});
