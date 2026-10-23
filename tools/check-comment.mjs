// This diagnostic only prepares the composer. It never submits a comment.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XhsClient } from '../lib/xhs.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(2);
const arg=k=>args[args.indexOf(k)+1];
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8').replace(/^\uFEFF/,''));
try {
  if(!args.includes('--draft')) throw new Error('用法：node tools/check-comment.mjs --draft <草稿ID> [--url http://127.0.0.1:18060]');
  const state=read('data/live/state.json'), cfg=read('data/live/fish.json');
  const draft=state.drafts.find(d=>d.id===arg('--draft'));
  if(!draft) throw new Error('草稿不存在');
  const note=draft.note?.token?draft.note:state.runs.flatMap(r=>r.notes||[]).find(n=>n.id===draft.noteId && n.token);
  if(!note) throw new Error('找不到含访问令牌的已读笔记');
  const url=new URL(args.includes('--url')?arg('--url'):state.config.xhsUrl);
  if(url.protocol!=='http:' || url.hostname!=='127.0.0.1' || url.username || url.password) throw new Error('只允许本机服务');
  const secrets=read('data/live/secrets.json');
  const xhs=new XhsClient({...state.config,xhsUrl:url.origin},secrets.xhsToken||'');
  const login=await xhs.login();
  if(!login.is_logged_in || login.user_id!==draft.account.id) throw new Error('服务未登录或账号与草稿不同');
  const mentions=draft.commentId?(draft.mentions||[]):cfg.share.mentionOwner?[{id:cfg.reply.ownerProfileId,name:cfg.reply.ownerNickname,avatar:cfg.reply.ownerAvatar}]:[];
  const result=await xhs.previewComment({...draft,mentions},note);
  console.log(JSON.stringify({draftId:draft.id,submitted:false,...result},null,2));
} catch(e) { console.error(e.message);process.exitCode=1; }
