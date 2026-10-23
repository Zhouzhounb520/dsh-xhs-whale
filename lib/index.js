import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.js';
import { startFishScheduler } from './scheduler.js';
import { fishPaths, readFishConfig, readJson } from './fish/config.js';
import { quotaFor } from './fish/facts.js';
import { describePlan } from './fish/clock.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

/**
 * 找真正的 node.exe。
 *
 * 插件跑在 DSH 的 Electron 里，process.execPath 是 Harness.exe —— 拿它跑 .mjs 不行。
 * 所以依次看：环境变量 DSH_NODE → DSH 自带运行时 → PATH 里的 node。
 * 找不到也不致命：养鱼命令会由会话用自己的 shell 执行，`fish.cmd` 里会退回 "node"。
 */
function findNode() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const candidates = [
    process.env.DSH_NODE,
    path.join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    'node',
  ];
  for (const candidate of candidates) {
    try { if (candidate && (candidate === 'node' || fs.existsSync(candidate))) return candidate; } catch {}
  }
  return 'node';
}

/** 给 DSH 设置页/工作台用的养鱼快照。只读文件，绝不启动或修改任何东西。 */
function fishSnapshot(dataDir) {
  const cfg = readFishConfig(dataDir);
  const state = readJson(fishPaths(dataDir).state, {}) || {};
  const clock = readJson(fishPaths(dataDir).clock, null);
  const selftest = readJson(fishPaths(dataDir).selftest, null);
  return {
    enabled: !!cfg.enabled,
    plan: clock,
    planText: describePlan(clock),
    quota: quotaFor(cfg, state),
    inbox: { revision: Number(state.revision ?? 0), pending: (state.inbox || []).filter(i => !state.replied?.[i.comment?.id]).length },
    selftestPassed: !!selftest?.ok,
    fishDir: path.join(PROJECT_ROOT, 'fish'),
    dataDir,
  };
}

export default {
  name: 'dsh-xhs-whale',
  // 一个数组写全：对象字面量里写两个 inject 键，后者会覆盖前者（bili-whale 踩过）。
  inject: ['webServer', 'connection', 'sessionController'],
  async apply(ctx) {
    let app;
    let error = '';
    let url = 'http://127.0.0.1:18061';
    // DSH 重启时，上一个进程可能还没释放 18061。这时"起不来"不该变成永久错误：
    // 隔 2 秒重试几次；每次都先确认是不是已经有别的工作台在跑（有就复用）。
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const existing = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) }).then(r => r.json()).catch(() => null);
        if (existing?.app === 'dsh-xhs-whale' && existing?.demo === false) { error = ''; break; }
        app = await startServer();
        url = app.url;
        error = '';
        break;
      } catch (e) {
        error = e.code === 'EADDRINUSE'
          ? '18061 端口被其他程序占用，请先停止冲突的程序。'
          : String(e.message);
        if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    const dataDir = app?.dataDir || path.join(PROJECT_ROOT, 'data', 'live');
    let sched = null;
    try {
      sched = startFishScheduler(ctx, {
        dataDir,
        projectRoot: PROJECT_ROOT,
        nodeExe: findNode(),
        sessionId: 'xhs-whale',
        log: (message) => { try { console.log(message); } catch {} },
      });
    } catch (e) {
      try { console.warn('[dsh-xhs-whale] 养鱼生物钟启动失败：' + e.message); } catch {}
    }

    const trusted = (req, res) => {
      try {
        const connection = ctx.get?.('connection') || ctx.connection;
        if (!connection?.requestRejection) { res.writeHead(503); res.end(); return false; }
        const rejection = connection.requestRejection(req);
        if (rejection !== undefined && rejection !== null && rejection !== false) { res.writeHead(403); res.end(); return false; }
        return true;
      } catch { if (!res.headersSent) res.writeHead(503); res.end(); return false; }
    };

    const disposeWorkbench = ctx.webServer.register({
      kind: 'exact', path: '/dsh-xhs/api/workbench',
      handler: (req, res) => {
        if (!trusted(req, res)) return;
        if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: !error, url, error }));
      },
    });

    // 养鱼状态：DSH 设置页那一小块「今天醒了几次 / 已发多少条」就读它。
    const disposeFish = ctx.webServer.register({
      kind: 'exact', path: '/dsh-xhs/api/fish',
      handler: (req, res) => {
        if (!trusted(req, res)) return;
        try {
          const body = JSON.stringify({
            ok: !error, url, error,
            ...fishSnapshot(dataDir),
            scheduler: sched?.status() ?? null,
          });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(body);
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: String(e.message).slice(0, 200) }));
        }
      },
    });

    // 「立刻醒一轮」：不等到点，直接按当前配置叫醒一次 —— 装完先验证链路用。
    const disposeWake = ctx.webServer.register({
      kind: 'exact', path: '/dsh-xhs/api/fish/wake',
      handler: (req, res) => {
        if (!trusted(req, res)) return;
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        try {
          if (!sched) throw new Error('生物钟没有启动（sessionController 不可用？）');
          const r = sched.wakeNow();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, ...r }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: String(e.message).slice(0, 200) }));
        }
      },
    });

    ctx.effect(() => () => {
      try { sched?.stop(); } catch {}
      for (const dispose of [disposeWorkbench, disposeFish, disposeWake]) {
        try { dispose?.(); } catch {}
      }
      if (app) void app.close();
    });
    console.log(`[dsh-xhs-whale] ${error || `工作台：${url}`}`);
  },
};
