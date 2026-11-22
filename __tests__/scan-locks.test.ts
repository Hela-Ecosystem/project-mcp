import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeCapabilities, isSqliteArtifact } from '../src/runtime/runtime-capabilities';
import { PathGuard } from '../src/runtime/path-guard';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'scan-locks-'));
}

function scanner(root: string): RuntimeCapabilities {
  return new RuntimeCapabilities({} as never, {} as never, new PathGuard(root));
}

describe('project-mcp#36: the secret scan never opens live SQLite files', () => {
  test('recognises databases and their WAL sidecars', () => {
    for (const name of [
      'memory.db', 'memory.db-wal', 'memory.db-shm', 'memory.db-journal',
      'project.sqlite', 'project.sqlite3', 'x.sqlite-wal', '/tmp/a/b/memory.db-shm',
    ]) {
      expect(isSqliteArtifact(name)).toBe(true);
    }
    for (const name of ['memory.md', 'db.conf', 'notes.db.txt', 'wallet.txt']) {
      expect(isSqliteArtifact(name)).toBe(false);
    }
  });

  test('a planted secret inside memory.db-wal is not read', async () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, 'memory.db'), 'SQLite format 3\0');
      // The sidecar is small enough to pass the 5 MB cap and would be scanned
      // before this fix, closing the descriptor SQLite holds its locks on.
      writeFileSync(join(root, 'memory.db-wal'), 'api_key = "abcdefghijklmnopqrstu"\n');
      writeFileSync(join(root, 'memory.db-shm'), 'secret = "abcdefghijklmnopqrstu"\n');
      writeFileSync(join(root, 'notes.md'), 'token = "abcdefghijklmnopqrstu"\n');

      const result = await scanner(root).scanProjectSecrets({ action: 'secrets', path: '.', exclude: [], maxFindings: 50 } as never);
      const files = result.findings.map((f: { file: string }) => f.file);

      expect(files).toContain('notes.md');
      expect(files.some(f => /memory\.db/.test(f))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a database named directly is refused rather than opened', async () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, 'memory.db'), 'SQLite format 3\0\nsecret = "abcdefghijklmnopqrstu"\n');
      const result = await scanner(root).scanProjectSecrets({ action: 'secrets', path: 'memory.db', exclude: [], maxFindings: 50 } as never);
      expect(result.findings).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the database and its sidecars are left byte-identical', async () => {
    const root = tempRoot();
    try {
      const db = join(root, 'memory.db');
      writeFileSync(db, 'SQLite format 3\0');
      mkdirSync(join(root, 'sub'), { recursive: true });
      writeFileSync(join(db + '-wal'), 'w'.repeat(32));
      const before = readFileSync(db + '-wal', 'utf8');

      await scanner(root).scanProjectSecrets({ action: 'secrets', path: '.', exclude: [], maxFindings: 50 } as never);

      expect(existsSync(db + '-wal')).toBe(true);
      expect(readFileSync(db + '-wal', 'utf8')).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
