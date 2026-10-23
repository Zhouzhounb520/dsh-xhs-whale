import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, text } from '../store.js';

/**
 * 养鱼配置与文件布局。
 *
 * 与主配置分开存放的理由：主配置（state.json 里的 config）是"读什么"的参数，
 * 养鱼配置是"怎么过日子"的参数（作息、人设、互动开关、回复分流）。两者生命周期不同，
 * 而且 DSH 插件进程要在不拿数据目录锁的情况下**只读**它算生物钟 —— 独立文件最省事。
 *
 * 写者只有一个：工作台进程（设置页）。插件进程只读。
 */
export const FISH_DEFAULTS = {
  enabled: true,
  persona: { name: '小鲸鱼', ownerTitle: '主人', selfClaim: '我' },
  night: {
    windows: [{ start: '20:00', end: '24:00', wakes: 1 }],
    skipChance: 0.3,
    minWakesPerWindow: 1,
    maxWakesPerDay: 2,
  },
  topics: [],
  feed: {
    source: 'auto', candidates: 5, shortlist: 3, deep: 2,
    // 每轮先刷几条"同城"的：city 始终加入本地搜索关键词。
    local: { enabled: true, city: '北京', count: 3 },
    sort: '最新',
    publish: '一周内',
    // 平台筛选（排序/时间/位置）默认关闭：依赖搜索页的悬停浮层，
    // 上游只有"整次搜索 60 秒"一个死线，面板没弹出来就一路等到超时。
    filters: false,
  },
  share: { enabled: true, mentionOwner: false },
  // 点赞：和评论分开记账。同一篇只点一次；每天有上限（平台对点赞也有频控）。
  like: { enabled: true, daily: 10 },
  reply: { ownerUserId: '', ownerDirect: true, strangerPolicy: 'draft' },
  visit: { enabled: true, chance: 0.3, cooldownHours: 72 },
  listen: { enabled: true, intervalSec: 300, allDay: false, limit: 20 },
  diary: { push: true },
  notify: { type: 'workbench', url: '' },
};

export function fishPaths(dataDir) {
  const dir = path.resolve(dataDir);
  return {
    dir,
    config: path.join(dir, 'fish.json'),
    state: path.join(dir, 'fish-state.json'),
    clock: path.join(dir, 'fish-clock.json'),
    log: path.join(dir, 'fish-log.jsonl'),
    letter: path.join(dir, 'fish-diary.md'),
    private: path.join(dir, 'fish-diary-private.md'),
    selftest: path.join(dir, 'fish-selftest.json'),
  };
}

function readText(file) {
  // PowerShell 的 Set-Content -Encoding UTF8 会带 BOM；人工改过的 JSON 也常带。
  // JSON.parse 不认 BOM，这里统一剥掉，别让一个看不见的字符变成"配置坏了"。
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

export function readJson(file, fallback) {
  try { return JSON.parse(readText(file)); } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    // 配置损坏时不静默回退：调用方需要知道"这不是没配置，而是坏了"。
    throw new AppError(`${path.basename(file)} 无法读取，请恢复备份或删除后重新配置`, 500);
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}

const cloneValue = value => (value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value);

function merge(base, over) {
  // 深拷贝：调用方拿到的配置绝不能和 FISH_DEFAULTS 共用数组/对象，
  // 否则任何一次 push/unshift 都会改掉"默认值"，污染同进程里的其它实例。
  const out = cloneValue(base) ?? {};
  for (const [k, v] of Object.entries(over || {})) {
    if (v === undefined) continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(out[k] ?? {}, v) : cloneValue(v);
  }
  return out;
}

/** 宽松读取：给插件进程用，任何异常都退回默认值，绝不因为配置坏了而卡住生物钟。 */
export function readFishConfig(dataDir) {
  const file = fishPaths(dataDir).config;
  let user = {};
  try { user = JSON.parse(readText(file)) || {}; } catch { user = {}; }
  const config = { ...merge(FISH_DEFAULTS, user), __present: Object.keys(user).length > 0 };
  if (config.share) delete config.share.daily;
  if (config.reply) delete config.reply.daily;
  return config;
}

export function writeFishConfig(dataDir, value) {
  writeJson(fishPaths(dataDir).config, value);
}

const HHMM = /^([01]?\d|2[0-4]):([0-5]\d)$/;
export function parseHHMM(raw) {
  const m = String(raw ?? '').trim().match(HHMM);
  if (!m) return null;
  const h = Number(m[1]); const min = Number(m[2]);
  if (h === 24 && min !== 0) return null;
  return (h === 24 ? 1440 : h * 60) + min;
}
export function formatHHMM(minutes) {
  const m = ((Number(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 严格校验（设置页走这里）。只接受已知字段，越界一律报错而不是悄悄夹紧 ——
 * 作息窗口写错会让鱼整晚不醒，静默修正比报错更难查。
 */
export function validateFishConfig(input, previous = FISH_DEFAULTS) {
  const out = merge(previous, {});
  delete out.share.daily;
  delete out.reply.daily;
  if ('enabled' in input) {
    if (typeof input.enabled !== 'boolean') throw new AppError('enabled 必须是布尔值');
    out.enabled = input.enabled;
  }
  if ('persona' in input) {
    const p = input.persona || {};
    out.persona = {
      name: text(p.name ?? out.persona.name, 40),
      ownerTitle: text(p.ownerTitle ?? out.persona.ownerTitle, 20),
      selfClaim: text(p.selfClaim ?? out.persona.selfClaim, 20),
    };
  }
  if ('night' in input) {
    const n = input.night || {};
    const minimum = clampInt(n.minWakesPerWindow ?? out.night.minWakesPerWindow ?? 1, 0, 12, 1);
    const windows = Array.isArray(n.windows) ? n.windows : out.night.windows;
    if (!windows.length) throw new AppError('至少要有一个作息窗口');
    if (windows.length > 6) throw new AppError('作息窗口最多 6 个');
    const parsed = windows.map((w, i) => {
      const start = parseHHMM(w?.start);
      const end = parseHHMM(w?.end);
      if (start === null || end === null) throw new AppError(`第 ${i + 1} 个作息窗口的时间格式应为 HH:MM`);
      const wakes = clampInt(w?.wakes ?? 1, 0, 12, 1);
      if (wakes < minimum) throw new AppError(`第 ${i + 1} 个作息窗口的最多醒来次数不能少于最低 ${minimum} 次`);
      if (start === end) throw new AppError(`第 ${i + 1} 个作息窗口的开始与结束时间不能相同`);
      return { start: formatHHMM(start), end: formatHHMM(end), wakes };
    });
    const total = parsed.reduce((sum, w) => sum + w.wakes, 0);
    if (total > 12) throw new AppError('所有窗口的醒来次数合计不能超过 12');
    out.night = {
      windows: parsed,
      minWakesPerWindow: minimum,
      skipChance: Math.min(0.95, Math.max(0, Number(n.skipChance ?? out.night.skipChance) || 0)),
      maxWakesPerDay: clampInt(n.maxWakesPerDay ?? out.night.maxWakesPerDay, 0, 12, 2),
    };
  }
  if ('topics' in input) {
    // 主题是"一行一个"，但实际收到过三种写法：真换行、字面的 \n（复制粘贴/手打转义）、数组。
    // 三种都认，否则整个字符串会变成一个主题，搜索时等于没配。
    const slash = String.fromCharCode(92) + 'n';
    const raw = Array.isArray(input.topics) ? input.topics : [String(input.topics ?? '')];
    out.topics = raw
      .flatMap(t => String(t).split(slash).join('\n').split(/\r?\n/))
      .map(t => text(t, 40))
      .filter(Boolean)
      .slice(0, 20);
  }
  if ('feed' in input) {
    const f = input.feed || {};
    if (f.source !== undefined && !['auto', 'feed', 'search'].includes(f.source)) {
      throw new AppError('浏览来源只能是 auto / feed / search');
    }
    const sorts = ['综合', '最新', '最多点赞', '最多评论', '最多收藏'];
    const publishes = ['不限', '一天内', '一周内', '半年内'];
    if (f.sort !== undefined && !sorts.includes(f.sort)) throw new AppError(`排序只能是 ${sorts.join(' / ')}`);
    if (f.publish !== undefined && !publishes.includes(f.publish)) throw new AppError(`时间范围只能是 ${publishes.join(' / ')}`);
    const l = f.local || {};
    if (l.enabled !== undefined && typeof l.enabled !== 'boolean') throw new AppError('同城开关无效');
    if (f.filters !== undefined && typeof f.filters !== 'boolean') throw new AppError('平台筛选开关无效');
    const previousLocal = out.feed.local || {};
    out.feed = {
      source: f.source ?? out.feed.source,
      candidates: clampInt(f.candidates ?? out.feed.candidates, 1, 30, 5),
      shortlist: clampInt(f.shortlist ?? out.feed.shortlist, 1, 8, 3),
      deep: clampInt(f.deep ?? out.feed.deep, 0, 5, 2),
      // 同城条数不能把整轮占满：至少留 1 条给"非限地域"的结果，否则永远只看同城。
      local: {
        enabled: l.enabled ?? previousLocal.enabled ?? true,
        city: text(l.city ?? previousLocal.city ?? '', 20),
        count: clampInt(l.count ?? previousLocal.count ?? 3, 0, 10, 3),
      },
      sort: f.sort ?? out.feed.sort,
      publish: f.publish ?? out.feed.publish,
      filters: f.filters ?? out.feed.filters ?? false,
    };
  }
  if ('share' in input) {
    const s = input.share || {};
    if (s.enabled !== undefined && typeof s.enabled !== 'boolean') throw new AppError('分享开关无效');
    if (s.mentionOwner !== undefined && typeof s.mentionOwner !== 'boolean') throw new AppError('提及主人开关无效');
    out.share = {
      enabled: s.enabled ?? out.share.enabled,
      mentionOwner: s.mentionOwner ?? out.share.mentionOwner ?? false,
    };
  }
  if ('like' in input) {
    const l = input.like || {};
    if (l.enabled !== undefined && typeof l.enabled !== 'boolean') throw new AppError('点赞开关无效');
    out.like = {
      enabled: l.enabled ?? out.like.enabled,
      daily: clampInt(l.daily ?? out.like.daily, 0, 50, 10),
    };
  }
  if ('reply' in input) {
    const r = input.reply || {};
    if (r.strangerPolicy !== undefined && !['draft', 'direct', 'off'].includes(r.strangerPolicy)) {
      throw new AppError('陌生人的评论只能设为 draft / direct / off');
    }
    if (r.ownerDirect !== undefined && typeof r.ownerDirect !== 'boolean') throw new AppError('主人直回开关无效');
    const ownerChanged = r.ownerUserId !== undefined && text(r.ownerUserId, 100) !== out.reply.ownerUserId;
    out.reply = {
      ownerUserId: text(r.ownerUserId ?? out.reply.ownerUserId, 100),
      ownerProfileId: text(r.ownerProfileId ?? (ownerChanged ? '' : out.reply.ownerProfileId), 100),
      ownerNickname: text(r.ownerNickname ?? (ownerChanged ? '' : out.reply.ownerNickname), 100),
      ownerAvatar: text(r.ownerAvatar ?? (ownerChanged ? '' : out.reply.ownerAvatar), 1000),
      ownerDirect: r.ownerDirect ?? out.reply.ownerDirect,
      strangerPolicy: r.strangerPolicy ?? out.reply.strangerPolicy,
    };
  }
  if ('visit' in input) {
    const v = input.visit || {};
    if (v.enabled !== undefined && typeof v.enabled !== 'boolean') throw new AppError('回访开关无效');
    const chance = Number(v.chance ?? out.visit.chance);
    if (!Number.isFinite(chance) || chance < 0 || chance > 1) throw new AppError('回访概率必须在 0～100% 之间');
    out.visit = { enabled: v.enabled ?? out.visit.enabled, chance,
      cooldownHours: clampInt(v.cooldownHours ?? out.visit.cooldownHours, 1, 720, 72) };
  }
  if ('listen' in input) {
    const l = input.listen || {};
    if (l.enabled !== undefined && typeof l.enabled !== 'boolean') throw new AppError('监听开关无效');
    if (l.allDay !== undefined && typeof l.allDay !== 'boolean') throw new AppError('全天监听开关无效');
    const interval = Number(l.intervalSec ?? out.listen.intervalSec);
    if (!Number.isInteger(interval) || interval < 120 || interval > 3600) {
      throw new AppError('扫描间隔必须在 120～3600 秒之间（太密会让上游浏览器不停导航）');
    }
    out.listen = {
      enabled: l.enabled ?? out.listen.enabled,
      allDay: l.allDay ?? out.listen.allDay,
      intervalSec: interval,
      limit: clampInt(l.limit ?? out.listen.limit, 5, 50, 20),
    };
  }
  if ('diary' in input) {
    if (input.diary?.push !== undefined && typeof input.diary.push !== 'boolean') throw new AppError('日记推送开关无效');
    out.diary = { push: input.diary?.push ?? out.diary.push };
  }
  if ('notify' in input) {
    const n = input.notify || {};
    if (n.type !== undefined && !['workbench', 'webhook', 'none'].includes(n.type)) {
      throw new AppError('通知方式只能是 workbench / webhook / none');
    }
    const url = text(n.url ?? out.notify.url, 500);
    if (url) {
      let parsed;
      try { parsed = new URL(url); } catch { throw new AppError('Webhook 地址无效'); }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new AppError('Webhook 必须是 http(s) 地址');
    }
    out.notify = { type: n.type ?? out.notify.type, url };
  }
  return out;
}
