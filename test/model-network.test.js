import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeek } from '../lib/model.js';

test('model distinguishes network permissions, DNS, TLS and real timeouts without leaking details', async () => {
  const cases = [
    [new TypeError('private detail', { cause: Object.assign(new Error('secret'), { code: 'EACCES' }) }), /网络访问.*拒绝/, 502],
    [new TypeError('private detail', { cause: new AggregateError([Object.assign(new Error('secret'), { code: 'EPERM' })]) }), /网络访问.*拒绝/, 502],
    [new DOMException('private detail', 'TimeoutError'), /响应超时/, 504],
    [new TypeError('private detail', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }), /响应超时/, 504],
    [new TypeError('private detail', { cause: { code: 'ENOTFOUND' } }), /域名/, 502],
    [new TypeError('private detail', { cause: { code: 'CERT_HAS_EXPIRED' } }), /证书校验/, 502],
    [new TypeError('private detail', { cause: { code: 'ECONNRESET' } }), /无法连接/, 502],
  ];
  for (const [error, message, status] of cases) {
    let requests = 0;
    const model = new DeepSeek({model:'deepseek-flash'}, 'test-secret', async () => { requests++; throw error; });
    await assert.rejects(model.test(), e => {
      assert.match(e.message, message); assert.equal(e.status, status);
      assert.doesNotMatch(e.message, /private detail|secret/); return true;
    });
    assert.equal(requests, 1);
  }
});

test('timeout while reading response body is reported as a timeout', async () => {
  const model = new DeepSeek({model:'deepseek-flash'}, 'test-secret', async () => ({
    ok:true, json:async () => { throw new DOMException('private detail', 'TimeoutError'); },
  }));
  await assert.rejects(model.test(), e => e.status === 504 && /响应超时/.test(e.message));
});

test('authentication and balance errors have actionable messages without echoing API response', async () => {
  for (const [status, message] of [[401,/密钥/], [402,/余额不足/]]) {
    const model = new DeepSeek({model:'deepseek-flash'}, 'test-secret', async () =>
      new Response('upstream-secret', {status}));
    await assert.rejects(model.test(), e => message.test(e.message) && !e.message.includes('secret'));
  }
});
