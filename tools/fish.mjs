#!/usr/bin/env node
/**
 * 养鱼命令行 —— 这条鱼"伸手做事"的唯一入口。
 *
 * 设计原则（照抄 dsh-bili-whale 的安全约定）：
 *   · 读命令随便跑；写命令必须显式 --go，默认 --dry 只预览
 *   · 一次一条：不做批量、不刷屏
 *   · 所有真正的校验在工作台里（同一条笔记 7 天、同一条评论只回一次、发送主开关），
 *     这个脚本只负责把话说清楚 —— 就算被人绕过，也发不出去
 *
 * 用法：node tools/fish.mjs help
 */
const DEFAULT_URL = process.env.XHS_URL || 'http://127.0.0.1:18061';

// ── 参数解析 ───────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'help';
const flags = new Map();
const positionals = [];
for (let i = command === 'help' ? 0 : 1; i < argv.length; i++) {
  const token = argv[i];
  if (token.startsWith('--')) {
    const eq = token.indexOf('=');
    if (eq > 0) { flags.set(token.slice(2, eq), token.slice(eq + 1)); continue; }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags.set(key, next); i++; } else flags.set(key, true);
  } else positionals.push(token);
}
const flag = (name, fallback = '') => (flags.has(name) ? (flags.get(name) === true ? 'true' : String(flags.get(name))) : fallback);
const has = name => flags.has(name);
const num = (name, fallback) => {
  const value = Number(flag(name, ''));
  return Number.isFinite(value) ? value : fallback;
};

const baseUrl = (flag('url') || DEFAULT_URL).replace(/\/+$/, '');

// ── HTTP ──────────────────────────────────────────────────────────────
let csrf = null;
/**
 * 连工作台。
 *
 * 为什么要等：DSH 刚重启时，插件可能还在启动工作台（或者上一个进程还没释放 18061）。
 * 她第一次醒来的那一轮就撞上过这个窗口 —— 于是"未登录 / 连不上服务"看起来像坏了。
 * 这里最多等约 30 秒，足够插件把服务挂起来；真的没起来才报错。
 */
async function connect() {
  if (csrf) return;
  let lastError = '';
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/api/session`, { signal: AbortSignal.timeout(4000) });
      if (response.ok) { csrf = (await response.json()).csrf; return; }
      lastError = `HTTP ${response.status}`;
    } catch (e) { lastError = e.name === 'TimeoutError' ? '超时' : e.message; }
    if (attempt === 2) console.log('工作台还没就绪，等一下再连…（最多约 30 秒）');
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`连不上工作台（${baseUrl}）：${lastError}。先运行 \`node tools/xhs.mjs serve\`，或在 DSH 里打开小红书插件。`);
}

async function request(route, { method = 'GET', body, timeout = 60_000 } = {}) {
  await connect();
  const url = `${baseUrl}/api/fish${route}`;
  const payloadBody = method === 'POST' ? (body ?? {}) : undefined;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { 'x-xhs-csrf': csrf, ...(payloadBody === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(payloadBody === undefined ? {} : { body: JSON.stringify(payloadBody) }),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError'
      ? `这次操作超时了（${Math.round(timeout / 1000)} 秒）。小红书服务可能卡住了，看一下 data/xhs-service/stderr.log。`
      : `请求失败：${e.message}`);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

async function api(route, options = {}) {
  try { return await request(route, options); }
  catch (e) { fail(e.message); }
}

/** 失败时返回 { ok:false, error } 而不是退出 —— 给"体检"这种要逐项报告的命令用。 */
async function apiSoft(route, options = {}) {
  try { return { ok: true, data: await request(route, options) }; }
  catch (e) { return { ok: false, error: e.message }; }
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}
function out(text = '') { console.log(text); }
function json(value) { console.log(JSON.stringify(value, null, 2)); }
function section(title) { out(`\n${title}`); out('─'.repeat(Math.max(8, Math.min(48, title.length * 2)))); }

// ── 命令 ──────────────────────────────────────────────────────────────
const COMMANDS = {
  help,
  deps,
  selftest,
  status,
  feed,
  inbox,
  reply,
  visit,
  draft,
  comment,
  like,
  diary,
  notify,
  log,
  quota,
};

async function help() {
  out(`养鱼 CLI —— 一条自己刷小红书、自己分清谁在说话的鱼

用法：node tools/fish.mjs <命令> [参数]
      fish.cmd <命令>            （在养鱼会话目录里，\`\\fish.cmd\` 就是它）

读：
  status                  今天的作息计划、发送记录、待回评论、提醒
  feed [--n 5] [--deep 2] [--topic 关键词] [--source auto|feed|search]
                          自己刷一轮：候选 → 精读 → 摘要（1–3 分钟）
  inbox [--all]           收件箱：谁回复了你、是谁、还能不能回（--scan 强制立即扫一次）
  visit [--comment <id>]  不带参数列待回访；带触发评论 ID 自动精读最新作品、预览、点赞并留言
  visit --prepare --run <id> --note <id> --message "…" [--mention]  兼容旧手动待办；正常自动回访不需要这一步
  visit --tasks          查看回访结果和历史手动待办
  diary [--book letter|private] [--show] [--tail 2000]
                          看/写日记（不给 --text 就是看）
  quota                   今天的发送记录（不设每日上限）

写（默认 --dry 只预览，真的发要 --go）：
  comment --note <noteId> --message "…" [--dry|--go] [--mention|--no-mention]
                          在笔记下发一条顶层评论（算"分享"，有每日上限）
                          --mention 真实 @ 主人；--no-mention 普通评论不带 @
  like --note <noteId> [--dry|--go]
                          给这条笔记点赞（不错的帖子才点；同一篇只点一次）
  reply --comment <id> --message "…" [--dry|--go]
                          回复一条评论（主人直发；陌生人按设置只会进草稿）
  draft --comment <id> --message "…"
                          把回复写成草稿，进工作台等主人审（陌生人走这条）
  diary --book letter --text "…"
                          追加今天的日记
  notify --text "…"       推给主人（工作台「养鱼」里能看到）
  log --kind done --note "…"
                          记一条事件

自检：
  deps                    登录 / 模型 / 发送开关 / 人设 / 主人 ID
  selftest                启动测试：跑一遍并告诉你还差哪两步

通用：--json 输出机器可读结果；--url <地址> 指定工作台（默认 http://127.0.0.1:18061）`);
}

async function deps() {
  const s = await api('/status', { timeout: 20_000 });
  // 真的问一次"我是谁"：不能拿"还没扫过收件箱"当成未登录 —— 第一次醒来时她就被这条误导过。
  const who = await apiSoft('/identity', { timeout: 30_000 });
  const me = who.ok ? who.data.self : (s.self?.id ? s.self : null);
  const loginDetail = !me
    ? `未登录：${who.error || '服务没有返回账号'}`
    : `${me.name}（${me.id}）`;
  const items = [
    { name: '工作台', ok: true, detail: baseUrl },
    { name: '养鱼配置', ok: !!s.config?.__present, detail: s.config?.__present ? '已配置' : '还没保存过设置' },
    { name: '小红书账号', ok: !!me, detail: loginDetail },
    { name: '发送主开关', ok: !!s.today?.sendingEnabled, detail: s.today?.sendingEnabled ? '已打开' : '关着：只能写草稿' },
    { name: '主人用户 ID', ok: !!s.ownerUserId, detail: s.ownerUserId || '未填：主人的评论会被当成陌生人' },
    { name: '收件箱监听', ok: !!s.config?.listen?.enabled, detail: s.config?.listen?.enabled ? `每 ${s.config.listen.intervalSec} 秒` : '关着' },
    { name: '今天计划', ok: true, detail: s.planText },
  ];
  if (has('json')) return json({ ok: items.every(i => i.ok), items, status: s });
  section('依赖体检');
  for (const item of items) out(`${item.ok ? '✓' : '✗'} ${item.name} — ${item.detail}`);
  if (s.warnings?.length) { out(''); for (const w of s.warnings) out(`· ${w}`); }
}

async function selftest() {
  const r = await api('/selftest', { method: 'POST', timeout: 120_000 });
  if (has('json')) return json(r);
  section('启动测试');
  for (const item of r.items) out(`${item.ok ? '✓' : '✗'} ${item.name} — ${item.detail || ''}`);
  out('');
  if (r.ok) out('核心项（登录 / 密钥 / 数据目录 / Node）都通过 ✓');
  out('────────── 接下来要做的两件事（很多人卡在这）──────────');
  out('');
  out('  ① 【找到她的会话】');
  out('     插件启动时会自动开一个会话，位置在：');
  out('       左侧「工作区」→ 展开「未分组」文件夹 → 里面那个 xhs-whale');
  out('     ⚠️ 不点开「未分组」是看不见它的 —— 这一步最容易漏');
  out('');
  out('  ② 【给她完全权限】');
  out('     打开那个会话 → 权限设置 → 选「完全访问 / danger-full-access」');
  out('     否则她起来后跑不了命令、发不了评论、写不了日记');
  out('');
  out('  ══════════ 全部通过 ✓ 可以用了 ══════════');
}

async function status() {
  const s = await api('/status', { timeout: 20_000 });
  if (has('json')) return json(s);
  section('今天');
  out(`计划：${s.planText}`);
  out(`今日记录：评论 ${s.quota.sharesToday} · 回复 ${s.quota.repliesToday} · 全站发送 ${s.today.sends}（不设每日上限）`);
  out(`收件箱：待回 ${s.inbox.pending} 条（主人 ${s.inbox.owner} / 陌生人 ${s.inbox.stranger}）`);
  out(`草稿：待审 ${s.drafts.pending} 条（其中养鱼 ${s.drafts.fishPending} 条）`);
  out(`沉默：${s.quota.silentDays} 天`);
  if (s.notices?.length) {
    section('最近推送');
    for (const n of s.notices) {
      // 她常把"【给他的信里最想说的那一段】"当小标题写，列表里只显示标题会像没内容 —— 跳到第一句真话。
      const lines = n.text.split('\n').map(s => s.trim()).filter(Boolean);
      const line = lines.find(s => !/^【[^】]*】$/.test(s)) || lines[0] || '';
      out(`· ${beijing(n.at)} ${line.slice(0, 90)}`);
    }
  }
  if (s.warnings?.length) { section('提醒'); for (const w of s.warnings) out(`· ${w}`); }
  section('她的日记');
  out(`给主人的信：${beijing(s.diary.letter) || '还没写'}`);
  out(`自己的日记：${beijing(s.diary.private) || '还没写'}`);
}

/** 文件与事件都是 UTC ISO，给人看要转成北京时间。 */
function beijing(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(d);
}

async function feed() {
  const body = {
    n: num('n', undefined), deep: num('deep', undefined),
    topic: flag('topic') || undefined, source: flag('source') || undefined,
  };
  if (!has('json')) console.log('正在刷小红书…（同城 + 关键词，通常 2–4 分钟）');
  const d = await api('/run', { method: 'POST', body, timeout: 900_000 });
  if (has('json')) return json(d);
  const local = d.local || {};
  const localLabel = local.filtered ? '同城' : '本地';
  const where = local.count ? `${localLabel}${local.city ? '（' + local.city + '）' : ''} ${local.count} 条 + ` : '';
  section(`刷完一轮：${where}${d.source === 'search' ? '关键词「' + d.topic + '」' : '首页推荐'}`);
  if (local.error) out(`（本地那一段没刷成：${local.error} —— 其余照常）`);
  if (d.filters && d.filters.attempted && d.filters.ok === false) out('（平台筛选这次没成：已退回不带筛选，并按发布时间从新到旧排）');
  else if (d.filters && !d.filters.attempted) out('（平台筛选未开启：按「城市词 + 发布时间」近似本地/近期）');
  if (d.fallback) out(`（搜索没成功（搜索页没加载出来，常见于短时间搜索过多），已退回首页：${d.fallback.slice(0, 100)}）`);
  out(`${d.candidates} 条候选 · ${d.notes.length} 条读取 · 跳过 ${d.skippedRead} 条读过的`);
  if (d.lowComment) {
    out(d.lowComment.count
      ? `低评论帖（≤${d.lowComment.max}）：${d.lowComment.count} 条可选 —— 至少挑一条点赞 + 评论`
      : `这一轮没有评论数 ≤${d.lowComment.max} 的帖子：别硬凑，按"有具体话就回"来`);
  }
  for (const [index, note] of d.notes.entries()) {
    const comments = note.comments || [];
    const owners = comments.filter(c => c.role === 'owner').length;
    const when = note.daysAgo === null || note.daysAgo === undefined ? '日期未知'
      : note.daysAgo === 0 ? '今天' : note.daysAgo === 1 ? '昨天' : `${note.daysAgo} 天前`;
    out('');
    const lowTag = Number(note.commentCount ?? 99) <= 5 ? ' · 低评论' : '';
    out(`${index + 1}. ${note.scope === 'local' ? '[同城] ' : ''}${note.title}  [${note.score ?? '?'}/20]`);
    out(`   ${note.author.name || '作者'} · ${note.type === 'video' ? '视频' : '图文'} · ${when}${note.ipLocation ? ' · ' + note.ipLocation : ''} · 评论 ${note.commentCount ?? '?'}${lowTag}${note.liked ? ' · 已赞' : ''} · noteId=${note.noteId}`);
    if (note.url) out(`   ${note.url}`);
    if (note.reading?.summary) out(`   摘要：${note.reading.summary}`);
    if (note.reading?.points?.length) for (const point of note.reading.points.slice(0, 4)) out(`   - ${point}`);
    if (note.reading?.recommendation) out(`   推荐：${note.reading.recommendation}`);
    if (comments.length) {
      out(`   评论 ${comments.length} 条${owners ? `（其中 ${owners} 条来自主人）` : ''}：`);
      for (const c of comments.slice(0, 6)) {
        const who = c.role === 'owner' ? `主人 ${c.author.name}` : c.role === 'self' ? `我自己` : `陌生人 ${c.author.name}`;
        out(`     [${who}] ${String(c.text).replace(/\s+/g, ' ').slice(0, 80)}  (${c.commentId})`);
      }
    }
  }
}

async function inbox() {
  if (has('scan')) await api('/inbox/scan', { method: 'POST', body: { force: has('force') }, timeout: 300_000 });
  const r = await api(`/inbox${has('all') ? '?all=1' : ''}`, { timeout: 30_000 });
  if (has('json')) return json(r);
  section(`收件箱：待回 ${r.counts.pending} 条（主人 ${r.counts.owner} / 陌生人 ${r.counts.stranger}）`);
  if (!r.items.length) return out('（没有人找你。安静的一天。）');
  for (const [index, item] of r.items.entries()) {
    const who = item.role === 'owner' ? `主人 ${item.from.name || ''}` : item.role === 'self' ? '我自己' : `陌生人 ${item.from.name || ''}`;
    const kind = { reply: '回复', mention: '@你', like: '点赞', favorite: '收藏', follow: '关注' }[item.kind] || item.kind;
    out('');
    out(`${index + 1}. [${kind}] ${who}${item.alreadyReplied ? ` · 已处理（${item.repliedStatus}）` : ''}`);
    out(`   他说：${String(item.comment.text).replace(/\s+/g, ' ').slice(0, 200) || '（无正文）'}`);
    out(`   笔记：${item.feed.title || item.feed.id || '（未知）'}`);
    out(`   坐标：--comment ${item.comment.id}${item.postable ? '' : '（这条不需要/不能回）'}`);
  }
}

async function reply() {
  const commentId = flag('comment') || positionals[0];
  const message = flag('message');
  if (!commentId) fail('缺少 --comment <评论ID>（先跑 fish inbox 看坐标）');
  if (!message) fail('缺少 --message "…"');
  const dry = !has('go');
  const r = await api('/reply', { method: 'POST', body: { commentId, content: message, dry }, timeout: 300_000 });
  if (has('json')) return json(r);
  if (r.dry) {
    section(r.routed === 'direct' ? '预览：这条会被直接发出' : '预览：这条只会进草稿');
    out(`对象：${r.role === 'owner' ? '主人' : r.role === 'stranger' ? '陌生人' : r.role}`);
    if (r.note) out(`笔记：${r.note.title}`);
    out(`正文：${r.content}`);
    if (r.mentions?.length) out(`真实 @ 对象：${r.mentions.map(m => m.name).join('、')}；不是普通 @ 文字`);
    if (r.preparation?.stage) out(`提交前检查：${r.preparation.stage}（尚未发送）`);
    if (r.reason) out(`（${r.reason}）`);
    if (r.quota) out(`今日已回复 ${r.quota.repliesToday} 条（不设每日上限）`);
    out('\n确认无误后加 --go 真的发送。');
    return;
  }
  if (r.routed === 'draft') {
    out(`✓ 已写成草稿（${r.draftId}）。按设置，这条不直接发 —— 去工作台「回复草稿」审。`);
    return;
  }
  out(`✓ ${r.status === 'sent' ? '已发出' : '已提交'}（${r.draftId}）`);
  if (r.revisit?.eligible) out(`这次安排回访 ${r.revisit.name || '对方'}：运行 fish visit --comment ${commentId}，自动精读最新作品、预览、点赞并留言；若守护已完成，不重复执行。`);
  if (r.mentionVerified) out('✓ 已核验评论中的主人提及；通知是否送达由小红书决定。');
  if (r.verification) out(`  ${r.verification}`);
}

async function visit() {
  if (has('tasks')) return json(await api('/visit/tasks'));
  if (has('prepare')) {
    if (!flag('run') || !flag('note') || !flag('message')) fail('需要 --run <runId> --note <noteId> --message "留言"');
    return json(await api('/visit/prepare', { method: 'POST', body: { runId: flag('run'), noteId: flag('note'), content: flag('message'), mentionOwner: has('mention') } }));
  }
  const commentId = flag('comment') || positionals[0];
  if (!commentId) return json(await api('/visits'));
  const result = await api('/visit', { method: 'POST', body: { commentId }, timeout: 600_000 });
  json(result);
}

async function draft() {
  const commentId = flag('comment') || positionals[0];
  const message = flag('message');
  if (!commentId) fail('缺少 --comment <评论ID>');
  if (!message) fail('缺少 --message "…"');
  const r = await api('/draft', { method: 'POST', body: { commentId, content: message }, timeout: 120_000 });
  if (has('json')) return json(r);
  out(`✓ 已进待审队列（${r.draftId}）。主人会在工作台「回复草稿」里看到。`);
}

async function comment() {
  const noteId = flag('note') || positionals[0];
  const message = flag('message');
  if (!noteId) fail('缺少 --note <noteId>（fish feed 的结果里有）');
  if (!message) fail('缺少 --message "…"');
  const dry = !has('go');
  // @ 是例外：默认不带；分享帖显式加 --mention。设置里的总闸关着时，--mention 也不会 @。
  const mentionOwner = has('mention') ? true : false;
  const r = await api('/comment', {
    method: 'POST',
    body: { noteId, content: message, dry, ...(mentionOwner === undefined ? {} : { mentionOwner }) },
    timeout: 300_000,
  });
  if (has('json')) return json(r);
  if (r.dry) {
    section(mentionOwner === false ? '预览：普通评论（不 @ 主人）' : '预览：分享到笔记下');
    out(`笔记：${r.note.title}\n${r.note.url || ''}`);
    out(`正文：${r.content}`);
    if (r.mentions?.length) out(`真实 @ 对象：${r.mentions.map(m => m.name).join('、')}`);
    else if (mentionOwner === false) out('真实 @：不加（这条只留一句普通评论）');
    if (r.preparation?.stage) out(`提交前检查：${r.preparation.stage}（尚未发送）`);
    out(`今日已评论 ${r.quota.sharesToday} 条（不设每日上限）`);
    if (mentionOwner && !r.mentions?.length) out('⚠ 本次未准备真实主人提及，请检查分享设置；不能记为已 @。');
    out(mentionOwner ? '\n确认无误后保留 --note、--message、--mention，将 --dry 换成 --go 发送。' : '\n确认无误后保留 --note、--message、--no-mention，将 --dry 换成 --go 发送。');
    return;
  }
  out(`✓ ${r.status === 'sent' ? '已发出' : '已提交'}（${r.draftId}）`);
  if (mentionOwner) out(r.status === 'sent' && r.mentionVerified === true
    ? '✓ 评论和真实主人提及均已核验；小红书通知是否送达未知。'
    : '⚠ 本次未确认真实主人提及成功，请记录实际状态；已提交或结果不确定时不要重发。');
  if (r.verification) out(`  ${r.verification}`);
}

async function like() {
  const noteId = flag('note') || positionals[0];
  if (!noteId) fail('缺少 --note <noteId>（fish feed 的结果里有）');
  const dry = !has('go');
  const r = await api('/like', { method: 'POST', body: { noteId, dry }, timeout: 120_000 });
  if (has('json')) return json(r);
  if (r.already) { out(`✓ 这条已经点过赞了（${r.at}），不重复点。`); return; }
  if (r.dry) {
    section('预览：点赞');
    out(`笔记：${r.note.title}\n${r.note.url || ''}`);
    out(`额度：今天还能点 ${r.quota.left} 个（上限 ${r.quota.daily}）`);
    out('\n确认后加 --go 真的点赞。');
    return;
  }
  out(`✓ 已点赞：${r.note.title}`);
}

async function diary() {
  const book = flag('book', 'letter') === 'private' ? 'private' : 'letter';
  const text = flag('text');
  if (text) {
    const r = await api('/diary', { method: 'POST', body: { book, content: text }, timeout: 30_000 });
    const size = r.bytes >= 1024 ? `${Math.round(r.bytes / 1024)} KB` : `${r.bytes} 字节`;
    out(`✓ 已写进${book === 'private' ? '自己的日记' : '给主人的信'}（${size}）：${r.path}`);
    return;
  }
  const r = await api(`/diary?book=${book}&tail=${num('tail', 4000)}`, { timeout: 30_000 });
  if (has('json')) return json(r);
  section(book === 'private' ? '自己的日记（不加滤镜）' : '给主人的信');
  out(r.content || '（还没写。第一条可以短一点，真一点。）');
}

async function notify() {
  const text = flag('text') || positionals.join(' ');
  if (!text) fail('缺少 --text "…"');
  const r = await api('/notify', { method: 'POST', body: { text, kind: flag('kind', 'note') }, timeout: 30_000 });
  if (has('json')) return json(r);
  out(`✓ 已推送给主人（${r.type}）。`);
}

async function log() {
  const kind = flag('kind') || positionals[0];
  if (!kind) fail('缺少 --kind <事件类型>');
  await api('/log', { method: 'POST', body: { kind, note: flag('note') }, timeout: 20_000 });
  out(`✓ 已记录：${kind}`);
}

async function quota() {
  const s = await api('/status', { timeout: 20_000 });
  if (has('json')) return json(s.quota);
  section('今日发送记录（不设每日上限）');
  out(`评论：今天已发 ${s.quota.sharesToday} 条`);
  out(`回复：今天已发 ${s.quota.repliesToday} 条`);
  out(`全站发送：${s.today.sends}（含所有来源）`);
  out(`发送开关：${s.today.sendingEnabled ? '开' : '关（只能写草稿）'}`);
}

// ── 入口 ──────────────────────────────────────────────────────────────
const run = COMMANDS[command];
if (!run) fail(`未知命令：${command}\n跑 "node tools/fish.mjs help" 看清单。`);
try {
  await run();
} catch (e) {
  fail(e?.message || String(e));
}

