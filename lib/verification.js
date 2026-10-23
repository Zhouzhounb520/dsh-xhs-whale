import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from './store.js';

export class VerificationRequiredError extends AppError {
  constructor(message = '小红书操作已暂停，请在工作台打开人工验证窗口，完成验证后保存并解除暂停。') {
    super(message, 409);
    this.code = 'XHS_VERIFICATION_REQUIRED';
  }
}

export function verificationUrl(keyword = '') {
  const url = new URL(keyword ? 'https://www.xiaohongshu.com/search_result' : 'https://www.xiaohongshu.com/explore');
  if (keyword) { url.searchParams.set('keyword', keyword); url.searchParams.set('source', 'web_explore_feed'); }
  return url.href;
}

// Only move this dedicated browser's Xiaohongshu cookies. Never return them to the UI/logs.
export function sessionCookies(rows) {
  if (!Array.isArray(rows)) throw new AppError('登录文件格式无效，请重新登录');
  return rows.filter(c => c && typeof c.name === 'string' && typeof c.value === 'string' &&
    typeof c.domain === 'string' && /(^|\.)xiaohongshu\.com$/i.test(c.domain.replace(/^\./, '')))
    .map(c => {
      const cookie = { name: c.name, value: c.value, domain: c.domain, path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly };
      if (['Strict', 'Lax', 'None'].includes(c.sameSite)) cookie.sameSite = c.sameSite;
      if (Number(c.expires) > 0) cookie.expires = Number(c.expires);
      return cookie;
    });
}

function browserExecutable() {
  const root = path.join(process.env.LOCALAPPDATA || '', 'xiaohongshu-mcp', 'browser');
  if (!process.env.LOCALAPPDATA || !fs.existsSync(root)) throw new AppError('未找到服务使用的浏览器，请先运行小红书服务安装和启动脚本');
  const versions = fs.readdirSync(root).filter(v => /^\d+(\.\d+)+$/.test(v)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const exe = path.join(root, version, 'browser', 'chrome.exe');
    if (fs.existsSync(exe)) return exe;
  }
  throw new AppError('未找到小红书服务的 chrome.exe，请先启动一次小红书服务');
}

// A small CDP transport used by our application for cookie transfer and opening a page.
// It does not inspect or solve challenges, click page controls, or scrape page contents.
class BrowserConnection {
  constructor(socket) {
    this.socket = socket; this.sequence = 0; this.pending = new Map();
    socket.addEventListener('message', event => {
      let data; try { data = JSON.parse(event.data); } catch { return; }
      const call = this.pending.get(data.id);
      if (!call) return;
      this.pending.delete(data.id); clearTimeout(call.timer);
      if (data.error) call.reject(new AppError('验证浏览器未能完成操作，请保留暂停并重新打开窗口'));
      else call.resolve(data.result || {});
    });
    socket.addEventListener('close', () => {
      for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(new AppError('验证窗口已关闭，请重新打开后完成验证')); }
      this.pending.clear();
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new AppError('无法连接验证浏览器')); }, 10000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new AppError('无法连接验证浏览器')); }, { once: true });
    });
    return new BrowserConnection(socket);
  }
  call(method, params = {}) {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new AppError('验证窗口已关闭，请重新打开'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new AppError('验证浏览器响应超时，仍保持暂停')); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.socket.close(); }
}

export class ManualVerification {
  constructor({ workflow, serviceDir, launch = spawn, connect = BrowserConnection.connect, findBrowser = browserExecutable }) {
    this.workflow = workflow; this.serviceDir = serviceDir;
    this.launch = launch; this.connect = connect; this.findBrowser = findBrowser;
    this.session = null; this.opening = false; this.finishing = false;
  }
  status() { return { open: !!this.session, opening: this.opening }; }
  async open() {
    if (this.workflow.demo) throw new AppError('演示模式不打开真实账号的验证窗口', 403);
    if (this.opening || this.finishing || this.workflow.busy) throw new AppError('请等待当前操作结束，再打开验证窗口', 409);
    if (this.session) return this.status();
    // This helper reads the cookie file of the bundled service, not arbitrary configured services.
    if (!['http://127.0.0.1:18060', 'http://localhost:18060'].includes(this.workflow.store.state.config.xhsUrl)) {
      throw new AppError('人工验证窗口仅支持本项目 18060 服务；其他服务请在其浏览器内验证');
    }
    this.workflow.pauseForVerification(new VerificationRequiredError('已进入人工验证模式，完成后请保存并解除暂停。'));
    this.opening = true;
    let child, connection;
    try {
      const exe = this.findBrowser();
      const cookiePath = path.join(this.serviceDir, 'cookies.json');
      const raw = JSON.parse(fs.readFileSync(cookiePath, 'utf8').replace(/^\uFEFF/, ''));
      const cookies = sessionCookies(Array.isArray(raw) ? raw : raw.cookies);
      if (!cookies.length) throw new AppError('没有可用的小红书登录状态，请先运行登录程序');
      // Unique profiles avoid reusing another browser process or stale DevToolsActivePort.
      const profile = path.join(this.serviceDir, `verification-${randomUUID()}`);
      fs.mkdirSync(profile, { recursive: true });
      let exited = false;
      child = this.launch(exe, [`--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore', windowsHide: false });
      child.once('error', () => { exited = true; });
      child.once('exit', () => { exited = true; if (this.session?.child === child) { this.session.connection.close(); this.session = null; } });
      let address;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (exited) throw new AppError('验证浏览器启动失败，请检查小红书浏览器安装');
        try {
          const [port, endpoint] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
          if (/^\d+$/.test(port) && /^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(endpoint)) { address = `ws://127.0.0.1:${port}${endpoint}`; break; }
        } catch { /* browser is starting */ }
        await delay(150);
      }
      if (!address) throw new AppError('验证浏览器启动超时，仍保持暂停');
      connection = await this.connect(address);
      await connection.call('Storage.setCookies', { cookies });
      const keyword = this.workflow.store.state.verification?.keyword || '';
      await connection.call('Target.createTarget', { url: verificationUrl(keyword) });
      if (exited) throw new AppError('验证窗口已关闭，请重新打开');
      this.session = { child, connection, cookiePath };
      return this.status();
    } catch (error) {
      connection?.close(); child?.kill();
      if (error instanceof AppError) throw error;
      throw new AppError('无法打开验证窗口，请检查登录文件和浏览器安装；自动操作仍暂停');
    } finally { this.opening = false; }
  }
  async complete({ confirm } = {}) {
    if (confirm !== true) throw new AppError('请先亲自完成验证，再确认保存');
    if (!this.session || this.opening || this.finishing) throw new AppError('请先打开验证窗口并完成验证', 409);
    this.finishing = true;
    try {
      const { connection, cookiePath } = this.session;
      const result = await connection.call('Storage.getCookies');
      const cookies = sessionCookies(result.cookies);
      if (!cookies.length) throw new AppError('窗口中没有小红书登录状态，仍保持暂停');
      const backup = `${cookiePath}.before-verification-${Date.now()}`;
      fs.copyFileSync(cookiePath, backup);
      const temporary = `${cookiePath}.${randomUUID()}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(cookies), { mode: 0o600 });
      fs.renameSync(temporary, cookiePath);
      await this.close();
      this.workflow.store.state.verification = null;
      this.workflow.store.event('verification_user_confirmed');
      return { ok: true, message: '已保存登录状态并解除暂停，后续定时任务可继续。失败的阅读任务请手动重新开始；尚未重新核验搜索结果。' };
    } finally { this.finishing = false; }
  }
  async close() {
    const session = this.session; this.session = null;
    if (!session) return;
    try { await session.connection.call('Browser.close'); } catch { session.child.kill(); }
    session.connection.close();
  }
}
