import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the exact embedded matcher shipped in the Go service against DOM-shaped
// fixtures for the observed top-level / list-container / reply-prefix structure.
const source = fs.readFileSync(new URL('../upstream/xiaohongshu-mcp/xiaohongshu/checked_comment_match.js', import.meta.url), 'utf8');
function item(id, { thread, sub = false, author = 'fish', name = '小鲸鱼', body = '你好', recipient = '' } = {}) {
  const node = {
    id: 'comment-' + id,
    classList: { contains: cls => cls === 'comment-item-sub' && sub },
    closest: () => thread,
    querySelector: selector => ({
      '.author [data-user-id]': { getAttribute: () => author },
      '.author .name': { textContent: name },
      '.content': {
        textContent: (recipient ? `回复 ${recipient} : ` : '') + body,
        querySelector: s => s === '.nickname' ? (recipient ? { textContent: recipient } : null) : s === '.note-text' ? {
          cloneNode: () => ({ textContent: body, querySelectorAll: () => [] }),
        } : null,
      },
    })[selector] || null,
  };
  return node;
}
function match(nodes, parent = '', body = '你好', mentions = []) {
  const document = {
    getElementById: id => nodes.find(n => n.id === id),
    querySelectorAll: () => nodes,
  };
  const fn = vm.runInNewContext(source, { document });
  return Array.from(fn('fish', body, parent, mentions));
}

test('checked reply ignores platform reply prefix but verifies author, thread and recipient', () => {
  const thread = {}, other = {};
  const target = item('target', { thread, sub: true, author: 'owner', name: '测试主人' });
  const good = item('new', { thread, sub: true, recipient: '测试主人' });
  const wrongThread = item('wrong-thread', { thread: other, sub: true, recipient: '测试主人' });
  const wrongRecipient = item('wrong-person', { thread, sub: true, recipient: '其他人' });
  const wrongAuthor = item('wrong-author', { thread, sub: true, recipient: '测试主人', author: 'someone' });
  assert.deepEqual(match([target, good, wrongThread, wrongRecipient, wrongAuthor], 'target'), ['new']);
});
test('checked top-level reply cannot be confused with a nested reply or top-level comment', () => {
  const thread = {};
  const root = item('root', { thread, author: 'owner' });
  const direct = item('direct', { thread, sub: true });
  const nested = item('nested', { thread, sub: true, recipient: '小鲸鱼' });
  const top = item('top', { thread });
  assert.deepEqual(match([root, direct, nested, top], 'root'), ['direct']);
  assert.deepEqual(match([root, direct, nested, top]), ['top']);
  assert.deepEqual(match([root, direct, nested, top], 'missing'), []);
});
test('checked matcher does not strip authored text or accept unverified mentions', () => {
  const top = item('top', { body: '回复 测试主人 : 你好' });
  assert.deepEqual(match([top]), []);
  assert.deepEqual(match([top], '', '回复 测试主人 : 你好'), ['top']);
  assert.deepEqual(match([top], '', '回复 测试主人 : 你好', [{ id: 'owner', name: '测试主人' }]), []);
});
