import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryManager } from '../memory-manager.js';
import type { SQLiteManager } from '../sqlite-manager.js';
import type { HarnessId, HarnessSession, SyncOptions, SyncResult } from './types.js';
import { locateStores } from './stores.js';
import {
  extractAntigravityConversations,
  extractCodexSessions,
  extractCursorSessions,
  extractDeltaThreads,
  extractDrizzleSessions,
  extractVscodeSessions,
  extractZedThreads,
  MAX_HARNESS_EPOCH_MS,
  type ExtractOptions,
} from './extractors.js';
import { cleanObservations } from './redact.js';

const WATERMARK_TABLE = 'harness_sync';
const LEGACY_TIMESTAMP = 'updated: +032971-04-28T00:00:00.000Z';

function checkSql(result: { success: boolean; error?: string }, missingTable?: string): void {
  if (result.success || (missingTable && result.error?.endsWith(`no such table: ${missingTable}`))) return;
  throw new Error(result.error || 'Harness sync database operation failed');
}

async function ensureWatermarkTable(sqlite: SQLiteManager): Promise<void> {
  const result = await sqlite.executeSql(
    'memory',
    `CREATE TABLE IF NOT EXISTS ${WATERMARK_TABLE} (
       harness TEXT NOT NULL,
       session_id TEXT NOT NULL,
       synced_updated INTEGER NOT NULL,
       PRIMARY KEY (harness, session_id)
     )`,
  );
  checkSql(result);
}

async function loadWatermarks(sqlite: SQLiteManager, harness: HarnessId, ids: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!ids.length || !existsSync(join(sqlite.getDatabasesPath(), 'memory.db'))) return map;
  const result = await sqlite.executeSql('memory', `SELECT session_id, synced_updated FROM ${WATERMARK_TABLE}
    WHERE harness = ? AND session_id IN (SELECT value FROM json_each(?))`, [harness, JSON.stringify(ids)], { readOnly: true });
  checkSql(result, WATERMARK_TABLE);
  for (const row of result.data?.rows ?? []) {
    const { session_id, synced_updated } = row;
    if (typeof session_id === 'string' && typeof synced_updated === 'number'
      && synced_updated > 0 && synced_updated < MAX_HARNESS_EPOCH_MS) map.set(session_id, synced_updated);
  }
  return map;
}

async function saveWatermark(sqlite: SQLiteManager, harness: HarnessId, sessionId: string, updatedAt: number): Promise<void> {
  const result = await sqlite.executeSql(
    'memory',
    `INSERT INTO ${WATERMARK_TABLE} (harness, session_id, synced_updated) VALUES (?, ?, ?)
     ON CONFLICT(harness, session_id) DO UPDATE SET synced_updated = excluded.synced_updated
     WHERE synced_updated < excluded.synced_updated OR synced_updated >= ?`,
    [harness, sessionId, updatedAt, MAX_HARNESS_EPOCH_MS],
  );
  checkSql(result);
}

async function repairLegacyTimestamps(sqlite: SQLiteManager, memory: MemoryManager): Promise<void> {
  for (const database of ['memory', memory.getCentralDatabaseId()]) {
    const dbPath = database === 'memory' ? join(sqlite.getDatabasesPath(), 'memory.db') : database;
    if (!existsSync(dbPath)) continue;
    const result = await sqlite.executeSql(database, `UPDATE entities SET observations = (
      SELECT json_group_array(observation) FROM (
        SELECT CASE WHEN value LIKE ? THEN substr(value, 1, length(value) - ?) ELSE value END AS observation
        FROM json_each(entities.observations) WHERE value <> ? ORDER BY key
      )
    ) WHERE name GLOB 'harness:antigravity:*' AND entity_type = 'session' AND json_valid(observations)
      AND EXISTS (SELECT 1 FROM json_each(observations) WHERE value = ? OR value LIKE ?)`,
    [`% | ${LEGACY_TIMESTAMP}`, LEGACY_TIMESTAMP.length + ' | '.length, LEGACY_TIMESTAMP,
      LEGACY_TIMESTAMP, `% | ${LEGACY_TIMESTAMP}`]);
    checkSql(result, 'entities');
  }
  const result = await sqlite.executeSql('memory',
    `DELETE FROM ${WATERMARK_TABLE} WHERE harness = 'antigravity' AND synced_updated >= ?`, [MAX_HARNESS_EPOCH_MS]);
  checkSql(result);
}

function entityName(s: HarnessSession): string {
  return `harness:${s.harness}:${s.sessionId}`;
}

async function existingEntities(sqlite: SQLiteManager, names: string[]): Promise<Set<string>> {
  if (!names.length || !existsSync(join(sqlite.getDatabasesPath(), 'memory.db'))) return new Set();
  const result = await sqlite.executeSql('memory', 'SELECT name FROM entities WHERE name IN (SELECT value FROM json_each(?))',
    [JSON.stringify(names)], { readOnly: true });
  checkSql(result, 'entities');
  return new Set((result.data?.rows ?? []).map(row => row.name).filter(name => typeof name === 'string'));
}

function sessionObservations(s: HarnessSession): string[] {
  const lines: string[] = [`[${s.harness}] ${s.title}`];
  if (s.project) lines.push(`project: ${s.project}`);
  if (s.summary) lines.push(s.summary);
  const meta: string[] = [];
  if (s.model) meta.push(`model: ${s.model}`);
  if (typeof s.messageCount === 'number') meta.push(`messages: ${s.messageCount}`);
  if (s.archived) meta.push('archived: true');
  meta.push(`updated: ${new Date(s.updatedAt).toISOString()}`);
  lines.push(meta.join(' | '));
  return cleanObservations(lines);
}

async function extractFor(
  harness: HarnessId,
  path: string,
  opts: ExtractOptions,
): Promise<{ sessions: HarnessSession[]; note?: string }> {
  switch (harness) {
    case 'opencode':
      return { sessions: await extractDrizzleSessions('opencode', path, opts) };
    case 'kilocode':
      return { sessions: await extractDrizzleSessions('kilocode', path, opts) };
    case 'zed':
      return { sessions: await extractZedThreads(path, opts) };
    case 'delta':
      return { sessions: await extractDeltaThreads(path, opts) };
    case 'antigravity':
      return { sessions: await extractAntigravityConversations(path, opts) };
    case 'codex':
      return { sessions: await extractCodexSessions(path, opts) };
    case 'cursor':
      return extractCursorSessions(path, opts);
    case 'vscode':
      return extractVscodeSessions(path);
  }
}

export async function syncHarnessSessions(
  sqlite: SQLiteManager,
  memory: MemoryManager,
  opts: SyncOptions = {},
): Promise<SyncResult[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const includeArchived = opts.includeArchived ?? false;
  const wanted = new Set(opts.harnesses ?? []);
  const results: SyncResult[] = [];
  if (!opts.dryRun) {
    await ensureWatermarkTable(sqlite);
    if (!wanted.size || wanted.has('antigravity')) await repairLegacyTimestamps(sqlite, memory);
  }

  for (const store of locateStores()) {
    if (wanted.size > 0 && !wanted.has(store.harness)) continue;
    if (!store.found) {
      results.push({ harness: store.harness, found: false, scanned: 0, created: 0, updated: 0, skipped: 0, errors: [store.detail] });
      continue;
    }
    const result: SyncResult = { harness: store.harness, found: true, scanned: 0, created: 0, updated: 0, skipped: 0, errors: [], sessions: [] };
    try {
      const { sessions, note } = await extractFor(store.harness, store.path, {
        limit,
        since: opts.since,
        project: opts.project,
        includeArchived,
        onInvalidTimestamp: (id, field, reason) => {
          result.skipped++;
          result.errors.push(`${id}: skipped ${field} timestamp (${reason})`);
        },
      });
      if (note) result.errors.push(note);
      result.scanned = sessions.length + result.skipped;
      const watermarks = await loadWatermarks(sqlite, store.harness, sessions.map(s => s.sessionId));
      const pending = sessions.filter(s => (watermarks.get(s.sessionId) ?? -1) < s.updatedAt);
      const existing = await existingEntities(sqlite, pending.map(entityName));
      for (const s of sessions) {
        const known = watermarks.get(s.sessionId) ?? -1;
        if (known >= s.updatedAt) {
          result.skipped++;
          result.sessions?.push({ sessionId: s.sessionId, title: s.title, updatedAt: s.updatedAt, action: 'skipped' });
          continue;
        }
        try {
          const name = entityName(s);
          const isUpdate = existing.has(name);
          const action = isUpdate ? 'updated' : 'created';
          if (!opts.dryRun) {
            const observations = sessionObservations(s);
            if (isUpdate) await memory.addObservation(name, observations);
            else await memory.createEntity(name, 'session', observations);
            await saveWatermark(sqlite, store.harness, s.sessionId, s.updatedAt);
          }
          existing.add(name);
          watermarks.set(s.sessionId, s.updatedAt);
          result[action]++;
          result.sessions?.push({ sessionId: s.sessionId, title: s.title, updatedAt: s.updatedAt, action: opts.dryRun ? 'dry-run' : action });
        } catch (e) {
          result.errors.push(`${s.sessionId}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      result.errors.push(e instanceof Error ? e.message : String(e));
    }
    results.push(result);
  }
  return results;
}
