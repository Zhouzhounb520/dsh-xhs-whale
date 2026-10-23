import { parseHHMM, formatHHMM } from './config.js';

/**
 * 生物钟：今天醒几次、几点醒、这一趟看不看。
 *
 * 移植自 dsh-bili-whale 的 whale-night.mjs，语义逐条保留：
 *   · 窗口固定、**时刻随机**（机器才准点）
 *   · 每个窗口先完成最低醒来次数，剩余机会才掷 skipChance
 *   · 跳过只结束当前窗口，不结束当天后续窗口；skip 不消耗真正醒来次数
 *   · 跨午夜窗口（end <= start，例如 22:00→02:00）按 [start, 1440+end) 处理
 *
 * 时区固定 Asia/Shanghai：这个项目所有"每日额度"都按北京时间算（store.shanghaiDay），
 * 生物钟必须用同一把尺子，否则跨时区/跨零点会出现"额度已经算今天、生物钟还算昨天"。
 */
export const FISH_TZ = 'Asia/Shanghai';
export const CLOCK_VERSION = 2;
export const minimumWakesPerWindow = cfg => Math.min(12, Math.max(0,
  Math.round(Number(cfg?.night?.minWakesPerWindow ?? 1) || 0)));

export function shanghaiClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: FISH_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = type => Number(parts.find(p => p.type === type)?.value);
  const hour = get('hour') % 24;
  return {
    date: `${get('year')}-${String(get('month')).padStart(2, '0')}-${String(get('day')).padStart(2, '0')}`,
    minutes: hour * 60 + get('minute'),
  };
}

/** 窗口规范化：返回分钟区间的列表，跨午夜窗口的 end 会大于 1440。 */
export function windowsOf(cfg) {
  const list = Array.isArray(cfg?.night?.windows) && cfg.night.windows.length
    ? cfg.night.windows
    : [{ start: '20:00', end: '24:00', wakes: 1 }];
  return list
    .map((w) => {
      const start = parseHHMM(w.start);
      let end = parseHHMM(w.end);
      if (start === null || end === null) return null;
      if (end <= start) end += 1440;             // 跨午夜
      return {
        start, end,
        wrap: end > 1440,
        label: `${w.start}–${w.end}`,
        wakes: Math.max(minimumWakesPerWindow(cfg), Math.max(0, Number(w.wakes ?? 1) || 0)),
      };
    })
    .filter(w => w && w.end > w.start);
}

export function maxWakesPerDay(cfg) {
  const windows = windowsOf(cfg);
  const sum = windows.reduce((total, w) => total + w.wakes, 0);
  const fallback = Number(cfg?.night?.maxWakesPerDay ?? 0) || windows.length;
  return Math.min(12, Math.max(0, sum || fallback));
}

export function wakesToday(state, today) {
  return state && state.date === today ? Number(state.wakes ?? 0) : 0;
}

/**
 * 算出今天当前这一趟的计划。纯函数：不会写文件，方便测试。
 * 返回对象的字段与 whale-night.mjs 的 plan 保持一致（fired/done/woke 由调用方维护）。
 */
export function computePlan({ cfg, state = {}, now = new Date(), random = Math.random } = {}) {
  const { date: today, minutes: nowMin } = shanghaiClock(now);
  const windows = windowsOf(cfg);
  const limit = maxWakesPerDay(cfg);
  const done = wakesToday(state, today);
  const minimum = minimumWakesPerWindow(cfg);
  const usedCount = state?.date === today && state?.usedCount && typeof state.usedCount === 'object'
    ? { ...state.usedCount } : {};
  const skippedWindows = state?.date === today ? { ...state.skippedWindows } : {};
  if (state?.date === today && state.action === 'skip' && state.fired && state.window) {
    skippedWindows[state.window] = true;
  }
  const base = { version: CLOCK_VERSION, date: today, wakes: done, usedCount, skippedWindows,
    createdAt: now.toISOString(), lastPromptedRevision: Number(state?.lastPromptedRevision ?? 0),
    lastListenPromptAt: Number(state?.lastListenPromptAt ?? 0) };
  if (limit === 0) {
    return { ...base, action: 'done', done: true, reason: '所有窗口的醒来次数都是 0 → 今天不醒' };
  }
  if (done >= limit && windows.every(w => Number(usedCount[w.label] || 0) >= minimum)) {
    return { ...base, action: 'done', done: true, reason: `今天已经醒了 ${done} 次（上限 ${limit}）` };
  }

  // 跨午夜窗口在任何时刻都算开放（它的"今天"可能从昨晚就开始了）
  const open = windows.filter(w => (w.wrap ? true : w.end > nowMin));
  if (!open.length) return { ...base, action: 'done', done: true, reason: '今天的窗口都过完了' };

  const pool = open.filter(w => {
    const used = Number(usedCount[w.label]) || 0;
    return used < w.wakes && (used < minimum || !skippedWindows[w.label]);
  });
  if (!pool.length) return { ...base, action: 'done', done: true, usedCount, reason: '所有窗口的醒来次数都用完了' };

  // 按实际结束时间选窗口，避免排到晚间后把尚未完成的早时段晾过去。
  const closingMinute = w => w.wrap && nowMin < w.end - 1440 ? w.end - 1440 : w.end;
  const sorted = pool.slice().sort((a, b) => {
    return closingMinute(a) - closingMinute(b) || (Number(usedCount[a.label]) || 0) - (Number(usedCount[b.label]) || 0);
  });
  const w = sorted[0];
  const nth = (Number(usedCount[w.label]) || 0) + 1;
  const withinWindow = `${w.label} 第 ${nth}/${w.wakes} 次`;
  const required = nth <= minimum;

  // 今天已有未投递的 skip 计划 → 必须沿用它的时刻。
  // 否则每次 tick 都重新随机、at 被不断顺延 → 永远追不上 → 永远不醒。
  const keepSkipAt = state?.date === today && state?.action === 'skip' && state?.fired !== true
    && Number.isFinite(Number(state.atMs)) && String(state.window ?? '') === String(w.label);

  // 选时刻：在"窗口剩余部分"里随机，且用**绝对分钟**表示跨午夜。
  //   nowAbs：如果当前在午夜后那段（00:00–tailEnd），把现在当作"昨天窗口的 1440+minutes"，
  //           否则就是今天的 minutes。这样窗口 [1320, 1560) 在任何时刻的比较都是单调的。
  //   旧实现把 at 折回 [0,1440)，再用 minutes 比较，跨午夜时会把"明天 01:36"误判成"已过去"。
  let atAbs;
  let atMs;
  if (keepSkipAt) {
    atAbs = Number(state.atAbs ?? state.at ?? 0);
    atMs = Number(state.atMs);
  } else {
    const tailEnd = w.end - 1440;
    const nowAbs = w.wrap && nowMin < tailEnd ? nowMin + 1440 : nowMin;
    const openStart = Math.max(w.start, nowAbs) + 1;
    const span = Math.max(1, w.end - openStart);
    atAbs = openStart + Math.floor(random() * span);
    if (atAbs >= w.end) atAbs = w.end - 1;
    // now 的毫秒数里含秒：按分钟差换算，误差 < 1 分钟，调度器每 30 秒 tick 一次足够。
    atMs = now.getTime() + (atAbs - nowAbs) * 60_000;
  }
  if (!Number.isFinite(atMs)) atMs = now.getTime() + 60_000;

  const nowAbs = w.wrap && nowMin < w.end - 1440 ? nowMin + 1440 : nowMin;
  const windowEndMs = now.getTime() - now.getSeconds() * 1000 - now.getMilliseconds() + (w.end - nowAbs) * 60_000;
  const common = {
    ...base, fired: false, at: ((atAbs % 1440) + 1440) % 1440, atAbs, atMs,
    atText: formatHHMM(atAbs), window: w.label, withinWindow, endAt: w.end, windowEndMs,
    minimum, required,
  };

  if (!required && random() < Number(cfg?.night?.skipChance ?? 0.3)) {
    return {
      ...common,
      action: 'skip',
      reason: `这次不想看（掷骰子掷到了「不看」那 ${Math.round((Number(cfg?.night?.skipChance ?? 0.3)) * 100)}%）`,
    };
  }

  // 注意：这里**不**把 usedCount 加一。额度只在"真的叫醒"时才消耗（scheduler 里加），
  // 否则用户每保存一次设置就重排一次计划，次数会被白白吃掉 —— 今天 18:00–20:00
  // 那个窗口一次没醒、20:00–22:00 却已经显示用了 2 次，就是这么来的。
  return { ...common, action: 'wake', roll: 'watch' };
}

/** 计划是否已经过期：跨天、没有动作、上一趟已经醒过、已经收工。 */
export function planIsStale(plan, today) {
  if (!plan) return true;
  if (plan.date !== today) return true;
  if (!plan.action) return true;
  if (plan.action === 'done') return true;
  if (plan.woke === true || plan.done === true) return true;
  return plan.action === 'skip';
}

export function describePlan(plan) {
  if (!plan) return '今天还没排计划';
  if (plan.action === 'done') return `${plan.date} → 今天不醒（${plan.reason ?? '次数用完了'}）`;
  const where = plan.window ? `（窗口 ${plan.window}${plan.withinWindow ? ' · ' + plan.withinWindow : ''}）` : '';
  const action = plan.action === 'skip' ? '不看' : '看小红书';
  return `${plan.date} → ${plan.atText ?? '?'} ${action}${where}${plan.fired ? ' · 已叫醒' : ''}`;
}
