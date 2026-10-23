import { shanghaiDay } from '../store.js';

/**
 * "今天的事实"：已发多少条、几天没人理。quotaFor 名称保留以兼容调用方。
 *
 * 工作台（写状态）和 DSH 插件（只读状态、写提示词）都要用同一把尺子，
 * 所以把它从 Fish 类里抽成纯函数。只统计，不据此限制发送。
 */
const DAY_MS = 86_400_000;

export function sharesToday(state, today = shanghaiDay()) {
  return (state?.shares || []).filter(s => s?.at && shanghaiDay(s.at) === today).length;
}

export function repliesToday(state, today = shanghaiDay()) {
  return Object.values(state?.replied || {})
    .filter(r => r?.status === 'sent' && r?.at && shanghaiDay(r.at) === today).length;
}

/**
 * 沉默天数：主人最近一次在评论里出现距今天数。
 * 从没出现过 → 从第一次分享算；连分享都没有 → 0 天（新鱼不算"没人理"）。
 */
export function silentDays(state, now = Date.now()) {
  let ref = state?.lastOwnerContactAt ? new Date(state.lastOwnerContactAt).getTime() : null;
  if (!ref && state?.shares?.length) ref = new Date(state.shares[0].at).getTime();
  if (!ref || !Number.isFinite(ref)) return 0;
  return Math.max(0, Math.floor((now - ref) / DAY_MS));
}

export function quotaFor(cfg, state, now = Date.now()) {
  const days = silentDays(state, now);
  const shares = sharesToday(state, shanghaiDay(new Date(now)));
  const replies = repliesToday(state, shanghaiDay(new Date(now)));
  return {
    unlimited: true, sharesToday: shares, repliesToday: replies,
    silentDays: days, band: days >= 7 ? 'faint' : days >= 3 ? 'quiet' : 'normal',
  };
}

/** 提示词里的今日发送记录。 */
export function todayLine({ quota, inbox = {}, plan }) {
  const bits = [
    `这是今天第 ${Number(plan?.wakes ?? 0) + 1} 次醒`,
    `今天已评论 ${quota.sharesToday} 条、回复 ${quota.repliesToday} 条（不设每日上限）`,
    `待回评论 ${inbox.pending ?? 0} 条`,
  ];
  return bits.join(' · ') + '。';
}
