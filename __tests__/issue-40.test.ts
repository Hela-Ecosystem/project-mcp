import { execFileSync, execSync, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { SQLiteManager } from '../src/sqlite-manager';
import { MemoryManager, buildPreCommitConfig, AUTO_COMBINE_HOOK_ENTRY } from '../src/memory-manager';
import { ImportExportManager } from '../src/import-export';
import { PromptHandlers } from '../src/prompts/prompt-handlers';
import { RequestHandlers } from '../src/handlers/request-handlers';
import { RuntimeCapabilities } from '../src/runtime/runtime-capabilities';
import { PathGuard } from '../src/runtime/path-guard';
import { AnalyzeGitChangesSchema } from '../src/types';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' });

describe('project-mcp#40 regressions', () => {
  describe('security_scan names the shared redaction patterns', () => {
    let root: string;

    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'guardian-scan-')); });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    test('reports AWS access keys and labels each finding by pattern name', async () => {
      writeFileSync(join(root, 'secrets.env'), [
        'aws_access_key = "AKIAIOSFODNN7EXAMPLE"',
        'github_token = "ghp_abcdefghijklmnopqrstuv"',
        'password = "hunter2secret"',
      ].join('\n'));
      const runtime = new RuntimeCapabilities({} as MemoryManager, {} as SQLiteManager, new PathGuard(root));

      const result = await runtime.scanProjectSecrets({ path: '.', exclude: [], maxFindings: 10 });
      const types = result.findings.map(finding => `${finding.line}:${finding.type}`);

      expect(types).toEqual(expect.arrayContaining([
        '1:aws_access_key',
        '2:github_pat',
        '3:key_value_secret',
      ]));
      expect(types.join('\n')).not.toContain('Generic API Key');
      expect(JSON.stringify(result)).not.toContain('AKIAIOSFODNN7EXAMPLE');
    });
  });

  describe('analyze_git_changes handles a one-commit repository', () => {
    let repo: string;

    beforeEach(() => {
      repo = mkdtempSync(join(tmpdir(), 'guardian-git-'));
      git(repo, 'init', '-q');
      writeFileSync(join(repo, 'committed.txt'), 'one\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'initial');
    });
    afterEach(() => rmSync(repo, { recursive: true, force: true }));

    const runtimeFor = (root: string) =>
      new RuntimeCapabilities({} as MemoryManager, {} as SQLiteManager, new PathGuard(root));

    test('falls back to the empty tree when HEAD~1 does not exist', async () => {
      writeFileSync(join(repo, 'committed.txt'), 'two\n');
      writeFileSync(join(repo, 'untracked.txt'), 'new\n');

      const result = await runtimeFor(repo).analyzeGitChanges({
        since: '1', includeUntracked: true, maxFiles: 100,
      });
      const paths = result.files.map(file => file.path);

      expect(paths).toEqual(expect.arrayContaining(['committed.txt', 'untracked.txt']));
    });

    test('the default since value means uncommitted changes', async () => {
      expect(AnalyzeGitChangesSchema.parse({}).since).toBe('0');
      writeFileSync(join(repo, 'committed.txt'), 'two\n');
      writeFileSync(join(repo, 'untracked.txt'), 'new\n');

      const result = await runtimeFor(repo).analyzeGitChanges({
        since: AnalyzeGitChangesSchema.parse({}).since, includeUntracked: true, maxFiles: 100,
      });
      const statuses = new Map(result.files.map(file => [file.path, file.status]));

      expect(statuses.get('committed.txt')).toBe('M');
      expect(statuses.get('untracked.txt')).toBe('??');
    });
  });

  describe('read_graph returns bounded pages', () => {
    let sqliteManager: SQLiteManager;
    let memoryManager: MemoryManager;
    let handlers: RequestHandlers;
    let dir: string;

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), 'guardian-graph-'));
      sqliteManager = new SQLiteManager(dir);
      memoryManager = new MemoryManager(sqliteManager, dir);
      handlers = new RequestHandlers(
        sqliteManager, memoryManager, new ImportExportManager(sqliteManager), new PromptHandlers(),
      );
      await memoryManager.initializeMemoryDatabase({ projectOnly: true });
      await memoryManager.createEntities(
        ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map(name => ({
          name: `task:${name}`, entityType: 'task', observations: ['seed'],
        })),
      );
    });
    afterEach(async () => {
      await sqliteManager.closeAllConnections();
      rmSync(dir, { recursive: true, force: true });
    });

    test('follows nextCursor until the graph is exhausted', async () => {
      const names: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      for (;;) {
        const response = await handlers.handleToolCall('read_graph', { limit: 2, ...(cursor ? { cursor } : {}) }) as {
          data: { entities: Array<{ name: string }>; nextCursor?: string | null };
        };
        pages++;
        expect(response.data.entities.length).toBeLessThanOrEqual(2);
        names.push(...response.data.entities.map(entity => entity.name));
        if (!response.data.nextCursor) break;
        cursor = response.data.nextCursor;
        expect(pages).toBeLessThan(10);
      }

      expect(pages).toBeGreaterThan(1);
      expect(names.sort()).toEqual(['task:alpha', 'task:beta', 'task:delta', 'task:epsilon', 'task:gamma']);
    });

    test('read_graph_stream still paginates unchanged', async () => {
      const first = await handlers.handleToolCall('read_graph_stream', { limit: 2 }) as {
        data: { entities: unknown[]; nextCursor: string | null };
      };
      expect(first.data.entities).toHaveLength(2);
      expect(typeof first.data.nextCursor).toBe('string');
    });
  });

  describe('get_file_context normalises absolute paths', () => {
    let sqliteManager: SQLiteManager;
    let memoryManager: MemoryManager;
    let projectRoot: string;
    let temp: string;

    beforeEach(async () => {
      temp = mkdtempSync(join(tmpdir(), 'guardian-context-'));
      projectRoot = join(temp, 'sample-project');
      mkdirSync(projectRoot);
      sqliteManager = new SQLiteManager(join(temp, 'db'));
      memoryManager = new MemoryManager(sqliteManager, projectRoot);
      await memoryManager.initializeMemoryDatabase({ projectOnly: true });
      await memoryManager.createEntity('file:sample-project/src/app.ts', 'file', ['tracked']);
    });
    afterEach(async () => {
      await sqliteManager.closeAllConnections();
      rmSync(temp, { recursive: true, force: true });
    });

    test('finds an entity stored relative to the workspace parent', async () => {
      const absolute = await memoryManager.getFileContext(join(projectRoot, 'src', 'app.ts'));
      const relativePath = await memoryManager.getFileContext('src/app.ts');

      expect(absolute.existsInMemory).toBe(true);
      expect(absolute.entityName).toBe(`file:${basename(projectRoot)}/src/app.ts`);
      expect(relativePath.existsInMemory).toBe(true);
    });
  });

  describe('bug-tracking guidance matches the stored convention', () => {
    test('files bug:<slug> with entityType "bug"', async () => {
      const text = await new PromptHandlers().handleGetPrompt('bug-tracking', { bug_description: 'Login fails hard' });

      expect(text).toContain('name: "bug:login-fails-hard"');
      expect(text).toContain('entityType: "bug"');
      expect(text).not.toContain('entityType: "risk"');
      expect(text).not.toContain('bug_');
    });
  });

  describe('destructive gate and empty conditions', () => {
    let sqliteManager: SQLiteManager;
    let memoryManager: MemoryManager;
    let handlers: RequestHandlers;
    let dir: string;

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), 'guardian-gate-'));
      sqliteManager = new SQLiteManager(dir);
      memoryManager = new MemoryManager(sqliteManager, dir);
      handlers = new RequestHandlers(
        sqliteManager, memoryManager, new ImportExportManager(sqliteManager), new PromptHandlers(),
      );
      await memoryManager.initializeMemoryDatabase({ projectOnly: true });
      delete process.env['HELA_GENOME_ALLOW_DESTRUCTIVE'];
    });
    afterEach(async () => {
      delete process.env['HELA_GENOME_ALLOW_DESTRUCTIVE'];
      await sqliteManager.closeAllConnections();
      rmSync(dir, { recursive: true, force: true });
    });

    test('gates insert_data, update_data and import_data like delete_data', async () => {
      for (const [tool, input] of [
        ['insert_data', { table: 'entities', records: [{ name: 'bug:gate', entity_type: 'bug', observations: '[]', created_at: 'x', updated_at: 'x' }] }],
        ['update_data', { table: 'entities', conditions: { name: 'bug:gate' }, updates: { observations: '[]' } }],
        ['import_data', { table: 'entities', filePath: 'rows.json', format: 'json' }],
      ] as const) {
        await expect(handlers.handleToolCall(tool, input)).rejects.toThrow(/HELA_GENOME_ALLOW_DESTRUCTIVE/);
      }
    });

    test('update_data and delete_data reject empty conditions explicitly', async () => {
      const update = await sqliteManager.updateData('memory', 'entities', {}, { entity_type: 'bug' });
      const remove = await sqliteManager.deleteData('memory', 'entities', {});

      expect(update.success).toBe(false);
      expect(update.error).toMatch(/conditions must contain at least one column/);
      expect(remove.success).toBe(false);
      expect(remove.error).toMatch(/conditions must contain at least one column/);
    });
  });

  describe('exported CSV neutralises spreadsheet formulas', () => {
    let sqliteManager: SQLiteManager;
    let dir: string;
    let csvPath: string;

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), 'guardian-csv-'));
      sqliteManager = new SQLiteManager(dir);
      await sqliteManager.createDatabase('csvdb');
      await sqliteManager.createTable('csvdb', 'cells', { columns: [{ name: 'label', type: 'TEXT' }] });
      await sqliteManager.insertData('csvdb', 'cells', [
        { label: '=HYPERLINK("http://evil.example","x")' },
        { label: '+1' },
        { label: 'she said "hi"' },
      ]);
      csvPath = join(process.cwd(), `issue40-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
    });
    afterEach(async () => {
      await sqliteManager.closeAllConnections();
      rmSync(dir, { recursive: true, force: true });
      try { unlinkSync(csvPath); } catch { /* export may have failed before creating the file */ }
    });

    test('prefixes =, +, - and @ cells with a quote', async () => {
      const manager = new ImportExportManager(sqliteManager);
      const result = await manager.exportToFile('csvdb', 'cells', csvPath, 'csv');
      const content = readFileSync(csvPath, 'utf8');

      expect(result.success).toBe(true);
      expect(content).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
      expect(content).toContain(`'+1`);
      expect(content).toContain('"she said ""hi"""');
    });
  });

  describe('generated pre-commit hook is non-destructive', () => {
    test('chains merge steps, merges observations, moves files, and restricts find', () => {
      const config = buildPreCommitConfig({ hasPython: false, hasNode: true });

      expect(config).toContain('&& mkdir -p .guardian-merged');
      expect(config).toContain('&& mv "$db"');
      expect(config).not.toContain('rm "$db"');
      expect(config).toContain('json_each(entities.observations)');
      expect(config).toContain('INSERT OR IGNORE INTO relations(from_entity, to_entity, relation_type, created_at)');
      expect(config).toContain('-not -path "*/node_modules/*"');
      expect(config).toContain('-not -path "*/.git/*"');
    });

    const sqliteAvailable = spawnSync('sqlite3', ['--version']).status === 0;

    (sqliteAvailable ? test : test.skip)('merges a nested memory.db and moves it instead of deleting it', () => {
      const root = mkdtempSync(join(tmpdir(), 'guardian-hook-'));
      const schema = [
        'CREATE TABLE entities(name TEXT PRIMARY KEY NOT NULL, entity_type TEXT NOT NULL, observations TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);',
        'CREATE TABLE relations(id INTEGER PRIMARY KEY AUTOINCREMENT, from_entity TEXT NOT NULL, to_entity TEXT NOT NULL, relation_type TEXT NOT NULL, created_at TEXT NOT NULL);',
      ].join(' ');
      const insert = (db: string, sql: string) => execFileSync('sqlite3', [db, sql]);

      try {
        insert(join(root, 'memory.db'), `${schema} INSERT INTO entities VALUES ('bug:shared', 'bug', '["root observation"]', 't', 't');`);
        mkdirSync(join(root, 'sub'));
        insert(join(root, 'sub', 'memory.db'), `${schema} INSERT INTO entities VALUES ('bug:shared', 'bug', '["nested observation"]', 't', 't'); INSERT INTO entities VALUES ('bug:new', 'bug', '["new entity"]', 't', 't');`);

        execSync(AUTO_COMBINE_HOOK_ENTRY, { cwd: root, stdio: 'pipe' });

        const rows = JSON.parse(execFileSync('sqlite3', [
          '-json', join(root, 'memory.db'), 'SELECT name, observations FROM entities ORDER BY name',
        ], { encoding: 'utf8' })) as Array<{ name: string; observations: string }>;

        const shared = rows.find(row => row.name === 'bug:shared');
        const observations = JSON.parse(shared!.observations) as string[];
        expect(observations).toEqual(expect.arrayContaining(['root observation', 'nested observation']));
        expect(rows.some(row => row.name === 'bug:new')).toBe(true);

        expect(readFileSafe(join(root, 'sub', 'memory.db'))).toBeNull();
        expect(readFileSafe(join(root, '.guardian-merged', 'sub__memory.db'))).not.toBeNull();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});

function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
