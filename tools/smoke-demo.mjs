import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-demo-'));
let app;
try {
  app = await startServer({ port: 0, demo: true, dataDir: dir });
  const health = await fetch(`${app.url}/health`).then(r => r.json());
  assert.equal(health.ok, true);
  assert.equal(health.demo, true);
  const page = await fetch(app.url).then(r => r.text());
  assert.match(page, /小红书/);
  const session = await fetch(`${app.url}/api/session`).then(r => r.json());
  const response = await fetch(`${app.url}/api/state`, { headers: { 'x-xhs-csrf': session.csrf } });
  assert.equal(response.status, 200);
  console.log('PASS: isolated demo health, HTML, session and state. No account or model calls.');
} finally {
  if (app) await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
