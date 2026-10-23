import fs from 'node:fs';
import path from 'node:path';
import {
  fishPaths, readFishConfig, readJson, writeJson, formatHHMM,
} from './fish/config.js';
import { CLOCK_VERSION, shanghaiClock, computePlan, planIsStale, windowsOf, describePlan } from './fish/clock.js';
import { quotaFor, todayLine } from './fish/facts.js';
import { shanghaiDay } from './store.js';
import { classifyNotification } from './fish/classify.js';
import { wakePrompt, skipPrompt, listenPrompt, FISH_COMMAND } from './fish/prompts.js';
import { AGENTS_MD } from './fish/agents.js';

const TICK_MS = 30_000;
const LISTEN_MS = 20_000;

/**
 * 自主生物钟（插件侧）。
 *
 * 它做的事只有一件：**到点往养鱼会话里塞一个回合** ——
 *   sessionController.prompt({ sessionId, mode:'queue', content:[{type:'text', text}] })
 *
 * 为什么不是"定时任务跑脚本"：那样鱼只会执行，不会"过日子"。
 * 叫醒一个会话，她才能自己决定看什么、说不说、写什么日记。
 *
 * 进程分工（很重要）：
 *   · 工作台进程写 fish.json / fish-state.json（配置、收件箱、互动记录）
 *   · 本文件所在的 DSH 插件进程**只写 fish-clock.json**（计划与"提示过没有"）
 *   · 两个进程不写同一个文件，所以不需要锁；插件也永远不碰数据目录锁
 *
 * 失效安全：
 *   · sessionController 不存在 → 只记一次警告，绝不让插件启动失败
 *   · 叫醒失败 → 不标记 fired，下一个 tick 重试
 *   · 配置坏了 → 退回默认值（readFishConfig 永不抛）
 */
export function startFishScheduler(ctx, opts) {
  const {
    dataDir,
    projectRoot,
    nodeExe = 'node',
    sessionId = 'xhs-whale',
    log = () => {},
  } = opts || {};
  if (!dataDir || !projectRoot) throw new Error('startFishScheduler 需要 dataDir 与 projectRoot');

  const paths = fishPaths(dataDir);
  const fishDir = path.join(projectRoot, 'fish');
  const cmdName = process.platform === 'win32' ? 'fish.cmd' : 'fish.sh';
  const commandLine = process.platform === 'win32'
    ? `@echo off\r\nrem 由 dsh-xhs-whale 生成：养鱼会话的命令入口（改了会被下次启动覆盖）\r\n"${nodeExe}" "${path.join(projectRoot, 'tools', 'fish.mjs')}" %*\r\n`
    : `#!/bin/sh\n# 由 dsh-xhs-whale 生成：养鱼会话的命令入口\nexec "${nodeExe}" "${path.join(projectRoot, 'tools', 'fish.mjs')}" "$@"\n`;

  const readClock = () => {
    try { return readJson(paths.clock, null); } catch { return null; }
  };
  const writeClock = (value) => {
    try { writeJson(paths.clock, value); } catch (e) { log(`[xhs-whale] 计划写入失败：${String(e.message).slice(0, 120)}`); }
  };

  /** 养鱼会话自己的目录：AGENTS.md + 命令入口。每次启动对齐一次，幂等。 */
  let filesReady = false;
  function ensureFiles() {
    if (filesReady) return;
    try {
      fs.mkdirSync(fishDir, { recursive: true });
      const agents = path.join(fishDir, 'AGENTS.md');
      if (!fs.existsSync(agents)) fs.writeFileSync(agents, AGENTS_MD, 'utf8');
      const cmd = path.join(fishDir, cmdName);
      let current = '';
      try { current = fs.readFileSync(cmd, 'utf8'); } catch {}
      if (current !== commandLine) {
        fs.writeFileSync(cmd, commandLine, process.platform === 'win32' ? 'utf8' : { mode: 0o755 });
      }
      filesReady = true;
    } catch (e) {
      log(`[xhs-whale] 养鱼目录准备失败：${String(e.message).slice(0, 140)}`);
    }
  }

  let sessionReady = false;
  async function ensureSession() {
    if (sessionReady) return;
    const sc = ctx.sessionController;
    if (!sc) throw new Error('sessionController 不可用');
    if (typeof sc.create === 'function') {
      try { await sc.create({ sessionId, cwd: fishDir }); } catch { /* 已存在就忽略 */ }
    }
    sessionReady = true;
  }

  async function speak(text, kind) {
    await ensureSession();
    await ctx.sessionController.prompt({
      requestId: `${sessionId}-${kind}-${Date.now()}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, new AbortController().signal);
  }

  /** 提示词要的"今天的事实"：发送记录、沉默天数、待回条数、自检有没有跑过。 */
  function factsFor(cfg, state, clock) {
    const quota = quotaFor(cfg, state);
    const ids = { selfId: String(state?.selfId ?? ''), ownerId: String(cfg.reply?.ownerUserId ?? '') };
    const inbox = { pending: 0, owner: 0, stranger: 0 };
    for (const raw of state?.inbox || []) {
      const c = classifyNotification({ type: raw.type, comment_id: raw.comment?.id, from: { user_id: raw.from?.id } }, ids);
      if (!c.postable || state?.replied?.[raw.comment?.id]) continue;
      inbox.pending++;
      if (c.role === 'owner') inbox.owner++;
      else inbox.stranger++;
    }
    const prevDays = Number(clock?.silenceSeen?.days ?? NaN);
    const recovered = Number.isFinite(prevDays) && prevDays >= 3 && quota.silentDays < 3 ? prevDays : null;
    // 点赞额度：和评论分开记账（fish-state.likes 里是"笔记 ID → 点赞时间"）
    const today = shanghaiDay();
    const likesToday = Object.values(state?.likes || {}).filter(at => shanghaiDay(at) === today).length;
    const likeDaily = Math.max(0, Number(cfg.like?.daily ?? 10));
    return {
      like: { left: Math.max(0, likeDaily - likesToday), daily: likeDaily },
      silentDays: quota.silentDays,
      recovered,
      asked: false,
      inbox,
      today: todayLine({ quota, inbox, plan: clock }),
      selftestPassed: !!readJson(paths.selftest, null)?.ok,
    };
  }

  let waking = false;
  const configStamp = () => { try { return fs.statSync(paths.config).mtimeMs; } catch { return 0; } };
  let cfgStamp = configStamp();
  /** 到点没有：优先用绝对时间（跨午夜窗口靠它），老计划才退回分钟比较。 */
  const isDue = (plan) => {
    if (Number.isFinite(Number(plan?.atMs))) return Date.now() >= Number(plan.atMs);
    return shanghaiClock().minutes >= Number(plan?.at ?? 0);
  };

  async function tick() {
    if (readJson(path.join(dataDir, 'state.json'), {})?.verification) return;
    if (waking) return;
    if (!ctx.sessionController) return;
    let cfg;
    try { cfg = readFishConfig(dataDir); } catch { return; }
    if (!cfg.enabled) return;
    ensureFiles();

    const clock = readClock();
    const { date, minutes } = shanghaiClock();

    // 配置被保存过（跨进程：插件只认文件的修改时间）→ 清掉旧计划，下一 tick 按新配置重算。
    const stamp = configStamp();
    if (stamp !== cfgStamp) {
      cfgStamp = stamp;
      if (clock?.date === date) {
        writeClock({
          date, wakes: Number(clock.wakes ?? 0), usedCount: clock.usedCount ?? {},
          lastPromptedRevision: Number(clock.lastPromptedRevision ?? 0),
          lastListenPromptAt: Number(clock.lastListenPromptAt ?? 0),
        });
        log('[xhs-whale] 养鱼配置已更新 → 今天计划重算');
        return;
      }
    }

    // 升级时恢复旧版提前收工的计划；离线错过的窗口不会在窗口外补发。
    if (clock && (clock.version !== CLOCK_VERSION || (!clock.manual && !clock.fired
      && Number.isFinite(clock.windowEndMs) && Date.now() >= clock.windowEndMs))) {
      writeClock(computePlan({ cfg, state: clock }));
      return;
    }

    // ① 掷到「不看」：到点也要叫醒她写日记（skip 不消耗醒来次数）
    if (clock?.date === date && clock.action === 'skip' && !clock.fired && isDue(clock)) {
      waking = true;
      try {
        const state = readJson(paths.state, {});
        const facts = factsFor(cfg, state, clock);
        await speak(skipPrompt({ cfg, plan: clock, facts }), 'skip');
        writeClock({ ...clock, fired: true,
          skippedWindows: { ...clock.skippedWindows, [clock.window]: true },
          silenceSeen: { days: facts.silentDays, at: new Date().toISOString() } });
        log(`[xhs-whale] 这一趟不看 → 已叫醒写日记 · ${clock.reason ?? ''}`);
      } catch (e) {
        log(`[xhs-whale] 不看那趟叫醒失败：${String(e.message).slice(0, 140)}（下一 tick 重试）`);
      } finally { waking = false; }
      return;
    }
    // 还没到点的 skip 计划：等它，不要重算（重算会把 at 一路顺延，永远追不上）
    if (clock?.date === date && clock.action === 'skip' && !clock.fired) return;
    // 今天已经收工：不要再每 30 秒重算一次写盘
    if (clock?.date === date && clock.action === 'done') return;

    // ② 计划该重算了：跨天 / 没有动作 / 上一次已经醒过 / 已经收工
    if (planIsStale(clock, date)) {
      const plan = computePlan({ cfg, state: clock ?? {} });
      writeClock(plan);
      log(`[xhs-whale] 计划：${describePlan(plan)}`);
      return;
    }

    // ③ 到点 → 叫醒
    if (clock.action === 'wake' && !clock.fired && isDue(clock)) {
      waking = true;
      try {
        const state = readJson(paths.state, {});
        const facts = factsFor(cfg, state, clock);
        await speak(wakePrompt({ cfg, plan: clock, facts }), 'wake');
        // 额度在这里消耗（不是排计划时）：保存设置导致的重排不应该吃掉醒来次数。
        const usedCount = { ...(clock.usedCount || {}) };
        const label = String(clock.window || '');
        if (label) usedCount[label] = (Number(usedCount[label]) || 0) + 1;
        writeClock({
          ...clock, fired: true, woke: true, usedCount,
          wakes: Number(clock.wakes ?? 0) + 1, wokeAt: new Date().toISOString(),
          silenceSeen: { days: facts.silentDays, at: new Date().toISOString() },
        });
        log(`[xhs-whale] 生物钟叫醒 · ${clock.atText ?? ''}${clock.window ? '（' + clock.window + '）' : ''} · 第 ${Number(clock.wakes ?? 0) + 1} 次`);
      } catch (e) {
        log(`[xhs-whale] 叫醒失败：${String(e.message).slice(0, 160)}（下一 tick 重试）`);
      } finally { waking = false; }
    }
  }

  function inWindow(cfg, minutes) {
    return windowsOf(cfg).some((w) => (w.wrap
      ? minutes >= w.start || minutes < w.end - 1440
      : minutes >= w.start && minutes < w.end));
  }

  let listening = false;
  async function listenTick() {
    if (readJson(path.join(dataDir, 'state.json'), {})?.verification) return;
    if (listening) return;
    if (!ctx.sessionController) return;
    let cfg;
    try { cfg = readFishConfig(dataDir); } catch { return; }
    if (!cfg.enabled || !cfg.listen?.enabled) return;

    const clock = readClock();
    let state;
    try { state = readJson(paths.state, {}) || {}; } catch { return; }
    const revision = Number(state.revision ?? 0);
    if (!(revision > Number(clock?.lastPromptedRevision ?? 0))) return;

    const { minutes } = shanghaiClock();
    if (!cfg.listen.allDay && !inWindow(cfg, minutes)) return;
    if (Date.now() - Number(clock?.lastListenPromptAt ?? 0) < 120_000) return;

    const ids = { selfId: String(state.selfId ?? ''), ownerId: String(cfg.reply?.ownerUserId ?? '') };
    const items = (state.inbox || [])
      .map(raw => {
        const c = classifyNotification({ type: raw.type, comment_id: raw.comment?.id, from: { user_id: raw.from?.id } }, ids);
        return { ...raw, role: c.role, kind: c.kind, postable: c.postable, replyable: c.replyable };
      })
      .filter(it => it.postable && !state.replied?.[it.comment?.id])
      .slice(0, 8);

    listening = true;
    try {
      // 没有能回的（只有点赞/关注/自己）：把版本号推平，别每 20 秒重复算
      if (!items.length) { writeClock({ ...(readClock() ?? {}), lastPromptedRevision: revision }); return; }
      await speak(listenPrompt({ cfg, items, facts: { count: items.length } }), 'listen');
      writeClock({ ...(readClock() ?? {}), lastPromptedRevision: revision, lastListenPromptAt: Date.now() });
      log(`[xhs-whale] 收件箱命中 ${items.length} 条（${items.map(i => i.role).join('、')}）→ 已叫醒`);
    } catch (e) {
      log(`[xhs-whale] 收件箱叫醒失败：${String(e.message).slice(0, 140)}`);
    } finally { listening = false; }
  }

  const timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  const timer2 = setInterval(() => { listenTick().catch(() => {}); }, LISTEN_MS);
  const boot = setTimeout(() => { ensureFiles(); tick().catch(() => {}); }, 8_000);
  const boot2 = setTimeout(() => { listenTick().catch(() => {}); }, 20_000);
  ensureFiles();   // 会话目录要先存在：create({cwd}) 不能指向一个还不存在的目录

  if (!ctx.sessionController) {
    log('[xhs-whale] 没有 sessionController：生物钟不会叫醒任何会话（插件其余功能不受影响）');
  } else {
    log(`[xhs-whale] 养鱼生物钟已启动（每 ${TICK_MS / 1000}s tick · 会话 ${sessionId} · 命令 ${FISH_COMMAND}）`);
  }

  return {
    /** 设置页保存后调用：清掉旧计划、按新配置重算；同时别让刚保存就立刻叫醒。 */
    invalidate() {
      const clock = readClock();
      const { date } = shanghaiClock();
      let revision = 0;
      try { revision = Number(readJson(paths.state, {})?.revision ?? 0); } catch {}
      writeClock(clock?.date === date
        ? { date, wakes: Number(clock.wakes ?? 0), usedCount: clock.usedCount ?? {}, lastPromptedRevision: revision, lastListenPromptAt: Date.now() }
        : { date, lastPromptedRevision: revision, lastListenPromptAt: Date.now() });
      cfgStamp = configStamp();
      tick().catch(() => {});
      listenTick().catch(() => {});
    },
    /** 「立刻醒一轮」：不等窗口，按当前配置马上叫醒一次，用来验证整条链路。 */
    async wakeNow() {
      const clock = readClock() || {};
      const { date, minutes } = shanghaiClock();
      const plan = {
        version: CLOCK_VERSION, date, action: 'wake', fired: false, at: minutes, atAbs: minutes, atMs: Date.now(),
        atText: formatHHMM(minutes),
        wakes: clock.date === date ? Number(clock.wakes ?? 0) : 0,
        usedCount: clock.date === date ? (clock.usedCount ?? {}) : {},
        window: '手动', withinWindow: '手动叫醒（不等窗口）', manual: true,
        lastPromptedRevision: Number(clock.lastPromptedRevision ?? 0),
        lastListenPromptAt: Number(clock.lastListenPromptAt ?? 0),
      };
      writeClock(plan);
      // 手动叫醒抢在"配置已更新 → 清计划"之前：先把配置戳对齐，
      // 否则刚保存设置就点「立刻醒一轮」会被下一次 tick 当成旧配置清掉。
      cfgStamp = configStamp();
      ensureFiles();
      await tick();
      const after = readClock();
      return { ok: after?.fired === true, planText: describePlan(plan) };
    },
    status() {
      const clock = readClock();
      return { plan: clock, planText: describePlan(clock), sessionId, fishDir, command: `${cmdName}` };
    },
    tick,
    listenTick,
    stop() {
      clearInterval(timer); clearInterval(timer2);
      clearTimeout(boot); clearTimeout(boot2);
    },
  };
}
