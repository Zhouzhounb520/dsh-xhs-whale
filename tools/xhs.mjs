#!/usr/bin/env node
import { startServer } from '../lib/server.js';

const args = process.argv.slice(2);
if (!args.length || args[0] === 'serve') {
  const portIndex = args.indexOf('--port');
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : args.includes('--demo') ? 18062 : 18061;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口应为 1024～65535');
  try {
    const app = await startServer({ port, demo: args.includes('--demo') });
    console.log(`小红书阅读助手${args.includes('--demo') ? '（演示模式）' : ''}：${app.url}`);
    console.log('按 Ctrl+C 停止。发送默认关闭；开启后按审核和养鱼回复策略执行。');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
  } catch (e) {
    console.error(e.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请打开已有页面或使用 --port 指定其他端口。` : e.message);
    process.exitCode = 1;
  }
} else {
  console.log('用法：node tools/xhs.mjs serve [--demo] [--port 18061]');
  process.exitCode = 1;
}
