import { text } from '../store.js';

/**
 * 把上游通知归一化成"一条可处理的评论"，并判断**是谁**、**是什么**。
 *
 * 小红书没有 B 站那种"回复我的 / @我的"两本收件箱，但通知页有「评论和@」分区，
 * 上游 v2.5.5 的 /notifications/list 会把每条通知里的评论、笔记、发起人都带出来：
 *   { id, type, title, time, from:{user_id,nickname}, comment_id, comment_text,
 *     liked, feed_id, feed_xsec_token, feed_title }
 * 有了 from.user_id，就能区分"自己 / 主人 / 陌生人"，不必靠昵称猜。
 *
 * 两侧的判定顺序很重要：**先认自己，再认主人**。主人如果和当前登录账号是同一个人
 * （多数单人使用场景就是这样），那条评论其实是我自己发的，绝不能回自己。
 */

const KIND_RULES = [
  { kind: 'reply', keys: ['comment', 'reply'] },
  { kind: 'mention', keys: ['mention', ' at', 'at/', '/at'] },
  { kind: 'like', keys: ['like', 'praise'] },
  { kind: 'favorite', keys: ['favorite', 'collect', 'fav'] },
  { kind: 'follow', keys: ['follow', 'connection'] },
];

export function notificationKind(item) {
  const type = String(item?.type ?? '').toLowerCase();
  for (const rule of KIND_RULES) {
    if (rule.keys.some(key => type.includes(key))) return rule.kind;
  }
  // 未知类型：带评论 ID 的一律按"评论"处理（保守），否则不知道它是什么。
  return text(item?.comment_id, 100) ? 'reply' : 'unknown';
}

export function classifyNotification(item, { selfId = '', ownerId = '' } = {}) {
  const fromId = String(item?.from?.user_id ?? '');
  const kind = notificationKind(item);
  let role = 'stranger';
  if (fromId && String(selfId) && fromId === String(selfId)) role = 'self';
  else if (fromId && String(ownerId) && fromId === String(ownerId)) role = 'owner';

  const commentId = text(item?.comment_id, 100);
  const feedId = text(item?.feed_id, 100);
  // 只有"评论/@且带评论 ID"才谈得上回复；点赞、关注、以及没有评论 ID 的条目一律不可回。
  const replyable = !!commentId && (kind === 'reply' || kind === 'mention');
  return {
    role,
    kind,
    replyable,
    // self 永远不回；其余是否真的能发还要看 reply.strangerPolicy / ownerDirect。
    postable: replyable && role !== 'self',
  };
}

/**
 * 通知条目 → 收件箱条目。保留回复所需的全部坐标（笔记 ID/令牌/评论 ID/对方 user_id），
 * 这样后面既能走"精确回复笔记评论"，也能退回"通知页回复"。
 */
export function toInboxItem(item, ids) {
  const c = classifyNotification(item, ids);
  return {
    id: text(item?.id, 120) || `c:${text(item?.comment_id, 100)}`,
    notificationId: text(item?.id, 120),
    type: text(item?.type, 60),
    kind: c.kind,
    role: c.role,
    replyable: c.replyable,
    postable: c.postable,
    title: text(item?.title, 200),
    at: item?.time ? new Date(Number(item.time) * 1000).toISOString() : new Date().toISOString(),
    from: {
      id: String(item?.from?.user_id ?? ''),
      name: text(item?.from?.nickname, 80),
    },
    comment: {
      id: text(item?.comment_id, 100),
      text: text(item?.comment_text, 4000),
      liked: item?.liked === true,
    },
    feed: {
      id: text(item?.feed_id, 100),
      token: text(item?.feed_xsec_token, 2000),
      title: text(item?.feed_title, 300),
    },
  };
}

/** 人类可读的"是谁"：self → 自己，owner → 主人，stranger → 陌生人。 */
export function roleLabel(role) {
  return { self: '我自己', owner: '主人', stranger: '陌生人' }[role] || role;
}

export function kindLabel(kind) {
  return { reply: '回复', mention: '@我', like: '点赞', favorite: '收藏', follow: '关注', unknown: '其他' }[kind] || kind;
}
