#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = path.join(root, '.tmp');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${command} exited with ${result.status}`);
}

try {
  fs.mkdirSync(temporary, { recursive: true });
  fs.copyFileSync(path.join(root, 'package.prod.json'), path.join(temporary, 'package.json'));
  run(npm, ['install', '--production'], { cwd: temporary });
  run(npx, ['esbuild', 'src/index.ts', '--bundle', '--minify', '--platform=node', '--format=esm', '--target=node18',
    '--outfile=dist/index.js', '--external:@modelcontextprotocol/sdk', '--external:sqlite3', '--external:zod', '--external:redis'], { cwd: root });
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
