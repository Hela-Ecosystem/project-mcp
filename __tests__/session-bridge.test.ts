import sqlite3 from 'sqlite3';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { redactSecrets, cleanObservations, cleanObservationsWithMeta, redactSecretsWithMeta, truncate } from '../src/session-bridge/redact';
import { locateStores } from '../src/session-bridge/stores';
import {
  extractAntigravityConversations,
  extractCodexSessions,
  extractCursorSessions,
  extractDeltaThreads,
  extractDrizzleSessions,
  extractVscodeSessions,
  extractZedThreads,
} from '../src/session-bridge/extractors';
import { syncHarnessSessions } from '../src/session-bridge/sync';
import { MemoryManager } from '../src/memory-manager';
import { SQLiteManager } from '../src/sqlite-manager';

function run(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params as never[], (err: Error | null) => (err ? reject(err) : resolve()));
  });
}

async function fixtureDb(path: string, setup: (db: sqlite3.Database) => Promise<void>): Promise<void> {
  const db = new sqlite3.Database(path);
  try {
    await setup(db);
  } finally {
    await new Promise<void>((resolve) => db.close(() => resolve()));
  }
}

describe('session-bridge/redact', () => {
  test('redacts known secret shapes', () => {
    expect(redactSecrets('key sk-or-v1-abcdefghijklmnop here')).toContain('[REDACTED]');
    expect(redactSecrets('token ghp_abcdefghijklmnop here')).toContain('[REDACTED]');
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnop')).toContain('[REDACTED]');
    expect(redactSecrets('password=supersecret123')).toContain('[REDACTED]');
    expect(redactSecrets('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----')).toContain('[REDACTED]');
  });

  test('leaves clean text alone and truncates', () => {
    expect(redactSecrets('fixed the login bug')).toBe('fixed the login bug');
    expect(truncate('a'.repeat(600), 500).length).toBeLessThanOrEqual(501);
  });

  test('dedups and caps observations', () => {
    const out = cleanObservations(['hi', 'hi', 'x', 'a proper observation here']);
    expect(out).toEqual(['a proper observation here']);
  });

  test('WithMeta twins: same output + named redaction metadata', () => {
    const texts = ['fixed the login bug', 'token ghp_abcdefghijklmnop leaked', 'password=supersecret123 here'];
    const { observations, redaction } = cleanObservationsWithMeta(texts);
    expect(observations).toEqual(cleanObservations(texts));
    expect(observations[1]).toContain('[REDACTED]');
    expect(redaction.applied).toBe(true);
    expect(redaction.fields).toContain('github_pat');
    expect(redaction.fields).toContain('key_value_secret');

    const clean = cleanObservationsWithMeta(['fixed the login bug']);
    expect(clean.redaction).toEqual({ applied: false, fields: [] });

    const single = redactSecretsWithMeta('key sk-or-v1-abcdefghijklmnop here');
    expect(single.text).toBe(redactSecrets('key sk-or-v1-abcdefghijklmnop here'));
    expect(single.fields).toEqual(['openai_key']);
  });
});

describe('session-bridge/stores', () => {
  const OLD = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD };
  });

  test('env overrides are honored and missing stores report found=false', () => {
    process.env.HARNESS_OPENCODE_PATH = '/nonexistent/opencode.db';
    process.env.HARNESS_CODEX_PATH = '/nonexistent/codex';
    const stores = locateStores();
    expect(stores).toHaveLength(8);
    expect(stores.map((s) => s.harness)).toEqual(
      expect.arrayContaining(['opencode', 'kilocode', 'zed', 'delta', 'antigravity', 'cursor', 'vscode', 'codex']),
    );
    const oc = stores.find((s) => s.harness === 'opencode');
    expect(oc?.found).toBe(false);
    expect(oc?.path).toBe('/nonexistent/opencode.db');
  });
});

describe('session-bridge/extractors', () => {
  let dir: string;
  const OLD = { ...process.env };

  beforeEach(() => {
    dir = join(tmpdir(), `bridge-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    process.env = { ...OLD };
    rmSync(dir, { recursive: true, force: true });
  });

  test('drizzle reader normalizes sessions, counts messages, skips archived by default', async () => {
    const dbPath = join(dir, 'opencode.db');
    await fixtureDb(dbPath, async (db) => {
      await run(db, 'CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER, model TEXT, summary_diffs TEXT)');
      await run(db, 'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)');
      await run(db, `INSERT INTO session VALUES ('s1','/proj/a','Fix login',1000,2000,NULL,'{"id":"m1"}','a|b')`);
      await run(db, `INSERT INTO session VALUES ('s2','/proj/a','Old work',1700000000,1700000100,1700000200,'{"id":"m1"}',NULL)`);
      await run(db, `INSERT INTO message VALUES ('m1','s1',1100,'{"role":"user","content":[{"type":"text","text":"please fix login"}]}')`);
      await run(db, `INSERT INTO message VALUES ('m2','s1',1200,'{"role":"assistant","content":"done"}')`);
    });
    const rows = await extractDrizzleSessions('opencode', dbPath, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: 's1', project: '/proj/a', title: 'Fix login', messageCount: 2, model: 'm1', updatedAt: 2000 });
    expect(rows[0]?.summary).toContain('please fix login');
    const withArchived = await extractDrizzleSessions('opencode', dbPath, { includeArchived: true });
    expect(withArchived).toHaveLength(2);
    expect(withArchived[0]).toMatchObject({ sessionId: 's2', updatedAt: 1700000100000 });
  });

  test('zed threads reader uses summaries', async () => {
    const dbPath = join(dir, 'threads.db');
    await fixtureDb(dbPath, async (db) => {
      await run(db, 'CREATE TABLE threads (id TEXT PRIMARY KEY, summary TEXT, updated_at TEXT, data BLOB)');
      await run(db, `INSERT INTO threads VALUES ('t1','Refactor auth module','2026-09-01T10:00:00Z','blob')`);
    });
    const rows = await extractZedThreads(dbPath, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ harness: 'zed', sessionId: 't1' });
    expect(rows[0]?.title).toContain('Refactor auth');
  });

  test('delta threads reader honors archived flag', async () => {
    const dbPath = join(dir, 'data.sqlite');
    await fixtureDb(dbPath, async (db) => {
      await run(db, 'CREATE TABLE app_threads (id TEXT PRIMARY KEY, name TEXT, created_at INTEGER, last_prompted_at INTEGER, status TEXT, archived INTEGER)');
      await run(db, `INSERT INTO app_threads VALUES ('d1','Ship it',1700000000000,1700000001000,'active',0)`);
      await run(db, `INSERT INTO app_threads VALUES ('d2','Old',1700000000000,1700000001000,'done',1)`);
    });
    expect(await extractDeltaThreads(dbPath, {})).toHaveLength(1);
    expect(await extractDeltaThreads(dbPath, { includeArchived: true })).toHaveLength(2);
  });

  test('antigravity summaries map rich rows', async () => {
    const dbPath = join(dir, 'summaries.db');
    await fixtureDb(dbPath, async (db) => {
      await run(
        db,
        'CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT, step_count INTEGER, last_modified_time TEXT, workspace_uris TEXT, status TEXT, agent_name TEXT, project_id TEXT)',
      );
      await run(
        db,
        `INSERT INTO conversation_summaries VALUES ('c1','Deploy pipeline','Deployed to staging',12,'2026-09-02 10:00:00','["/home/u/proj"]','done','agent-x','proj-9')`,
      );
    });
    const rows = await extractAntigravityConversations(dbPath, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ harness: 'antigravity', sessionId: 'c1', project: 'proj-9', messageCount: 12 });
    expect(rows[0]?.summary).toContain('Deployed to staging');
  });

  test('codex rollout jsonl parses meta + first user text (real shapes)', async () => {
    const root = join(dir, 'codex');
    mkdirSync(join(root, 'sessions', '2026', '09', '10'), { recursive: true });
    writeFileSync(
      join(root, 'sessions', '2026', '09', '10', 'rollout-2026-09-10T10-00-00-abc123.jsonl'),
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'abc123', cwd: '/home/u/proj', model_provider: 'openai' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'add dark mode' } }),
        JSON.stringify({ type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: 'on it' }] } }),
      ].join('\n'),
    );
    const rows = await extractCodexSessions(root, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ harness: 'codex', sessionId: 'abc123', project: '/home/u/proj', messageCount: 2, model: 'openai' });
    expect(rows[0]?.title).toContain('dark mode');
  });

  test('codex skips slash-command noise for titles', async () => {
    const root = join(dir, 'codex2');
    mkdirSync(join(root, 'sessions', '2026', '09', '10'), { recursive: true });
    writeFileSync(
      join(root, 'sessions', '2026', '09', '10', 'rollout-x.jsonl'),
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'x1', cwd: '/home/u' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '<command-name>/model</command-name>' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'refactor the router' } }),
      ].join('\n'),
    );
    const rows = await extractCodexSessions(root, {});
    expect(rows[0]?.title).toContain('refactor the router');
  });

  test('cursor reports honest notes when absent or unparseable', async () => {
    const missing = await extractCursorSessions(join(dir, 'nope'), {});
    expect(missing.sessions).toHaveLength(0);
    expect(missing.note).toBeDefined();
  });

  test('cursor parses composer state.vscdb fixture', async () => {
    const ws = join(dir, 'ws', 'abc');
    mkdirSync(ws, { recursive: true });
    await fixtureDb(join(ws, 'state.vscdb'), async (db) => {
      await run(db, 'CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
      await run(
        db,
        `INSERT INTO ItemTable VALUES ('composer.composerData', '{"conversation":[{"id":"cc1","title":"Refactor API","updatedAt":1789000000000}]}')`,
      );
    });
    const { sessions } = await extractCursorSessions(join(dir, 'ws'), {});
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ harness: 'cursor', sessionId: 'cc1' });
  });

  test('vscode locator is honest when absent', async () => {
    const r = await extractVscodeSessions(join(dir, 'nope'));
    expect(r.sessions).toHaveLength(0);
    expect(r.note).toBeDefined();
  });
});

describe('session-bridge/sync', () => {
  test('normalizes source timestamps and reports invalid rows in preview and sync', async () => {
    const dir = join(tmpdir(), `bridge-invalid-timestamps-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const previousPath = process.env.HARNESS_ANTIGRAVITY_PATH;
    const sqlite = new SQLiteManager(dir);
    const memory = new MemoryManager(sqlite);
    try {
      const dbPath = join(dir, 'summaries.db');
      process.env.HARNESS_ANTIGRAVITY_PATH = dbPath;
      await fixtureDb(dbPath, async (db) => {
        await run(db, `CREATE TABLE conversation_summaries (
          conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT, step_count INTEGER, last_modified_time TEXT,
          workspace_uris TEXT, status TEXT, agent_name TEXT, project_id TEXT)`);
        for (const [id, timestamp] of [
          ['seconds', 1700000000], ['early-iso', '1999-01-01 00:00:00+00:00'],
          ['go-zero', '0001-01-01 00:00:00+00:00'], ['zero', 0], ['missing', null],
          ['far-future', '+032971-04-28T00:00:00.000Z'],
        ]) {
          await run(db, 'INSERT INTO conversation_summaries (conversation_id, last_modified_time) VALUES (?, ?)', [id, timestamp]);
        }
      });
      await memory.initializeMemoryDatabase();
      const opts = { harnesses: ['antigravity' as const] };
      const [initialPreview] = await syncHarnessSessions(sqlite, memory, { ...opts, dryRun: true });
      expect(initialPreview).toMatchObject({ scanned: 6, created: 2, updated: 0, skipped: 4 });
      const schema = await sqlite.executeSql('memory', "SELECT name FROM sqlite_schema WHERE name = 'harness_sync'");
      expect(schema.data?.rows).toEqual([]);

      const [synced] = await syncHarnessSessions(sqlite, memory, opts);
      expect(synced).toMatchObject({ scanned: 6, created: 2, updated: 0, skipped: 4 });
      expect(synced?.errors).toEqual(initialPreview?.errors);
      for (const id of ['go-zero', 'zero', 'missing', 'far-future']) {
        expect(synced?.errors).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^${id}: .*last_modified_time`))]));
        expect(await memory.openNode(`harness:antigravity:${id}`)).toBeNull();
      }
      expect((await memory.openNode('harness:antigravity:seconds'))?.observations).toContain('updated: 2023-11-14T22:13:20.000Z');
      expect((await memory.openNode('harness:antigravity:early-iso'))?.observations).toContain('updated: 1999-01-01T00:00:00.000Z');

      const [preview] = await syncHarnessSessions(sqlite, memory, { ...opts, dryRun: true });
      const [rerun] = await syncHarnessSessions(sqlite, memory, opts);
      expect(preview).toMatchObject({ scanned: 6, created: 0, updated: 0, skipped: 6 });
      expect(preview).toEqual(rerun);

      const legacy = 'updated: +032971-04-28T00:00:00.000Z';
      await memory.createEntity('harness:antigravity:go-zero', 'session', ['[antigravity] Legacy session', `messages: 0 | ${legacy}`]);
      await memory.addObservation('harness:antigravity:seconds', [legacy]);
      await memory.syncToCentral();
      const seeded = await sqlite.executeSql('memory', `INSERT OR REPLACE INTO harness_sync VALUES
        ('antigravity', 'seconds', 978307200000000), ('antigravity', 'go-zero', 978307200000000)`);
      expect(seeded.success).toBe(true);

      const [repairPreview] = await syncHarnessSessions(sqlite, memory, { ...opts, dryRun: true });
      expect(repairPreview).toMatchObject({ created: 0, updated: 1, skipped: 5 });
      expect((await memory.openNode('harness:antigravity:go-zero'))?.observations[1]).toContain(legacy);
      const [repaired] = await syncHarnessSessions(sqlite, memory, opts);
      expect(repaired).toMatchObject({ created: 0, updated: 1, skipped: 5 });
      for (const database of ['memory', memory.getCentralDatabaseId()]) {
        const saved = await sqlite.executeSql(database, 'SELECT name, observations FROM entities ORDER BY name');
        expect(saved.success).toBe(true);
        expect(saved.data?.rows).toHaveLength(3);
        expect(JSON.stringify(saved.data?.rows)).not.toContain(legacy);
        expect(JSON.stringify(saved.data?.rows)).toContain('messages: 0');
      }
      const watermarks = await sqlite.executeSql('memory', 'SELECT session_id, synced_updated FROM harness_sync ORDER BY session_id');
      expect(watermarks.data?.rows).toEqual([
        { session_id: 'early-iso', synced_updated: Date.parse('1999-01-01T00:00:00.000Z') },
        { session_id: 'seconds', synced_updated: 1700000000000 },
      ]);
    } finally {
      if (previousPath === undefined) delete process.env.HARNESS_ANTIGRAVITY_PATH;
      else process.env.HARNESS_ANTIGRAVITY_PATH = previousPath;
      await sqlite.closeAllConnections();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('preview and sync agree on creates and updates and persist redacted observations', async () => {
    const dir = join(tmpdir(), `bridge-sync-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const previousPath = process.env.HARNESS_ZED_PATH;
    const sqlite = new SQLiteManager(dir);
    const memory = new MemoryManager(sqlite);
    const opts = { harnesses: ['zed' as const] };
    try {
      const dbPath = join(dir, 'threads.db');
      process.env.HARNESS_ZED_PATH = dbPath;
      await fixtureDb(dbPath, async db => {
        await run(db, 'CREATE TABLE threads (id TEXT PRIMARY KEY, summary TEXT, updated_at TEXT, data BLOB)');
        await run(db, 'INSERT INTO threads VALUES (?, ?, ?, ?)',
          ['t1', 'Ship feature with key sk-or-v1-abcdefghijklmnop inside', '2026-09-05T10:00:00Z', 'x']);
      });
      const [first] = await syncHarnessSessions(sqlite, memory, opts);
      expect(first).toMatchObject({ created: 1, updated: 0, skipped: 0, errors: [] });
      const entity = await memory.openNode('harness:zed:t1');
      expect(entity?.entityType).toBe('session');
      expect(JSON.stringify(entity?.observations)).not.toContain('sk-or-v1-abcdefghijklmnop');
      expect(JSON.stringify(entity?.observations)).toContain('[REDACTED]');

      await fixtureDb(dbPath, async db => {
        await run(db, "UPDATE threads SET updated_at = '2026-09-05T11:00:00Z' WHERE id = 't1'");
        await run(db, "INSERT INTO threads VALUES ('t2', 'New session', '2026-09-05T12:00:00Z', 'x')");
      });
      const [preview] = await syncHarnessSessions(sqlite, memory, { ...opts, dryRun: true });
      expect(preview).toMatchObject({ created: 1, updated: 1, skipped: 0, errors: [] });
      expect(preview?.sessions?.map(session => session.action)).toEqual(['dry-run', 'dry-run']);
      expect(await memory.openNode('harness:zed:t1')).toEqual(entity);
      expect(await memory.openNode('harness:zed:t2')).toBeNull();
      const [synced] = await syncHarnessSessions(sqlite, memory, opts);
      expect(synced).toMatchObject({ created: 1, updated: 1, skipped: 0, errors: [] });
      expect(synced?.sessions?.map(session => session.action)).toEqual(['created', 'updated']);
      expect((await memory.openNode('harness:zed:t1'))?.observations).toContain('updated: 2026-09-05T11:00:00.000Z');
    } finally {
      if (previousPath === undefined) delete process.env.HARNESS_ZED_PATH;
      else process.env.HARNESS_ZED_PATH = previousPath;
      await sqlite.closeAllConnections();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
