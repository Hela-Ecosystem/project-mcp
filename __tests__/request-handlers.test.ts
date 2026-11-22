import { RequestHandlers, isReadOnlySql } from '../src/handlers/request-handlers';
import { SQLiteManager } from '../src/sqlite-manager';
import { ImportExportManager } from '../src/import-export';
import { MemoryManager } from '../src/memory-manager';
import { PromptHandlers } from '../src/prompts/prompt-handlers';
import { existsSync, unlinkSync, rmdirSync, readdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RuntimeCapabilities } from '../src/runtime/runtime-capabilities';
import { PathGuard } from '../src/runtime/path-guard';

describe('RequestHandlers', () => {
  let sqliteManager: SQLiteManager;
  let importExportManager: ImportExportManager;
  let memoryManager: MemoryManager;
  let requestHandlers: RequestHandlers;
  let testDbPath: string;
  let runtimeCapabilities: RuntimeCapabilities;
  let inspectedTexts: unknown[];

  beforeEach(async () => {
    // Use unique test directory for each test to avoid conflicts
    testDbPath = `./test-databases-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    sqliteManager = new SQLiteManager(testDbPath);
    importExportManager = new ImportExportManager(sqliteManager);
    memoryManager = new MemoryManager(sqliteManager);
    inspectedTexts = [];
    const runtime = new RuntimeCapabilities(memoryManager, sqliteManager, new PathGuard(testDbPath));
    runtimeCapabilities = {
      inspectUntrustedText: (input: unknown) => {
        inspectedTexts.push(input);
        return { suspicious: false, alerts: [] };
      },
      getSessionContext: runtime.getSessionContext.bind(runtime),
      setWorkspaceRoot: runtime.setWorkspaceRoot.bind(runtime),
    } as unknown as RuntimeCapabilities;
    requestHandlers = new RequestHandlers(
      sqliteManager,
      memoryManager,
      importExportManager,
      new PromptHandlers(),
      runtimeCapabilities
    );

    await memoryManager.initializeMemoryDatabase();
    await sqliteManager.createDatabase('test_db');
  });

  describe('SQL write guard', () => {
    test('allows read-only statements', () => {
      expect(isReadOnlySql('SELECT 1')).toBe(true);
      expect(isReadOnlySql('VALUES (1)')).toBe(true);
      expect(isReadOnlySql('EXPLAIN QUERY PLAN SELECT 1')).toBe(true);
      expect(isReadOnlySql('WITH one AS (SELECT 1 AS n) SELECT n FROM one')).toBe(true);
      expect(isReadOnlySql('PRAGMA integrity_check')).toBe(true);
      expect(isReadOnlySql('PRAGMA table_info(entities)')).toBe(true);
      expect(isReadOnlySql('PRAGMA user_version')).toBe(true);
    });

    test('rejects writes and write-capable pragmas', () => {
      expect(isReadOnlySql('INSERT INTO entities (name) VALUES (1)')).toBe(false);
      expect(isReadOnlySql('WITH one AS (SELECT 1 AS n) INSERT INTO entities (name) SELECT n FROM one')).toBe(false);
      expect(isReadOnlySql('PRAGMA user_version = 42')).toBe(false);
      expect(isReadOnlySql('PRAGMA journal_mode(WAL)')).toBe(false);
      expect(isReadOnlySql('PRAGMA optimize')).toBe(false);
      expect(isReadOnlySql('')).toBe(false);
    });
  });

  afterEach(async () => {
    await sqliteManager.closeAllConnections();
    // Clean up test database directory
    try {
      if (existsSync(testDbPath)) {
        const files = readdirSync(testDbPath);
        for (const file of files) {
          if (file.endsWith('.db')) {
            unlinkSync(join(testDbPath, file));
          }
        }
        rmdirSync(testDbPath);
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Database Tool Handling', () => {
    test('should handle execute_sql tool', async () => {
      const result = await requestHandlers.handleToolCall('execute_sql', {
        query: 'SELECT 1 as test',
        parameters: []
      });

      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('data.rows');
    });

    test('should handle query_data tool', async () => {
      // Create test table
      const schema = {
        columns: [
          { name: 'id', type: 'INTEGER', constraints: ['PRIMARY KEY'] },
          { name: 'name', type: 'TEXT' }
        ]
      };
      await sqliteManager.createTable('memory', 'test_table', schema);

      const result = await requestHandlers.handleToolCall('query_data', {
        table: 'test_table',
        conditions: {},
        limit: 10
      });

      expect(result).toHaveProperty('success', true);
    });

    test('should handle insert_data tool', async () => {
      process.env['HELA_GENOME_ALLOW_DESTRUCTIVE'] = 'true';
      try {
        // Create test table
        const schema = {
          columns: [
            { name: 'id', type: 'INTEGER', constraints: ['PRIMARY KEY'] },
            { name: 'name', type: 'TEXT' }
          ]
        };
        await sqliteManager.createTable('memory', 'test_table', schema);

        const result = await requestHandlers.handleToolCall('insert_data', {
          table: 'test_table',
          records: [{ id: 1, name: 'Test' }]
        });

        expect(result).toHaveProperty('success', true);
      } finally {
        delete process.env['HELA_GENOME_ALLOW_DESTRUCTIVE'];
      }
    });

    test('should handle update_data tool', async () => {
      process.env['HELA_GENOME_ALLOW_DESTRUCTIVE'] = 'true';
      try {
        // Create test table and insert data
        const schema = {
          columns: [
            { name: 'id', type: 'INTEGER', constraints: ['PRIMARY KEY'] },
            { name: 'name', type: 'TEXT' }
          ]
        };
        await sqliteManager.createTable('memory', 'test_table', schema);
        await sqliteManager.insertData('memory', 'test_table', [{ id: 1, name: 'Test' }]);

        const result = await requestHandlers.handleToolCall('update_data', {
          table: 'test_table',
          conditions: { id: 1 },
          updates: { name: 'Updated Test' }
        });

        expect(result).toHaveProperty('success', true);
      } finally {
        delete process.env['HELA_GENOME_ALLOW_DESTRUCTIVE'];
      }
    });

    test('should handle delete_data tool', async () => {
      // delete_data is gated behind an explicit opt-in; enable it for this
      // test, which exercises the tool rather than the gate.
      process.env['HELA_GENOME_ALLOW_DESTRUCTIVE'] = 'true';
      try {
        // Create test table and insert data
        const schema = {
          columns: [
            { name: 'id', type: 'INTEGER', constraints: ['PRIMARY KEY'] },
            { name: 'name', type: 'TEXT' }
          ]
        };
        await sqliteManager.createTable('memory', 'test_table', schema);
        await sqliteManager.insertData('memory', 'test_table', [{ id: 1, name: 'Test' }]);

        const result = await requestHandlers.handleToolCall('delete_data', {
          table: 'test_table',
          conditions: { id: 1 }
        });

        expect(result).toHaveProperty('success', true);
      } finally {
        delete process.env['HELA_GENOME_ALLOW_DESTRUCTIVE'];
      }
    });

    test('should refuse delete_data unless destructive tools are enabled', async () => {
      delete process.env['HELA_GENOME_ALLOW_DESTRUCTIVE'];
      const schema = {
        columns: [
          { name: 'id', type: 'INTEGER', constraints: ['PRIMARY KEY'] },
          { name: 'name', type: 'TEXT' }
        ]
      };
      await sqliteManager.createTable('memory', 'test_table', schema);
      await sqliteManager.insertData('memory', 'test_table', [{ id: 1, name: 'Test' }]);

      await expect(
        requestHandlers.handleToolCall('delete_data', {
          table: 'test_table',
          conditions: { id: 1 }
        })
      ).rejects.toThrow(/HELA_GENOME_ALLOW_DESTRUCTIVE/);

      // the row must still be there
      const result = await sqliteManager.queryData('memory', 'test_table', {});
      expect(result.success).toBe(true);
      expect(result.data?.rowCount).toBe(1);
    });
  });

  describe('Memory Tool Handling', () => {
    test('should handle initialize_memory tool', async () => {
      const result = await requestHandlers.handleToolCall('initialize_memory', {});

      expect(result).toHaveProperty('success', true);
    });

    test('should handle memory_edit create_entities action', async () => {
      const result = await requestHandlers.handleToolCall('memory_edit', {
        action: 'create_entities',
        entities: [{
          name: 'test_project',
          entityType: 'project',
          observations: ['Test project']
        }]
      });

      expect(result).toHaveProperty('success', true);
    });

    test('should normalize legacy create_entity alias', async () => {
      const result = await requestHandlers.handleToolCall('create_entity', {
        entities: [{
          name: 'alias_project',
          entityType: 'project',
          observations: ['Via a hidden alias']
        }]
      });

      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('message', 'Created 1 entities');
    });

    test('should hide a deleted project entity from open_node and search_nodes in the same process', async () => {
      const name = 'probe:deletionsentinel';
      const open = () => requestHandlers.handleToolCall('open_node', { names: [name] });
      const search = () => requestHandlers.handleToolCall('search_nodes', { query: 'deletionsentinel' });
      const create = (observation: string) => requestHandlers.handleToolCall('memory_edit', {
        action: 'create_entities',
        entities: [{ name, entityType: 'resource', observations: [observation] }]
      });

      await expect(create('Original content')).resolves.toHaveProperty('message', 'Created 1 entities');
      // Automatic central sync is disabled during tests.
      await expect(memoryManager.syncToCentral()).resolves.toHaveProperty('entities', 1);
      await expect(open()).resolves.toMatchObject({ data: [expect.objectContaining({ name })] });
      await expect(search()).resolves.toMatchObject({ data: { entities: [expect.objectContaining({ name })] } });

      await expect(requestHandlers.handleToolCall('memory_edit', {
        action: 'delete_entities', entityNames: [name]
      })).resolves.toEqual({ success: true, message: 'Deleted 1 entities' });
      const [opened, found] = await Promise.all([open(), search()]);
      expect({ opened, found }).toMatchObject({
        opened: { data: [] },
        found: { data: { entities: [] } }
      });
      await expect(requestHandlers.handleToolCall('read_graph', { database: 'central' })).resolves.toMatchObject({
        data: { entities: [expect.objectContaining({ name })] }
      });
      await expect(requestHandlers.handleToolCall('read_graph', {})).resolves.toMatchObject({ data: { entities: [] } });
      await expect(requestHandlers.handleToolCall('read_graph_stream', {})).resolves.toMatchObject({ data: { entities: [] } });
      await expect(open()).resolves.toMatchObject({ data: [] });

      await expect(create('Recreated content')).resolves.toHaveProperty('message', 'Created 1 entities');
      const recreated = expect.objectContaining({ name, observations: ['Recreated content'] });
      await expect(open()).resolves.toMatchObject({ data: [recreated] });
      await expect(search()).resolves.toMatchObject({ data: { entities: [recreated] } });
    });

    test.each(['push', 'pull'])('propagates a deletion to central and removes stale project copies on %s', async direction => {
      const name = 'task:deleted-across-projects';
      const survivor = 'task:survivor';
      const central = memoryManager.getCentralDatabaseId();
      const secondRoot = mkdtempSync(join(tmpdir(), 'guardian-second-root-'));
      const secondSqlite = new SQLiteManager(secondRoot);
      const second = new MemoryManager(secondSqlite, secondRoot);
      const push = () => requestHandlers.handleToolCall('sync_central_memory', {});
      try {
        await memoryManager.createEntities([name, survivor].map(name => ({ name, entityType: 'task', observations: ['Original'] })));
        await memoryManager.createRelation(name, survivor, 'blocks');
        await push();
        await second.syncFromCentral();
        expect((await second.readStore('memory')).entities.map(entity => entity.name).sort()).toEqual([name, survivor]);
        await expect(memoryManager.deleteEntity(name)).resolves.toBe(1);

        await expect(push()).resolves.toMatchObject({ data: { deleted: { central: 1 } } });
        await expect(sqliteManager.queryData(central, 'entities', { name })).resolves.toMatchObject({ success: true, data: { rows: [] } });
        await expect(second.openNode(name)).resolves.toBeNull();
        expect((await second.searchNodes('deleted-across-projects')).entities).toEqual([]);
        expect((await second.readGraphStream()).relations).toEqual([]);

        const reconciliation = direction === 'push' ? second.syncToCentral() : second.syncFromCentral();
        await expect(reconciliation).resolves.toMatchObject({
          deleted: { project: 1, central: 0 },
          skipped: direction === 'push' ? { entities: 1, relations: 1 } : { entities: 0, relations: 0 },
        });
        for (let i = 0; i < 2; i++) {
          await second.syncFromCentral();
          await Promise.all([push(), second.syncToCentral()]);
        }
        for (const [manager, database] of [[second, 'memory'], [memoryManager, central]] as const) {
          const graph = await manager.readStore(database);
          expect(graph.entities.map(entity => entity.name)).toEqual([survivor]);
          expect(graph.relations).toEqual([]);
        }
      } finally {
        await secondSqlite.closeAllConnections();
        rmSync(secondRoot, { recursive: true, force: true });
      }
    });

    test('reports a central copy skipped by a pending project deletion on pull', async () => {
      const name = 'task:project-tombstone';
      await memoryManager.createEntity(name, 'task', ['Original']);
      await memoryManager.syncToCentral();
      await memoryManager.deleteEntity(name);

      await expect(requestHandlers.handleToolCall('obsidian_vault', { action: 'sync_from_central' })).resolves.toMatchObject({
        data: { entities: 0, skipped: { entities: 1 }, deleted: { central: 1 } },
      });
      await expect(memoryManager.openNode(name)).resolves.toBeNull();
      expect((await memoryManager.readStore(memoryManager.getCentralDatabaseId())).entities).toEqual([]);
    });

    test('retains pending deletions when a central sync fails and retries them successfully', async () => {
      const central = memoryManager.getCentralDatabaseId();
      const name = 'task:retry-deletion';
      await memoryManager.createEntity(name, 'task', ['Original']);
      await memoryManager.syncToCentral();
      await memoryManager.deleteEntity(name);
      const trigger = await sqliteManager.executeSql(central, `CREATE TRIGGER fail_sync BEFORE DELETE ON entities
        BEGIN SELECT RAISE(ABORT, 'injected sync failure'); END`);
      expect(trigger.success).toBe(true);

      await expect(memoryManager.syncToCentral()).rejects.toThrow('injected sync failure');
      expect((await memoryManager.readStore(central)).entities.map(entity => entity.name)).toEqual([name]);
      await expect(sqliteManager.queryData(central, 'deleted_entities', { name })).resolves.toMatchObject({ success: true, data: { rows: [] } });

      expect((await sqliteManager.executeSql(central, 'DROP TRIGGER fail_sync')).success).toBe(true);
      await expect(memoryManager.syncToCentral()).resolves.toMatchObject({ deleted: { central: 1 } });
      expect((await memoryManager.readStore(central)).entities).toEqual([]);
    });

    test('honors deletions made directly in central', async () => {
      const name = 'task:central-deletion';
      const central = memoryManager.getCentralDatabaseId();
      await memoryManager.createEntity(name, 'task', ['Original']);
      await memoryManager.syncToCentral();
      await expect(sqliteManager.deleteData(central, 'entities', { name })).resolves.toMatchObject({ data: { changes: 1 } });

      await expect(memoryManager.syncFromCentral()).resolves.toMatchObject({ deleted: { project: 1 } });
      await expect(memoryManager.createEntity(name, 'task', ['Stale copy'])).rejects.toThrow('deleted from central memory');
      expect((await memoryManager.readStore('memory')).entities).toEqual([]);
      expect((await memoryManager.readStore(central)).entities).toEqual([]);
    });

    test('should count deleted rows and report each missing name', async () => {
      const name = 'probe:deletecount';
      const missing = ['probe:missingone', 'probe:missingtwo'];
      const deleteNames = (entityNames: string[]) => requestHandlers.handleToolCall('memory_edit', {
        action: 'delete_entities', entityNames
      });
      await expect(requestHandlers.handleToolCall('memory_edit', {
        action: 'create_entities', entities: [{ name, entityType: 'resource', observations: [] }]
      })).resolves.toHaveProperty('message', 'Created 1 entities');

      await expect(deleteNames([missing[0], name, name, missing[1]])).resolves.toEqual({
        success: true,
        message: 'Deleted 1/4 entities (3 not found)',
        errors: [missing[0], name, missing[1]].map(name => ({ name, reason: `Entity '${name}' does not exist` }))
      });
      await expect(deleteNames(missing)).resolves.toEqual({
        success: true,
        message: 'Deleted 0/2 entities (2 not found)',
        errors: missing.map(name => ({ name, reason: `Entity '${name}' does not exist` }))
      });
    });

    test('should handle read_graph tool', async () => {
      const result = await requestHandlers.handleToolCall('read_graph', {});

      expect(result).toHaveProperty('success', true);
    });

    test('should handle read_graph_stream tool', async () => {
      const result = await requestHandlers.handleToolCall('read_graph_stream', {
        limit: 10
      });

      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('data.entities');
      expect(result).toHaveProperty('data.relations');
      expect(result).toHaveProperty('data.nextCursor');
    });

    test('should search unicode entity names', async () => {
      await requestHandlers.handleToolCall('memory_edit', {
        action: 'create_entities',
        entities: [{
          name: 'task:测试',
          entityType: 'task',
          observations: ['unicode search target']
        }]
      });

      const result = await requestHandlers.handleToolCall('search_nodes', {
        query: '测试'
      });

      expect(result).toMatchObject({ success: true, data: { entities: expect.arrayContaining([expect.objectContaining({ name: 'task:测试' })]) } });
    });

    test('should reinitialize schema after set_project_root', async () => {
      const targetRoot = mkdtempSync(join(tmpdir(), 'guardian-root-'));
      try {
        await memoryManager.createEntity('task:previous-root', 'task', ['Central only after switch']);
        await memoryManager.syncToCentral();
        process.env.NODE_ENV = 'production';
        const switched = await requestHandlers.handleToolCall('set_project_root', { path: targetRoot });
        process.env.NODE_ENV = 'test';
        expect(switched).toHaveProperty('success', true);
        await expect(requestHandlers.handleToolCall('read_graph', { database: 'project' })).resolves.toEqual({
          success: true, data: { entities: [], relations: [] },
        });
        await expect(requestHandlers.handleToolCall('get_session_context', {})).resolves.toMatchObject({
          data: { stats: { entities: 0 }, activeTasks: [] },
        });
        await expect(requestHandlers.handleToolCall('get_session_context', { scope: 'merged' })).resolves.toMatchObject({
          data: { stats: { entities: 1 }, activeTasks: [expect.objectContaining({ name: 'task:previous-root' })] },
        });

        const created = await requestHandlers.handleToolCall('memory_edit', {
          action: 'create_entities',
          entities: [{
            name: 'root2:Only',
            entityType: 'task',
            observations: ['isolated root']
          }]
        });
        expect(created).toMatchObject({ success: true, data: [expect.objectContaining({ name: 'root2:Only' })] });

        const graph = await requestHandlers.handleToolCall('read_graph', { database: 'project' });
        expect(graph).toMatchObject({ success: true, data: { entities: expect.arrayContaining([expect.objectContaining({ name: 'root2:Only' })]) } });

        const exported = await requestHandlers.handleToolCall('export_data', {
          table: 'entities',
          filePath: 'export.json',
          format: 'json'
        });
        expect(exported).toHaveProperty('success', true);
        expect(existsSync(join(targetRoot, 'export.json'))).toBe(true);

        const outside = await requestHandlers.handleToolCall('export_data', {
          table: 'entities',
          filePath: '/tmp/guardian-outside.json',
          format: 'json'
        });
        expect(outside).toHaveProperty('success', false);

        // The production switch used to upload all data in the destination root.
        process.env.NODE_ENV = 'production';
        await requestHandlers.handleToolCall('set_project_root', { path: targetRoot });
        expect((await memoryManager.readStore(memoryManager.getCentralDatabaseId())).entities.map(entity => entity.name))
          .toEqual(['task:previous-root']);
      } finally {
        process.env.NODE_ENV = 'test';
        rmSync(targetRoot, { recursive: true, force: true });
      }
    });

    test('should handle search_nodes tool', async () => {
      const result = await requestHandlers.handleToolCall('search_nodes', {
        query: 'test'
      });

      expect(result).toHaveProperty('success', true);
    });
  });

  describe('Error Handling', () => {
    test.each([null, [], 'not an object', 1])('rejects non-object tool arguments: %p', async input => {
      await expect(requestHandlers.handleToolCall('read_graph', input)).rejects.toThrow('Tool execution failed:');
    });

    test('validates prompt arguments as strings and vault actions before dispatch', async () => {
      await expect(requestHandlers.handleToolCall('get_project_guidance', { guidance_name: 'project_setup', arguments: { project_name: 42 } })).rejects.toThrow('Tool execution failed:');
      await expect(requestHandlers.handleToolCall('obsidian_vault', { action: 'overwrite' })).rejects.toThrow('Tool execution failed:');
    });

    test('should handle non-existent tool', async () => {
      await expect(requestHandlers.handleToolCall('non_existent_tool', {}))
        .rejects.toThrow('Unknown tool: non_existent_tool');
    });

    test('should handle invalid tool arguments', async () => {
      await expect(requestHandlers.handleToolCall('query_data', {
        // Missing required 'table' parameter
        conditions: {}
      })).rejects.toThrow('Tool execution failed');
    });
  });

  describe('Runtime Companion Tool Handling', () => {
    test('should validate and dispatch inspect_untrusted_text', async () => {
      const result = await requestHandlers.handleToolCall('inspect_untrusted_text', { text: 'safe text' });
      expect(result).toEqual({ success: true, data: { suspicious: false, alerts: [] } });
      expect(inspectedTexts).toEqual([{ text: 'safe text' }]);
    });

    test('should reject unknown runtime arguments', async () => {
      await expect(requestHandlers.handleToolCall('inspect_untrusted_text', { text: 'safe', extra: true }))
        .rejects.toThrow('Tool execution failed');
    });
  });

  describe('Import/Export Tool Handling', () => {
    test('should handle export_data tool', async () => {
      // Create test table and insert data
      const schema = {
        columns: [
          { name: 'id', type: 'INTEGER', constraints: ['PRIMARY KEY'] },
          { name: 'name', type: 'TEXT' }
        ]
      };
      await sqliteManager.createTable('memory', 'test_table', schema);
      await sqliteManager.insertData('memory', 'test_table', [{ id: 1, name: 'Test' }]);

      const result = await requestHandlers.handleToolCall('export_data', {
        table: 'test_table',
        filePath: './export_test.csv',
        format: 'csv'
      });

      expect(result).toHaveProperty('success', true);

      // Clean up
      if (existsSync('./export_test.csv')) {
        unlinkSync('./export_test.csv');
      }
    });
  });
});
