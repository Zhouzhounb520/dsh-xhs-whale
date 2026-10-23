import { AppError, text } from '../store.js';
import { FISH_DEFAULTS } from './config.js';

/**
 * 养鱼的 HTTP 接口。工作台页面和 `tools/fish.mjs` 共用这一套。
 *
 * 约定：
 *   · 所有写操作默认是 **dry（只预览）**，必须显式传 `dry:false` 才真的发 ——
 *     和 dsh-bili-whale 的 `--dry` / `--go` 一样，防止一个笔误变成公开评论。
 *   · 返回体永远是业务结果；错误统一由 server.js 转成 { error } + 状态码。
 */
export async function handleFishApi({ fish, method, pathname, query = {}, body = {} }) {
  if (!fish) throw new AppError('演示模式没有养鱼：养鱼只在正式版运行', 403);
  const route = pathname.replace(/^\/api\/fish/, '') || '/';
  const isPost = method === 'POST';

  if (route === '/status' && method === 'GET') return fish.status();
  if (route === '/identity' && method === 'GET') return { self: await fish.refreshIdentity() };
  if (route === '/config' && method === 'GET') {
    return { config: fish.config(), defaults: FISH_DEFAULTS, path: fish.paths.config };
  }
  if (route === '/config' && isPost) {
    const next = fish.saveConfig(body.config || body);
    return { ok: true, config: next, invalidated: true };
  }
  if (route === '/inbox' && method === 'GET') {
    const all = query.get('all') === '1';
    return { items: fish.inbox({ all }), counts: fish.inboxCounts(), revision: fish.state().revision };
  }
  if (route === '/inbox/scan' && isPost) return fish.scanInbox({ force: body.force === true });

  if (route === '/run' && isPost) {
    return fish.run({ topic: body.topic, n: body.n, deep: body.deep, source: body.source });
  }
  if (route === '/comment' && isPost) {
    return fish.comment({ noteId: text(body.noteId, 100), content: body.content, dry: body.dry !== false, mentionOwner: body.mentionOwner });
  }
  if (route === '/owner/resolve' && isPost) return fish.resolveOwner();
  if (route === '/visit' && isPost) return fish.visit({ commentId: text(body.commentId, 100) });
  if (route === '/visits' && method === 'GET') return fish.pendingVisits();
  if (route === '/visit/tasks' && method === 'GET') return fish.manualVisitTasks();
  if (route === '/visit/prepare' && isPost) return fish.prepareVisit({ runId: body.runId, noteId: body.noteId, content: body.content, mentionOwner: body.mentionOwner });
  if (route === '/like' && isPost) {
    return fish.like({ noteId: text(body.noteId, 100), dry: body.dry !== false });
  }
  if (route === '/reply' && isPost) {
    return fish.reply({ commentId: text(body.commentId, 100), content: body.content, dry: body.dry !== false });
  }
  if (route === '/draft' && isPost) {
    return fish.draft({ commentId: text(body.commentId, 100), content: body.content });
  }
  if (route === '/drafts' && method === 'GET') {
    const drafts = (fish.workflow.store.state.drafts || []).filter(d => d.origin === 'fish');
    return { items: drafts.slice(0, 50) };
  }
  if (route === '/diary' && method === 'GET') {
    return fish.readDiary({
      book: query.get('book') || 'letter',
      tail: Number(query.get('tail') || 0),
    });
  }
  if (route === '/diary' && isPost) {
    return fish.appendDiary({ book: body.book === 'private' ? 'private' : 'letter', content: body.content });
  }
  if (route === '/notify' && isPost) return fish.notify({ text: body.text, kind: text(body.kind, 40) || 'note' });
  if (route === '/log' && isPost) {
    fish.appendLog({ kind: body.kind, note: body.note });
    return { ok: true };
  }
  if (route === '/log' && method === 'GET') {
    return { items: fish.tailLog(Number(query.get('n') || 20)) };
  }
  if (route === '/selftest' && isPost) return fish.selftest();

  throw new AppError('未找到养鱼接口', 404);
}

