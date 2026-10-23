import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const defaults = {
  xhsUrl: 'http://127.0.0.1:18060',
  model: 'deepseek-flash',
  interests: '',
  excludes: '广告带货,纯搬运',
  candidateLimit: 15,
  shortlistLimit: 5,
  deepReadLimit: 3,
  imageLimit: 6,
  commentLimit: 20,
  sendingEnabled: false,
  replyStyle: '简洁、自然、具体。根据原帖与评论回答，不编造自己的经历。',
};

export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function text(value, max = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
export function validateConfig(input, previous = defaults) {
  const out = { ...previous };
  // Ignore the retired daily cap, including values saved by older versions.
  delete out.dailySendLimit;
  for (const k of ['interests', 'excludes', 'replyStyle']) {
    if (k in input) out[k] = text(input[k], 1500);
  }
  if ('model' in input) {
    if (!['deepseek-flash', 'deepseek-v4-pro'].includes(input.model)) throw new AppError('请选择支持的 DeepSeek 模型');
    out.model = input.model;
  }
  if ('xhsUrl' in input) {
    let url;
    try { url = new URL(input.xhsUrl); } catch { throw new AppError('小红书服务地址无效'); }
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
      throw new AppError('小红书服务必须使用本机 HTTP 地址，例如 http://127.0.0.1:18060');
    }
    out.xhsUrl = url.origin;
  }
  const ranges = { candidateLimit: [1, 30], shortlistLimit: [1, 8], deepReadLimit: [1, 5],
    imageLimit: [0, 9], commentLimit: [5, 50] };
  for (const [k, [min, max]] of Object.entries(ranges)) {
    if (!(k in input)) continue;
    const v = Number(input[k]);
    if (!Number.isInteger(v) || v < min || v > max) throw new AppError(`${k} 必须在 ${min}～${max} 之间`);
    out[k] = v;
  }
  if ('sendingEnabled' in input) {
    if (typeof input.sendingEnabled !== 'boolean') throw new AppError('发送开关无效');
    out.sendingEnabled = input.sendingEnabled;
  }
  return out;
}

export class Store {
  constructor(dir) {
    this.dir = path.resolve(dir);
    fs.mkdirSync(this.dir, { recursive: true });
    // One owner per data directory. A second process must not bypass send serialization.
    this.lockPath = path.join(this.dir, 'instance.lock');
    try { this.acquireLock(); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(this.lockPath, 'utf8'));
      let alive = true;
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw new AppError('该数据目录已由另一个实例使用，请使用已打开的页面', 409);
      fs.unlinkSync(this.lockPath);
      this.acquireLock();
    }
    try {
      this.state = this.read('state.json', { config: { ...defaults }, runs: [], drafts: [], events: [] });
      this.state.config = validateConfig(this.state.config);
      for (const d of this.state.drafts) if (d.status === 'sending') {
        d.status = 'uncertain';
        d.error = '上次发送期间程序退出。请先在小红书核对，程序不会自动重发。';
      }
      this.save();
    } catch (e) { this.close(); throw e; }
  }
  acquireLock() { fs.writeFileSync(this.lockPath, String(process.pid), { flag: 'wx' }); }
  close() {
    try { if (fs.readFileSync(this.lockPath, 'utf8') === String(process.pid)) fs.unlinkSync(this.lockPath); } catch {}
  }
  read(name, fallback) {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return fallback; throw new AppError(`${name} 无法读取，请恢复备份后再启动`, 500); }
  }
  write(name, value) {
    const file = path.join(this.dir, name);
    const temp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  save() { this.write('state.json', this.state); }
  secrets() {
    const saved = this.read('secrets.json', {});
    return { apiKey: process.env.DEEPSEEK_API_KEY || saved.apiKey || '',
      xhsToken: process.env.XHS_AUTH_TOKEN || saved.xhsToken || '' };
  }
  saveSettings(body) {
    const cfg = validateConfig(body.config || {}, this.state.config);
    const secrets = this.read('secrets.json', {});
    for (const k of ['apiKey', 'xhsToken']) if (text(body[k], 2000)) secrets[k] = text(body[k], 2000);
    if (body.clearApiKey === true) delete secrets.apiKey;
    if (body.clearXhsToken === true) delete secrets.xhsToken;
    this.write('secrets.json', secrets);
    this.state.config = cfg;
    this.save();
    return this.settings();
  }
  settings() {
    const secrets = this.secrets();
    return { config: this.state.config, hasApiKey: !!secrets.apiKey, hasXhsToken: !!secrets.xhsToken,
      apiKeyFromEnvironment: !!process.env.DEEPSEEK_API_KEY };
  }
  event(kind, data = {}) {
    this.state.events.unshift({ id: randomUUID(), at: new Date().toISOString(), kind, ...data });
    this.state.events = this.state.events.slice(0, 500);
    this.save();
  }
}

export function shanghaiDay(iso = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(iso));
}
