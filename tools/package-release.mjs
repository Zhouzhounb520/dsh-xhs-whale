#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { collectReleaseFiles } from './release-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (!/^[a-z0-9-]+$/.test(pkg.name) || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(pkg.version)) throw new Error('Invalid release name/version');
// Validate all sources before creating a publishable directory. Never copy runtime trees.
const files = collectReleaseFiles(root);
const stamp = new Date().toISOString().replace(/[-:.]/g, '');
const dest = path.join(root, 'dist', `${pkg.name}-${pkg.version}-${stamp}`);
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.mkdirSync(dest);
const manifest = { name: pkg.name, version: pkg.version, files: [] };
for (const { name, data } of files) {
  const file = path.join(dest, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  manifest.files.push({ path: name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
}
fs.writeFileSync(path.join(dest, 'SOURCE-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(dest);
