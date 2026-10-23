// Distributed in the modified dsh-xhs-whale source snapshot. See MODIFICATIONS.md.
(uid, txt, parent, mentions) => {
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  const target = parent ? document.getElementById('comment-' + parent) : null;
  const targetThread = target?.closest('.parent-comment');
  const targetName = target?.querySelector('.author .name')?.textContent;
  const replyingToSub = target?.classList.contains('comment-item-sub');
  if (parent && !targetThread) return [];
  return Array.from(document.querySelectorAll('.comments-container .comment-item')).filter(e => {
    const author = e.querySelector('.author [data-user-id]');
    if (!author || author.getAttribute('data-user-id') !== uid) return false;
    const content = e.querySelector('.content');
    // The platform adds a separate "回复 昵称 :" prefix for replies to subcomments.
    // Only .note-text contains the authored message. Never strip user text by regex.
    const body = content?.querySelector('.note-text');
    if (!body) return false;
    if (parent) {
      if (!e.classList.contains('comment-item-sub') || e.closest('.parent-comment') !== targetThread) return false;
      const recipient = norm(content.querySelector('.nickname')?.textContent);
      if (replyingToSub && (!norm(targetName) || recipient !== norm(targetName))) return false;
      if (!replyingToSub && recipient) return false;
    } else if (e.classList.contains('comment-item-sub')) return false;
    const copy = body.cloneNode(true);
    for (const m of (mentions || [])) {
      const tag = Array.from(copy.querySelectorAll('[data-user-id],[data-id],a[href]')).find(a =>
        a.getAttribute('data-user-id') === m.id || a.getAttribute('data-id') === m.id ||
        (a.getAttribute('href') || '').split('?')[0] === '/user/profile/' + m.id ||
        (a.getAttribute('href') || '').split('?')[0] === 'https://www.xiaohongshu.com/user/profile/' + m.id);
      if (!tag) return false;
      tag.remove();
    }
    return norm(copy.textContent) === norm(txt) && !!e.id;
  }).map(e => e.id.replace(/^comment-/, ''));
}
