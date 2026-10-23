const titles = ['把收藏夹变成真正读过的知识', '一周工作流：从资料到行动', '图文笔记为什么不能只看标题', '热点合集：今天值得关注的三件事', '新手工具清单与使用边界', '低价课程限时推广'];
export class DemoXhs {
  async login() { return { is_logged_in: true, user_id: 'demo-user', username: '演示账号（虚构）' }; }
  async qrcode() { return { is_logged_in: true }; }
  async search(keyword) {
    return titles.map((title, i) => ({ id: `demo-${i + 1}`, title, token: 'demo-token', type: 'normal',
      author: { id: `demo-author-${i}`, name: `示例作者 ${i + 1}` }, cover: '', likes: String((i + 1) * 37),
      url: '', query: keyword }));
  }
  async feed() { return this.search('演示'); }
  async detail(c) {
    return { ...c, body: '这是一条用于验证界面的虚构笔记。\n先写下阅读目的，再整理三个要点，最后决定下一步行动。每周回看一次阅读记录，删除重复材料。\n示例内容不代表真实小红书帖子。',
      images: [], imageCount: 0, commentsPartial: true, fetchedAt: new Date().toISOString(),
      comments: [{ id: `${c.id}-c1`, parentId: '', text: '如果收藏很多，应该先从哪一条开始？',
        author: { id: 'demo-reader', name: '示例读者' }, subCount: 0 },
      { id: `${c.id}-c2`, parentId: '', text: '我希望看到更具体的操作例子。', author: { id: 'demo-reader2', name: '另一位读者' }, subCount: 0 }] };
  }
  async send() { throw new Error('演示模式不能发送'); }
}
export class DemoModel {
  async test() { return { ok: true, model: '演示数据，未调用模型' }; }
  async rank(candidates) { return candidates.map((c, i) => ({ id: c.id, score: Math.max(2, 18 - i * 2),
    reason: '演示评分：正式模式会结合当次兴趣和排除词由 DeepSeek 判断。' })); }
  async read() { return { summary: '示例笔记提出“明确目的—提取要点—落实行动”的阅读方法。',
    points: ['先写阅读目的', '每条笔记提取三个要点', '每周回看并删除重复材料'],
    evidence: [{ source: '正文', quote: '先写下阅读目的，再整理三个要点，最后决定下一步行动。' }],
    commentInsights: ['读者希望知道从哪条收藏开始。'], limitations: ['虚构演示数据，未访问小红书、未调用 DeepSeek。'],
    recommendation: '用它检查页面流程；切换正式模式后再开始真实阅读。', imagesProvided: 0, model: 'demo' }; }
  async draft() { return '可以先挑一条与你这周要完成的事情直接相关的笔记，读完只记一个能马上尝试的步骤。'; }
}
