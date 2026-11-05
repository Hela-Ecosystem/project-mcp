#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncVaults } from '../dist/vault-sync.js';

const remote = process.argv[2];
if (!remote || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(remote)) {
  throw new Error('Usage: node scripts/test-vault-sync-ssh.mjs user@host');
}
const local = mkdtempSync(join(tmpdir(), 'hela-vault-sync-test-'));
let peer;
function onPeer(code) {
  return execFileSync('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', remote,
    'node --input-type=module -'], { input: code, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
}
function peerAction(code) {
  assert.match(peer, /^\/var\/tmp\/hela-vault-sync-test-[A-Za-z0-9]+$/);
  return onPeer(`import fs from 'node:fs';import path from 'node:path';const root=${JSON.stringify(peer)};${code}`);
}
function peerWrite(name, content) {
  peerAction(`fs.writeFileSync(path.join(root,${JSON.stringify(name)}),${JSON.stringify(content)});`);
}
function peerRead(name) {
  return peerAction(`process.stdout.write(fs.readFileSync(path.join(root,${JSON.stringify(name)}),'utf8'));`);
}
const sync = () => syncVaults(local, peer, { remote });

try {
  peer = onPeer("import fs from 'node:fs';process.stdout.write(fs.mkdtempSync('/var/tmp/hela-vault-sync-test-'));");
  assert.match(peer, /^\/var\/tmp\/hela-vault-sync-test-[A-Za-z0-9]+$/);
  writeFileSync(join(local, 'shared.md'), 'base');
  writeFileSync(join(local, 'delete.md'), 'recover deleted content');
  peerWrite('remote.md', 'independent remote creation');
  assert.equal((await sync()).copied, 3);
  assert.equal(peerRead('shared.md'), 'base');
  assert.equal(readFileSync(join(local, 'remote.md'), 'utf8'), 'independent remote creation');

  writeFileSync(join(local, 'shared.md'), 'local concurrent edit');
  peerWrite('shared.md', 'remote concurrent edit');
  assert.deepEqual((await sync()).conflicts, ['shared.md']);
  assert.equal(readFileSync(join(local, 'shared.md'), 'utf8'), 'local concurrent edit');
  assert.equal(peerRead('shared.md'), 'remote concurrent edit');
  const archived = JSON.parse(peerAction(`const directory=path.join(root,'.hela-sync','conflicts');process.stdout.write(JSON.stringify(fs.readdirSync(directory).flatMap(group=>fs.readdirSync(path.join(directory,group)).map(name=>fs.readFileSync(path.join(directory,group,name),'utf8')))));`));
  assert.ok(archived.includes('local concurrent edit'));
  assert.ok(archived.includes('remote concurrent edit'));

  peerWrite('shared.md', 'local concurrent edit');
  assert.deepEqual((await sync()).conflicts, []);
  assert.deepEqual(await sync(), { copied: 0, deleted: 0, conflicts: [] });
  unlinkSync(join(local, 'delete.md'));
  assert.equal((await sync()).deleted, 1);
  assert.equal(peerAction("process.stdout.write(String(fs.existsSync(path.join(root,'delete.md'))));"), 'false');
  const recovery = JSON.parse(peerAction(`const directory=path.join(root,'.hela-sync','recovery');process.stdout.write(JSON.stringify(fs.readdirSync(directory).flatMap(group=>fs.readdirSync(path.join(directory,group)).map(name=>fs.readFileSync(path.join(directory,group,name),'utf8')))));`));
  assert.ok(recovery.includes('recover deleted content'));

  unlinkSync(join(local, 'shared.md'));
  peerWrite('shared.md', 'edit competing with deletion');
  assert.deepEqual((await sync()).conflicts, ['shared.md']);
  assert.equal(peerRead('shared.md'), 'edit competing with deletion');
  console.log('PASS: SSH create/edit/delete conflicts, recovery archives, and idempotent reruns; only disposable vaults used.');
} finally {
  try {
    if (peer) peerAction('fs.rmSync(root,{recursive:true,force:true});');
  } finally {
    rmSync(local, { recursive: true, force: true });
  }
}
