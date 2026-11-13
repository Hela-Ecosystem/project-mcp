#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const jest = fileURLToPath(new URL('../node_modules/jest/bin/jest.js', import.meta.url));
const result = spawnSync(process.execPath, [jest, ...process.argv.slice(2)], {
  env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--experimental-vm-modules'].filter(Boolean).join(' ') },
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
