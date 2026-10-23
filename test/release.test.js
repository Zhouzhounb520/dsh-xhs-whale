import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPublicFile, collectReleaseFiles } from '../tools/release-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('release contains embedded Go sources and hidden GitHub metadata, not local runtime files', () => {
  const files = collectReleaseFiles(root);
  const names = new Set(files.map(f => f.name));
  for (const name of ['.github/workflows/ci.yml', '.gitignore', '.env.example', 'LICENSE',
    'upstream/xiaohongshu-mcp/LICENSE', 'upstream/xiaohongshu-mcp/go.mod',
    'upstream/xiaohongshu-mcp/browser/browser_version.txt',
    'upstream/xiaohongshu-mcp/xiaohongshu/checked_comment_match.js']) assert.ok(names.has(name), name);
  for (const name of names) assert.ok(!/^(data|vendor|output|dist|test-results)\//.test(name), name);
  assert.ok(!names.has('fish/fish.cmd'));
});
test('release scan rejects credential values and private file names without echoing values', () => {
  const secret = 'sk-' + 'a'.repeat(32);
  assert.throws(() => assertPublicFile('lib/example.js', `const key = '${secret}'`), error => !error.message.includes(secret));
  for (const name of ['data/live/state.json', 'cookies.json.backup-1', 'docs/secrets.json', '.env', 'vendor/service.exe']) {
    assert.throws(() => assertPublicFile(name, ''));
  }
  assert.doesNotThrow(() => assertPublicFile('.env.example', 'DEEPSEEK_API_KEY='));
});
test('release does not follow source directory links', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-release-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const fixture = path.join(temp, 'fixture');
  fs.mkdirSync(fixture);
  for (const { name, data } of collectReleaseFiles(root)) {
    if (name.includes('/') && name !== 'fish/AGENTS.md') continue;
    const dest = path.join(fixture, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }
  // Windows directory junctions need no symlink privilege. Do not traverse either kind.
  fs.symlinkSync(path.join(root, 'lib'), path.join(fixture, 'lib'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => collectReleaseFiles(fixture), /Symbolic link rejected/);
});
