import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ObsidianVaultMirror } from '../src/obsidian-vault.js';
import { MemoryManager } from '../src/memory-manager.js';
import { SQLiteManager } from '../src/sqlite-manager.js';

describe('Optional vault mirror and idempotent memory sync', () => {
  let root: string;
  let vaultPath: string;
  let mirror: ObsidianVaultMirror;
  let sqlite: SQLiteManager;
  let memory: MemoryManager;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'guardian-mirror-'));
    vaultPath = join(root, 'vault');
    process.env.HELA_GENOME_OBSIDIAN_VAULT = vaultPath;
    mirror = new ObsidianVaultMirror();
    sqlite = new SQLiteManager(join(root, 'databases'));
    memory = new MemoryManager(sqlite, root);
    await memory.initializeMemoryDatabase();
  });

  afterEach(async () => {
    memory.stopVaultWatcher();
    await sqlite.closeAllConnections();
    rmSync(root, { recursive: true, force: true });
  });

  async function noteFor(name: string): Promise<{ filename: string; path: string; content: string }> {
    const filename = mirror.listNotes().find(filename => mirror.parseNote(mirror.readNote(filename) || '')?.name === name);
    if (!filename) throw new Error(`No note for ${name}`);
    return { filename, path: join(vaultPath, filename), content: mirror.readNote(filename)! };
  }

  test('parses only observation bullets, preserving multiline facts and unrelated wikilinks', () => {
    const note = '---\nname: "service:alpha"\ntype: "service"\n---\n\n- outside\n## Observations\n\n- fact\n- fact\n- line one\n  line two\n- [[reference]] is useful\n- [[project:alpha]] — part_of\n## Relations\n- [[project:alpha]] — part_of\n- [[service:beta]] — uses (incoming)\n## Other\n- not a fact\n';
    expect(mirror.parseNote(note)?.observations).toEqual(['fact', 'line one\nline two', '[[reference]] is useful']);
    expect(mirror.parseNote(note.replace(/\n/g, '\r\n'))?.observations).toEqual(['fact', 'line one\nline two', '[[reference]] is useful']);
    expect(mirror.parseNote('---\nname: 123\ntype: "task"\n---\n')).toBeNull();
  });

  test('repeated rebuild/backfill cycles do not amplify relation annotations or change stable entity timestamps', async () => {
    await memory.createEntity('project:alpha', 'project', ['Project fact']);
    await memory.createEntity('service:alpha', 'service', ['Fact one', 'Fact one', 'line one\nline two']);
    await memory.createRelation('service:alpha', 'project:alpha', 'part_of');
    const before = await memory.openNode('service:alpha');
    for (let index = 0; index < 4; index++) {
      await memory.rebuildFromVault();
      await memory.backfillVault();
    }
    const after = await memory.openNode('service:alpha');
    expect(after?.observations).toEqual(['Fact one', 'line one\nline two']);
    expect(after?.updatedAt).toBe(before?.updatedAt);
    const note = await noteFor('service:alpha');
    expect(note.content.match(/\[\[project:alpha\]\] — part_of/g)).toHaveLength(1);
    expect((await memory.readStore('memory')).relations).toHaveLength(1);
  });

  test('human observation removal is respected when SQLite still matches the rendered baseline', async () => {
    await memory.createEntity('service:alpha', 'service', ['Keep this', 'Remove this']);
    const note = await noteFor('service:alpha');
    writeFileSync(note.path, note.content.replace('- Remove this\n', ''));
    await memory.obsidianSync();
    expect((await memory.openNode('service:alpha'))?.observations).toEqual(['Keep this']);
  });

  test('a fresh SQLite database can rebuild entities and edges from managed vault notes', async () => {
    await memory.createEntity('project:alpha', 'project', ['Project']);
    await memory.createEntity('service:alpha', 'service', ['Service']);
    await memory.createRelation('service:alpha', 'project:alpha', 'part_of');
    const freshSqlite = new SQLiteManager(join(root, 'fresh'));
    const freshMemory = new MemoryManager(freshSqlite, root);
    try {
      await freshMemory.rebuildFromVault();
      const graph = await freshMemory.readStore('memory');
      expect(graph.entities).toHaveLength(2);
      expect(graph.relations).toEqual([expect.objectContaining({ from: 'service:alpha', to: 'project:alpha', relationType: 'part_of' })]);
    } finally {
      freshMemory.stopVaultWatcher();
      await freshSqlite.closeAllConnections();
    }
  });

  test('relation deletion removes its managed note and does not reappear on import', async () => {
    await memory.createEntity('project:alpha', 'project', ['Project']);
    await memory.createEntity('service:alpha', 'service', ['Service']);
    await memory.createRelation('service:alpha', 'project:alpha', 'part_of');
    await memory.rebuildFromVault();
    await memory.deleteRelation('service:alpha', 'project:alpha', 'part_of');
    await memory.rebuildFromVault();
    expect((await memory.readStore('memory')).relations).toEqual([]);
    expect(mirror.listNotes().map(filename => mirror.parseRelation(mirror.readNote(filename)!)).filter(Boolean)).toEqual([]);
  });

  test('concurrent human and database edits survive even with identical millisecond timestamps', async () => {
    await memory.createEntity('service:alpha', 'service', ['Base fact']);
    const note = await noteFor('service:alpha');
    writeFileSync(note.path, note.content.replace('- Base fact', '- Base fact\n- Human fact'));
    await memory.addObservation('service:alpha', ['Agent fact']);
    expect(readFileSync(note.path, 'utf8')).toContain('Human fact');
    await memory.obsidianSync();
    expect((await memory.openNode('service:alpha'))?.observations).toEqual(['Base fact', 'Agent fact', 'Human fact']);
    expect(readFileSync(note.path, 'utf8')).toContain('Agent fact');
    expect(mirror.listNotes().every(filename => !filename.startsWith('.'))).toBe(true);
    expect(readdirSync(join(vaultPath, '.hela-conflicts')).length).toBeGreaterThan(0);
    await memory.rebuildFromVault();
    expect((await memory.openNode('service:alpha'))?.observations).toHaveLength(3);
  });

  test('known note deletions use frontmatter identity, not the sanitized filename', async () => {
    await memory.createEntity('service:alpha/worker', 'service', ['Fact']);
    await memory.rebuildFromVault();
    const note = await noteFor('service:alpha/worker');
    unlinkSync(note.path);
    await memory.obsidianSync();
    expect(await memory.openNode('service:alpha/worker')).toBeNull();
  });

  test('an unavailable vault is not interpreted as deleting every entity', async () => {
    await memory.createEntity('service:alpha', 'service', ['Fact']);
    await memory.rebuildFromVault();
    const original = mirror.listNotes();
    rmSync(vaultPath, { recursive: true });
    await expect(memory.obsidianSync()).rejects.toThrow();
    expect((await memory.openNode('service:alpha'))?.observations).toEqual(['Fact']);
    expect(original).toHaveLength(1);
  });

  test('a deleted note cannot discard a newer SQLite edit', async () => {
    await memory.createEntity('service:alpha', 'service', ['Base']);
    await memory.rebuildFromVault();
    const note = await noteFor('service:alpha');
    await memory.addObservation('service:alpha', ['Newer']);
    unlinkSync(note.path);
    await memory.obsidianSync();
    expect((await memory.openNode('service:alpha'))?.observations).toEqual(['Base', 'Newer']);
    expect(readFileSync(note.path, 'utf8')).toContain('Newer');
  });

  test('junk guards apply during rebuild, and recovery/conflict notes stay out of imports', async () => {
    const note = '---\nname: "test_bad_entity"\ntype: "task"\n---\n\n## Observations\n- junk\n';
    writeFileSync(join(vaultPath, 'junk.md'), note);
    mkdirSync(join(vaultPath, '.hela-sync', 'conflicts'), { recursive: true });
    writeFileSync(join(vaultPath, '.hela-sync', 'conflicts', 'archive.md'), note.replace('test_bad_entity', 'archived:fact'));
    await memory.rebuildFromVault();
    expect((await memory.readStore('memory')).entities).toEqual([]);
    expect(mirror.listNotes()).toEqual(['junk.md']);
  });

  test('filename normalization collisions do not overwrite unrelated entities', async () => {
    await memory.createEntity('service:alpha', 'service', ['Colon']);
    await memory.createEntity('service/alpha', 'service', ['Slash']);
    expect(mirror.listNotes()).toHaveLength(2);
    await memory.rebuildFromVault();
    expect((await memory.openNode('service:alpha'))?.observations).toEqual(['Colon']);
    expect((await memory.openNode('service/alpha'))?.observations).toEqual(['Slash']);
  });

  test('central roundtrips merge independent facts and never duplicate relations', async () => {
    await memory.createEntity('project:alpha', 'project', ['Project']);
    await memory.createEntity('service:alpha', 'service', ['Local fact']);
    await memory.createRelation('service:alpha', 'project:alpha', 'part_of');
    await memory.syncToCentral();
    await sqlite.updateData(memory.getCentralDatabaseId(), 'entities', { name: 'service:alpha' }, {
      observations: JSON.stringify(['Central fact']), updated_at: '2000-01-01T00:00:00.000Z',
    });
    for (let index = 0; index < 5; index++) {
      await memory.syncFromCentral();
      await memory.syncToCentral();
    }
    const graph = await memory.readStore('memory');
    expect(graph.relations).toHaveLength(1);
    expect(graph.entities.find(entity => entity.name === 'service:alpha')?.observations).toEqual(['Local fact', 'Central fact']);
    expect((await memory.readStore(memory.getCentralDatabaseId())).relations).toHaveLength(1);
  });

  test('explicit dedup cleans generated annotations and preserves renamed entity relationships', async () => {
    await memory.createEntity('service:alpha', 'service', ['Fact']);
    await memory.createEntity('project:alpha', 'project', ['Project']);
    await memory.createEntity('Service:Alpha', 'service', ['Other fact']);
    await memory.createRelation('service:alpha', 'project:alpha', 'part_of');
    await memory.createRelation('Service:Alpha', 'project:alpha', 'uses');
    await memory.syncToCentral();
    await sqlite.updateData('memory', 'entities', { name: 'service:alpha' }, {
      observations: JSON.stringify(['Fact', 'Fact', '[[project:alpha]] — part_of', '[[project:alpha]] — part_of']),
      created_at: '2000-01-01T00:00:00.000Z',
    });
    expect(await memory.dedupEntities()).toEqual({ merged: 1, removed: 1 });
    const graph = await memory.readStore('memory');
    expect(graph.entities.find(entity => entity.name === 'service:alpha')?.observations.sort()).toEqual(['Fact', 'Other fact']);
    expect(graph.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'service:alpha', to: 'project:alpha', relationType: 'part_of' }),
      expect.objectContaining({ from: 'service:alpha', to: 'project:alpha', relationType: 'uses' }),
    ]));
    expect(graph.relations.some(relation => relation.from === 'Service:Alpha')).toBe(false);
    expect(await memory.dedupEntities()).toEqual({ merged: 0, removed: 0 });
    for (let index = 0; index < 3; index++) {
      await memory.syncFromCentral();
      await memory.syncToCentral();
      await memory.rebuildFromVault();
    }
    expect((await memory.readStore('memory')).entities.map(entity => entity.name).sort()).toEqual(['project:alpha', 'service:alpha']);
    expect((await memory.readStore('memory')).relations).toHaveLength(2);
  });

  test('destructive legacy hooks fail before invocation, and failed hooks propagate to callers', async () => {
    process.env.HELA_GENOME_OBSIDIAN_PULL_CMD = 'rsync -a --delete source destination';
    await expect(new ObsidianVaultMirror().pullSync()).rejects.toThrow('Destructive rsync');
    process.env.HELA_GENOME_OBSIDIAN_PULL_CMD = `${JSON.stringify(process.execPath)} -e "process.exit(7)"`;
    await expect(new ObsidianVaultMirror().pullSync()).rejects.toThrow('hook failed');
  });
});
