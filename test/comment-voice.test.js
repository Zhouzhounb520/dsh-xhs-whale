import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DeepSeek } from '../lib/model.js';
import { wakePrompt, skipPrompt, listenPrompt } from '../lib/fish/prompts.js';
import { AGENTS_MD } from '../lib/fish/agents.js';
import { COMMENT_VOICE, WHALE_PERSONA } from '../lib/fish/voice.js';

test('wake, skip and incoming replies share the whale persona and original comment voice', () => {
  const cfg = { persona: { name: '测试主人的小鲸鱼', ownerTitle: '主人', selfClaim: '本鲸' } };
  for (const prompt of [wakePrompt({ cfg }), skipPrompt({ cfg }), listenPrompt({ cfg })]) {
    assert.ok(prompt.includes(WHALE_PERSONA));
    assert.ok(prompt.includes(COMMENT_VOICE));
    assert.match(prompt, /自称「本鲸」/);
  }
  for (const instructions of [AGENTS_MD, fs.readFileSync(new URL('../fish/AGENTS.md', import.meta.url), 'utf8')]) {
    assert.ok(instructions.includes(WHALE_PERSONA));
    assert.ok(instructions.includes(COMMENT_VOICE));
  }
});

test('both manual draft routes receive original comment voice without changing analysis instructions', async () => {
  const requests = [];
  const model = new DeepSeek({ model: 'deepseek-flash' }, 'test-key', async (_url, request) => {
    requests.push(JSON.parse(request.body));
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{"content":"这个细节也太用心了！"}' } }] }) };
  });
  const note = { title: '手作分享', body: '作品制作记录', comments: [] };
  await model.draft(note, null, '自然');
  await model.draft(note, { id: 'c1', text: '谢谢喜欢' }, '自然');
  for (const request of requests) {
    assert.ok(request.messages[1].content.includes(COMMENT_VOICE));
    assert.ok(!request.messages[0].content.includes(WHALE_PERSONA));
  }
});
