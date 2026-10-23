import fs from 'node:fs';
import path from 'node:path';

const rootFiles = [
  'package.json', 'README.md', 'LICENSE', 'NOTICE.md', 'CHANGELOG.md', 'CONTRIBUTING.md',
  '.gitignore', '.gitattributes', '.env.example', 'cordis.patch.yml', '启动小红书服务.cmd',
];
const trees = {
  lib: /\.js$/, public: /\.(js|css|html)$/, tools: /\.mjs$/, scripts: /\.ps1$/,
  test: /\.(test\.js|ps1)$/, docs: /\.md$/, examples: /\.example\.json$/,
  licenses: /\.LICENSE$/, '.github': /\.(yml|md)$/,
  'upstream/xiaohongshu-mcp': /(?:\.(go|js|md)$|(?:^|\/)(?:go\.mod|go\.sum|LICENSE|NOTICE|browser_version\.txt)$)/,
};

export function assertPublicFile(name, content) {
  const normalized = name.replaceAll('\\', '/');
  if (/(^|\/)(data|vendor|output|node_modules|dist|test-results)(\/|$)/.test(normalized) ||
      /(^|\/)(cookies\.json[^/]*|secrets\.json|fish-diary[^/]*|\.env(?:\..*)?)$/.test(normalized) && normalized !== '.env.example' ||
      /\.(exe|dll|zip|log|tmp|bak|download)$/i.test(normalized)) {
    throw new Error(`Private or generated path rejected: ${name}`);
  }
  const patterns = [
    /\bsk-[a-zA-Z0-9_-]{20,}\b/, /\bgh[pousr]_[a-zA-Z0-9]{30,}\b/,
    /github_pat_[a-zA-Z0-9_]{30,}/, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /["'](?:apiKey|deepseekKey|DEEPSEEK_API_KEY)["']\s*:\s*["'][a-zA-Z0-9_-]{20,}["']/,
    /xsec_token=[a-zA-Z0-9_%+\/-]{24,}/,
    /[A-Z]:[\\/]Users[\\/](?!<|YOUR_USER|example|Public|Default)[^\s"'<>/\\]+[\\/]/i,
  ];
  if (patterns.some(pattern => pattern.test(content))) throw new Error(`Potential credential or private path in ${name}; inspect locally (value omitted).`);
}

export function collectReleaseFiles(root) {
  const result = [];
  function add(name) {
    const stat = fs.lstatSync(path.join(root, name));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular source file: ${name}`);
    const data = fs.readFileSync(path.join(root, name));
    assertPublicFile(name, data.toString('utf8'));
    result.push({ name: name.replaceAll('\\', '/'), data });
  }
  function walk(dir, filter) {
    if (fs.lstatSync(path.join(root, dir)).isSymbolicLink()) throw new Error(`Symbolic link rejected: ${dir}`);
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const name = `${dir}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Symbolic link rejected: ${name}`);
      if (entry.isDirectory()) walk(name, filter);
      else if (filter.test(name)) add(name);
    }
  }
  for (const name of rootFiles) add(name);
  add('fish/AGENTS.md');
  for (const [dir, filter] of Object.entries(trees)) walk(dir, filter);
  return result.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}
