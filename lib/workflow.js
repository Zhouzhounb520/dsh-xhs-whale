import { randomUUID } from 'node:crypto';
import { AppError, text } from './store.js';
import { XhsClient } from './xhs.js';
import { DeepSeek } from './model.js';
import { DemoModel, DemoXhs } from './demo.js';
import { VerificationRequiredError } from './verification.js';

export class Workflow {
  constructor(store, { demo = false, clients } = {}) {
    this.store = store;
    this.demo = demo;
    this.clientsOverride = clients;
    this.busy = false;
    this.activeRun = null;
    for (const run of store.state.runs) if (['queued', 'running'].includes(run.status)) {
      run.status = 'interrupted'; run.progress = '程序上次退出，已保留完成的结果。';
    }
    store.save();
  }
  clients(config = this.store.state.config) {
    if (this.clientsOverride) return this.clientsOverride(config);
    const secrets = this.store.secrets();
    return this.demo ? { xhs: new DemoXhs(), model: new DemoModel() } :
      { xhs: new XhsClient(config, secrets.xhsToken, fetch, {
        beforeRequest: () => this.assertPlatformReady(),
        onVerification: (error, context) => this.pauseForVerification(error, context),
      }), model: new DeepSeek(config, secrets.apiKey) };
  }
  assertPlatformReady() {
    if (this.store.state.verification) throw new VerificationRequiredError();
  }
  pauseForVerification(error, context = {}) {
    if (this.store.state.verification) return;
    this.store.state.verification = { at: new Date().toISOString(), message: error.message,
      keyword: text(context.keyword, 120), runId: this.activeRun };
    this.store.event('verification_required');
  }
  async exclusive(fn) {
    if (this.busy) throw new AppError('正在执行另一项操作，请等待完成或停止当前任务', 409);
    this.busy = true;
    try { return await fn(); } catch (e) {
      if (e.code === 'XHS_VERIFICATION_REQUIRED') this.pauseForVerification(e);
      throw e;
    } finally { this.busy = false; }
  }
  async identity(xhs) {
    this.assertPlatformReady();
    const login = await xhs.login();
    if (!login.is_logged_in) throw new AppError('小红书尚未登录，请先扫码登录', 409);
    if (!login.user_id) throw new AppError('当前小红书服务没有返回账号 ID，请更新至支持 user_id 的版本后重试', 409);
    return { id: String(login.user_id), name: text(login.username, 100) };
  }
  start(body, { profileUserId = '' } = {}) {
    this.assertPlatformReady();
    if (this.busy) throw new AppError('正在执行另一项操作，请稍后再开始', 409);
    if (!this.demo && !this.store.secrets().apiKey && !this.clientsOverride) throw new AppError('请先在连接设置中填写 DeepSeek API Key');
    const keyword = text(body.keyword, 120);
    if (body.source !== 'feed' && !keyword) throw new AppError('请输入搜索关键词');
    const sort = ['综合', '最新', '最多点赞', '最多评论', '最多收藏'].includes(body.sort) ? body.sort : '综合';
    const publish = ['不限', '一天内', '一周内', '半年内'].includes(body.publish) ? body.publish : '不限';
    // 位置距离（同城/附近）只有搜索页有，首页推荐没有这个筛选项。
    const location = ['同城', '附近'].includes(body.location) ? body.location : '';
    // 养鱼每轮只要 5 条候选、2 条精读：允许本次任务覆盖默认上限（仍然过范围校验）。
    const limits = {};
    for (const [key, [min, max]] of Object.entries({ candidateLimit: [1, 30], shortlistLimit: [1, 8], deepReadLimit: [0, 5] })) {
      if (!(key in body) || body[key] === undefined) continue;
      const value = Number(body[key]);
      if (!Number.isInteger(value) || value < min || value > max) throw new AppError(`${key} 必须在 ${min}～${max} 之间`);
      limits[key] = value;
    }
    const cfg = { ...this.store.state.config, ...limits };
    const run = { id: randomUUID(), at: new Date().toISOString(), mode: this.demo ? 'demo' : 'live',
      status: 'queued', keyword, source: profileUserId ? 'profile' : body.source === 'feed' ? 'feed' : 'search',
      ...(profileUserId ? { profileUserId } : {}),
      preferences: { interests: text(body.interests ?? cfg.interests, 1500), excludes: text(body.excludes ?? cfg.excludes, 1500) },
      config: cfg, skipRead: body.skipRead !== false, preferRecent: body.preferRecent === true,
      // 低评论帖保证：前几条预选都是热帖时，再补读几条候选去找"评论数 ≤ lowCommentMax"的。
      lowCommentMax: Number.isFinite(Number(body.lowCommentMax)) ? Math.max(0, Number(body.lowCommentMax)) : null,
      lowCommentExtra: Number.isFinite(Number(body.lowCommentExtra)) ? Math.min(5, Math.max(0, Number(body.lowCommentExtra))) : 2,
      // 初筛门槛：工作台默认 8 分（宁缺毋滥）；养鱼传 0 —— 让鱼自己按标尺判断，
      // 否则"推荐的帖子恰好不合模型口味"时会一条都读不到，看起来像坏了。
      minScore: Number.isFinite(Number(body.minScore)) ? Math.min(20, Math.max(0, Number(body.minScore))) : 8,
      filters: { sort_by: sort, publish_time: publish, note_type: '不限', ...(location ? { location } : {}) },
      progress: '等待开始', notes: [], candidates: [], errors: [], cancelled: false, endpoint: cfg.xhsUrl };
    this.store.state.runs.unshift(run);
    this.store.save();
    this.activeRun = run.id;
    this.task = this.exclusive(() => this.execute(run)).finally(() => { this.activeRun = null; });
    return { id: run.id };
  }
  mark(run, message) { run.progress = message; this.store.save(); }
  checkCancelled(run) { if (run.cancelled) throw new AppError('任务已停止，已完成的结果已保存', 409); }
  async execute(run) {
    const { xhs, model } = this.clients(run.config);
    try {
      run.status = 'running';
      this.mark(run, '检查小红书登录状态…');
      run.account = await this.identity(xhs);
      this.checkCancelled(run);
      this.mark(run, '获取候选笔记…');
      const found = run.source === 'profile' ? await xhs.profile(run.profileUserId)
        : run.source === 'feed' ? await xhs.feed() : await xhs.search(run.keyword, run.filters);
      const seen = new Set(run.skipRead ? this.store.state.runs
        .filter(r => r.id !== run.id && r.mode === run.mode && r.account?.id === run.account.id)
        .flatMap(r => r.notes.filter(n => n.reading).map(n => n.id)) : []);
      const unique = [...new Map(found.map(n => [n.id, n])).values()];
      const candidates = unique.filter(n => !seen.has(n.id)).slice(0, run.config.candidateLimit);
      run.skippedRead = unique.filter(n => seen.has(n.id)).length;
      run.candidates = candidates;
      if (!candidates.length) {
        run.status = 'completed'; this.mark(run, '没有新的候选笔记，可更换关键词或关闭“跳过已读”。'); return;
      }
      this.checkCancelled(run);
      this.mark(run, `DeepSeek 正在初筛 ${candidates.length} 条候选…`);
      const ranking = await model.rank(candidates, run.preferences);
      if (!ranking.length) throw new AppError('模型没有选出候选笔记，请调整筛选条件');
      run.ranking = ranking;
      const eligible = ranking.filter(r => r.score >= (run.minScore ?? 8));
      // 近期优先时保留搜索端“最新”的候选顺序，避免高分旧帖挤掉新帖；正文日期随后再核对。
      if (run.preferRecent) eligible.sort((a, b) => candidates.findIndex(n => n.id === a.id) - candidates.findIndex(n => n.id === b.id));
      const selected = eligible.slice(0, run.config.shortlistLimit);
      for (const [i, scored] of selected.entries()) {
        this.checkCancelled(run);
        const candidate = candidates.find(n => n.id === scored.id);
        if (!candidate) throw new AppError('模型返回了未知笔记 ID', 502);
        this.mark(run, `读取笔记 ${i + 1}/${selected.length}：${candidate.title}`);
        // Stop on platform errors; never hammer a login/challenge page.
        const note = await xhs.detail(candidate);
        if (run.source === 'profile' && note.author?.id !== run.profileUserId) throw new AppError('回访笔记作者与评论者不符，已停止');
        note.score = scored.score; note.reason = scored.reason;
        run.notes.push(note);
        this.store.save();
        this.checkCancelled(run);
        if (!run.preferRecent && i < run.config.deepReadLimit) {
          this.mark(run, `DeepSeek 正在精读：${note.title}`);
          note.reading = await model.read(note, run.preferences);
          this.store.save();
        }
      }
      if (run.preferRecent) {
        // 搜索列表通常没有日期，先取正文中的发布时间，再把精读名额留给更新的内容。
        // 日期未知/无效放最后；相同日期保留初筛次序。
        run.notes.sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0));
        this.store.save();
        for (const note of run.notes.slice(0, run.config.deepReadLimit)) {
          this.checkCancelled(run);
          this.mark(run, `DeepSeek 正在精读：${note.title}`);
          note.reading = await model.read(note, run.preferences);
          this.store.save();
        }
      }
      // 低评论帖保证：规则要求"至少挑一条评论数 ≤ N 的"，但预选的前几条可能全是热帖。
      // 这里再补读最多 lowCommentExtra 条候选，直到遇到一条低评论的 —— 只多几次详情读取，
      // 不额外搜索（搜索才是最容易被风控的那一步）。
      // 注意 null 必须先排除：Number(null) === 0 会让"没启用"被当成"≤0 条"。
      if (run.lowCommentMax !== null && run.lowCommentMax !== undefined && Number.isFinite(Number(run.lowCommentMax))) {
        const max = Number(run.lowCommentMax);
        const hasLow = run.notes.some(n => Number(n.commentCount ?? Number.MAX_SAFE_INTEGER) <= max);
        if (!hasLow) {
          const readIds = new Set(run.notes.map(n => n.id));
          let extra = 0;
          for (const candidate of candidates.filter(c => !readIds.has(c.id))) {
            if (extra >= Number(run.lowCommentExtra ?? 2)) break;
            this.checkCancelled(run);
            this.mark(run, `补读低评论帖：${candidate.title}`);
            const note = await xhs.detail(candidate);
            const scored = (run.ranking || []).find(r => r.id === note.id);
            note.score = scored?.score; note.reason = scored?.reason;
            run.notes.push(note);
            extra++;
            this.store.save();
            if (Number(note.commentCount ?? Number.MAX_SAFE_INTEGER) <= max) break;
          }
        }
      }
      run.status = 'completed';
      this.mark(run, `已完成：${candidates.length} 条候选，${run.notes.filter(n => n.reading).length} 条精读。`);
    } catch (e) {
      if (e.code === 'XHS_VERIFICATION_REQUIRED') this.pauseForVerification(e, { keyword: run.keyword });
      run.status = run.cancelled ? 'cancelled' : e.code === 'XHS_VERIFICATION_REQUIRED' ? 'waiting_verification' : 'failed';
      run.errors.push(e instanceof AppError ? e.message : '处理失败，请检查本地服务与配置。');
      this.mark(run, run.errors.at(-1));
    }
  }
  cancel(id) {
    const run = this.run(id);
    if (!['queued', 'running'].includes(run.status)) throw new AppError('该任务已经结束');
    run.cancelled = true;
    this.mark(run, '已请求停止，将在当前请求结束后停止后续步骤。');
    return { ok: true };
  }
  run(id) {
    const run = this.store.state.runs.find(r => r.id === id);
    if (!run) throw new AppError('找不到任务', 404);
    return run;
  }
  note(runId, noteId) {
    const run = this.run(runId);
    const note = run.notes.find(n => n.id === noteId);
    if (!note) throw new AppError('找不到已读取的笔记', 404);
    return { run, note };
  }
  /**
   * 草稿对应的笔记快照。
   *
   * 工作台产生的草稿挂在一次阅读任务下（run.notes 里找）；养鱼产生的草稿来自通知收件箱，
   * 没有对应的 run —— 所以建草稿时把 {id, token, title, url} 存在草稿自己身上。
   * 发送时两种情况都必须能拿到"笔记 ID + 访问令牌"，否则写不出去。
   */
  noteForDraft(draft) {
    if (draft.note?.id) return draft.note;
    return this.note(draft.runId, draft.noteId).note;
  }
  /**
   * 直接落一条"已经写好"的草稿（不调用模型）。
   * 养鱼用它：回复主人、或者把陌生人的回复先塞进待审队列。
   * 同一个目标不会重复排队（targetKey 去重），避免同一个评论生成两版草稿。
   */
  async addDraft({ note, comment = null, content, origin = 'fish', mentions = [] }) {
    return this.exclusive(async () => {
      if (!note?.id) throw new AppError('缺少目标笔记');
      const body = text(content, 4000);
      if (!body || [...body].length > 500) throw new AppError('回复应为 1～500 个字符');
      const account = await this.identity(this.clients().xhs);
      const key = `${account.id}:${note.id}:${comment?.id || 'top'}`;
      const previous = this.store.state.drafts.find(d => d.targetKey === key && !['rejected', 'not_sent'].includes(d.status));
      if (previous) return previous;
      const draft = {
        id: randomUUID(), at: new Date().toISOString(), revision: 1, status: 'pending',
        runId: null, noteId: note.id, title: text(note.title, 300) || '（未命名笔记）',
        commentId: comment?.id || '', target: comment || null, content: body,
        targetKey: key, account, endpoint: this.store.state.config.xhsUrl, mode: this.demo ? 'demo' : 'live',
        origin, mentions: mentions.map(m => ({ id: text(m.id, 100), name: text(m.name, 100), avatar: text(m.avatar, 1000) })),
        note: { id: note.id, token: note.token, title: text(note.title, 300), url: note.url || '' },
      };
      this.store.state.drafts.unshift(draft);
      this.store.event('draft_created', { draftId: draft.id, origin });
      return draft;
    });
  }
  async draft(body) {
    return this.exclusive(async () => {
      const { run, note } = this.note(body.runId, body.noteId);
      if (run.mode !== (this.demo ? 'demo' : 'live')) throw new AppError('不能跨模式操作历史数据');
      if (!note.reading) throw new AppError('请先对这条笔记完成精读');
      const commentId = text(body.commentId, 100);
      const target = commentId ? note.comments.find(c => c.id === commentId) : null;
      if (commentId && !target) throw new AppError('目标评论不在已读取的评论中');
      const key = `${run.account.id}:${note.id}:${commentId || 'top'}`;
      const previous = this.store.state.drafts.find(d => d.targetKey === key && !['rejected', 'not_sent'].includes(d.status));
      if (previous) return previous;
      const content = await this.clients().model.draft(note, target, this.store.state.config.replyStyle);
      const draft = { id: randomUUID(), at: new Date().toISOString(), revision: 1, status: 'pending',
        runId: run.id, noteId: note.id, title: note.title, commentId, target: target || null, content,
        targetKey: key, account: run.account, endpoint: run.endpoint, mode: run.mode };
      this.store.state.drafts.unshift(draft);
      this.store.event('draft_created', { draftId: draft.id });
      return draft;
    });
  }
  getDraft(id) {
    const d = this.store.state.drafts.find(x => x.id === id);
    if (!d) throw new AppError('找不到草稿', 404);
    return d;
  }
  editDraft(id, body) {
    const d = this.getDraft(id);
    if (d.status !== 'pending') throw new AppError('只有待审核草稿可以编辑', 409);
    if (body.revision !== d.revision) throw new AppError('草稿已修改，请刷新后再操作', 409);
    const content = text(body.content, 4000);
    if (!content || [...content].length > 500) throw new AppError('回复应为 1～500 个字符');
    d.content = content; d.revision++;
    this.store.event('draft_edited', { draftId: d.id });
    return d;
  }
  reject(id) {
    const d = this.getDraft(id);
    if (d.status !== 'pending') throw new AppError('该草稿已处理', 409);
    d.status = 'rejected';
    this.store.event('draft_rejected', { draftId: d.id });
    return d;
  }
  isVisitNote(noteId) {
    return this.store.state.runs.some(r => r.source === 'profile' && r.notes.some(n => n.id === noteId));
  }
  async send(id, body) {
    return this.exclusive(async () => {
      if (this.demo) throw new AppError('演示模式不连接真实账号，不能发送', 403);
      const cfg = this.store.state.config;
      if (!cfg.sendingEnabled) throw new AppError('发送开关未开启，请在连接设置中开启审核发送', 403);
      const d = this.getDraft(id);
      if (!d.commentId && this.isVisitNote(d.noteId)) throw new AppError('回访留言仅供主人手动完成，禁止自动发送', 403);
      if (d.mode !== 'live' || d.status !== 'pending') throw new AppError('该草稿已处理或不属于正式模式，不能发送', 409);
      if (body.confirm !== true || body.revision !== d.revision || body.content !== d.content) {
        throw new AppError('请审核当前版本的完整回复内容后再发送', 409);
      }
      if (d.endpoint !== cfg.xhsUrl) throw new AppError('小红书服务地址已改变，请恢复原服务后发送', 409);
      const note = this.noteForDraft(d);
      const { xhs } = this.clients();
      const account = await this.identity(xhs);
      if (account.id !== d.account.id) throw new AppError('当前小红书账号与生成草稿时不同，已阻止发送', 409);
      // Re-fetch before writing: refresh token context and ensure target still exists.
      // 通知收件箱来的草稿可能没有笔记访问令牌（上游没给 xsec_token）—— 这时跳过详情，
      // 直接用通知页回复（上游会自己定位评论并核对回复对象）。
      const fresh = note.token ? await xhs.detail(note) : null;
      // 没有令牌就无从"重新定位"，只能靠通知页；有令牌但评论没被加载出来，也退回通知页。
      const targetLoaded = !!fresh && (!d.commentId || fresh.comments.some(c => c.id === d.commentId));
      if (d.commentId && !targetLoaded && d.origin !== 'fish') {
        throw new AppError('本次未能重新定位目标评论，请在小红书确认后重新读取笔记', 409);
      }
      if (!fresh && !(d.origin === 'fish' && d.commentId)) {
        throw new AppError('缺少笔记访问令牌，无法确定发表位置；请重新读取这条笔记后再发', 409);
      }
      // Recheck after await: another tab may have edited/rejected the draft.
      if (d.status !== 'pending' || d.revision !== body.revision || d.content !== body.content) {
        throw new AppError('草稿在核验期间发生变化，请重新审核', 409);
      }
      if (!this.store.state.config.sendingEnabled) throw new AppError('发送开关已关闭', 403);
      if (xhs.prepare) await xhs.prepare(d);
      if (d.status !== 'pending' || d.revision !== body.revision || d.content !== body.content || !this.store.state.config.sendingEnabled) {
        throw new AppError('草稿或发送设置在能力核验期间发生变化，请重新审核', 409);
      }
      d.status = 'sending'; d.sentAt = new Date().toISOString();
      this.store.event('send_started', { draftId: d.id });
      let submission;
      try {
        const result = (d.origin === 'fish' && d.commentId && !targetLoaded)
          ? await xhs.replyByNotification(d.commentId, d.content)
          : await xhs.send(d, fresh || note);
        if (result?.success !== true) throw new AppError('发送响应未明确确认成功', 502);
        submission = result;
      } catch (e) {
        d.failureStage = e.stage || 'unknown';
        d.failureReason = e instanceof AppError ? e.message : '服务未能确认提交结果';
        if (e.delivery === 'not_sent') {
          d.status = 'not_sent'; d.attemptedAt = d.sentAt; delete d.sentAt;
          d.error = d.failureReason; d.verification = '服务确认在提交前停止，本次未发送';
          this.store.event('send_not_submitted', { draftId: d.id, stage: d.failureStage });
          throw new AppError(d.error, 502);
        }
        d.status = 'uncertain';
        d.error = `${d.failureReason} 发送结果不确定。请在小红书核对后标记结果；不会自动重发。`;
        this.store.event('send_uncertain', { draftId: d.id });
        throw new AppError(d.error, 502);
      }
      d.status = 'sent'; d.verification = '服务已报告提交成功，页面尚未核验';
      d.createdCommentId = submission?.comment_id || '';
      d.mentionVerified = submission?.mention_verified === true && !!d.createdCommentId;
      if (d.createdCommentId) d.verification = `已在原页核验到本账号的新评论${d.mentionVerified ? '及主人提及' : ''}`;
      this.store.event('send_accepted', { draftId: d.id });
      if (fresh && !d.createdCommentId) {
        try {
          const after = await xhs.detail(fresh);
          const match = after.comments.find(c => c.author.id === account.id && c.text === d.content &&
            (d.commentId ? c.parentId === d.commentId : !c.parentId));
          d.verification = match ? '已在返回的评论列表中核验到该回复' : '已提交；本次返回的评论列表未定位到新回复，请打开原帖核对';
        } catch { /* Accepted sends must never be retried because verification failed. */ }
      } else if (!d.createdCommentId) {
        d.verification = '已通过通知页提交；没有笔记访问令牌，无法在评论列表里回读核验，请打开原帖核对';
      }
      this.store.save();
      return d;
    });
  }
  resolve(id, body) {
    const d = this.getDraft(id);
    if (d.status !== 'uncertain' || body.confirm !== true || !['sent', 'not_sent'].includes(body.result)) {
      throw new AppError('仅可人工核对并处理结果不确定的回复');
    }
    d.status = body.result;
    delete d.error;
    d.verification = body.result === 'sent' ? '用户已在小红书确认发出' : '用户已在小红书确认未发出，可重新生成草稿';
    this.store.event('send_manually_resolved', { draftId: d.id, result: body.result });
    return d;
  }
  snapshot() {
    const clean = value => JSON.parse(JSON.stringify(value, (key, v) => key === 'token' ? undefined : v));
    return clean({ demo: this.demo, busy: this.busy, activeRun: this.activeRun,
      verification: this.store.state.verification || null,
      ...this.store.settings(), runs: this.store.state.runs, drafts: this.store.state.drafts,
      events: this.store.state.events.slice(0, 40) });
  }
  exportMarkdown(id) {
    const run = this.run(id);
    return [`# 小红书阅读清单${run.mode === 'demo' ? '（虚构演示）' : ''}`, '',
      `时间：${run.at}  \n关键词：${run.keyword}  \n兴趣：${run.preferences.interests}`, '',
      ...run.notes.flatMap(n => [`## ${n.title}`, '', n.url ? `原帖：${n.url}` : '演示笔记，无真实链接',
        '', `初筛 ${n.score}/20：${n.reason}`, '', n.reading?.summary || '已获取正文，尚未完成模型精读。', '',
        ...(n.reading?.points || []).map(p => `- ${p}`), '', '依据：',
        ...(n.reading?.evidence || []).map(e => `- ${e.source}：${e.quote}`), '', '阅读范围：',
        ...(n.reading?.limitations || []).map(p => `- ${p}`), ''])].join('\n');
  }
}
