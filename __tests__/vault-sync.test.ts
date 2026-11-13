import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncVaults } from '../src/vault-sync.js';

describe('Conflict-aware vault transport', () => {
  let root: string;
  let left: string;
  let right: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guardian-vault-sync-'));
    left = join(root, 'left');
    right = join(root, 'right');
    mkdirSync(left);
    mkdirSync(right);
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  });

  function text(vault: string, name: string): string {
    return readFileSync(join(vault, name), 'utf8');
  }

  function archiveFiles(vault: string, kind: string): string[] {
    const directory = join(vault, '.hela-sync', kind);
    return readdirSync(directory).flatMap(group => readdirSync(join(directory, group))
      .map(file => readFileSync(join(directory, group, file), 'utf8')));
  }

  function fakeSsh(body: string): void {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'ssh'), `#!${process.execPath}\n${body}`, { mode: 0o700 });
    process.env.PATH = `${bin}:${originalPath}`;
  }

  test('first sync unions independent notes and attachments without copying hidden directories', async () => {
    writeFileSync(join(left, 'alpha.md'), 'left');
    mkdirSync(join(right, 'nested'));
    writeFileSync(join(right, 'nested', 'beta.md'), 'right');
    writeFileSync(join(left, 'image.bin'), Buffer.from([0, 255, 127]));
    mkdirSync(join(left, '.obsidian'));
    writeFileSync(join(left, '.obsidian', 'settings.json'), 'private settings');
    expect(await syncVaults(left, right)).toEqual({ copied: 3, deleted: 0, conflicts: [] });
    expect(text(right, 'alpha.md')).toBe('left');
    expect(text(left, 'nested/beta.md')).toBe('right');
    expect(readFileSync(join(right, 'image.bin'))).toEqual(Buffer.from([0, 255, 127]));
    expect(readdirSync(right)).not.toContain('.obsidian');
    expect(await syncVaults(left, right)).toEqual({ copied: 0, deleted: 0, conflicts: [] });
  });

  test('single-sided edits propagate in either direction and archive overwritten revisions', async () => {
    writeFileSync(join(left, 'note.md'), 'base');
    await syncVaults(left, right);
    writeFileSync(join(left, 'note.md'), 'edited on left');
    expect((await syncVaults(left, right)).copied).toBe(1);
    expect(text(right, 'note.md')).toBe('edited on left');
    expect(archiveFiles(right, 'recovery')).toContain('base');
    writeFileSync(join(right, 'note.md'), 'edited on right');
    await syncVaults(right, left);
    expect(text(left, 'note.md')).toBe('edited on right');
    expect(archiveFiles(left, 'recovery')).toContain('edited on left');
  });

  test('matching concurrent edits converge without conflicts', async () => {
    writeFileSync(join(left, 'note.md'), 'base');
    await syncVaults(left, right);
    for (const vault of [left, right]) writeFileSync(join(vault, 'note.md'), 'same edit');
    expect(await syncVaults(left, right)).toEqual({ copied: 0, deleted: 0, conflicts: [] });
  });

  test.each([false, true])('preserves both divergent revisions, including first-sync=%s conflicts', async firstSync => {
    writeFileSync(join(left, 'note.md'), 'base');
    if (!firstSync) await syncVaults(left, right);
    writeFileSync(join(left, 'note.md'), 'left revision');
    writeFileSync(join(right, 'note.md'), 'right revision');
    expect(await syncVaults(left, right)).toEqual({ copied: 0, deleted: 0, conflicts: ['note.md'] });
    for (const vault of [left, right]) {
      expect(archiveFiles(vault, 'conflicts')).toEqual(expect.arrayContaining(['left revision', 'right revision']));
    }
    const previous = archiveFiles(left, 'conflicts');
    await syncVaults(left, right);
    expect(archiveFiles(left, 'conflicts')).toEqual(previous);
    expect(text(left, 'note.md')).toBe('left revision');
    expect(text(right, 'note.md')).toBe('right revision');
    writeFileSync(join(right, 'note.md'), 'left revision');
    expect((await syncVaults(left, right)).conflicts).toEqual([]);
  });

  test('propagates deletion only from a matching shared baseline, with recovery content', async () => {
    writeFileSync(join(left, 'note.md'), 'keep a recovery copy');
    await syncVaults(left, right);
    unlinkSync(join(left, 'note.md'));
    expect(await syncVaults(left, right)).toEqual({ copied: 0, deleted: 1, conflicts: [] });
    expect(readdirSync(right)).not.toContain('note.md');
    expect(archiveFiles(right, 'recovery')).toContain('keep a recovery copy');
    expect((await syncVaults(left, right)).deleted).toBe(0);
  });

  test('an explicit repair policy archives both originals and establishes an idempotent shared baseline', async () => {
    writeFileSync(join(left, 'note.md'), 'left fact');
    writeFileSync(join(right, 'note.md'), 'right fact');
    const resolveConflict = (name: string, a: Buffer | null, b: Buffer | null) =>
      name === 'note.md' && a && b ? Buffer.concat([a, Buffer.from('\n'), b]) : undefined;
    expect(await syncVaults(left, right, { resolveConflict })).toEqual({ copied: 2, deleted: 0, conflicts: [] });
    for (const vault of [left, right]) {
      expect(text(vault, 'note.md')).toBe('left fact\nright fact');
      expect(archiveFiles(vault, 'conflicts')).toEqual(expect.arrayContaining(['left fact', 'right fact']));
      expect(archiveFiles(vault, 'recovery')).toContain(vault === left ? 'left fact' : 'right fact');
    }
    expect(await syncVaults(left, right)).toEqual({ copied: 0, deleted: 0, conflicts: [] });
  });

  test('repair policies can decline conflicts and cannot publish oversized results', async () => {
    writeFileSync(join(left, 'note.md'), 'left');
    writeFileSync(join(right, 'note.md'), 'right');
    expect((await syncVaults(left, right, { resolveConflict: () => undefined })).conflicts).toEqual(['note.md']);
    await expect(syncVaults(left, right, { maxBytes: 16384, resolveConflict: () => Buffer.alloc(16385) }))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(text(left, 'note.md')).toBe('left');
    expect(text(right, 'note.md')).toBe('right');
    expect((await syncVaults(left, right)).conflicts).toEqual(['note.md']);
  });

  test('a pre-publication policy can inspect the complete plan and refuse deletions', async () => {
    writeFileSync(join(left, 'note.md'), 'keep');
    await syncVaults(left, right);
    unlinkSync(join(left, 'note.md'));
    await expect(syncVaults(left, right, { beforeApply: result => {
      expect(result.deleted).toBe(1);
      throw new Error('Deletion not approved');
    } })).rejects.toMatchObject({ code: 'VAULT_UNAVAILABLE' });
    expect(text(right, 'note.md')).toBe('keep');
  });

  test('edit/delete conflicts retain edited content and record deletion intent on both sides', async () => {
    writeFileSync(join(left, 'note.md'), 'base');
    await syncVaults(left, right);
    unlinkSync(join(left, 'note.md'));
    writeFileSync(join(right, 'note.md'), 'concurrent edit');
    expect((await syncVaults(left, right)).conflicts).toEqual(['note.md']);
    expect(readdirSync(left)).not.toContain('note.md');
    expect(text(right, 'note.md')).toBe('concurrent edit');
    for (const vault of [left, right]) {
      const archive = archiveFiles(vault, 'conflicts');
      expect(archive).toContain('concurrent edit');
      expect(archive.some(value => value.includes('"deletion":true'))).toBe(true);
    }
  });

  test('simultaneous creates, edits, and deletes reconcile without dropping unrelated notes', async () => {
    for (const name of ['edited.md', 'deleted.md']) writeFileSync(join(left, name), 'base');
    await syncVaults(left, right);
    writeFileSync(join(left, 'created-left.md'), 'new left');
    writeFileSync(join(right, 'created-right.md'), 'new right');
    writeFileSync(join(right, 'edited.md'), 'new edit');
    unlinkSync(join(left, 'deleted.md'));
    expect(await syncVaults(left, right)).toEqual({ copied: 3, deleted: 1, conflicts: [] });
    for (const vault of [left, right]) {
      expect(text(vault, 'edited.md')).toBe('new edit');
      expect(text(vault, 'created-left.md')).toBe('new left');
      expect(text(vault, 'created-right.md')).toBe('new right');
      expect(readdirSync(vault)).not.toContain('deleted.md');
    }
  });

  test('stale snapshots fail before overwriting an editor change', async () => {
    writeFileSync(join(left, 'note.md'), 'base');
    await syncVaults(left, right);
    writeFileSync(join(right, 'note.md'), 'peer edit');
    await expect(syncVaults(left, right, { beforeApply: () => writeFileSync(join(left, 'note.md'), 'late local edit') }))
      .rejects.toMatchObject({ code: 'STALE_SNAPSHOT' });
    expect(text(left, 'note.md')).toBe('late local edit');
    expect(text(right, 'note.md')).toBe('peer edit');
    expect((await syncVaults(left, right)).conflicts).toEqual(['note.md']);
  });

  test('a cooperating second sync cannot acquire a held vault lock', async () => {
    writeFileSync(join(left, 'note.md'), 'base');
    await syncVaults(left, right, { beforeApply: async () => {
      await expect(syncVaults(left, right)).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
    } });
    expect((await syncVaults(left, right)).conflicts).toEqual([]);
  });

  test('missing peers do not delete existing data or retain local locks', async () => {
    writeFileSync(join(left, 'note.md'), 'untouched');
    await expect(syncVaults(left, join(root, 'missing'))).rejects.toMatchObject({ code: 'VAULT_UNAVAILABLE' });
    expect(text(left, 'note.md')).toBe('untouched');
    expect((await syncVaults(left, right)).copied).toBe(1);
  });

  test('corrupt state fails closed without changing either note', async () => {
    writeFileSync(join(left, 'note.md'), 'base');
    await syncVaults(left, right);
    const stateDirectory = join(left, '.hela-sync', 'state');
    writeFileSync(join(stateDirectory, readdirSync(stateDirectory)[0]), '{broken');
    unlinkSync(join(left, 'note.md'));
    await expect(syncVaults(left, right)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(text(right, 'note.md')).toBe('base');
  });

  test('symlinks and overlapping vaults are rejected', async () => {
    writeFileSync(join(left, 'note.md'), 'base');
    symlinkSync(join(left, 'note.md'), join(right, 'escape.md'));
    await expect(syncVaults(left, right)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    await expect(syncVaults(left, left)).rejects.toMatchObject({ code: 'OVERLAPPING_VAULTS' });
    expect(text(left, 'note.md')).toBe('base');
  });

  test('bounds snapshot size and validates remote arguments before executing SSH', async () => {
    writeFileSync(join(left, 'note.md'), 'a'.repeat(17000));
    await expect(syncVaults(left, right, { maxBytes: 16384 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(syncVaults(left, right, { remote: '-oProxyCommand=unsafe' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(readdirSync(right)).not.toContain('note.md');
  });

  test('executes the serialized SSH peer against an isolated fake SSH transport', async () => {
    const diagnostic = join(root, 'ssh-error.txt');
    fakeSsh(`const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(${JSON.stringify(process.execPath)},['--input-type=module','-'],{stdio:['pipe','pipe','pipe']});process.stdin.pipe(child.stdin);child.stdout.on('data',data=>process.stdout.write(data));child.stderr.on('data',data=>fs.appendFileSync(${JSON.stringify(diagnostic)},data));child.on('exit',code=>process.exitCode=code);`);
    writeFileSync(join(left, "quoted ' note.md"), 'local');
    try {
      expect((await syncVaults(left, right, { remote: 'test@fixture' })).copied).toBe(1);
    } catch (error) {
      let details = '';
      try { details = readFileSync(diagnostic, 'utf8'); } catch {}
      throw new Error(`${(error as Error).message}: ${details}`);
    }
    expect(text(right, "quoted ' note.md")).toBe('local');
    writeFileSync(join(right, 'remote.md'), 'remote');
    expect((await syncVaults(left, right, { remote: 'test@fixture' })).copied).toBe(1);
    expect(text(left, 'remote.md')).toBe('remote');
  });

  test('SSH failure cannot be mistaken for an empty peer vault', async () => {
    fakeSsh('process.stdin.resume();process.stdin.on("end",()=>process.exit(255));');
    writeFileSync(join(left, 'note.md'), 'untouched');
    await expect(syncVaults(left, right, { remote: 'test@fixture' })).rejects.toMatchObject({ code: 'SSH_FAILED' });
    expect(text(left, 'note.md')).toBe('untouched');
  });
});
