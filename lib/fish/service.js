import fs from 'node:fs';
import path from 'node:path';
import { AppError, text, shanghaiDay } from '../store.js';
import { VerificationRequiredError } from '../verification.js';
import {
  fishPaths, readFishConfig, writeFishConfig, validateFishConfig, readJson, writeJson,
} from './config.js';
import { describePlan } from './clock.js';
import { quotaFor, silentDays as silentDaysOf } from './facts.js';
import { toInboxItem, classifyNotification, roleLabel } from './classify.js';

const STATE_DEFAULT = {
  revision: 0, inbox: [], seen: {}, shares: [], replied: {}, notices: [], likes: {},
  lastScanAt: null, lastOwnerContactAt: null, selfId: '', selfName: '',
  silenceSeen: null, topics: [],
  visits: {}, visitDecisions: {}, visitTasks: {},
};
const DAY_MS = 86_400_000;

/**
 * 养鱼的业务层：状态、收件箱、刷笔记、回复分流、额度、日记、推送。
 *
 * 它跑在**工作台进程**里（持有数据目录锁），所以能安全地读写状态文件；
 * DSH 插件进程只读 fish.json / fish-state.json，从不写它们 —— 见 scheduler.js 的说明。
 *
 * 安全边界（代码强制，不靠提示词）：
 *   · 只有 sendingEnabled 打开才可能真的发出去
 *   · 评论、回复和全站发送不设每日上限；记录保留用于去重与核验
 *   · 同一条笔记 7 天内只分享一次；同一条评论永远只回一次
 *   · 自己的评论永远不回；陌生人的默认只进草稿等你审
 */
export class Fish {
  constructor({ dataDir, workflow, log = () => {}, random = Math.random }) {
    if (!dataDir) throw new AppError('养鱼缺少数据目录');
    this.dataDir = path.resolve(dataDir);
    this.workflow = workflow;
    this.log = log;
    this.random = random;
    this.paths = fishPaths(this.dataDir);
    this.identityCache = { at: 0, value: null };
    this.scanning = false;
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  // ── 配置与状态 ───────────────────────────────────────────────────────
  config() { return readFishConfig(this.dataDir); }

  saveConfig(input) {
    // __present 是"这个文件存不存在"的运行时标记，不该被写回配置文件。
    const { __present, ...previous } = this.config();
    const validated = validateFishConfig(input || {}, previous);
    writeFishConfig(this.dataDir, validated);
    return validated;
  }

  state() {
    const raw = readJson(this.paths.state, {});
    // 必须深拷贝默认值：直接展开会让 out.inbox/out.seen 和模块级常量共用同一个数组/对象，
    // 一次 unshift 就把"默认状态"改成了上一个实例的状态（跨实例/跨测试污染，很难查）。
    const out = { ...JSON.parse(JSON.stringify(STATE_DEFAULT)), ...(raw && typeof raw === 'object' ? raw : {}) };
    for (const key of ['inbox', 'shares']) if (!Array.isArray(out[key])) out[key] = [];
    for (const key of ['seen', 'replied', 'likes', 'visits', 'visitDecisions', 'visitTasks']) if (!out[key] || typeof out[key] !== 'object') out[key] = {};
    if (!Array.isArray(out.notices)) out.notices = [];
    if (!Array.isArray(out.topics)) out.topics = [];
    out.revision = Number(out.revision ?? 0) || 0;
    return out;
  }

  saveState(next) { writeJson(this.paths.state, next); }

  mutate(fn) {
    const state = this.state();
    const result = fn(state);
    this.saveState(state);
    return result;
  }

  /** 登录身份（带 5 分钟缓存）。养鱼的"我是谁"和"主人是谁"都靠它。 */
  async identity({ force = false } = {}) {
    this.workflow.assertPlatformReady();
    if (!force && this.identityCache.value && Date.now() - this.identityCache.at < 300_000) {
      return this.identityCache.value;
    }
    const { xhs } = this.workflow.clients();
    const login = await xhs.login();
    if (!login?.is_logged_in) throw new AppError('小红书尚未登录，请先扫码登录', 409);
    if (!login.user_id) throw new AppError('小红书服务没有返回账号 ID，请更新上游服务后重试', 409);
    const value = { id: String(login.user_id), name: text(login.username, 100) };
    this.identityCache = { at: Date.now(), value };
    return value;
  }

  ids() {
    const cfg = this.config();
    const state = this.state();
    const selfId = String(state.selfId || this.identityCache.value?.id || '');
    const ownerId = String(cfg.reply?.ownerProfileId || cfg.reply?.ownerUserId || '');
    return { selfId, ownerId };
  }

  /** 真的问一次"我是谁"并写回状态。体检和第一次醒来都靠它 —— 别让"还没扫过收件箱"看起来像未登录。 */
  async refreshIdentity() {
    const me = await this.identity({ force: true });
    const next = this.state();
    next.selfId = me.id;
    next.selfName = me.name;
    this.saveState(next);
    return me;
  }

  // ── 额度与"日子" ─────────────────────────────────────────────────────
  sharesToday(state = this.state()) {
    const today = shanghaiDay();
    return state.shares.filter(s => shanghaiDay(s.at) === today).length;
  }

  repliesToday(state = this.state()) {
    const today = shanghaiDay();
    return Object.values(state.replied || {})
      .filter(r => r?.status === 'sent' && shanghaiDay(r.at) === today).length;
  }

  sharesOfNote(noteId, state = this.state()) {
    return state.shares.filter(s => s.noteId === noteId);
  }

  /** 沉默天数：主人最近一次在评论里出现距今天数；从没出现过 → 从第一次分享算。 */
  silentDays(state = this.state()) {
    return silentDaysOf(state);
  }

  /** 今天还能不能分享 / 回复。返回"事实"，让提示词自己决定少说 —— 真正的拒绝在 comment()/reply() 里。 */
  quota() {
    return quotaFor(this.config(), this.state());
  }

  // ── 收件箱：区分「自己 / 主人 / 陌生人」 ─────────────────────────────
  /**
   * 拉一次通知列表并并入收件箱。
   *
   * 上游每次要真的开一次浏览器页面（十几秒），所以：
   *   · 有节流（listen.intervalSec，最小 120 秒）
   *   · 工作台正忙时直接跳过（不和用户的搜索/发送抢浏览器）
   *   · 按 notificationId 去重，重复扫描不会重复计数
   */
  async scanInbox({ force = false } = {}) {
    const cfg = this.config();
    if (!force && !cfg.listen?.enabled) return { skipped: '没开监听', ...this.inboxCounts() };
    if (this.scanning) return { skipped: '上一次扫描还没结束', ...this.inboxCounts() };

    const state = this.state();
    if (!force && state.lastScanAt) {
      const gap = Date.now() - new Date(state.lastScanAt).getTime();
      if (gap >= 0 && gap < Math.max(120, Number(cfg.listen?.intervalSec ?? 300)) * 1000) {
        return { skipped: '还没到下一次扫描时间', ...this.inboxCounts() };
      }
    }
    if (this.workflow.busy) return { skipped: '工作台正忙，这一轮不扫', ...this.inboxCounts() };

    this.scanning = true;
    try {
      const me = await this.identity({ force: true });
      const { xhs } = this.workflow.clients();
      const limit = Math.max(5, Math.min(50, Number(cfg.listen?.limit ?? 20)));
      const list = await this.workflow.exclusive(() => xhs.notifications('mentions', limit));
      const ids = { selfId: me.id, ownerId: String(cfg.reply?.ownerProfileId || cfg.reply?.ownerUserId || '') };

      const next = this.state();
      next.selfId = me.id;
      next.selfName = me.name;
      const fresh = [];
      for (const raw of list.items) {
        const item = toInboxItem(raw, ids);
        if (!item.comment.id && !item.feed.id) continue;
        if (next.seen[item.notificationId]) continue;
        next.seen[item.notificationId] = new Date().toISOString();
        next.inbox.unshift(item);
        fresh.push(item);
      }
      // 只留最近 200 条，避免状态文件无限长大
      next.inbox = next.inbox.slice(0, 200);
      if (fresh.some(i => i.role === 'owner')) next.lastOwnerContactAt = new Date().toISOString();
      if (fresh.length) {
        next.revision = Number(next.revision ?? 0) + 1;
        next.unreadBatch = fresh.map(i => i.id);
      }
      next.lastScanAt = new Date().toISOString();
      this.saveState(next);
      this.log(`[fish] 收件箱：拉到 ${list.items.length} 条（过滤 ${list.filtered}），新增 ${fresh.length} 条`);
      return {
        fetched: list.items.length, filtered: list.filtered, fresh: fresh.length,
        revision: next.revision, ...this.inboxCounts(next),
      };
    } finally {
      this.scanning = false;
    }
  }

  /** 收件箱（默认只给"还能处理"的：未被自己回过、不是自己的）。每次读都按当前配置重算身份。 */
  inbox({ all = false } = {}) {
    const state = this.state();
    const ids = this.ids();
    const items = state.inbox.map((raw) => {
      const c = classifyNotification({
        type: raw.type, comment_id: raw.comment?.id, from: { user_id: raw.from?.id },
      }, ids);
      const replied = state.replied[raw.comment?.id] || null;
      return {
        ...raw, role: c.role, kind: c.kind, replyable: c.replyable, postable: c.postable,
        alreadyReplied: !!replied, repliedStatus: replied?.status || null,
      };
    }).filter(it => all || it.postable || it.role === 'owner');
    return items;
  }

  inboxCounts(state = this.state()) {
    const ids = this.ids();
    const rows = state.inbox.map((raw) => {
      const c = classifyNotification({ type: raw.type, comment_id: raw.comment?.id, from: { user_id: raw.from?.id } }, ids);
      return { ...c, replied: !!state.replied[raw.comment?.id] };
    });
    return {
      total: rows.length,
      pending: rows.filter(r => r.postable && !r.replied).length,
      owner: rows.filter(r => r.role === 'owner' && r.postable && !r.replied).length,
      stranger: rows.filter(r => r.role === 'stranger' && r.postable && !r.replied).length,
      revision: Number(state.revision ?? 0),
    };
  }

  // ── 自己刷小红书 ─────────────────────────────────────────────────────
  /**
   * 选一个主题：优先本次指定 → 配置里的主题轮换 → 主配置的"兴趣"第一个词。
   * 首页推荐不需要主题；关键词搜索失败时会自动退回首页（上游搜索经常被限流/验证）。
   */
  pickTopic(explicit) {
    const cfg = this.config();
    const state = this.state();
    if (explicit) return text(explicit, 60);
    const topics = Array.isArray(cfg.topics) ? cfg.topics.filter(Boolean) : [];
    if (topics.length) {
      const used = new Set((state.topics || []).slice(-Math.max(1, topics.length - 1)).map(t => t.topic));
      return topics.find(t => !used.has(t)) || topics[0];
    }
    const interest = String(this.workflow.store.state.config.interests || '').split(/[,，、;；\n]/).map(s => s.trim()).filter(Boolean)[0];
    return interest ? text(interest, 60) : '';
  }

  /**
   * 自己刷一轮。分两段：
   *   ① 同城 + 最新（先刷几条"北京·同城"的）
   *   ② 其余（关键词搜索 / 首页推荐）
   *
   * 关于筛选：小红书搜索页的排序/时间/位置筛选要"悬停筛选面板再点选项"，在这台机器上
   * 实测很不稳定（经常 60 秒超时后 500）。所以这里做了两层退让：
   *   · 先按设置带筛选试一次；失败就**不带筛选**重搜（关键词里补上城市），整轮照常
   *   · 失败会记进 fish-state：6 小时内不再尝试筛选，省掉每分钟的 60 秒卡顿
   * 带筛选时优先请求最新一周；降级时只能在已取得的笔记中按发布时间排序，不能保证都是近期/本地内容。
   */
  async run({ topic, n, deep, source } = {}) {
    this.workflow.assertPlatformReady();
    const cfg = this.config();
    const candidates = Math.max(1, Math.min(30, Number(n ?? cfg.feed?.candidates ?? 5) || 5));
    const deepRead = Math.max(0, Math.min(5, Number(deep ?? cfg.feed?.deep ?? 2) || 0));
    const keyword = text(topic ?? '', 60) || this.pickTopic();
    const mode = source || cfg.feed?.source || 'auto';
    const sort = cfg.feed?.sort || '最新';
    const publish = cfg.feed?.publish || '一周内';
    const localCfg = cfg.feed?.local || {};
    // 同城最多占 count 条，且必须留 1 条给非限地域的结果。
    const localCount = localCfg.enabled === false ? 0
      : Math.min(Math.max(0, Number(localCfg.count ?? 3)), Math.max(0, candidates - 1));
    const city = text(localCfg.city ?? '', 20);

    const state0 = this.state();
    // 平台筛选（排序/时间/位置）默认**不开**。60 秒超时的根因通常不是筛选，而是搜索页
    // 本身没加载出来：上游 SearchFeeds 每次新开浏览器，整次搜索只有一个 60 秒死线，
    // 卡在 MustWait(__INITIAL_STATE__) 上就一直等到超时（实测堆栈在 search.go:120，
    // 还没走到筛选那一步）。短时间搜索太多会被平台的风控/验证页顶掉。
    // 所以：筛选只在显式开启时尝试，失败立刻退回不带筛选，并按关键词记住 24 小时。
    const failFor = (word) => {
      const at = state0.filterFails?.[word];
      return at && Date.now() - new Date(at).getTime() < 24 * 3_600_000;
    };
    let filtersOk = cfg.feed?.filters === true;
    const markFilters = (ok, word) => {
      const next = this.state();
      next.filters = { ok, at: new Date().toISOString() };
      if (!ok && word) {
        next.filterFails = { ...(next.filterFails || {}), [word]: new Date().toISOString() };
      } else if (ok && word && next.filterFails) {
        delete next.filterFails[word];
      }
      this.saveState(next);
    };

    /** 带筛选试一次；失败就退回"不带筛选"。返回 { digest, usedFilters }。 */
    const phase = async ({ label, keyword: word, fallbackKeyword, source: src, candidates: count, deepRead: read, filters }) => {
      if (filtersOk && Object.keys(filters || {}).length && !failFor(word)) {
        try {
          const digest = await this.executeRun({ keyword: word, source: src, candidates: count, deepRead: read, filters });
          markFilters(true, word);
          return { digest, usedFilters: true };
        } catch (e) {
          if (e.code === 'XHS_VERIFICATION_REQUIRED') throw e;
          filtersOk = false;
          markFilters(false, word);
          this.log(`[fish] ${label}的筛选不可用（这个词 24 小时内不再试），退回不带筛选：${String(e?.message ?? e).slice(0, 120)}`);
          return { digest: await this.executeRun({ keyword: fallbackKeyword, source: src, candidates: count, deepRead: read }), usedFilters: false, error: String(e?.message ?? e).slice(0, 160) };
        }
      }
      return { digest: await this.executeRun({ keyword: fallbackKeyword, source: src, candidates: count, deepRead: read }), usedFilters: false };
    };

    let local = null;
    let localError = '';
    let localFiltered = false;
    // 本地优先独立于其余内容的来源；关闭 local.enabled 才跳过本地段。
    if (localCount > 0) {
      try {
        // 有无筛选都带城市；已有城市词时不重复添加。
        const base = city && !keyword.includes(city) ? `${city} ${keyword}`.trim() : keyword || city;
        const result = await phase({
          label: '同城', keyword: base, fallbackKeyword: base,
          source: 'search', candidates: localCount, deepRead: Math.min(1, deepRead),
          filters: { sort, publish, location: '同城' },
        });
        local = result.digest;
        localFiltered = result.usedFilters;
        localError = result.error || '';
        for (const note of local.notes) note.scope = 'local';
      } catch (e) {
        if (e.code === 'XHS_VERIFICATION_REQUIRED') throw e;
        localError = String(e?.message ?? e).slice(0, 160);
        this.log(`[fish] 同城那一段没刷成（不影响整轮）：${localError}`);
      }
    }

    const localNotes = local?.notes?.length ?? 0;
    let general = null;
    let usedSource = 'feed';
    let fallback = '';
    let generalFiltered = false;
    const remaining = Math.max(1, candidates - localNotes);
    const remainingDeep = Math.max(0, deepRead - (local?.notes?.filter(x => x.reading).length ?? 0));

    if (mode !== 'feed' && keyword) {
      try {
        const result = await phase({
          label: '关键词', keyword, fallbackKeyword: keyword, source: 'search',
          candidates: remaining, deepRead: remainingDeep, filters: { sort, publish },
        });
        general = result.digest;
        generalFiltered = result.usedFilters;
        usedSource = 'search';
      } catch (e) {
        if (e.code === 'XHS_VERIFICATION_REQUIRED') throw e;
        // 搜索挂了不是"鱼死了"：退回首页推荐，把原因记下来，让提示词自己决定要不要报备。
        fallback = `搜索失败（${String(e?.message ?? e).slice(0, 160)}）`;
        if (mode === 'search') {
          throw new AppError(`关键词搜索失败：${fallback}。可以改用首页推荐（--source feed）`, 502);
        }
      }
    }
    if (!general) {
      general = await this.executeRun({ keyword: '', source: 'feed', candidates: remaining, deepRead: remainingDeep });
      usedSource = 'feed';
    }
    for (const note of general.notes) note.scope = 'general';

    const notes = [...(local?.notes || []), ...general.notes]
      .filter((note, index, all) => all.findIndex(x => x.noteId === note.noteId) === index)
      // 同城在前；同组里按发布时间从新到旧（拿不到时间就保持原顺序）
      .sort((a, b) => {
        const rank = (a.scope === 'local' ? 0 : 1) - (b.scope === 'local' ? 0 : 1);
        if (rank) return rank;
        const ta = Date.parse(a.publishedAt) || 0;
        const tb = Date.parse(b.publishedAt) || 0;
        return tb - ta;
      });

    const digest = {
      today: shanghaiDay(),
      runId: [local?.runId, general.runId].filter(Boolean).join('+'),
      status: general.status,
      progress: general.progress,
      errors: [...(local?.errors || []), ...general.errors],
      skippedRead: (local?.skippedRead ?? 0) + general.skippedRead,
      candidates: (local?.candidates ?? 0) + general.candidates,
      ranking: [...(local?.ranking || []).slice(0, 5), ...(general.ranking || []).slice(0, 5)],
      notes,
      // 合并后也要给出"有没有 ≤5 评论的帖子"——两段各自算过，但以合并结果为准。
      lowComment: (() => {
        const low = notes.filter(n => Number(n.commentCount ?? Number.MAX_SAFE_INTEGER) <= 5);
        return { max: 5, count: low.length, noteIds: low.map(n => n.noteId) };
      })(),
      local: {
        enabled: localCount > 0, count: localNotes, city,
        error: localError, filtered: localFiltered,
      },
      filters: { ok: filtersOk, generalFiltered, attempted: cfg.feed?.filters === true },
    };

    const next = this.state();
    next.topics = [...(next.topics || []), { topic: keyword || '(首页推荐)', at: new Date().toISOString() }].slice(-20);
    this.saveState(next);
    const where = `${localNotes ? `同城${city ? '·' + city : ''} ${localNotes} 条 + ` : ''}${usedSource}`;
    this.log(`[fish] 刷完一轮：${where}${keyword ? ' · ' + keyword : ''} · ${notes.length} 条`);
    return { ...digest, source: usedSource, topic: keyword, fallback };
  }

  async executeRun({ keyword, source, candidates, deepRead, filters = {} }) {
    const main = this.workflow.store.state.config;
    const { id } = this.workflow.start({
      keyword, source, skipRead: true,
      interests: main.interests, excludes: main.excludes,
      candidateLimit: candidates, shortlistLimit: Math.max(1, Math.min(8, candidates)),
      deepReadLimit: deepRead, minScore: 0, preferRecent: true,
      // 至少有一条"评论数 ≤ 5"的可选帖：预选全是热帖时补读几条候选。
      lowCommentMax: 5, lowCommentExtra: 2,
      sort: filters.sort || '综合', publish: filters.publish || '不限',
      location: filters.location || '',
    });
    await this.workflow.task;
    const run = this.workflow.run(id);
    if (run.status === 'waiting_verification' || this.workflow.store.state.verification) throw new VerificationRequiredError();
    if (run.status === 'failed') throw new AppError(run.errors.at(-1) || '读取失败', 502);
    return this.digest(run);
  }

  digest(run) {
    const ids = this.ids();
    // 还没扫过收件箱时 state.selfId 是空的，但这一轮登录已经拿到了账号 ID —— 用它，
    // 否则她自己的评论会被标成"陌生人"。
    const selfId = ids.selfId || String(run.account?.id ?? '');
    const ownerId = ids.ownerId;
    const roleOf = (authorId) => {
      const id = String(authorId || '');
      if (id && selfId && id === selfId) return 'self';
      if (id && ownerId && id === ownerId) return 'owner';
      return 'stranger';
    };
    return {
      runId: run.id,
      status: run.status,
      progress: run.progress,
      errors: run.errors,
      skippedRead: run.skippedRead ?? 0,
      candidates: run.candidates?.length ?? 0,
      ranking: (run.ranking || []).slice(0, 10),
      notes: (run.notes || []).map(note => ({
        noteId: note.id,
        title: note.title,
        url: note.url,
        type: note.type,
        author: { id: note.author?.id ?? '', name: note.author?.name ?? '' },
        likes: note.likes ?? '0',
        // 平台的总评论数（不是本次加载到的条数）：判"评论 ≤5"用它。
        commentCount: Number(note.commentCount ?? 0),
        likedCount: Number(note.likedCount ?? 0),
        liked: note.liked === true,
        score: note.score,
        reason: note.reason,
        body: text(note.body, 4000),
        publishedAt: note.publishedAt || null,
        daysAgo: note.publishedAt
          ? Math.max(0, Math.floor((Date.now() - new Date(note.publishedAt).getTime()) / DAY_MS)) : null,
        ipLocation: note.ipLocation || '',
        reading: note.reading ? {
          summary: note.reading.summary,
          points: note.reading.points,
          evidence: note.reading.evidence,
          commentInsights: note.reading.commentInsights,
          limitations: note.reading.limitations,
          recommendation: note.reading.recommendation,
        } : null,
        comments: (note.comments || []).slice(0, 15).map(c => ({
          commentId: c.id,
          parentId: c.parentId || '',
          text: c.text,
          author: { id: c.author?.id ?? '', name: c.author?.name ?? '' },
          role: roleOf(c.author?.id),
        })),
      })),
      // 规则用：这一轮有没有"评论数 ≤5"的帖子可选（没有就让提示词别硬凑）
      lowComment: (() => {
        const low = (run.notes || []).filter(n => Number(n.commentCount ?? Number.MAX_SAFE_INTEGER) <= 5);
        return { max: 5, count: low.length, noteIds: low.map(n => n.id) };
      })(),
    };
  }

  /** 找回一条读过的笔记（发表顶层评论要用它带的访问令牌）。 */
  findNote(noteId) {
    for (const run of this.workflow.store.state.runs) {
      const note = (run.notes || []).find(n => n.id === noteId);
      if (note?.token) return note;
    }
    const item = this.state().inbox.find(i => i.feed?.id === noteId);
    if (item?.feed?.token) return { id: item.feed.id, token: item.feed.token, title: item.feed.title, url: `https://www.xiaohongshu.com/explore/${encodeURIComponent(item.feed.id)}` };
    return null;
  }

  // ── 分享 / 回复 / 草稿 ───────────────────────────────────────────────
  async resolveOwner() {
    this.workflow.assertPlatformReady();
    const cfg = this.config();
    let query = String(cfg.reply?.ownerUserId || '').trim();
    const match = query.match(/^https:\/\/www\.xiaohongshu\.com\/user\/profile\/([a-f\d]{24})(?:[/?#]|$)/i);
    if (match) query = match[1];
    if (!query) throw new AppError('请先填写主人的小红书号或个人主页用户 ID');
    const client = this.workflow.clients().xhs;
    if (!client.resolveOwner) throw new AppError('当前服务不支持核实主人，请启动评论修复版');
    const owner = await this.workflow.exclusive(() => client.resolveOwner(query));
    if (this.config().reply?.ownerUserId !== cfg.reply?.ownerUserId) throw new AppError('主人设置在核实期间改变，请重新核实');
    if (!/^[a-f\d]{24}$/i.test(owner?.id || '') || !owner.name || (query !== owner.id && owner.red_id !== query)) {
      throw new AppError('返回用户与主人的小红书号不一致，未绑定');
    }
    this.saveConfig({ reply: { ownerProfileId: owner.id, ownerNickname: owner.name, ownerAvatar: owner.avatar } });
    return owner;
  }
  /**
   * 在笔记下发一条顶层评论（"分享"）。
   * 同一条笔记 7 天一次；评论数量不设每日上限。
   */
  async comment({ noteId, content, dry = false, mentionOwner } = {}) {
    if (this.workflow.isVisitNote(noteId)) throw new AppError('回访留言仅供主人手动完成，请用 fish visit --prepare 保存', 403);
    if (mentionOwner !== undefined && typeof mentionOwner !== 'boolean') throw new AppError('提及主人开关必须是布尔值');
    const cfg = this.config();
    if (!cfg.share?.enabled) throw new AppError('分享开关没开（设置 → 养鱼 → 分享）', 403);
    const body = text(content, 2000);
    if (!body || [...body].length > 500) throw new AppError('评论应为 1～500 个字符');
    const note = this.findNote(noteId);
    if (!note) throw new AppError('找不到这条笔记（先在 fish feed 里读过，或用通知里的 feed_id）', 404);

    const q = this.quota();
    const recent = this.sharesOfNote(note.id).filter(s => Date.now() - new Date(s.at).getTime() < 7 * DAY_MS);
    if (recent.length) throw new AppError('这条笔记 7 天内已经分享过一次（同一条不做第二次）', 409);

    // @ 主人是"例外"，不是默认：
    //   · 设置里的开关是总闸（关着就永远不 @，--mention 也不行）
    //   · 开着时，本次调用可以显式关掉（--no-mention / mentionOwner:false）
    const mentionAllowed = cfg.share?.mentionOwner === true;
    const wantsMention = mentionAllowed && (mentionOwner ?? true);
    let mentions = [];
    if (wantsMention) {
      let owner = { id: cfg.reply?.ownerProfileId, name: cfg.reply?.ownerNickname, avatar: cfg.reply?.ownerAvatar };
      if (!/^[a-f\d]{24}$/i.test(owner.id || '') || !owner.name || !owner.avatar) owner = await this.resolveOwner();
      mentions = [{ id: owner.id, name: owner.name, avatar: owner.avatar }];
    }

    if (dry) {
      const client = this.workflow.clients().xhs;
      let preparation = null;
      if (client.previewComment) {
        const account = await this.identity();
        preparation = await this.workflow.exclusive(() => client.previewComment({ content: body, account, mentions }, note));
      }
      return { dry: true, note: { id: note.id, title: note.title, url: note.url }, content: body, mentions, preparation, quota: q };
    }
    if (this.workflow.demo) throw new AppError('演示模式不连接真实账号，不能发送', 403);

    const draft = await this.workflow.addDraft({ note, comment: null, content: body, origin: 'fish', mentions });
    if (draft.content !== body) throw new AppError('这条笔记下已有不同内容的待处理草稿，请先在工作台处理', 409);
    if (JSON.stringify(draft.mentions || []) !== JSON.stringify(mentions)) throw new AppError('已有草稿的 @ 对象与本次不同，请先处理旧草稿', 409);
    const sent = await this.workflow.send(draft.id, { confirm: true, revision: draft.revision, content: draft.content });

    const next = this.state();
    next.shares.unshift({ at: new Date().toISOString(), noteId: note.id });
    next.shares = next.shares.slice(0, 200);
    this.saveState(next);
    this.log(`[fish] 分享：${note.title} · ${sent.verification || sent.status}`);
    return { ok: sent.status === 'sent', draftId: sent.id, status: sent.status, verification: sent.verification, mentionVerified: sent.mentionVerified === true };
  }

  /**
   * 给一条读过的笔记点赞（"不错的帖子"由她自己判断）。
   * 和评论分开记账：同一篇只点一次；每天有上限；仍然要过发送主开关。
   */
  async like({ noteId, dry = false }) {
    if (this.workflow.isVisitNote(noteId)) throw new AppError('回访仅阅读和准备留言，不自动点赞', 403);
    this.workflow.assertPlatformReady();
    const cfg = this.config();
    if (!cfg.like?.enabled) throw new AppError('点赞开关没开（设置 → 养鱼 → 点赞）', 403);
    // 和评论共用同一个总刹车：关掉"允许发送评论"就是"别对外动手"，点赞也算动手。
    if (!this.workflow.store.state.config.sendingEnabled) {
      throw new AppError('「允许发送评论」主开关关着：点赞也停手', 403);
    }
    const note = this.findNote(noteId);
    if (!note) throw new AppError('找不到这条笔记（先在 fish feed 里读过）', 404);
    const state = this.state();
    const likedAt = state.likes?.[note.id];
    if (likedAt) return { ok: true, already: true, at: likedAt, note: { id: note.id, title: note.title } };
    const daily = Math.max(0, Number(cfg.like?.daily ?? 10));
    const today = Object.values(state.likes || {}).filter(at => shanghaiDay(at) === shanghaiDay()).length;
    if (today >= daily) throw new AppError(`今天的点赞额度用完了（${today}/${daily}）`, 409);
    if (note.liked === true) {
      const next = this.state();
      next.likes = { ...(next.likes || {}), [note.id]: new Date().toISOString() };
      this.saveState(next);
      return { ok: true, already: true, note: { id: note.id, title: note.title }, at: next.likes[note.id] };
    }
    if (dry) {
      return { dry: true, note: { id: note.id, title: note.title, url: note.url || '' }, quota: { daily, today, left: Math.max(0, daily - today) } };
    }
    if (this.workflow.demo) throw new AppError('演示模式不连接真实账号，不能点赞', 403);
    const { xhs } = this.workflow.clients();
    await this.workflow.exclusive(() => xhs.like(note));
    const next = this.state();
    next.likes = { ...(next.likes || {}), [note.id]: new Date().toISOString() };
    this.saveState(next);
    this.log(`[fish] 点赞：${note.title}`);
    return { ok: true, note: { id: note.id, title: note.title }, at: next.likes[note.id] };
  }

  findInboxItem(commentId) {
    const id = String(commentId || '');
    return this.inbox({ all: true }).find(it => it.comment?.id === id) || null;
  }

  /** 谁能被直接回复：主人（开关开）→ 直发；其他人 → 按 strangerPolicy。 */
  routeFor(item, cfg = this.config()) {
    if (!item) return 'unknown';
    if (item.role === 'self') return 'self';
    if (item.role === 'owner') return cfg.reply?.ownerDirect ? 'direct' : 'draft';
    const policy = cfg.reply?.strangerPolicy || 'draft';
    if (policy === 'off') return 'off';
    if (policy === 'direct') return 'direct';
    return 'draft';
  }

  /**
   * 回复一条评论。这是"区分评论"落地的唯一入口：
   *   · 自己 → 拒绝
   *   · 主人 + ownerDirect → 直接发（受 sendingEnabled 约束）
   *   · 其他人 → 默认只生成草稿，进工作台「回复草稿」等审核
   */
  async reply({ commentId, content, dry = false }) {
    const cfg = this.config();
    const item = this.findInboxItem(commentId);
    if (!item) throw new AppError('收件箱里没有这条评论，先跑一次 fish inbox', 404);
    if (item.role === 'self') throw new AppError('这是我自己的评论，不回自己', 400);
    if (!item.replyable) throw new AppError('这条通知不是可以直接回复的评论', 400);
    const state = this.state();
    if (state.replied[item.comment.id]?.status === 'sent') throw new AppError('这条评论已经回复过了（同一条只回一次）', 409);

    const route = this.routeFor(item, cfg);
    const body = text(content, 2000);
    if (!body || [...body].length > 500) throw new AppError('回复应为 1～500 个字符');

    if (route === 'off') throw new AppError('设置里关掉了对陌生人的回复', 403);
    if (route === 'draft') {
      if (dry) return { dry: true, routed: 'draft', role: item.role, content: body, reason: '按设置，这条只能先成草稿等主人审' };
      return this.draft({ commentId: item.comment.id, content: body, role: item.role });
    }

    const q = this.quota();
    const note = this.noteForItem(item);
    if (dry) {
      let preparation = { stage: 'local_preview', dry: true };
      const { xhs } = this.workflow.clients();
      if (note.token && xhs.previewComment) {
        preparation = await this.workflow.exclusive(async () => {
          const account = await this.identity({ force: true });
          return xhs.previewComment({ content: body, commentId: item.comment.id, account, mentions: [] }, note);
        });
      }
      return { dry: true, routed: 'direct', role: item.role, note: { id: note.id, title: note.title }, content: body, preparation, quota: q };
    }
    if (this.workflow.demo) throw new AppError('演示模式不连接真实账号，不能发送', 403);

    const draft = await this.workflow.addDraft({
      note,
      comment: { id: item.comment.id, author: item.from, text: item.comment.text, parentId: '' },
      content: body, origin: 'fish',
    });
    if (draft.content !== body) throw new AppError('这条评论下已有不同内容的待处理草稿，请先在工作台处理', 409);

    let sent;
    try {
      sent = await this.workflow.send(draft.id, { confirm: true, revision: draft.revision, content: draft.content });
    } catch (e) {
      // 发送失败/不确定：仍然记一条，防止同一句反复重试（不确定的绝不自动重发）
      const next = this.state();
      next.replied[item.comment.id] = { at: new Date().toISOString(), draftId: draft.id, status: 'failed', error: String(e.message).slice(0, 200) };
      if (item.role === 'owner') next.lastOwnerContactAt = new Date().toISOString();
      this.saveState(next);
      throw e;
    }
    const next = this.state();
    next.replied[item.comment.id] = { at: new Date().toISOString(), draftId: sent.id, status: 'sent' };
    if (item.role === 'owner') next.lastOwnerContactAt = new Date().toISOString();
    this.saveState(next);
    this.log(`[fish] 回复 ${roleLabel(item.role)}：${item.comment.text.slice(0, 30)} · ${sent.verification || sent.status}`);
    let revisit = null;
    try { if (sent.status === 'sent') revisit = this.planVisit(item, sent.account?.id || this.ids().selfId); }
    catch { this.log('[fish] 原评论已回复；回访安排未保存，本次不回访。'); }
    return { ok: sent.status === 'sent', routed: 'direct', draftId: sent.id, status: sent.status, verification: sent.verification, revisit };
  }

  /** A visit is offered only after a confirmed reply, with one persisted draw per comment. */
  planVisit(item, accountId) {
    const cfg = this.config();
    if (!cfg.visit.enabled || !accountId || !item.from?.id || item.from.id === accountId) return null;
    const state = this.state();
    const key = `${accountId}:${item.comment.id}`, userKey = `${accountId}:${item.from.id}`;
    if (state.visitDecisions[key]) return state.visitDecisions[key];
    const recent = state.visits[userKey];
    const cooling = recent && Date.now() - Date.parse(recent.at) < cfg.visit.cooldownHours * 3600_000;
    const eligible = !cooling && this.random() < cfg.visit.chance;
    const decision = { at: new Date().toISOString(), eligible, accountId, userId: item.from.id,
      name: item.from.name, commentId: item.comment.id, reason: cooling ? '同一人回访冷却中' : eligible ? '这次想去对方家冒个泡' : '这次只聊天，不回访' };
    state.visitDecisions[key] = decision;
    // Reserve immediately: a batch of replies from the same person yields one offer.
    if (eligible) state.visits[userKey] = { at: decision.at, status: 'pending', commentId: item.comment.id };
    this.saveState(state);
    return decision;
  }

  pendingVisits() {
    const state = this.state(), cfg = this.config();
    if (!cfg.visit.enabled) return { items: [] };
    const accountId = this.ids().selfId;
    return { items: Object.values(state.visitDecisions).filter(d => d.eligible && d.accountId === accountId
      && state.visits[`${accountId}:${d.userId}`]?.status === 'pending'
      && state.visits[`${accountId}:${d.userId}`]?.commentId === d.commentId)
      .map(d => ({ commentId: d.commentId, name: d.name, userId: d.userId })) };
  }

  async visit({ commentId } = {}) {
    this.workflow.assertPlatformReady();
    const cfg = this.config();
    if (!cfg.visit.enabled) throw new AppError('回访开关没开', 403);
    const item = this.findInboxItem(commentId);
    if (!item || item.role === 'self' || !item.replyable || this.routeFor(item, cfg) !== 'direct') {
      throw new AppError('只能回访允许直接互动的评论者', 403);
    }
    if (this.state().replied[commentId]?.status !== 'sent') throw new AppError('先确认这条评论已经回复，再考虑回访', 409);
    const account = await this.identity({ force: true });
    const key = `${account.id}:${commentId}`, userKey = `${account.id}:${item.from.id}`;
    const state = this.state(), decision = state.visitDecisions[key], visit = state.visits[userKey];
    if (!decision?.eligible || decision.userId !== item.from.id || visit?.commentId !== commentId) {
      return { visited: false, reason: '本次没有安排回访' };
    }
    if (visit.status !== 'pending') return { visited: false, reason: '这次回访已处理，不重复读取' };
    if (this.workflow.busy) throw new AppError('正在执行其他操作，请稍后回访', 409);
    const { id } = this.workflow.start({ keyword: `回访 ${item.from.name || '评论者'}`,
      candidateLimit: 3, shortlistLimit: 3, deepReadLimit: 1, skipRead: true,
      minScore: 0, preferRecent: true }, { profileUserId: item.from.id });
    state.visits[userKey] = { ...visit, status: 'reading', runId: id };
    this.saveState(state);
    await this.workflow.task;
    const run = this.workflow.run(id), next = this.state();
    next.visits[userKey] = { ...next.visits[userKey], status: run.status === 'completed' ? 'visited' : 'failed' };
    this.saveState(next);
    if (run.status === 'waiting_verification' || this.workflow.store.state.verification) throw new VerificationRequiredError();
    if (run.status !== 'completed') throw new AppError(run.errors.at(-1) || '回访读取失败', 502);
    this.log(`[fish] 回访：${item.from.name || item.from.id} · ${run.notes.length} 条已读`);
    return { visited: true, user: item.from, ...this.digest(run),
      runId: id, manualOnly: true,
      next: `只为已精读的一篇准备留言：fish visit --prepare --run ${id} --note <noteId> --message "留言"。想分享给主人时写“主人，本鲸捞到/看到……”并邀请互动，加 --mention 标记需手动真实 @。保存后提醒主人手动完成；不要点赞，不调用 comment/reply/send。` };
  }

  manualVisitTasks() {
    return { items: Object.values(this.state().visitTasks).filter(t => t.accountId === this.ids().selfId) };
  }

  prepareVisit({ runId, noteId, content, mentionOwner = false } = {}) {
    if (typeof mentionOwner !== 'boolean') throw new AppError('提及主人开关必须是布尔值');
    const { run, note } = this.workflow.note(runId, noteId);
    if (run.source !== 'profile' || run.status !== 'completed' || !note.reading || note.author.id !== run.profileUserId) {
      throw new AppError('只能为回访中已精读的本人作品准备留言', 409);
    }
    if (!run.account?.id || run.account.id !== this.ids().selfId) throw new AppError('回访账号已改变', 409);
    const body = text(content, 2000);
    if (!body || [...body].length > 500) throw new AppError('留言应为 1～500 个字符');
    const state = this.state();
    const previous = Object.values(state.visitTasks).find(t => t.runId === runId || (t.accountId === run.account.id && t.noteId === noteId));
    if (previous) return { ok: true, already: true, manualOnly: true, task: previous };
    const task = { id: runId, runId, accountId: run.account.id, noteId, userId: run.profileUserId,
      name: note.author.name, title: note.title, url: `https://www.xiaohongshu.com/explore/${encodeURIComponent(noteId)}`,
      content: body, mentionOwner, ownerName: mentionOwner ? text(this.config().reply?.ownerNickname, 100) : '',
      status: 'pending_manual', at: new Date().toISOString() };
    state.visitTasks[task.id] = task;
    this.saveState(state);
    const mentionHint = mentionOwner ? `\n需要真实 @ 主人${task.ownerName ? `（${task.ownerName}）` : ''}：请发布时从小红书候选列表手动选择主人账号；未添加提及、未通知该账号。` : '';
    const message = `主人，有一项回访需要你手动完成：${task.name}《${task.title}》\n${task.url}\n准备的留言：${body}${mentionHint}\n小鲸鱼只读了作品、备好留言，未点赞、未发送。请自行打开小红书决定是否发布。`;
    this.appendDiary({ book: 'letter', content: message });
    this.notify({ text: message, kind: 'visit:manual' });
    return { ok: true, manualOnly: true, task };
  }

  /** 陌生人（或主人）的回复进待审队列：不发送，只写草稿 + 通知主人。 */
  async draft({ commentId, content, role = 'stranger' }) {
    const item = this.findInboxItem(commentId);
    if (!item) throw new AppError('收件箱里没有这条评论，先跑一次 fish inbox', 404);
    if (item.role === 'self') throw new AppError('这是我自己的评论', 400);
    const body = text(content, 2000);
    if (!body || [...body].length > 500) throw new AppError('回复应为 1～500 个字符');
    const note = this.noteForItem(item);
    const draft = await this.workflow.addDraft({
      note,
      comment: { id: item.comment.id, author: item.from, text: item.comment.text, parentId: '' },
      content: body, origin: 'fish',
    });
    if (draft.content !== body) throw new AppError('这条评论下已有不同内容的待审草稿，请先在工作台处理', 409);
    const next = this.state();
    next.replied[item.comment.id] = { at: new Date().toISOString(), draftId: draft.id, status: 'draft' };
    this.saveState(next);
    this.notify({
      text: `【等你审核 1 条回复】→ ${item.from?.name || '对方'}（${roleLabel(item.role)}）\n他说：${item.comment.text.slice(0, 200)}\n我要回：${body}`,
      kind: 'draft',
    });
    this.log(`[fish] 草稿待审：${item.from?.name || '对方'} · ${body.slice(0, 30)}`);
    return { ok: true, routed: 'draft', draftId: draft.id, status: draft.status };
  }

  /** 通知条目 → 笔记快照（带访问令牌才能精确回复）。令牌缺失时留空，发送会退回通知页回复。 */
  noteForItem(item) {
    const note = {
      id: item.feed?.id || '', token: item.feed?.token || '',
      title: item.feed?.title || '', url: item.feed?.id ? `https://www.xiaohongshu.com/explore/${encodeURIComponent(item.feed.id)}` : '',
    };
    if (!note.id) throw new AppError('这条通知没有关联笔记，无法回复', 409);
    if (!note.token) {
      // 没有 token 也能发：send 会退回 /notifications/reply（只认 comment_id）
      this.log(`[fish] 通知里没有笔记令牌，回复将走通知页：${note.id}`);
    }
    return note;
  }

  // ── 日记 / 推送 / 日志 ───────────────────────────────────────────────
  diaryFile(book) {
    return book === 'private' ? this.paths.private : this.paths.letter;
  }

  appendDiary({ book = 'letter', content: body }) {
    const content = String(body ?? '').trim();
    if (!content) throw new AppError('日记内容不能为空');
    if (content.length > 20000) throw new AppError('一条日记最多 20000 个字符');
    const file = this.diaryFile(book);
    const today = shanghaiDay();
    let current = '';
    try { current = fs.readFileSync(file, 'utf8'); } catch { current = ''; }
    const heading = `## ${today}`;
    const lastHeading = [...current.matchAll(/^##\s+(.+)$/gm)].at(-1)?.[1]?.trim();
    let next;
    if (lastHeading === today) {
      next = `${current.trimEnd()}\n\n${content}\n`;
    } else {
      next = `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${heading}\n\n${content}\n`;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next, { mode: 0o600 });
    this.log(`[fish] 日记（${book === 'private' ? '自己' : '给主人'}）：${content.slice(0, 40)}`);
    return { ok: true, book, path: file, bytes: Buffer.byteLength(next) };
  }

  readDiary({ book = 'letter', tail = 0 } = {}) {
    const file = this.diaryFile(book);
    let content = '';
    try { content = fs.readFileSync(file, 'utf8'); } catch { content = ''; }
    const limited = tail > 0 ? content.slice(-Math.max(200, Number(tail) || 0)) : content;
    let modifiedAt = null;
    try { modifiedAt = fs.statSync(file).mtime.toISOString(); } catch {}
    return { book, path: file, exists: !!content, modifiedAt, content: limited };
  }

  notify({ text: message, kind = 'note' }) {
    const body = String(message ?? '').trim();
    if (!body) throw new AppError('推送内容不能为空');
    const record = { at: new Date().toISOString(), kind, text: body.slice(0, 4000) };
    const next = this.state();
    next.notices.unshift(record);
    next.notices = next.notices.slice(0, 50);
    this.saveState(next);
    this.appendLog({ kind: `notify:${kind}`, note: body.slice(0, 200) });

    const cfg = this.config();
    if (cfg.notify?.type === 'webhook' && cfg.notify?.url) {
      // 推送失败不影响主线（网络问题不该让"写日记"这一步失败），但要留痕。
      fetch(cfg.notify.url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: body, content: body, msgtype: 'text', title: '养鱼' }),
        signal: AbortSignal.timeout(10000),
      }).catch(e => this.appendLog({ kind: 'notify:failed', note: String(e.message).slice(0, 160) }));
    }
    return { ok: true, at: record.at, type: cfg.notify?.type ?? 'workbench' };
  }

  appendLog({ kind, note }) {
    try {
      fs.mkdirSync(path.dirname(this.paths.log), { recursive: true });
      fs.appendFileSync(this.paths.log, JSON.stringify({
        at: new Date().toISOString(), kind: text(kind, 60) || 'event', note: text(note, 500) || null,
      }) + '\n');
    } catch {}
  }

  tailLog(limit = 20) {
    try {
      const lines = fs.readFileSync(this.paths.log, 'utf8').trim().split('\n').filter(Boolean);
      return lines.slice(-Math.max(1, Math.min(200, limit))).map((line) => {
        try { return JSON.parse(line); } catch { return { at: null, kind: 'raw', note: line }; }
      });
    } catch { return []; }
  }

  // ── 状态一览（工作台 / CLI / DSH 设置页共用）─────────────────────────
  status({ withIdentity = true } = {}) {
    const cfg = this.config();
    const state = this.state();
    const clock = readJson(this.paths.clock, null);
    const q = this.quota();
    const counts = this.inboxCounts(state);
    const drafts = this.workflow.store.state.drafts || [];
    const today = shanghaiDay();
    return {
      enabled: !!cfg.enabled,
      config: cfg,
      dataDir: this.dataDir,
      workbenchUrl: this.workbenchUrl || '',
      self: { id: state.selfId || this.identityCache.value?.id || '', name: state.selfName || this.identityCache.value?.name || '' },
      ownerUserId: cfg.reply?.ownerUserId || '',
      plan: clock || null,
      planText: describePlan(clock),
      clockText: clock ? `${clock.date} ${clock.action}${clock.atText ? ' @ ' + clock.atText : ''}` : '',
      quota: q,
      inbox: counts,
      drafts: {
        pending: drafts.filter(d => d.status === 'pending').length,
        fishPending: drafts.filter(d => d.status === 'pending' && d.origin === 'fish').length,
        uncertain: drafts.filter(d => d.status === 'uncertain').length,
      },
      today: {
        shares: q.sharesToday, replies: q.repliesToday,
        sends: drafts.filter(d => d.sentAt && shanghaiDay(d.sentAt) === today).length,
        sendingEnabled: !!this.workflow.store.state.config.sendingEnabled,
      },
      notices: state.notices.slice(0, 5),
      diary: {
        letter: this.readDiary({ book: 'letter', tail: 0 }).modifiedAt,
        private: this.readDiary({ book: 'private', tail: 0 }).modifiedAt,
      },
      selftestPassed: !!readJson(this.paths.selftest, null)?.ok,
      log: this.tailLog(8),
      warnings: this.warnings(cfg, q, clock),
    };
  }

  warnings(cfg, q, clock) {
    const out = [];
    if (!cfg.listen?.enabled) out.push('收件箱监听关着：不会发现谁回复了你。');
    if (!cfg.listen?.allDay && cfg.listen?.enabled) out.push('只在作息窗口内扫收件箱（设置里可开全天）。');
    if (!this.workflow.store.state.config.sendingEnabled) out.push('主开关「允许发送评论」关着：只能生成草稿，发不出去。');
    if (!String(cfg.reply?.ownerUserId || '')) out.push('还没填主人的小红书用户 ID：主人的评论会被当成陌生人，只会进草稿。');
    if (clock?.action === 'done' && clock?.date === shanghaiDay()) out.push(`今天不醒了：${clock.reason ?? ''}`);
    return out;
  }

  // ── 自检 ─────────────────────────────────────────────────────────────
  async selftest() {
    const items = [];
    const push = (name, ok, detail = '') => items.push({ name, ok, detail });
    const cfg = this.config();

    push('养鱼配置', cfg.__present, cfg.__present ? this.paths.config : `还没有配置文件（会在第一次保存设置时创建）：${this.paths.config}`);
    push('数据目录', fs.existsSync(this.dataDir), this.dataDir);

    try {
      const me = await this.identity({ force: true });
      push('小红书登录', true, `已登录：${me.name}（${me.id}）`);
      const next = this.state();
      next.selfId = me.id; next.selfName = me.name;
      this.saveState(next);
    } catch (e) { push('小红书登录', false, e.message); }

    const apiKey = this.workflow.store.secrets().apiKey;
    push('DeepSeek 密钥', !!apiKey, apiKey ? '已配置（不回显）' : '还没配置：先在工作台填写 API Key');
    push('发送主开关', !!this.workflow.store.state.config.sendingEnabled,
      this.workflow.store.state.config.sendingEnabled ? '已打开' : '关着：只能写草稿，不能发评论');
    push('Node 版本', Number(process.versions.node.split('.')[0]) >= 22, process.versions.node);
    push('主人的用户 ID', !!cfg.reply?.ownerUserId, cfg.reply?.ownerUserId || '留空 = 只区分「我自己」和「别人」');

    const result = {
      ok: items.filter(i => !['DeepSeek 密钥', '发送主开关', '主人的用户 ID', '养鱼配置'].includes(i.name)).every(i => i.ok),
      at: new Date().toISOString(), items,
    };
    writeJson(this.paths.selftest, result);
    return result;
  }
}
