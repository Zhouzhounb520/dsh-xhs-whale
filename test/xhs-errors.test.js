import test from 'node:test';
import assert from 'node:assert/strict';
import { XhsClient } from '../lib/xhs.js';

test('upstream read deadline identifies the failed operation without echoing private details or retrying', async () => {
  let count = 0;
  const xhs = new XhsClient({xhsUrl:'http://127.0.0.1:18060'}, '', async () => {
    count++;
    return Response.json({error:'服务器内部错误', details:'context deadline exceeded; cookie=private-secret'}, {status:500});
  });
  await assert.rejects(xhs.search('游戏', {}), e => e.code === 'XHS_VERIFICATION_REQUIRED' && /搜索笔记超时/.test(e.message) && !e.message.includes('private-secret'));
  assert.equal(count, 1);
});

test('verification hooks pause subsequent reads and writes; generic HTTP 500 is not a confirmed challenge', async () => {
  let paused = false, calls = 0;
  const xhs = new XhsClient({ xhsUrl: 'http://127.0.0.1:18060' }, '', async () => {
    calls++;
    return Response.json({ error: '安全验证', details: 'private-token' }, { status: 403 });
  }, { beforeRequest: () => { if (paused) throw new Error('paused'); }, onVerification: () => { paused = true; } });
  await assert.rejects(xhs.search('北京'), e => e.code === 'XHS_VERIFICATION_REQUIRED' && !e.message.includes('private-token'));
  await assert.rejects(xhs.feed(), /paused/);
  await assert.rejects(xhs.send({ content: 'test' }, { id: 'n', token: 't' }), /paused/);
  assert.equal(calls, 1);
  const broken = new XhsClient({ xhsUrl: 'http://127.0.0.1:18060' }, '', async () => Response.json({ error: 'internal error' }, { status: 500 }));
  await assert.rejects(broken.search('北京'), e => !e.code && /HTTP 500/.test(e.message));
});

test('write deadline never recommends retrying a possibly successful comment', async () => {
  const xhs = new XhsClient({xhsUrl:'http://127.0.0.1:18060'}, '', async () =>
    Response.json({details:'context deadline exceeded'}, {status:500}));
  await assert.rejects(xhs.send({content:'test'}, {id:'n',token:'t'}), e =>
    /提交评论失败/.test(e.message) && !/重试/.test(e.message));
});

test('search omits default filters but preserves explicitly selected sort and time range', async () => {
  const requests = [];
  const xhs = new XhsClient({xhsUrl:'http://127.0.0.1:18060'}, '', async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json({success:true, data:{feeds:[]}});
  });
  await xhs.search('交友、游戏、玩乐', {sort_by:'综合', publish_time:'不限', note_type:'不限'});
  assert.deepEqual(requests[0], {keyword:'交友、游戏、玩乐'});
  await xhs.search('游戏', {sort_by:'最新', publish_time:'一周内', note_type:'不限'});
  assert.deepEqual(requests[1], {keyword:'游戏', filters:{sort_by:'最新', publish_time:'一周内'}});
});
