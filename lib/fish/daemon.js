import { shanghaiClock, windowsOf } from './clock.js';

/**
 * 收件箱守护（工作台进程内）。
 *
 * 为什么放在工作台而不是插件里：拉通知要开浏览器，而浏览器归工作台的上游服务管；
 * 工作台还持有数据目录锁，是唯一能写 fish-state.json 的进程。
 *
 * 定期把"谁回复了你"收进收件箱、核验累计留言，并在满足条件时每轮推进一项自动回访。
 * 叫醒会话是插件的事（插件只读 revision）。这样"发现"和"叫醒"解耦，
 * 插件挂了不会漏消息，工作台挂了也不会打扰会话。
 */
export function startFishDaemon(fish, { log = () => {}, intervalMs = 30_000 } = {}) {
  let stopped = false;
  let timer = null;
  let running = false;

  function inWindow(cfg, minutes) {
    return windowsOf(cfg).some(w => (w.wrap
      ? minutes >= w.start || minutes < w.end - 1440
      : minutes >= w.start && minutes < w.end));
  }

  async function tick() {
    if (stopped || running) return;
    if (fish.workflow.store.state.verification) return;
    let cfg;
    try { cfg = fish.config(); } catch { return; }
    if (!cfg.enabled || !cfg.listen?.enabled) return;
    if (!cfg.listen.allDay && !inWindow(cfg, shanghaiClock().minutes)) return;
    if (fish.workflow.busy) return;         // 不和用户的搜索/发送抢浏览器
    running = true;
    try {
      const result = await fish.scanInbox();
      if (result?.fresh) log(`[fish] 收件箱新增 ${result.fresh} 条（待回 ${result.pending}）`);
      // 每轮最多回访一人；无需先直回评论，草稿策略也不会吞掉已满足的回访条件。
      const pending = fish.pendingVisits().items[0];
      if (pending && fish.config().visit.enabled && !stopped) {
        const visit = await fish.visit({ commentId: pending.commentId });
        if (visit.visited) log(`[fish] 回访 ${pending.name || pending.userId}：${visit.status || visit.reason}`);
      }
    } catch (e) {
      // 验证码/限流/页面改版都到这里：记一笔，下一轮再来，绝不重试刷屏
      log(`[fish] 收件箱扫描失败：${String(e?.message ?? e).slice(0, 160)}`);
    } finally {
      running = false;
    }
  }

  timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
  const boot = setTimeout(() => { tick().catch(() => {}); }, 20_000);

  return {
    tick,
    stop() {
      stopped = true;
      clearInterval(timer);
      clearTimeout(boot);
    },
  };
}
