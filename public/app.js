const $ = id => document.getElementById(id);
let state, csrf, tab = 'explore', selectedRun = null, sendDraft = null, polling = false, settingsLoaded = false;
let fishState = null, fishLoaded = false, fishLoading = 0;
const draftEdits = new Map();
const statusNames = { pending: '待审核', sending: '正在发送', sent: '已提交', uncertain: '需核对', rejected: '已放弃',
  waiting_verification: '等待人工验证',
  not_sent: '确认未发送', completed: '已完成', running: '进行中', queued: '等待中', failed: '未完成', cancelled: '已停止', interrupted: '已中断' };
function el(tag, cls, value) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (value !== undefined) node.textContent = value;
  return node;
}
function btn(label, action, cls = 'secondary small') {
  const node = el('button', cls, label); node.type = 'button';
  node.addEventListener('click', () => action(node)); return node;
}
function toast(message, error = false) {
  $('toast').textContent = message; $('toast').className = error ? 'error' : ''; $('toast').hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('toast').hidden = true; }, error ? 12000 : 5000);
}
async function api(route, body, raw = false) {
  const res = await fetch(`/api${route}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-xhs-csrf': csrf, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (raw && res.ok) return res;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}
async function action(fn, button) {
  if (button) button.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message, true); }
  finally { if (button) button.disabled = false; await refresh().catch(() => {}); }
}
function switchTab(next) {
  tab = next;
  document.querySelectorAll('.pane').forEach(p => { p.hidden = p.id !== next; });
  document.querySelectorAll('.nav').forEach(p => p.classList.toggle('active', p.dataset.tab === next));
  $('breadcrumb').textContent = `工作台 / ${{ explore: '发现与阅读', drafts: '回复草稿', history: '阅读记录', fish: '养鱼', settings: '连接设置' }[next]}`;
  render();
}
document.querySelectorAll('[data-tab]').forEach(n => n.addEventListener('click', () => switchTab(n.dataset.tab)));
function date(iso) { return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }
function currentRun() { return state?.runs.find(r => r.id === selectedRun) || state?.runs[0]; }
async function refresh() {
  state = await api('/state'); render();
}
function render() {
  if (!state) return;
  $('demo-banner').hidden = !state.demo;
  $('mode-label').textContent = state.demo ? '演示模式 · 独立数据' : '本地运行 · 审核发送';
  $('mode-pill').textContent = state.demo ? 'DEMO · 演示' : 'LIVE · 正式';
  $('draft-count').textContent = state.drafts.filter(d => d.status === 'pending').length;
  const fishPending = state.drafts.filter(d => d.status === 'pending' && d.origin === 'fish').length;
  $('fish-badge').hidden = !fishPending; $('fish-badge').textContent = fishPending;
  $('setup-hint').hidden = state.demo || state.hasApiKey;
  $('start-button').disabled = state.busy || !!state.verification;
  $('verification-panel').hidden = !state.verification;
  $('verification-message').textContent = state.verification?.message || '';
  const verificationWindow = state.verificationWindow || {};
  $('verification-open').disabled = state.busy || verificationWindow.open || verificationWindow.opening;
  $('verification-complete').disabled = !verificationWindow.open;
  $('verification-close').disabled = !verificationWindow.open;
  $('manual-verification').disabled = state.demo || state.busy || verificationWindow.opening;
  const active = state.runs.find(r => r.id === state.activeRun);
  $('progress').hidden = !active;
  $('progress-text').textContent = active?.progress || '';
  $('cancel-run').disabled = !!active?.cancelled;
  if (!settingsLoaded) { fillSettings(); settingsLoaded = true; }
  if (tab === 'explore') renderResults();
  if (tab === 'drafts' && !document.querySelector('#draft-list textarea:focus')) renderDrafts();
  if (tab === 'history') renderHistory();
  if (tab === 'fish') renderFish();
}
function renderResults() {
  const run = currentRun();
  $('results').replaceChildren();
  $('empty').hidden = !!run;
  $('run-actions').hidden = !run;
  $('run-meta').textContent = run ? `${statusNames[run.status] || run.status} · ${run.progress}${run.skippedRead ? ` · 跳过 ${run.skippedRead} 条已精读` : ''}` : '';
  if (!run) return;
  if (!run.notes.length && !['queued', 'running'].includes(run.status)) {
    $('results').append(el('p', 'hint', run.errors.length ? run.errors.join('；') : '没有符合条件的笔记，请调整关键词或筛选偏好。'));
  }
  for (const n of run.notes) {
    const card = el('article', 'note-card');
    const cover = el('div', 'card-cover');
    if (n.cover) { const img = el('img'); img.src = n.cover; img.alt = n.title; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; cover.append(img); }
    else cover.append(el('div', 'cover-fallback', n.title));
    cover.append(el('span', 'score', `${n.score}/20 · 初筛`));
    const body = el('div', 'card-body');
    body.append(el('h3', 'card-title', n.title), el('div', 'author', `${n.author.name || '作者'} · ${n.type === 'video' ? '视频笔记' : '图文笔记'}`),
      el('p', 'summary', n.reading?.summary || n.body || n.reason));
    const bottom = el('div', 'card-bottom');
    bottom.append(el('span', 'tag', n.reading ? '已精读' : '已获取正文'), btn('展开阅读 ↗', () => showNote(run, n), 'text-button'));
    body.append(bottom); card.append(cover, body); $('results').append(card);
  }
}
function list(title, items, parent) {
  if (!items?.length) return;
  parent.append(el('h3', 'subhead', title));
  const ul = el('ul'); items.forEach(x => ul.append(el('li', '', x))); parent.append(ul);
}
function sourceLink(note) {
  if (!note.url) return el('span', 'hint', '虚构演示笔记');
  const a = el('a', 'text-button', '打开小红书原帖 ↗');
  a.href = note.url; a.target = '_blank'; a.rel = 'noreferrer noopener'; return a;
}
function showNote(run, note) {
  const container = $('note-content'); container.replaceChildren();
  const head = el('div', 'note-heading');
  head.append(el('h2', '', note.title), el('span', 'author', `${note.author.name || '作者'} · ${note.score}/20 初筛评分　`), sourceLink(note));
  const columns = el('div', 'detail-columns'); const left = el('div'); const right = el('div');
  left.append(el('h3', '', '原帖正文'), el('div', 'original', note.body || '本次未返回正文'));
  if (note.images.length) {
    const images = el('div', 'detail-images');
    note.images.forEach((url, i) => { const img = el('img'); img.src = url; img.alt = `原帖图片 ${i + 1}`; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; images.append(img); });
    left.append(images, el('p', 'hint', `原帖 ${note.imageCount} 张图 · 本次分析附图 ${note.reading?.imagesProvided || 0} 张`));
  }
  left.append(el('h3', 'subhead', '已读取的评论'));
  if (!note.comments.length) left.append(el('p', 'hint', '本次没有返回评论。'));
  note.comments.forEach(c => {
    const item = el('div', `comment${c.parentId ? ' reply' : ''}`);
    item.append(el('small', '', c.author.name || '读者'), el('p', '', c.text));
    const b = btn('生成回复草稿', node => makeDraft(run.id, note.id, c.id, node), 'text-button');
    b.disabled = !note.reading || state.busy;
    item.append(b); left.append(item);
  });
  if (note.commentsPartial) left.append(el('p', 'hint', '评论未全部加载；以上不代表完整评论区。'));
  right.append(el('h3', '', 'DeepSeek 阅读笔记'));
  if (note.reading) {
    const r = note.reading;
    right.append(el('p', 'reading-text', r.summary));
    list('核心要点', r.points, right);
    list('阅读依据（模型提取）', r.evidence.map(e => `${e.source}：${e.quote}`), right);
    list('评论中的观点与问题', r.commentInsights, right);
    list('阅读范围与信息缺口', r.limitations, right);
    right.append(el('h3', 'subhead', '推荐理由'), el('p', 'reading-text', r.recommendation));
    const button = btn('为这条笔记写评论草稿', node => makeDraft(run.id, note.id, '', node), 'primary');
    button.disabled = state.busy; right.append(button);
  } else right.append(el('p', 'hint', '已读取原文，尚未完成模型精读。'));
  columns.append(left, right); container.append(head, columns);
  $('note-dialog').showModal();
}
async function makeDraft(runId, noteId, commentId, button) {
  await action(async () => {
    const draft = await api('/drafts', { runId, noteId, commentId });
    $('note-dialog').close(); await refresh(); switchTab('drafts');
    toast(draft.status === 'pending' ? '草稿已就绪，请核对后再发送。' : '该目标已有处理记录，请查看。');
  }, button);
}
$('close-note').onclick = () => $('note-dialog').close();
function renderDrafts() {
  const root = $('draft-list'); root.replaceChildren();
  if (!state.drafts.length) { root.append(el('div', 'empty', '还没有回复草稿。展开一条已精读笔记，选择想回复的评论。')); return; }
  state.drafts.forEach(d => {
    const card = el('article', 'draft-card');
    const head = el('div', 'draft-header');
    head.append(el('h3', '', d.title), el('span', `status-label ${d.status}`, statusNames[d.status] || d.status));
    card.append(head, el('p', 'hint', `${date(d.at)} · 账号：${d.account.name || d.account.id}${d.mode === 'demo' ? ' · 演示' : ''}`),
      el('div', 'quote', d.target ? `${d.target.author.name}：${d.target.text}` : '回复位置：原帖下方的顶层评论'));
    const textarea = el('textarea', 'draft-text'); textarea.value = draftEdits.get(d.id) ?? d.content; textarea.rows = 3;
    textarea.addEventListener('input', () => draftEdits.set(d.id, textarea.value));
    textarea.maxLength = 500; textarea.disabled = d.status !== 'pending'; textarea.setAttribute('aria-label', `回复草稿：${d.title}`);
    card.append(textarea);
    const actions = el('div', 'button-row');
    if (d.status === 'pending') {
      actions.append(btn('保存修改', node => action(async () => {
        await api('/drafts/edit', { id: d.id, revision: d.revision, content: textarea.value }); draftEdits.delete(d.id); toast('草稿修改已保存。');
      }, node)));
      const send = btn(state.demo ? '演示模式不可发送' : '审核并发送', () => {
        if (textarea.value !== d.content) { toast('请先保存修改，再审核发送。', true); return; }
        sendDraft = d;
        $('send-title').textContent = d.title;
        $('send-target').textContent = d.target ? `回复 ${d.target.author.name}：${d.target.text}` : '发送到原帖的顶层评论区';
        $('send-preview').textContent = d.content + (d.mentions?.length ? `\n\n真实 @：${d.mentions.map(m => `${m.name}（${m.id}）`).join('、')}` : '');
        $('send-account').textContent = `发送账号：${d.account.name || d.account.id}。确认后将公开发布这段文字。`;
        $('send-dialog').showModal();
      }, 'primary');
      send.disabled = state.demo || state.busy || !state.config.sendingEnabled; actions.append(send);
      actions.append(btn('放弃草稿', node => action(() => api('/drafts/reject', { id: d.id }), node), 'text-button'));
      if (!state.config.sendingEnabled && !state.demo) card.append(el('p', 'hint', '审核发送尚未开启，可在连接设置中开启。'));
    }
    if (d.status === 'uncertain') {
      actions.append(btn('我已核对：已经发出', node => resolveDraft(d, 'sent', node)),
        btn('我已核对：没有发出', node => resolveDraft(d, 'not_sent', node)));
    }
    const note = state.runs.find(r => r.id === d.runId)?.notes.find(n => n.id === d.noteId);
    if (note) actions.append(sourceLink(note));
    card.append(actions);
    if (d.error && ['uncertain','not_sent'].includes(d.status)) card.append(el('p', 'hint', d.error));
    if (d.mentions?.length) card.append(el('p', 'hint', `真实 @ 对象：${d.mentions.map(m => m.name).join('、')}（发送时选择平台用户项）`));
    if (d.verification) card.append(el('p', 'hint', d.verification));
    root.append(card);
  });
}
async function resolveDraft(d, result, node) {
  if (!window.confirm(result === 'sent' ? '已在小红书确认这条回复已发出？' : '已在小红书确认这条回复没有发出？确认后可以重新生成草稿。')) return;
  await action(() => api('/drafts/resolve', { id: d.id, result, confirm: true }), node);
}
function renderHistory() {
  const root = $('history-list'); root.replaceChildren();
  if (!state.runs.length) { root.append(el('div', 'empty', '还没有阅读记录。')); return; }
  state.runs.forEach(r => {
    const row = el('article', 'history-row'); const detail = el('div');
    detail.append(el('h3', '', r.keyword || '首页推荐'), el('small', '', `${date(r.at)} · ${r.notes.length} 条笔记 · ${r.preferences.interests || '通用阅读'}`));
    row.append(detail, el('span', 'status-label', statusNames[r.status] || r.status),
      btn('查看 →', () => { selectedRun = r.id; switchTab('explore'); })); root.append(row);
  });
}
// ── 养鱼 ─────────────────────────────────────────────────────────────
async function loadFish(force = false) {
  if (!force && fishState && Date.now() - fishLoading < 8000) return;
  fishLoading = Date.now();
  const [status, inbox, letter, priv] = await Promise.all([
    api('/fish/status'), api('/fish/inbox?all=1'),
    api('/fish/diary?book=letter&tail=4000'), api('/fish/diary?book=private&tail=4000'),
  ]);
  fishState = { status, inbox: inbox.items || [], letter: letter.content, private: priv.content };
}
async function renderFish() {
  try {
    if (state.demo) {
      $('fish-status').replaceChildren(el('p', 'hint', '演示模式没有养鱼：养鱼只连真实账号，请打开正式版。'));
      return;
    }
    await loadFish();
    renderFishStatus(); renderFishInbox(); renderFishDiaries(); renderFishNotices();
    if (!fishLoaded) { fillFishForm(fishState.status.config); fishLoaded = true; }
  } catch (e) {
    const root = $('fish-status');
    if (root) root.replaceChildren(el('p', 'hint', `养鱼暂时不可用：${e.message}。如果刚更新过插件，请重启 DSH。`));
  }
}
const roleNames = { self: '我自己', owner: '主人', stranger: '陌生人' };
const kindNames = { reply: '回复', mention: '@你', like: '点赞', favorite: '收藏', follow: '关注', unknown: '其他' };
function renderFishStatus() {
  const s = fishState.status;
  const root = $('fish-status'); root.replaceChildren();
  const cards = [
    ['今天的计划', s.planText || '还没排计划'],
    ['今日记录', `评论 ${s.quota.sharesToday} · 回复 ${s.quota.repliesToday} · 全站发送 ${s.today.sends}（不设每日上限）`],
    ['收件箱', `待回 ${s.inbox.pending} 条（主人 ${s.inbox.owner} / 陌生人 ${s.inbox.stranger}）`],
    ['草稿', `待审 ${s.drafts.pending} 条（其中养鱼 ${s.drafts.fishPending} 条）`],
    ['状态', `${s.today.sendingEnabled ? '可以发送' : '发送开关关着（只能写草稿）'} · 沉默 ${s.quota.silentDays} 天 · 自检${s.selftestPassed ? '已通过' : '还没跑'}`],
  ];
  for (const [label, value] of cards) {
    const card = el('div', 'fish-card');
    card.append(el('span', 'fish-card-label', label), el('strong', '', value));
    root.append(card);
  }
  const warn = $('fish-warnings'); warn.replaceChildren();
  for (const message of s.warnings || []) warn.append(el('p', 'fish-warn', `· ${message}`));
}
function fishWindowsNode(windows, onChange) {
  const box = $('fish-windows'); box.replaceChildren();
  windows.forEach((w, index) => {
    const row = el('div', 'fish-window');
    const start = el('input'); start.type = 'time'; start.value = w.start || '20:00';
    const sep = el('span', 'hint', '–');
    const end = el('input'); end.type = 'time'; end.value = w.end || '24:00';
    const count = el('input'); count.type = 'number'; count.min = '0'; count.max = '12'; count.value = w.wakes ?? 1;
    count.title = '这个窗口最多醒几次';
    const del = btn('✕', () => { windows.splice(index, 1); onChange(windows); }, 'text-button');
    del.title = '删除这个窗口';
    row.append(start, sep, end, count, del);
    box.append(row);
  });
}
let fishWindows = [];
function fillFishForm(cfg) {
  const f = $('fish-form');
  f.elements.personaName.value = cfg.persona?.name ?? '';
  f.elements.personaOwner.value = cfg.persona?.ownerTitle ?? '';
  f.elements.personaSelf.value = cfg.persona?.selfClaim ?? '';
  fishWindows = (cfg.night?.windows || []).map(w => ({ ...w }));
  fishWindowsNode(fishWindows, renderWindowsAgain);
  f.elements.maxWakes.value = cfg.night?.maxWakesPerDay ?? 2;
  f.elements.minWakes.value = cfg.night?.minWakesPerWindow ?? 1;
  f.elements.skipChance.value = Math.round((cfg.night?.skipChance ?? 0.3) * 100);
  f.elements.topics.value = (cfg.topics || []).join('\n');
  f.elements.source.value = cfg.feed?.source || 'auto';
  f.elements.candidates.value = cfg.feed?.candidates ?? 5;
  f.elements.shortlist.value = cfg.feed?.shortlist ?? 3;
  f.elements.deep.value = cfg.feed?.deep ?? 2;
  f.elements.sort.value = cfg.feed?.sort || '最新';
  f.elements.publish.value = cfg.feed?.publish || '一周内';
  f.elements.localEnabled.checked = cfg.feed?.local?.enabled !== false;
  f.elements.city.value = cfg.feed?.local?.city ?? '北京';
  f.elements.localCount.value = cfg.feed?.local?.count ?? 3;
  f.elements.filtersEnabled.checked = cfg.feed?.filters === true;
  f.elements.shareEnabled.checked = !!cfg.share?.enabled;
  f.elements.mentionOwner.checked = !!cfg.share?.mentionOwner;
  $('owner-resolution').textContent = cfg.reply?.ownerProfileId ? `已绑定：${cfg.reply.ownerNickname}（${cfg.reply.ownerProfileId}）` : '尚未核实真实用户；不会用普通 @ 文本代替提及。';
  f.elements.likeEnabled.checked = cfg.like?.enabled !== false;
  f.elements.likeDaily.value = cfg.like?.daily ?? 10;
  f.elements.ownerUserId.value = cfg.reply?.ownerUserId ?? '';
  f.elements.ownerDirect.checked = !!cfg.reply?.ownerDirect;
  f.elements.strangerPolicy.value = cfg.reply?.strangerPolicy || 'draft';
  f.elements.visitEnabled.checked = cfg.visit?.enabled !== false;
  f.elements.listenEnabled.checked = !!cfg.listen?.enabled;
  f.elements.listenAllDay.checked = !!cfg.listen?.allDay;
  f.elements.listenInterval.value = cfg.listen?.intervalSec ?? 300;
  f.elements.diaryPush.checked = !!cfg.diary?.push;
  f.elements.notifyType.value = cfg.notify?.type || 'workbench';
  f.elements.notifyUrl.value = cfg.notify?.url || '';
}
function renderWindowsAgain(next) { fishWindows = next; fishWindowsNode(fishWindows, renderWindowsAgain); }
function collectFishConfig() {
  const f = $('fish-form');
  const windows = [...$('fish-windows').querySelectorAll('.fish-window')].map(row => {
    const inputs = row.querySelectorAll('input');
    return { start: inputs[0].value, end: inputs[1].value, wakes: Number(inputs[2].value) || 0 };
  });
  return {
    enabled: fishState?.status?.config?.enabled !== false,
    persona: { name: f.elements.personaName.value, ownerTitle: f.elements.personaOwner.value, selfClaim: f.elements.personaSelf.value },
    night: { windows, maxWakesPerDay: Number(f.elements.maxWakes.value), minWakesPerWindow: Number(f.elements.minWakes.value), skipChance: Number(f.elements.skipChance.value) / 100 },
    topics: f.elements.topics.value.split('\n').map(s => s.trim()).filter(Boolean),
    feed: {
      source: f.elements.source.value, candidates: Number(f.elements.candidates.value),
      shortlist: Number(f.elements.shortlist.value), deep: Number(f.elements.deep.value),
      sort: f.elements.sort.value, publish: f.elements.publish.value,
      local: {
        enabled: f.elements.localEnabled.checked, city: f.elements.city.value.trim(),
        count: Number(f.elements.localCount.value),
      },
      filters: f.elements.filtersEnabled.checked,
    },
    visit: { enabled: f.elements.visitEnabled.checked },
    share: { enabled: f.elements.shareEnabled.checked, mentionOwner: f.elements.mentionOwner.checked },
    like: { enabled: f.elements.likeEnabled.checked, daily: Number(f.elements.likeDaily.value) },
    reply: { ownerUserId: f.elements.ownerUserId.value.trim(), ownerDirect: f.elements.ownerDirect.checked,
      strangerPolicy: f.elements.strangerPolicy.value },
    listen: { enabled: f.elements.listenEnabled.checked, allDay: f.elements.listenAllDay.checked, intervalSec: Number(f.elements.listenInterval.value) },
    diary: { push: f.elements.diaryPush.checked },
    notify: { type: f.elements.notifyType.value, url: f.elements.notifyUrl.value.trim() },
  };
}
function renderFishInbox() {
  const root = $('fish-inbox'); root.replaceChildren();
  const items = fishState.inbox || [];
  if (!items.length) {
    root.append(el('p', 'hint', '（收件箱是空的。没有人找你，或者还没扫过。点右上角「立即扫一次」。）'));
    return;
  }
  for (const item of items.slice(0, 20)) {
    const card = el('div', 'fish-inbox-item');
    const head = el('div', 'fish-inbox-head');
    head.append(el('span', `status-label ${item.role === 'owner' ? 'sent' : item.role === 'self' ? 'rejected' : 'pending'}`, roleNames[item.role] || item.role),
      el('span', 'tag', kindNames[item.kind] || item.kind),
      el('strong', '', item.from?.name || '（无昵称）'),
      item.alreadyReplied ? el('span', 'hint', `已处理：${item.repliedStatus}`) : el('span', 'hint', '未回'));
    card.append(head, el('p', 'fish-inbox-text', item.comment?.text || '（无正文）'),
      el('p', 'hint', `笔记：${item.feed?.title || item.feed?.id || '未知'} · ${item.at ? date(item.at) : ''}`));
    if (item.postable && !item.alreadyReplied) {
      const actions = el('div', 'button-row');
      const writeDraft = () => {
        const text = window.prompt(`以${item.from?.name || '对方'}为对象写一条回复（草稿，等我审）：`, '');
        if (!text) return;
        action(async () => {
          await api('/fish/draft', { commentId: item.comment.id, content: text });
          toast('已进待审草稿。'); await loadFish(true); renderFish();
        }, null);
      };
      if (item.role === 'owner' && fishState.status.config.reply?.ownerDirect) {
        actions.append(btn('直接回复（发出）', node => {
          const text = window.prompt('直接发出去的回复：', '');
          if (!text) return;
          if (!window.confirm(`将以当前账号直接回复 ${item.from?.name || '对方'}：\n\n${text}`)) return;
          action(async () => {
            const r = await api('/fish/reply', { commentId: item.comment.id, content: text, dry: false });
            toast(r.verification || '已发出。');
            await loadFish(true); renderFish();
          }, node);
        }, 'primary small'));
      }
      actions.append(btn('写回复草稿', writeDraft, 'secondary small'));
      card.append(actions);
    }
    root.append(card);
  }
}
function renderFishDiaries() {
  $('fish-diary-letter').textContent = fishState.letter?.trim() || '（还没写）';
  $('fish-diary-private').textContent = fishState.private?.trim() || '（还没写）';
}
function renderFishNotices() {
  const root = $('fish-notices'); root.replaceChildren();
  const notices = fishState.status.notices || [];
  if (!notices.length) { root.append(el('p', 'hint', '（还没有推送。等她写完日记推你一条。）')); return; }
  for (const n of notices) {
    const row = el('div', 'fish-notice');
    row.append(el('small', '', date(n.at)), el('p', '', n.text));
    root.append(row);
  }
}
$('fish-form').onsubmit = e => {
  e.preventDefault();
  action(async () => {
    await api('/fish/config', { config: collectFishConfig() });
    fishLoaded = false; await loadFish(true); fillFishForm(fishState.status.config); fishLoaded = true;
    renderFishStatus(); $('fish-save-hint').textContent = '已保存，生物钟会按新作息重算。';
    toast('养鱼设置已保存。');
  }, e.submitter);
};
$('fish-add-window').onclick = () => {
  fishWindows = [...fishWindows, { start: '20:00', end: '22:00', wakes: 1 }];
  fishWindowsNode(fishWindows, renderWindowsAgain);
};
$('fish-scan').onclick = () => action(async () => {
  $('fish-scan-hint').textContent = '正在扫（要开一次浏览器，十几秒）…';
  const r = await api('/fish/inbox/scan', { force: true });
  $('fish-scan-hint').textContent = r.skipped ? r.skipped : `新增 ${r.fresh ?? 0} 条`;
  await loadFish(true); renderFish();
}, $('fish-scan'));
$('fish-selftest').onclick = () => action(async () => {
  const box = $('fish-selftest-out');
  box.hidden = false; box.textContent = '正在自检（会真的检查一次登录）…';
  const r = await api('/fish/selftest', {});
  box.replaceChildren(...r.items.map(item => el('div', `fish-selftest-row ${item.ok ? 'ok' : 'bad'}`,
    `${item.ok ? '✓' : '✗'} ${item.name}${item.detail ? ' — ' + item.detail : ''}`)));
  box.append(el('p', 'hint', r.ok ? '核心项通过。接下来：找到「工作区 → 未分组 → xhs-whale」并给它完全访问权限。'
    : '有核心项没过，按上面的提示处理后再试。'));
  toast(r.ok ? '启动测试：核心项通过。' : '启动测试：还有核心项没过。', !r.ok);
}, $('fish-selftest'));

function fillSettings() {
  const form = $('settings-form');
  for (const [key, value] of Object.entries(state.config)) {
    const input = form.elements.namedItem(key); if (!input) continue;
    if (input.type === 'checkbox') input.checked = value; else input.value = value;
  }
  form.elements.apiKey.value = ''; form.elements.xhsToken.value = '';
  $('interests').value = state.config.interests; $('excludes').value = state.config.excludes;
  $('key-state').textContent = state.hasApiKey ? `密钥已配置${state.apiKeyFromEnvironment ? '（环境变量）' : '（本机文件）'}` : '尚未配置 API Key';
  $('xhs-token-state').textContent = state.hasXhsToken ? '服务令牌已保存' : '未设置令牌；上游未启用鉴权时可以留空';
}
async function saveSettings() {
  const form = $('settings-form');
  const config = {};
  for (const key of Object.keys(state.config)) {
    const input = form.elements.namedItem(key); if (!input) continue;
    config[key] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
  }
  await api('/settings', { config, apiKey: form.elements.apiKey.value, xhsToken: form.elements.xhsToken.value });
  await refresh(); fillSettings(); $('settings-message').textContent = '已保存。';
}
$('settings-form').onsubmit = e => { e.preventDefault(); action(async () => { await saveSettings(); toast('设置已保存。'); }, e.submitter); };
$('search-form').onsubmit = e => {
  e.preventDefault();
  action(async () => {
    const run = await api('/runs', { keyword: $('keyword').value, interests: $('interests').value,
      excludes: $('excludes').value, source: $('source').value, sort: $('sort').value, publish: $('publish').value, skipRead: $('skip-read').checked });
    selectedRun = run.id; toast('已开始筛选，可以在这里查看进度。');
  }, e.submitter);
};
$('cancel-run').onclick = () => action(() => api('/runs/cancel', { id: state.activeRun }), $('cancel-run'));
$('export-run').onclick = () => action(async () => {
  const run = currentRun(); if (!run) return;
  const res = await api(`/runs/${run.id}/export`, undefined, true);
  const url = URL.createObjectURL(await res.blob()); const a = el('a');
  a.href = url; a.download = `小红书阅读-${run.at.slice(0, 10)}.md`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
async function connectionAction(statusId, pendingText, task, button) {
  return action(async () => {
    $(statusId).textContent = pendingText;
    try { await saveSettings(); await task(); }
    catch (error) { $(statusId).textContent = `连接失败：${error.message}`; throw error; }
  }, button);
}
$('check-login').onclick = () => connectionAction('login-status', '正在检查登录…', async () => {
  const r = await api('/login', {});
  $('login-status').textContent = r.is_logged_in ? `已登录：${r.username || '小红书用户'}${r.user_id ? ` · ${r.user_id}` : '（服务未返回账号 ID，需要更新版本）'}` : '尚未登录，请点击扫码登录。';
  if (r.is_logged_in) $('qr-image').hidden = true;
}, $('check-login'));
$('get-qr').onclick = () => connectionAction('login-status', '正在获取二维码…', async () => {
  $('qr-image').hidden = true;
  const r = await api('/qrcode', {});
  if (r.is_logged_in) { $('login-status').textContent = '已经登录，可点击“检查登录”确认账号。'; return; }
  if (!r.img) throw new Error('服务未返回二维码，请运行登录工具。');
  const image = r.img.startsWith('data:image/') ? r.img : `data:image/png;base64,${r.img}`;
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/.test(image)) throw new Error('二维码格式不支持');
  $('qr-image').src = image; $('qr-image').hidden = false;
  $('login-status').textContent = '用小红书 App 扫码，完成后点击“检查登录”。二维码过期可重新获取。';
}, $('get-qr'));
$('test-model').onclick = () => connectionAction('model-status', '正在测试模型连接…', async () => {
  const r = await api('/model/test', {}); $('model-status').textContent = `连接成功：${r.model}`;
}, $('test-model'));
for (const id of ['close-send', 'cancel-send']) $(id).onclick = () => $('send-dialog').close();
$('confirm-send').onclick = () => action(async () => {
  const d = sendDraft; $('send-dialog').close();
  const result = await api('/drafts/send', { id: d.id, content: d.content, revision: d.revision, confirm: true });
  toast(result.verification || '已提交，请核对原帖。');
}, $('confirm-send'));
async function init() {
  try {
    const session = await fetch('/api/session').then(r => r.json()); csrf = session.csrf;
    await refresh();
    setInterval(async () => {
      if (polling || document.hidden) return;
      polling = true;
      try { await refresh(); } catch (e) { $('mode-pill').textContent = '连接中断，请刷新'; }
      finally { polling = false; }
    }, 3000);
  } catch (e) { toast(`无法连接本地服务：${e.message}`, true); }
}
$('verification-open').onclick = () => action(async () => {
  await api('/verification/open', {});
  toast('请在弹出的浏览器中亲自完成验证，再回到这里保存。');
}, $('verification-open'));
$('resolve-owner').onclick = () => action(async () => {
  const ownerUserId = $('fish-form').elements.ownerUserId.value.trim();
  await api('/fish/config', { config: { reply: { ownerUserId } } });
  const owner = await api('/fish/owner/resolve', {});
  $('owner-resolution').textContent = `已核实：${owner.name}（小红书号 ${owner.red_id}）`;
  toast('已绑定主人，真实 @ 会按这个用户 ID 选择。');
}, $('resolve-owner'));
$('manual-verification').onclick = () => action(async () => {
  await api('/verification/open', {});
  toast('已暂停自动操作，请在弹出的浏览器中验证，再回到页面上方保存。');
}, $('manual-verification'));
$('verification-complete').onclick = () => action(async () => {
  const result = await api('/verification/complete', { confirm: true });
  toast(result.message);
}, $('verification-complete'));
$('verification-close').onclick = () => action(async () => {
  await api('/verification/close', {});
  toast('已关闭验证窗口，自动操作仍暂停。');
}, $('verification-close'));
init();
