import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../lib/store.js';
import { Workflow } from '../lib/workflow.js';
import { DemoXhs, DemoModel } from '../lib/demo.js';
import { Fish } from '../lib/fish/service.js';
import { startFishDaemon } from '../lib/fish/daemon.js';
import { ManualVerification, VerificationRequiredError, sessionCookies, verificationUrl } from '../lib/verification.js';
import { startServer } from '../lib/server.js';

const cookie = { name: 'web_session', value: 'private-old-session', domain: '.xiaohongshu.com', path: '/', secure: true, httpOnly: true, expires: -1 };
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-verify-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function fixture(t) {
  const dir = temporary(t), store = new Store(dir);
  const xhs = new DemoXhs();
  const workflow = new Workflow(store, { clients: () => ({ xhs, model: new DemoModel() }) });
  t.after(() => store.close());
  return { dir, store, xhs, workflow };
}
function browserMock(dir) {
  fs.writeFileSync(path.join(dir, 'cookies.json'), JSON.stringify([cookie]));
  const calls = [], children = [];
  let saveError = false;
  const connection = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'Storage.getCookies') {
        if (saveError) throw new Error('private transport error');
        return { cookies: [{ ...cookie, value: 'private-new-session' }, { ...cookie, domain: '.example.com' }] };
      }
      return {};
    }, close() {},
  };
  const options = {
    serviceDir: dir, findBrowser: () => 'mock-chrome.exe', connect: async () => connection,
    launch: (_exe, args, options) => {
      assert.equal(options.windowsHide, false);
      const profile = args.find(a => a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
      fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), '12345\n/devtools/browser/test-id\n');
      const child = new EventEmitter(); child.kill = () => child.emit('exit'); children.push(child); return child;
    },
  };
  return { options, calls, children, failSave: () => { saveError = true; } };
}

test('risk pause stops fish fallback/search/feed and survives workbench restart', async t => {
  const { dir, store, workflow, xhs } = fixture(t);
  const fish = new Fish({ dataDir: dir, workflow });
  fish.saveConfig({ feed: { filters: true } });
  let searches = 0, feeds = 0;
  xhs.search = async () => { searches++; throw new VerificationRequiredError('疑似验证'); };
  xhs.feed = async () => { feeds++; return []; };
  await assert.rejects(fish.run({ topic: '游戏', n: 5 }), e => e.code === 'XHS_VERIFICATION_REQUIRED');
  assert.equal(searches, 1); assert.equal(feeds, 0);
  assert.equal(store.state.runs[0].status, 'waiting_verification');
  assert.equal(store.state.verification.keyword, '北京 游戏');
  await assert.rejects(fish.run({ topic: '游戏' }), e => e.code === 'XHS_VERIFICATION_REQUIRED');
  store.close();
  const restored = new Store(dir);
  try {
    const other = new Workflow(restored, { clients: () => ({ xhs }) });
    assert.throws(() => other.start({ keyword: '游戏' }), e => e.code === 'XHS_VERIFICATION_REQUIRED');
    assert.equal(searches, 1);
  } finally { restored.close(); }
});

test('paused daemon does not scan notifications', async t => {
  const { dir, workflow } = fixture(t);
  workflow.pauseForVerification(new VerificationRequiredError());
  const fish = new Fish({ dataDir: dir, workflow });
  fish.saveConfig({ listen: { enabled: true, allDay: true } });
  let scans = 0; fish.scanInbox = async () => { scans++; };
  const daemon = startFishDaemon(fish);
  await daemon.tick(); daemon.stop();
  assert.equal(scans, 0);
});

test('manual verification imports session, opens a trusted URL, backs up and saves only on user confirmation', async t => {
  const { dir, workflow, store } = fixture(t);
  const mock = browserMock(dir);
  const manual = new ManualVerification({ workflow, ...mock.options });
  workflow.pauseForVerification(new VerificationRequiredError(), { keyword: '北京 & 游戏' });
  await manual.open(); await manual.open();
  assert.equal(mock.children.length, 1);
  assert.equal(mock.calls[0].method, 'Storage.setCookies');
  const url = new URL(mock.calls[1].params.url);
  assert.equal(url.origin, 'https://www.xiaohongshu.com');
  assert.equal(url.searchParams.get('keyword'), '北京 & 游戏');
  assert.ok(store.state.verification);
  await assert.rejects(manual.complete({}), /亲自完成/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'cookies.json')))[0].value, 'private-old-session');
  await manual.complete({ confirm: true });
  assert.equal(store.state.verification, null);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'cookies.json')));
  assert.equal(saved.length, 1); assert.equal(saved[0].value, 'private-new-session');
  assert.ok(fs.readdirSync(dir).some(name => name.includes('.before-verification-')));
  assert.equal(JSON.stringify(workflow.snapshot()).includes('private-new-session'), false);
  assert.equal(manual.status().open, false);
});

test('closing or failing to save the verification window never clears the pause', async t => {
  const { dir, workflow, store } = fixture(t), mock = browserMock(dir);
  const manual = new ManualVerification({ workflow, ...mock.options });
  await manual.open(); mock.failSave();
  await assert.rejects(manual.complete({ confirm: true }));
  assert.ok(store.state.verification);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'cookies.json')))[0].value, 'private-old-session');
  mock.children[0].emit('exit');
  assert.equal(manual.status().open, false);
  assert.ok(store.state.verification);
  await manual.open(); await manual.close();
  assert.ok(store.state.verification);
  await assert.rejects(manual.complete({ confirm: true }), /先打开/);
});

test('verification startup failure keeps pause; invalid domains are not transferred', async t => {
  const { dir, workflow, store } = fixture(t), mock = browserMock(dir);
  const manual = new ManualVerification({ workflow, ...mock.options, findBrowser: () => { throw new Error('private-path'); } });
  await assert.rejects(manual.open(), e => !e.message.includes('private-path'));
  assert.ok(store.state.verification);
  assert.deepEqual(sessionCookies([{ ...cookie, domain: 'evilxiaohongshu.com' }, { ...cookie, domain: 'xiaohongshu.com.evil.test' }]), []);
  assert.equal(new URL(verificationUrl('https://evil.test')).host, 'www.xiaohongshu.com');
});

test('verification HTTP actions require CSRF and explicit completion; no session cookies reach the UI', async t => {
  const dir = temporary(t), mock = browserMock(dir);
  const app = await startServer({ port: 0, dataDir: path.join(dir, 'state'), clients: () => ({ xhs: new DemoXhs(), model: new DemoModel() }), verificationOptions: mock.options });
  t.after(() => app.close());
  const csrf = (await fetch(`${app.url}/api/session`).then(r => r.json())).csrf;
  const post = (route, body, authenticated = true) => fetch(`${app.url}/api/verification/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { 'x-xhs-csrf': csrf } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post('open', {}, false)).status, 403);
  assert.equal((await post('open', {})).status, 200);
  assert.equal((await post('complete', {})).status, 400);
  const state = await fetch(`${app.url}/api/state`, { headers: { 'x-xhs-csrf': csrf } }).then(r => r.json());
  assert.ok(state.verification); assert.equal(state.verificationWindow.open, true);
  assert.equal(JSON.stringify(state).includes('private-old-session'), false);
  assert.equal((await post('complete', { confirm: true })).status, 200);
});
