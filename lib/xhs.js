import { AppError, text } from './store.js';
import { VerificationRequiredError } from './verification.js';

export function safeImageUrl(raw) {
  try {
    const u = new URL(raw);
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) return '';
    if (!['xhscdn.com', 'xiaohongshu.com'].some(d => u.hostname === d || u.hostname.endsWith(`.${d}`))) return '';
    u.protocol = 'https:';
    return u.href;
  } catch { return ''; }
}
function imageUrl(img) {
  return safeImageUrl(img?.urlDefault || img?.url || img?.urlPre || img?.infoList?.[0]?.url);
}
function user(u = {}) { return { id: text(u.userId || u.user_id, 100), name: text(u.nickname || u.nickName, 100) }; }

/**
 * 互动数：小红书给的是字符串，可能是 "12"、"1.2万"、"3k"、"10+"。
 * 用来判断"评论数 ≤ 5"这种规则时必须先变成数字，否则 "1.2万" 会被当成 0。
 */
export function parseCount(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return 0;
  const match = value.match(/^([\d.]+)\s*(万|w|W|k|K)?/);
  if (!match) return 0;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return 0;
  const unit = match[2];
  if (unit === '万' || unit === 'w' || unit === 'W') return Math.round(base * 10000);
  if (unit === 'k' || unit === 'K') return Math.round(base * 1000);
  return Math.round(base);
}
export function normalizeFeeds(data) {
  const rows = Array.isArray(data) ? data : data?.feeds;
  if (!Array.isArray(rows)) throw new AppError('搜索结果结构与预期不同，请检查小红书服务版本', 502);
  return rows.filter(r => r.id && r.noteCard && (!r.modelType || r.modelType === 'note')).map(r => ({
    id: String(r.id), token: text(r.xsecToken, 2000), title: text(r.noteCard.displayTitle || r.noteCard.title, 300),
    type: r.noteCard.type || 'normal', author: user(r.noteCard.user), cover: imageUrl(r.noteCard.cover),
    likes: String(r.noteCard.interactInfo?.likedCount || '0'),
    commentCount: parseCount(r.noteCard.interactInfo?.commentCount),
    url: `https://www.xiaohongshu.com/explore/${encodeURIComponent(r.id)}`,
  }));
}
export function normalizeDetail(data, candidate) {
  const root = data?.data || data;
  if (!root?.note?.noteId || String(root.note.noteId) !== candidate.id) {
    throw new AppError('笔记详情缺失或返回了不同笔记，已停止处理', 502);
  }
  const note = root.note;
  const comments = [];
  function walk(rows = [], parentId = '', depth = 0) {
    if (depth > 5 || !Array.isArray(rows)) return;
    for (const c of rows) {
      if (!c.id || comments.length >= 200) continue;
      comments.push({ id: String(c.id), parentId, text: text(c.content, 4000), author: user(c.userInfo),
        subCount: Number(c.subCommentCount || 0), at: c.createTime || null });
      walk(c.subComments, String(c.id), depth + 1);
    }
  }
  walk(root.comments?.list);
  const rawImages = Array.isArray(note.imageList) ? note.imageList : [];
  // 发布时间：小红书用毫秒时间戳，个别字段可能给秒 —— 两种都认。
  const raw = Number(note.time ?? note.createTime ?? 0);
  const publishedAt = Number.isFinite(raw) && raw > 0
    ? new Date(raw > 1e12 ? raw : raw * 1000).toISOString() : null;
  const interact = note.interactInfo || {};
  return { ...candidate, token: candidate.token || text(note.xsecToken, 2000),
    title: text(note.title || candidate.title, 300), body: text(note.desc, 20000),
    type: note.type || candidate.type, author: user(note.user), comments,
    publishedAt, ipLocation: text(note.ipLocation, 40),
    // 评论数用总数（不是"本次加载到的评论条数"）：判"评论 ≤5"必须看平台的计数。
    commentCount: parseCount(interact.commentCount),
    likedCount: parseCount(interact.likedCount),
    liked: interact.liked === true || note.liked === true,
    images: rawImages.map(imageUrl).filter(Boolean), imageCount: rawImages.length,
    commentsPartial: !!root.comments?.hasMore || comments.some(c => c.subCount > comments.filter(x => x.parentId === c.id).length),
    fetchedAt: new Date().toISOString() };
}

export class XhsClient {
  constructor(config, token = '', fetcher = fetch, hooks = {}) {
    this.base = config.xhsUrl;
    this.token = token;
    this.config = config;
    this.fetcher = fetcher;
    this.hooks = hooks;
  }
  async request(route, body, timeout = 120000) {
    this.hooks.beforeRequest?.();
    let response;
    try {
      response = await this.fetcher(`${this.base}/api/v1${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error', signal: AbortSignal.timeout(timeout),
      });
    } catch { throw new AppError('小红书服务连接失败或超时。请检查服务是否启动；涉及发送时请先人工核对结果。', 502); }
    if (response.status === 404 && route === '/capabilities') {
      const error = new AppError('当前服务未提供扩展能力', 502);
      error.upstreamStatus = 404;
      throw error;
    }
    let json;
    try { json = await response.json(); } catch { throw new AppError('小红书服务返回了无法识别的响应', 502); }
    if (!response.ok || json.success !== true || json.data?.success === false) {
      if (route === '/feeds/comment/checked' && json.success === true && json.data?.success === false) {
        const stages = { validate: '参数校验', navigate: '打开笔记', activate: '激活编辑器', input: '输入正文', mention: '选择真实 @ 用户', ready: '检查发送按钮', submit: '点击提交', confirm: '核验新评论' };
        const stage = Object.hasOwn(stages, json.data.stage) ? json.data.stage : 'unknown';
        const notSent = json.data.certainty === 'not_sent' && ['validate','navigate','activate','input','mention','ready'].includes(stage);
        if (json.data.needs_verification === true) {
          const error = new VerificationRequiredError('评论页面要求登录或人工验证。自动操作已暂停，请打开工作台的验证窗口处理。');
          error.delivery = notSent ? 'not_sent' : 'uncertain'; error.stage = stage;
          this.hooks.onVerification?.(error, {});
          throw error;
        }
        const error = new AppError(`评论在「${stages[stage] || '未知阶段'}」未完成。${notSent ? '尚未提交，可修正后重新生成。' : '提交结果需人工核对，不会自动重发。'}`, 502);
        error.delivery = notSent ? 'not_sent' : 'uncertain';
        error.stage = stage;
        throw error;
      }
      // Deliberately do not echo raw upstream details (tokens and cookie-bearing URLs).
      const operation = ({ '/login/status': '检查登录', '/login/qrcode': '获取登录二维码',
        '/feeds/search': '搜索笔记', '/feeds/list': '读取首页', '/feeds/detail': '读取笔记详情',
        '/feeds/comment': '提交评论', '/feeds/comment/reply': '提交回复', '/users/resolve': '核实主人',
        '/notifications/list': '读取通知列表', '/notifications/unread': '读取未读数',
        '/notifications/reply': '回复通知里的评论', '/user/profile': '读取评论者主页' })[route] || '操作';
      const isRead = ['/login/status', '/login/qrcode', '/feeds/search', '/feeds/list', '/feeds/detail',
        '/notifications/list', '/notifications/unread', '/users/resolve', '/user/profile'].includes(route);
      const details = [json.error, json.message, json.details].filter(v => typeof v === 'string').join(' ');
      const deadline = isRead && response.status >= 500 && /context deadline exceeded|deadline exceeded/i.test(details);
      const challenge = /captcha|security.?verif|安全验证|验证码|风控|访问过于频繁|异常访问/i.test(details);
      if (deadline || challenge || response.status === 429) {
        const error = new VerificationRequiredError(`小红书${operation}${deadline ? '超时，可能遇到验证页或页面加载异常' : '遇到验证提示或限流'}。自动操作已暂停，请打开工作台的人工验证窗口处理。`);
        this.hooks.onVerification?.(error, { keyword: route === '/feeds/search' ? text(body?.keyword, 120) : '' });
        throw error;
      }
      const msg = response.status === 401 ? '小红书服务鉴权失败，请检查服务令牌' :
        response.status === 429 ? '小红书服务限流，本次任务已停止' : `小红书${operation}失败，请检查页面验证或服务日志`;
      const error = new AppError(`${msg}（HTTP ${response.status}）`, 502);
      error.upstreamStatus = response.status;
      if (['/feeds/comment','/feeds/comment/reply','/notifications/reply'].includes(route)) {
        const beforeSubmit = /未找到评论输入框|无法点击评论输入框|未找到评论输入区域|无法输入评论内容|未找到提交按钮|无法找到评论:|无法找到回复按钮|点击回复按钮失败|无法找到回复输入框|输入回复内容失败|无法找到提交按钮/.test(details);
        if (beforeSubmit || [400,401,404].includes(response.status)) {
          error.delivery = 'not_sent';
          error.stage = beforeSubmit ? 'prepare' : 'request';
          error.message = `评论提交前失败：${beforeSubmit ? '未能完成目标定位或编辑器输入' : '请求被服务拒绝'}（HTTP ${response.status}）。本次未提交。`;
        }
      }
      throw error;
    }
    return json.data;
  }
  async login() { return this.request('/login/status'); }
  async qrcode() { return this.request('/login/qrcode'); }
  async search(keyword, filters = {}) {
    // Default selections already apply on a fresh search page. Omit them so upstream
    // versions do not unnecessarily open and click the hover-only filter panel.
    const defaults = { sort_by: '综合', publish_time: '不限', note_type: '不限', search_scope: '不限', location: '不限' };
    const selected = Object.fromEntries(Object.entries(filters).filter(([key, value]) =>
      Object.hasOwn(defaults, key) && value && value !== defaults[key]));
    return normalizeFeeds(await this.request('/feeds/search', {
      keyword, ...(Object.keys(selected).length ? { filters: selected } : {}),
    }));
  }
  async feed() { return normalizeFeeds(await this.request('/feeds/list')); }
  async profile(userId) {
    if (!/^[a-f\d]{24}$/i.test(userId || '')) throw new AppError('回访缺少有效的评论者主页 ID');
    const result = await this.request('/user/profile', { user_id: userId, tab: 'note' }, 90000);
    const data = result?.data ?? result;
    // The Go service serializes an empty profile's nil feed slice as null.
    if (data?.feeds === null && data?.userBasicInfo) return [];
    // Only the author's own notes are eligible, never favorites or recommended cards.
    return normalizeFeeds(data).filter(n => n.author.id === userId && n.token);
  }
  /** 点赞一条笔记（需要笔记访问令牌）。重复点同一篇由服务端决定，调用方仍应自己记账。 */
  async like(note) {
    if (!note?.token) throw new AppError('笔记访问令牌缺失，无法点赞；请重新搜索获取', 409);
    const data = await this.request('/feeds/like', { feed_id: note.id, xsec_token: note.token }, 120000);
    if (data?.success === false) throw new AppError('点赞没有被平台确认成功，已停止', 502);
    return data;
  }
  async detail(candidate) {
    if (!candidate.token) throw new AppError('笔记访问令牌缺失，请重新搜索获取');
    return normalizeDetail(await this.request('/feeds/detail', {
      feed_id: candidate.id, xsec_token: candidate.token, load_all_comments: true,
      comment_config: { max_comment_items: this.config.commentLimit, click_more_replies: true,
        max_replies_threshold: 10, scroll_speed: 'slow' },
    }, 180000), candidate);
  }
  async send(draft, note) {
    if (this.checkedComments) {
      const result = await this.request('/feeds/comment/checked', { feed_id: note.id, xsec_token: note.token,
        content: draft.content, account_id: draft.account.id, comment_id: draft.commentId || '',
        mentions: draft.mentions || [], dry: false }, 150000);
      if (result?.dry !== false || result.stage !== 'confirm' || result.certainty !== 'sent' || !result.comment_id || (draft.mentions?.length && result.mention_verified !== true)) {
        throw Object.assign(new AppError('服务未返回完整的评论核验结果，请核对原帖', 502), { delivery: 'uncertain', stage: 'confirm' });
      }
      return result;
    }
    if (draft.mentions?.length) throw new AppError('当前服务不支持真实 @，请双击项目根目录的「启动小红书服务.cmd」切换到评论修复版；未发送普通 @ 文本', 409);
    return this.request(draft.commentId ? '/feeds/comment/reply' : '/feeds/comment', {
      feed_id: note.id, xsec_token: note.token, content: draft.content,
      ...(draft.commentId ? { comment_id: draft.commentId, user_id: draft.target?.author?.id || '' } : {}),
    });
  }
  async prepare(draft) {
    let caps;
    try { caps = await this.request('/capabilities'); }
    catch (e) { if (e.upstreamStatus !== 404) throw e; caps = {}; }
    this.checkedComments = caps.checked_comments === 1;
    if (draft.mentions?.length && caps.real_mentions !== 1) throw new AppError('当前服务不支持真实 @，请双击项目根目录的「启动小红书服务.cmd」切换到评论修复版', 409);
  }
  async resolveOwner(query) { return this.request('/users/resolve', { query }, 180000); }
  async previewComment(draft, note) {
    await this.prepare(draft);
    if (!this.checkedComments) return { dry: true, stage: 'local_preview', success: true };
    return this.request('/feeds/comment/checked', { feed_id: note.id, xsec_token: note.token,
      content: draft.content, account_id: draft.account.id, comment_id: draft.commentId || '',
      mentions: draft.mentions || [], dry: true }, 150000);
  }

  // ── 通知收件箱（上游 v2.5.5 起支持）────────────────────────────────────
  // 这是"区分评论"的数据来源：谁回的、回了什么、在哪条笔记下，一次给全。
  // 注意上游把结果又包了一层：{ success, data: { data: { tab, filtered, items } } }。
  async notifications(tab = 'mentions', limit = 20) {
    const data = await this.request('/notifications/list', { tab, limit }, 240000);
    const list = data?.data ?? data;
    return {
      tab: list?.tab ?? tab,
      filtered: Number(list?.filtered ?? 0),
      items: Array.isArray(list?.items) ? list.items : [],
    };
  }
  async unreadCounts() {
    const data = await this.request('/notifications/unread');
    const counts = data?.data ?? data ?? {};
    return {
      mentions: Number(counts.mentions ?? 0), likes: Number(counts.likes ?? 0),
      connections: Number(counts.connections ?? 0), unread: Number(counts.unread ?? 0),
    };
  }
  /**
   * 通知页回复：只要 comment_id 和正文。
   * 上游会自己在「评论和@」里定位这条评论、核对回复对象再发 —— 所以它是
   * "精确回复笔记评论"失败时的兜底（评论没被详情加载出来、或没有 xsec_token 时）。
   */
  async replyByNotification(commentId, content) {
    return this.request('/notifications/reply', { comment_id: commentId, content }, 180000);
  }
  async likeNotification(commentId, unlike = false) {
    return this.request('/notifications/like', { comment_id: commentId, ...(unlike ? { unlike: true } : {}) }, 120000);
  }
}
