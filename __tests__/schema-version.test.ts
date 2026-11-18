import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sqlite3 from 'sqlite3';
import { SQLiteManager } from '../src/sqlite-manager.js';

const userVersionOf = (path: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path, (error) => error && reject(error));
    db.get('PRAGMA user_version', (error, row: { user_version: number }) => {
      db.close();
      if (error) reject(error);
      else resolve(Number(row.user_version));
    });
  });

describe('SQLite schema versioning', () => {
  let directory: string;
  let manager: SQLiteManager;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'hela-schema-'));
    manager = new SQLiteManager(directory);
  });

  afterEach(async () => {
    await manager.closeAllConnections();
    rmSync(directory, { recursive: true, force: true });
  });

  it('stamps a fresh database with the current schema version', async () => {
    const result = await manager.ensureSchemaVersion('memory');
    expect(result).toEqual({ previous: 0, current: SQLiteManager.SCHEMA_VERSION });
    expect(await userVersionOf(join(directory, 'memory.db'))).toBe(SQLiteManager.SCHEMA_VERSION);
  });

  it('is idempotent once stamped', async () => {
    await manager.ensureSchemaVersion('memory');
    await expect(manager.ensureSchemaVersion('memory')).resolves.toEqual({
      previous: SQLiteManager.SCHEMA_VERSION,
      current: SQLiteManager.SCHEMA_VERSION,
    });
  });

  it('refuses a database written by a newer schema', async () => {
    await manager.ensureSchemaVersion('memory');
    await manager.closeConnection('memory');
    const path = join(directory, 'memory.db');
    await new Promise<void>((resolve, reject) => {
      const db = new sqlite3.Database(path, (error) => error && reject(error));
      db.run(`PRAGMA user_version = ${SQLiteManager.SCHEMA_VERSION + 5}`, (error) => {
        db.close();
        error ? reject(error) : resolve();
      });
    });
    await expect(manager.ensureSchemaVersion('memory')).rejects.toThrow(/newer schema/);
  });
});
