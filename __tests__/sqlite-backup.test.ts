import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import sqlite3 from 'sqlite3';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SQLiteManager } from '../src/sqlite-manager.js';

describe('SQLite backup and new-destination restore', () => {
  let directory: string;
  let manager: SQLiteManager;
  const connections = new Set<sqlite3.Database>();

  async function open(path: string): Promise<sqlite3.Database> {
    return new Promise((resolve, reject) => {
      const db = new sqlite3.Database(path, error => {
        if (error) return reject(error);
        connections.add(db);
        resolve(db);
      });
    });
  }

  async function run(db: sqlite3.Database, sql: string): Promise<void> {
    await new Promise<void>((resolve, reject) => db.exec(sql, error => error ? reject(error) : resolve()));
  }

  async function rows(db: sqlite3.Database, sql: string): Promise<unknown[]> {
    return new Promise((resolve, reject) => db.all(sql, (error, result) => error ? reject(error) : resolve(result)));
  }

  async function createSource(): Promise<{ db: sqlite3.Database; path: string }> {
    const path = join(directory, 'source.db');
    const db = await open(path);
    await run(db, 'PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT); PRAGMA wal_checkpoint(TRUNCATE);');
    await run(db, "INSERT INTO records VALUES (1, 'committed in WAL');");
    return { db, path };
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'guardian-sqlite-backup-test-'));
    manager = new SQLiteManager(join(directory, 'databases'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await manager.closeAllConnections();
    for (const db of connections) {
      await new Promise<void>((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
    }
    connections.clear();
    rmSync(directory, { recursive: true, force: true });
  });

  test('roundtrips committed, uncheckpointed WAL data while the source stays open', async () => {
    const source = await createSource();
    const mainFileBefore = readFileSync(source.path);
    expect(statSync(`${source.path}-wal`).size).toBeGreaterThan(32);
    const backupPath = join(directory, "backup's snapshot.db");

    expect((await manager.backupDatabase(source.path, backupPath)).success).toBe(true);
    expect(readFileSync(source.path)).toEqual(mainFileBefore);
    expect(statSync(`${source.path}-wal`).size).toBeGreaterThan(32);
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    expect(existsSync(`${backupPath}-wal`)).toBe(false);
    await run(source.db, "INSERT INTO records VALUES (2, 'after backup');");

    const result = await manager.restoreDatabase(backupPath, 'restored');
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ databaseName: 'restored', path: join(directory, 'databases', 'restored.db') });
    const restored = await open(result.data.path);
    expect(await rows(restored, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(await rows(restored, 'SELECT * FROM records')).toEqual([{ id: 1, value: 'committed in WAL' }]);
    expect(await rows(source.db, 'SELECT count(*) AS count FROM records')).toEqual([{ count: 2 }]);
  });

  test('backs up an empty SQLite database as a valid, standalone database', async () => {
    expect((await manager.createDatabase('empty')).success).toBe(true);
    const backupPath = join(directory, 'empty-backup.db');
    expect((await manager.backupDatabase('empty', backupPath)).success).toBe(true);
    expect((await manager.restoreDatabase(backupPath, 'empty-restored')).success).toBe(true);
  });

  test('preserves sqlite-vec virtual tables through online backup and restore', async () => {
    expect((await manager.executeSql('vectors', 'CREATE VIRTUAL TABLE embeddings USING vec0(embedding float[2])')).success).toBe(true);
    expect((await manager.executeSql('vectors', "INSERT INTO embeddings(rowid, embedding) VALUES (1, '[1,2]')")).success).toBe(true);
    const backupPath = join(directory, 'vectors-backup.db');
    expect((await manager.backupDatabase('vectors', backupPath)).success).toBe(true);
    expect((await manager.restoreDatabase(backupPath, 'restored-vectors')).success).toBe(true);
    const result = await manager.executeSql('restored-vectors', 'SELECT rowid FROM embeddings');
    expect(result.success).toBe(true);
    expect(result.data.rows).toEqual([{ rowid: 1 }]);
  });

  test.each(['text', 'empty', 'truncated', 'invalid-pages'])('rejects a malformed %s backup without publishing a destination', async kind => {
    const backupPath = join(directory, 'malformed.db');
    let contents = Buffer.from('not a SQLite database');
    if (kind === 'empty') contents = Buffer.alloc(0);
    if (kind === 'truncated') contents = Buffer.from('SQLite format 3\0');
    if (kind === 'invalid-pages') {
      contents = Buffer.alloc(4096);
      Buffer.from('SQLite format 3\0').copy(contents);
    }
    writeFileSync(backupPath, contents);
    const result = await manager.restoreDatabase(backupPath, 'rejected');
    expect(result.success).toBe(false);
    expect(readFileSync(backupPath)).toEqual(contents);
    expect(existsSync(join(directory, 'databases', 'rejected.db'))).toBe(false);
  });

  test('refuses an existing live destination, including a normalized path alias', async () => {
    const source = await createSource();
    const backupPath = join(directory, 'backup.db');
    expect((await manager.backupDatabase(source.path, backupPath)).success).toBe(true);
    expect((await manager.executeSql('live', 'CREATE TABLE live_data (value TEXT)')).success).toBe(true);
    expect((await manager.executeSql('live', "INSERT INTO live_data VALUES ('keep me')")).success).toBe(true);
    const livePath = join(directory, 'databases', 'live.db');
    const original = readFileSync(livePath);
    const alias = join(directory, 'database-alias');
    symlinkSync(join(directory, 'databases'), alias);

    for (const destination of ['live', livePath, join(alias, 'live.db')]) {
      const result = await manager.restoreDatabase(backupPath, destination);
      expect(result.success).toBe(false);
      expect(result.error).toContain('offline operator procedure');
    }
    expect(readFileSync(livePath)).toEqual(original);
    const query = await manager.executeSql('live', 'SELECT * FROM live_data');
    expect(query.success).toBe(true);
    expect(query.data.rows).toEqual([{ value: 'keep me' }]);
  });

  test.each(['file', 'directory', 'symlink', 'dangling-symlink', 'hardlink', 'wal', 'shm', 'journal', 'dangling-wal'])('refuses a destination occupied by %s and preserves it', async kind => {
    const source = await createSource();
    const backupPath = join(directory, 'backup.db');
    expect((await manager.backupDatabase(source.path, backupPath)).success).toBe(true);
    const target = join(directory, 'databases', 'occupied.db');
    let occupied = target;
    if (kind === 'directory') mkdirSync(target);
    else if (kind === 'symlink') symlinkSync(source.path, target);
    else if (kind === 'dangling-symlink') symlinkSync(join(directory, 'missing.db'), target);
    else if (kind === 'hardlink') linkSync(source.path, target);
    else if (kind === 'dangling-wal') {
      occupied = `${target}-wal`;
      symlinkSync(join(directory, 'missing-wal'), occupied);
    } else {
      if (['wal', 'shm', 'journal'].includes(kind)) occupied = `${target}-${kind}`;
      writeFileSync(occupied, 'preserve existing contents');
    }
    const original = lstatSync(occupied);
    const result = await manager.restoreDatabase(backupPath, 'occupied');
    expect(result.success).toBe(false);
    expect(result.error).toContain('offline operator procedure');
    expect(lstatSync(occupied).ino).toBe(original.ino);
    if (kind === 'file' || ['wal', 'shm', 'journal'].includes(kind)) {
      expect(readFileSync(occupied, 'utf8')).toBe('preserve existing contents');
    }
    expect(await rows(source.db, 'SELECT * FROM records')).toEqual([{ id: 1, value: 'committed in WAL' }]);
  });

  test.each(['wal', 'shm', 'journal'])('refuses a new destination named as a SQLite %s sidecar', async suffix => {
    const source = await createSource();
    const target = join(directory, `new.db-${suffix}`);
    expect((await manager.backupDatabase(source.path, target)).success).toBe(false);
    const backupPath = join(directory, 'backup.db');
    expect((await manager.backupDatabase(source.path, backupPath)).success).toBe(true);
    expect((await manager.restoreDatabase(backupPath, target)).success).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  test('never overwrites an existing backup or the source database', async () => {
    const source = await createSource();
    const backupPath = join(directory, 'backup.db');
    writeFileSync(backupPath, 'previous backup');
    const original = readFileSync(source.path);
    expect((await manager.backupDatabase(source.path, backupPath)).success).toBe(false);
    expect(readFileSync(backupPath, 'utf8')).toBe('previous backup');
    expect((await manager.backupDatabase(source.path, source.path)).success).toBe(false);
    expect(readFileSync(source.path)).toEqual(original);
  });

  test('fails closed on integrity validation failure and leaves the source and destination untouched', async () => {
    const source = await createSource();
    const backupPath = join(directory, 'backup.db');
    const query = jest.spyOn(manager as unknown as { query: (...args: unknown[]) => Promise<unknown> }, 'query');
    query.mockResolvedValueOnce({ rows: [{ integrity_check: 'corrupt test fixture' }] });

    const result = await manager.backupDatabase(source.path, backupPath);
    expect(result.success).toBe(false);
    expect(result.error).toContain('integrity validation failed');
    expect(existsSync(backupPath)).toBe(false);
    expect(readdirSync(directory).sort()).toEqual(['databases', 'source.db', 'source.db-shm', 'source.db-wal']);
    expect(await rows(source.db, 'SELECT * FROM records')).toEqual([{ id: 1, value: 'committed in WAL' }]);
  });

  test('preserves a destination created while the backup is being validated', async () => {
    const source = await createSource();
    const backupPath = join(directory, 'backup.db');
    const internals = manager as unknown as { query: (...args: unknown[]) => Promise<unknown> };
    const originalQuery = internals.query.bind(manager);
    jest.spyOn(internals, 'query').mockImplementationOnce(async (...args) => {
      const result = await originalQuery(...args);
      writeFileSync(backupPath, 'created by another writer');
      return result;
    });

    const result = await manager.backupDatabase(source.path, backupPath);
    expect(result.success).toBe(false);
    expect(readFileSync(backupPath, 'utf8')).toBe('created by another writer');
    expect(await rows(source.db, 'SELECT * FROM records')).toEqual([{ id: 1, value: 'committed in WAL' }]);
  });

  test('malformed sources cannot publish a backup', async () => {
    const sourcePath = join(directory, 'not-sqlite.db');
    const backupPath = join(directory, 'backup.db');
    writeFileSync(sourcePath, 'not SQLite');
    expect((await manager.backupDatabase(sourcePath, backupPath)).success).toBe(false);
    expect(existsSync(backupPath)).toBe(false);
    expect(readFileSync(sourcePath, 'utf8')).toBe('not SQLite');
  });

  test('concurrent restores to one new destination publish only one validated database', async () => {
    const source = await createSource();
    const backupPath = join(directory, 'backup.db');
    expect((await manager.backupDatabase(source.path, backupPath)).success).toBe(true);
    const results = await Promise.all([
      manager.restoreDatabase(backupPath, 'contended'),
      manager.restoreDatabase(backupPath, 'contended')
    ]);
    expect(results.filter(result => result.success)).toHaveLength(1);
    const restored = await open(join(directory, 'databases', 'contended.db'));
    expect(await rows(restored, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(await rows(restored, 'SELECT * FROM records')).toEqual([{ id: 1, value: 'committed in WAL' }]);
  });

  test('missing inputs and destination parents do not create or change database files', async () => {
    const source = await createSource();
    expect((await manager.backupDatabase(join(directory, 'missing.db'), join(directory, 'backup.db'))).success).toBe(false);
    expect((await manager.restoreDatabase(join(directory, 'missing.db'), 'restored')).success).toBe(false);
    expect((await manager.backupDatabase(source.path, join(directory, 'missing-parent', 'backup.db'))).success).toBe(false);
    expect(existsSync(join(directory, 'missing.db'))).toBe(false);
    expect(existsSync(join(directory, 'databases', 'restored.db'))).toBe(false);
    expect(existsSync(join(directory, 'missing-parent'))).toBe(false);
  });
});
