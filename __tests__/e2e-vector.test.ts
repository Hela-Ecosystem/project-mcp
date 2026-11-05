import { SQLiteManager } from '../src/sqlite-manager';
import { MemoryManager } from '../src/memory-manager';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import os from 'os';

describe('E2E Vector Hybrid RAG', () => {
  let tmpDir: string;
  let sm: SQLiteManager;
  let mm: MemoryManager;
  beforeEach(async () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(process.env.GUARDIAN_CENTRAL_DB).toMatch(/guardian-jest-.*central-\d+\.db$/);
    expect(process.env.HELA_GENOME_OBSIDIAN_VAULT).toBeUndefined();
    expect(process.env.HELA_GENOME_OBSIDIAN_SYNC_CMD).toBeUndefined();
    expect(process.env.HELA_GENOME_OBSIDIAN_PULL_CMD).toBeUndefined();
    process.env.ENABLE_VECTOR_TEST = '1';
    tmpDir = mkdtempSync(join(os.tmpdir(), 'e2e-vec-'));
    sm = new SQLiteManager(tmpDir);
    mm = new MemoryManager(sm, tmpDir);
    await mm.initializeMemoryDatabase();
  }, 30000);

  afterEach(async () => {
    delete process.env.ENABLE_VECTOR_TEST;
    if (sm) await sm.closeAllConnections();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('hybrid search finds semantic match that keyword misses', async () => {
    // Create two distinct entities
    await mm.createEntity('task:auth-login', 'task', ['Implement login with JWT', 'Handle authentication failure and session timeout']);
    await mm.createEntity('task:ui-button', 'task', ['Create button component with hover effect and rounded corners']);

    const kw = await mm.searchNodes('authenticate', 10, 'keyword');
    expect(kw.entities).toHaveLength(0);

    const vec = await mm.searchNodes('authenticate', 10, 'vector');
    expect(vec.entities.length).toBeGreaterThan(0);
    expect(vec.entities[0].name).toBe('task:auth-login');

    // Hybrid search must retain a semantic match absent from keyword results.
    const hyb = await mm.searchNodes('authenticate', 10, 'hybrid');
    expect(hyb.entities.length).toBeGreaterThan(0);
    expect(hyb.entities[0].name).toBe('task:auth-login');

    // Verify vec table exists and has rows
    const vecCheck = await sm.executeSql('memory', 'SELECT COUNT(*) as c FROM vec_entities');
    expect(vecCheck.success).toBe(true);
    expect(vecCheck.data?.rows[0].c).toBe(2);

    // Add observation to ui-button and verify vec updates (re-embed)
    await mm.addObservation('task:ui-button', ['Add icon support']);
    const vec2 = await mm.searchNodes('icon', 10, 'vector');
    expect(vec2.entities[0]?.name).toBe('task:ui-button');

    // Delete should clean vec
    await mm.deleteEntity('task:ui-button');
    const vecAfterDel = await sm.executeSql('memory', 'SELECT COUNT(*) as c FROM vec_entities');
    expect(vecAfterDel.success).toBe(true);
    expect(vecAfterDel.data?.rows[0].c).toBe(1);
  }, 120000);

  test('readStore and readGraph respect limit pagination with vec', async () => {
    // Create 5 entities
    for (let i = 0; i < 5; i++) {
      await mm.createEntity(`task:bulk-${i}`, 'task', [`obs ${i}`]);
    }
    const g5 = await mm.readStore('memory', { limit: 3 });
    expect(g5.entities.length).toBe(3);
    const gAll = await mm.readGraph({ limit: 10 });
    expect(gAll.entities.length).toBeGreaterThanOrEqual(5);
  }, 60000);
});
