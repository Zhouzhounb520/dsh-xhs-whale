window.__ModuleLoader__.load({
  id: 'dsh-xhs-whale',
  factory: require => {
    const { createElement: h, useState, useEffect } = require('react');

    const card = { background: 'rgba(127,127,127,.06)', border: '1px solid rgba(127,127,127,.18)', borderRadius: '10px', padding: '14px 16px', marginBottom: '10px' };
    const label = { fontSize: '11px', opacity: .6, letterSpacing: '.06em', marginBottom: '2px' };
    const value = { fontSize: '13px', lineHeight: 1.7 };
    const button = { background: 'transparent', border: '1px solid rgba(127,127,127,.35)', borderRadius: '6px', padding: '6px 12px', fontSize: '12px', cursor: 'pointer', color: 'inherit' };
    const primary = { ...button, background: '#266257', borderColor: '#266257', color: '#fff' };

    function Field(props) {
      return h('div', { style: { marginBottom: '8px' } },
        h('div', { style: label }, props.label),
        h('div', { style: value }, props.value ?? '—'));
    }

    function XhsSection() {
      const [info, setInfo] = useState(null);
      const [fish, setFish] = useState(null);
      const [note, setNote] = useState('');
      const [busy, setBusy] = useState(false);

      const loadFish = () => fetch('/dsh-xhs/api/fish', { headers: { accept: 'application/json' } })
        .then(r => r.json()).then(setFish).catch(() => setFish({ ok: false }));

      useEffect(() => {
        fetch('/dsh-xhs/api/workbench', { headers: { accept: 'application/json' } })
          .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }).then(setInfo)
          .catch(() => setInfo({ ok: false, error: '工作台连接失败，请运行项目中的启动脚本。' }));
        loadFish();
        const timer = setInterval(loadFish, 15000);
        return () => clearInterval(timer);
      }, []);

      const wakeNow = () => {
        setBusy(true); setNote('正在叫醒…');
        fetch('/dsh-xhs/api/fish/wake', { method: 'POST' })
          .then(r => r.json()).then((r) => {
            setNote(r.ok ? '已叫醒。去「工作区 → 未分组 → xhs-whale」看它干活。' : `叫醒失败：${r.error || '未知原因'}`);
            loadFish();
          })
          .catch(e => setNote(`叫醒失败：${e.message}`))
          .finally(() => setBusy(false));
      };

      return h('div', { style: { padding: '24px', maxWidth: '760px' } },
        h('h2', { style: { marginBottom: '6px' } }, '小红书 · 养鱼'),
        h('p', { style: { opacity: .7, marginTop: 0, fontSize: '13px' } },
          '它有自己的作息：到点自己醒，自己刷小红书，分清谁在说话。你只需要偶尔看一眼。'),

        h('div', { style: card },
          h(Field, { label: '今天的计划', value: fish?.planText || (fish?.ok === false ? '养鱼状态读取失败' : '还没排计划') }),
          h(Field, { label: '今日记录', value: fish?.quota ? `评论 ${fish.quota.sharesToday} · 回复 ${fish.quota.repliesToday}（不设每日上限） · 沉默 ${fish.quota.silentDays} 天` : '—' }),
          h(Field, { label: '收件箱', value: fish?.inbox ? `待回 ${fish.inbox.pending} 条` : '—' }),
          h(Field, { label: '启动测试', value: fish?.selftestPassed ? '已通过' : '还没跑（在工作台「养鱼 → 启动测试」，或在养鱼会话里说一句"跑 selftest"）' })),

        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', margin: '14px 0' } },
          info?.ok ? h('a', { href: info.url, target: '_blank', rel: 'noreferrer', style: { ...primary, textDecoration: 'none' } }, '打开工作台 ↗') : null,
          h('button', { style: button, onClick: wakeNow, disabled: busy }, '立刻醒一轮'),
          h('button', { style: button, onClick: loadFish }, '刷新状态')),
        note ? h('p', { style: { fontSize: '12px', opacity: .75 } }, note) : null,
        info && !info.ok ? h('p', { style: { fontSize: '12px', color: '#c0392b' } }, info.error) : null,

        h('div', { style: { ...card, fontSize: '12px', lineHeight: 1.9 } },
          h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '第一次用，留意两件事'),
          h('div', null, '① 它的会话在「工作区 → 未分组 → xhs-whale」（不点开「未分组」看不见）'),
          h('div', null, '② 打开那个会话，把权限设为「完全访问 / danger-full-access」，否则它跑不了命令'),
          h('div', { style: { opacity: .65, marginTop: '4px' } }, '作息、人设、互动设置都在工作台「养鱼」页签里改，保存即生效；只有换插件代码才需要重启 DSH。')),

        h('p', { style: { opacity: .5, fontSize: '11px' } },
          '正式版工作台：http://127.0.0.1:18061 · 命令行：node tools/fish.mjs help'));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'xhs-whale', order: 7, label: () => '小红书 · 养鱼' }, XhsSection),
        'xhs-whale: settings section'), 'xhs-whale: settings section');
      },
    };
  },
});
