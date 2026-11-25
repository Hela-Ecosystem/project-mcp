import sqlite3 from 'sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SQLiteManager } from '../src/sqlite-manager';
import { MemoryManager } from '../src/memory-manager';

function exec(path: string, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path);
    db.exec(sql, error => db.close(() => (error ? reject(error) : resolve())));
  });
}

describe('project-mcp#41 regressions', () => {
  let roots: string[];
  let managers: SQLiteManager[];
  const project = () => {
    const root = mkdtempSync(join(tmpdir(), 'guardian-41-'));
    roots.push(root);
    const sqlite = new SQLiteManager(root);
    managers.push(sqlite);
    return { sqlite, memory: new MemoryManager(sqlite, root) };
  };

  beforeEach(() => { roots = []; managers = []; });
  afterEach(async () => {
    await Promise.all(managers.map(manager => manager.closeAllConnections()));
    roots.forEach(root => rmSync(root, { recursive: true, force: true }));
  });

  describe('ISS-67 tombstones carry deleted_at and can be cleared', () => {
    test('a delete stamps deleted_at and the create error reports the tombstone age', async () => {
      const { sqlite, memory } = project();
      await memory.createEntity('task:reuse', 'task', ['first']);
      await memory.syncToCentral();
      await memory.deleteEntity('task:reuse');
      await memory.syncToCentral();

      const central = await sqlite.queryData(memory.getCentralDatabaseId(), 'deleted_entities', { name: 'task:reuse' });
      expect(central.data?.rows[0]?.deleted_at).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/));
      await expect(memory.createEntity('task:reuse', 'task', ['again']))
        .rejects.toThrow(/deleted from central memory \d+s ago.*restore:true/);
    });

    test('restore:true brings a deleted name back and it survives later syncs', async () => {
      const { memory } = project();
      await memory.createEntity('task:reuse', 'task', ['first']);
      await memory.syncToCentral();
      await memory.deleteEntity('task:reuse');
      await memory.syncToCentral();

      await memory.createEntity('task:reuse', 'task', ['second'], undefined, true);
      await memory.syncToCentral();
      await memory.syncFromCentral();
      expect((await memory.openNode('task:reuse'))?.observations).toEqual(['second']);
      expect((await memory.readStore(memory.getCentralDatabaseId())).entities.map(e => e.name)).toEqual(['task:reuse']);
    });

    test('a stale tombstone from another project does not kill a newer re-created entity', async () => {
      const a = project();
      const b = project();
      await a.memory.createEntity('task:reuse', 'task', ['first']);
      await a.memory.syncToCentral();
      await b.memory.syncFromCentral();
      await a.memory.deleteEntity('task:reuse');
      await a.memory.syncToCentral();
      await b.memory.syncFromCentral();
      await a.memory.createEntity('task:reuse', 'task', ['second'], undefined, true);
      await a.memory.syncToCentral();

      await b.memory.syncToCentral();
      await b.memory.syncFromCentral();
      expect((await b.memory.openNode('task:reuse'))?.observations).toEqual(['second']);
    });

    test('a legacy name-only deleted_entities table is migrated without losing tombstones', async () => {
      const central = join(mkdtempSync(join(tmpdir(), 'guardian-41-legacy-')), 'central.db');
      roots.push(join(central, '..'));
      process.env.GUARDIAN_CENTRAL_DB = central;
      await exec(central, `CREATE TABLE deleted_entities (name TEXT PRIMARY KEY NOT NULL);
        INSERT INTO deleted_entities VALUES ('task:legacy');`);
      const { sqlite, memory } = project();
      await memory.createEntity('task:keep', 'task', ['x']);
      await memory.syncToCentral();

      const rows = await sqlite.executeSql(central, 'SELECT name, deleted_at FROM deleted_entities');
      expect(rows.data?.rows).toEqual([{ name: 'task:legacy', deleted_at: expect.stringMatching(/^\d{4}-/) }]);
      await expect(memory.createEntity('task:legacy', 'task', ['x'])).rejects.toThrow(/deleted from central memory/);
      await memory.deleteEntity('task:keep');
      await memory.syncToCentral();
      const after = await sqlite.queryData(central, 'deleted_entities', { name: 'task:keep' });
      expect(after.data?.rows[0]?.deleted_at).toEqual(expect.stringMatching(/^\d{4}-/));
    });
  });

  describe('ISS-68 delete reaches entities that only live in central', () => {
    test('deleting a central-only entity succeeds, tombstones it and hides it from other projects', async () => {
      const writer = project();
      const other = project();
      await writer.memory.createEntity('task:from-writer', 'task', ['shared']);
      await writer.memory.createRelation('task:from-writer', 'task:from-writer', 'self');
      await writer.memory.syncToCentral();
      const central = other.memory.getCentralDatabaseId();
      expect((await other.memory.readStore('memory')).entities).toEqual([]);
      expect((await other.memory.openNode('task:from-writer'))?.name).toBe('task:from-writer');

      await expect(other.memory.deleteEntities(['task:from-writer', 'task:absent']))
        .resolves.toEqual({ deleted: 1, missing: ['task:absent'] });

      expect(await other.memory.openNode('task:from-writer')).toBeNull();
      const graph = await other.memory.readStore(central);
      expect(graph.entities).toEqual([]);
      expect(graph.relations).toEqual([]);
      expect((await other.sqlite.queryData(central, 'deleted_entities', { name: 'task:from-writer' })).data?.rows).toHaveLength(1);

      await writer.memory.syncFromCentral();
      expect(await writer.memory.openNode('task:from-writer')).toBeNull();
    });
  });
});
