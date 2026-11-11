import { SQLiteManager } from './sqlite-manager.js';
import { Entity, Relation, KnowledgeGraph, SearchResult, CompactEntity, FileContextResult, TimelineResult, TimelineEntry, Mission, CreateMissionInput, ListMissionsInput, UpdateMissionInput } from './types.js';
import { DatabaseRow, DatabaseOperationResult, SqlExecutionData, memoryRowSchemas } from './types.js';
import { z } from 'zod';
import { ObsidianVaultMirror, uniqueObservations, observationHash } from './obsidian-vault.js';
import { createHash } from 'crypto';
import { sanitizePrivateContent } from './utils/sanitize.js';
import {
  ObservationProvenance,
  ensureObservationProvenanceSchema,
  recordObservationProvenance,
  ProvenanceRowSchema,
} from './observation-provenance.js';
import { embedText, toVecString } from './vector-manager.js';
import * as fs from 'fs';
import * as path from 'path';
import { exec, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';
import { isAbsolute, resolve, basename, dirname, join as joinPath } from 'path';
import { createInterface } from 'readline';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const MAX_CENTRAL_BACKUPS = 7;

export class MemoryManager {
  private sqliteManager: SQLiteManager;
  private memoryDbName: string = 'memory';
  private targetRoot: string;
  private centralDbPath: string;
  /** Per-entity failures from the most recent createEntities call. */
  private lastCreateFailures: Array<{ name: string; reason: string }> = [];
  private obsidianMirror!: ObsidianVaultMirror;
  private vaultWatcher: NodeJS.Timeout | null = null;
  private vaultNotes = new Map<string, { hash: string; name: string; version: string }>();
  private vaultRelations = new Map<string, { from: string; to: string; relationType: string; createdAt: string }>();
  private vaultSync: Promise<void> | null = null;

  constructor(sqliteManager: SQLiteManager, targetRoot?: string) {
    this.sqliteManager = sqliteManager;
    this.targetRoot = targetRoot ?? process.cwd();
    const configured = process.env.GUARDIAN_CENTRAL_DB;
    let centralPath = (configured && isAbsolute(configured))
      ? resolve(configured)
      : path.join(homedir(), 'memory', 'memory.db');
    // Windows guard: never let a C:\Windows\System32 cwd capture the central DB.
    if (centralPath && centralPath.toLowerCase().includes('windows\\system32')) {
      centralPath = path.join(homedir(), 'memory', 'memory.db');
    }
    this.centralDbPath = centralPath;

    this.obsidianMirror = new ObsidianVaultMirror();
    if (process.env.NODE_ENV !== 'test') {
      (async () => {
        await this.ensureProjectSchema();
        // Central <-> project sync: pull central entities into project (best-effort)
        try { await this.syncFromCentral(); } catch (e) { void e; }
        if (this.obsidianMirror.isEnabled()) {
          console.error('[obsidian] scheduling sync');
          try { await this.obsidianMirror.pullSync(); }
          catch (error) { console.error('[obsidian] remote sync unavailable:', (error as Error).message); }
          await this.rebuildFromVault();
          // Backfill: mirror any SQLite-only entities to vault, then push
          try { await this.backfillVault(); }
          catch (error) { console.error('[obsidian] backfill sync unavailable:', (error as Error).message); }
          this.startVaultWatcher();
          console.error('[obsidian] sync done');
        }
      })().catch((e) => { console.error('[obsidian] sync error', e); });
    }
  }

  private async ensureFtsSchema(dbName: string): Promise<void> {
    await this.sqliteManager.executeSql(dbName, `
      CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
        name, 
        entity_type, 
        observations,
        content='entities',
        content_rowid='rowid'
      );
    `);

    await this.sqliteManager.executeSql(dbName, `
      CREATE TRIGGER IF NOT EXISTS entities_ai AFTER INSERT ON entities BEGIN
        INSERT INTO entities_fts(rowid, name, entity_type, observations) 
        VALUES (new.rowid, new.name, new.entity_type, new.observations);
      END;
    `);

    await this.sqliteManager.executeSql(dbName, `
      CREATE TRIGGER IF NOT EXISTS entities_ad AFTER DELETE ON entities BEGIN
        INSERT INTO entities_fts(entities_fts, rowid, name, entity_type, observations) 
        VALUES('delete', old.rowid, old.name, old.entity_type, old.observations);
      END;
    `);

    await this.sqliteManager.executeSql(dbName, `
      CREATE TRIGGER IF NOT EXISTS entities_au AFTER UPDATE ON entities BEGIN
        INSERT INTO entities_fts(entities_fts, rowid, name, entity_type, observations) 
        VALUES('delete', old.rowid, old.name, old.entity_type, old.observations);
        INSERT INTO entities_fts(rowid, name, entity_type, observations) 
        VALUES (new.rowid, new.name, new.entity_type, new.observations);
      END;
    `);

    // Backfill FTS index if it was just created or if it went out of sync
    await this.sqliteManager.executeSql(dbName, `
      INSERT INTO entities_fts(entities_fts) VALUES('rebuild');
    `);
  }

  setTargetRoot(targetRoot: string): void {
    this.targetRoot = targetRoot;
    this.projectSchemaReady = false;
  }

  private async ensureCentralSchema(): Promise<void> {
    await this.sqliteManager.createTable(this.centralDbPath, 'entities', {
      columns: [
        { name: 'name', type: 'TEXT', constraints: ['PRIMARY KEY', 'NOT NULL'] },
        { name: 'entity_type', type: 'TEXT', constraints: ['NOT NULL'] },
        { name: 'observations', type: 'TEXT', constraints: ['NOT NULL'] },
        { name: 'created_at', type: 'TEXT', constraints: ['NOT NULL'] },
        { name: 'updated_at', type: 'TEXT', constraints: ['NOT NULL'] }
      ]
    });
    await this.sqliteManager.createTable(this.centralDbPath, 'relations', {
      columns: [
        { name: 'id', type: 'INTEGER', constraints: ['PRIMARY KEY', 'AUTOINCREMENT'] },
        { name: 'from_entity', type: 'TEXT', constraints: ['NOT NULL'] },
        { name: 'to_entity', type: 'TEXT', constraints: ['NOT NULL'] },
        { name: 'relation_type', type: 'TEXT', constraints: ['NOT NULL'] },
        { name: 'created_at', type: 'TEXT', constraints: ['NOT NULL'] }
      ],
      indexes: [
        { name: 'idx_central_relations_unique', columns: ['from_entity', 'to_entity', 'relation_type'], unique: true }
      ]
    });
    
    await this.ensureFtsSchema(this.centralDbPath);
    await this.ensureMissionsSchema(this.centralDbPath);
    try {
      await this.sqliteManager.executeSql(this.centralDbPath, `CREATE VIRTUAL TABLE IF NOT EXISTS vec_entities USING vec0(embedding float[${384}])`);
    } catch (e) { void e; }
  }

  private async ensureMissionsSchema(dbName: string): Promise<void> {
    await this.sqliteManager.executeSql(dbName, `
      CREATE TABLE IF NOT EXISTS missions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        origin_agent TEXT NOT NULL,
        target_agent TEXT NOT NULL DEFAULT 'any',
        status TEXT NOT NULL DEFAULT 'queued',
        priority TEXT NOT NULL DEFAULT 'normal',
        payload TEXT,
        result TEXT,
        error TEXT,
        claimed_by TEXT,
        claimed_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    await this.sqliteManager.executeSql(dbName, `CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status);`);
    await this.sqliteManager.executeSql(dbName, `CREATE INDEX IF NOT EXISTS idx_missions_target_status ON missions(target_agent, status);`);
    await this.sqliteManager.executeSql(dbName, `CREATE INDEX IF NOT EXISTS idx_missions_updated_at ON missions(updated_at DESC);`);
  }

  private projectSchemaReady = false;
  private async ensureProjectSchema(): Promise<void> {
    if (this.projectSchemaReady) return;
    // idempotent: IF NOT EXISTS handles re-entrancy, flag avoids extra I/O after warm
    await this.sqliteManager.createTable(this.memoryDbName, 'entities', {
      columns: [
        { name: 'name', type: 'TEXT', constraints: ['PRIMARY KEY', 'NOT NULL'] },
        { name: 'entity_type', type: 'TEXT', constraints: ['NOT NULL'] },
        { name: 'observations', type: 'TEXT', constraints: ['NOT NULL'] },
        { name: 'created_at', type: 'TEXT', constraints: ['NOT NULL'] },
        { name: 'updated_at', type: 'TEXT', constraints: ['NOT NULL'] }
      ]
    });
    await this.sqliteManager.createTable(this.memoryDbName, 'relations', {
      columns: [
        { name: 'id', type: 'INTEGER', constraints: ['PRIMARY KEY', 'AUTOINCREMENT'] },
        { name: 'from_entity', type: 'TEXT', constraints: ['NOT NULL'] },
        { name: 'to_entity', type: 'TEXT', constraints: ['NOT NULL'] },
        { name: 'relation_type', type: 'TEXT', constraints: ['NOT NULL'] },
        { name: 'created_at', type: 'TEXT', constraints: ['NOT NULL'] }
      ],
      indexes: [
        { name: 'idx_relations_from', columns: ['from_entity'] },
        { name: 'idx_relations_to', columns: ['to_entity'] },
        { name: 'idx_relations_type', columns: ['relation_type'] }
      ]
    });
    const dedup = await this.sqliteManager.executeSql(this.memoryDbName,
      'DELETE FROM relations WHERE id NOT IN (SELECT MIN(id) FROM relations GROUP BY from_entity, to_entity, relation_type)');
    if (!dedup.success) throw new Error(dedup.error || 'Relation deduplication failed');
    const unique = await this.sqliteManager.executeSql(this.memoryDbName,
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_relations_unique ON relations(from_entity, to_entity, relation_type)');
    if (!unique.success) throw new Error(unique.error || 'Relation uniqueness index failed');
    const aliases = await this.sqliteManager.executeSql(this.memoryDbName,
      'CREATE TABLE IF NOT EXISTS entity_aliases(alias TEXT PRIMARY KEY, canonical_name TEXT NOT NULL)');
    if (!aliases.success) throw new Error(aliases.error);
    const r1 = await this.sqliteManager.executeSql(this.memoryDbName, 'CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type)');
    if (!r1.success) console.warn('Failed to create entity type index:', r1.error);
    const r2 = await this.sqliteManager.executeSql(this.memoryDbName, 'CREATE INDEX IF NOT EXISTS idx_entities_updated ON entities(updated_at)');
    if (!r2.success) console.warn('Failed to create entity updated index:', r2.error);
    await this.ensureFtsSchema(this.memoryDbName);
    await this.ensureMissionsSchema(this.memoryDbName);
    const vecRes = await this.sqliteManager.executeSql(this.memoryDbName, `CREATE VIRTUAL TABLE IF NOT EXISTS vec_entities USING vec0(embedding float[384])`);
    if (!vecRes.success) console.warn('[vec] create table failed for', this.memoryDbName, vecRes.error);
    // P1-C2: provenance sidecar for externally-sourced observation facts
    await ensureObservationProvenanceSchema(this.sqliteManager, this.memoryDbName);
    this.projectSchemaReady = true;
  }

  private async upsertVec(dbName: string, entityName: string, text: string): Promise<void> {
    if (process.env.NODE_ENV === 'test' && !process.env.ENABLE_VECTOR_TEST) return;
    try {
      const vec = await embedText(text);
      const vecStr = toVecString(vec);
      // rowid mapping to entities
      const row = await this.sqliteManager.executeSql(dbName, `SELECT rowid FROM entities WHERE name=?`, [entityName]);
      if (!row.success || !row.data?.rows?.length) return;
      const rowid = z.number().int().parse(row.data.rows[0].rowid ?? row.data.rows[0].ROWID);
      // vec0 upsert: delete then insert (vec0 has no UPDATE)
      await this.sqliteManager.executeSql(dbName, `DELETE FROM vec_entities WHERE rowid=?`, [rowid]);
      const ins = await this.sqliteManager.executeSql(dbName, `INSERT INTO vec_entities(rowid, embedding) VALUES (?, ?)`, [rowid, vecStr]);
      if (!ins.success) throw new Error(ins.error);
    } catch (e) {
      console.warn(`vec upsert failed for ${entityName}:`, (e as Error).message);
    }
  }

  async syncToCentral(): Promise<{ entities: number; relations: number }> {
    const graph = await this.readStore(this.memoryDbName, { limit: 10000 });
    if (graph.entities.length === 0 && graph.relations.length === 0) {
      return { entities: 0, relations: 0 };
    }

    await this.ensureCentralSchema();
    // P1-C2: central sidecar so synced observations keep their provenance refs
    await ensureObservationProvenanceSchema(this.sqliteManager, this.centralDbPath);

    // batch in single transaction — was N separate writes, now 1 fsync
    await this.sqliteManager.executeSql(this.centralDbPath, 'BEGIN TRANSACTION');
    try {
      for (const entity of graph.entities) {
        const r = await this.sqliteManager.executeSql(
          this.centralDbPath,
          this.mergeEntitySql(),
          [entity.name, entity.entityType, JSON.stringify(entity.observations), entity.createdAt, entity.updatedAt]
        );
        if (!r.success) throw new Error(r.error);
        // P1-C2: carry the entity's provenance sidecar rows to central (idempotent)
        const prov = await this.sqliteManager.executeSql(
          this.memoryDbName,
          `SELECT observation, source, retrieved_at, confidence, freshness FROM observation_provenance WHERE entity_name = ?`,
          [entity.name]
        );
        if (prov.success && prov.data) {
          for (const value of prov.data.rows ?? []) {
            const row = ProvenanceRowSchema.parse(value);
            const cp = await this.sqliteManager.executeSql(
              this.centralDbPath,
              `INSERT OR REPLACE INTO observation_provenance
               (entity_name, observation, source, retrieved_at, confidence, freshness)
               VALUES (?, ?, ?, ?, ?, ?)`,
              [entity.name, row.observation, row.source, row.retrieved_at, row.confidence ?? null, row.freshness ?? null]
            );
            if (!cp.success) throw new Error(cp.error);
          }
        }
      }
      for (const relation of graph.relations) {
        const r = await this.sqliteManager.executeSql(
          this.centralDbPath,
          `INSERT OR IGNORE INTO relations (from_entity, to_entity, relation_type, created_at) VALUES (?, ?, ?, ?)`,
          [relation.from, relation.to, relation.relationType, relation.createdAt]
        );
        if (!r.success) throw new Error(r.error);
      }
      await this.sqliteManager.executeSql(this.centralDbPath, 'COMMIT');
    } catch (e) {
      try { await this.sqliteManager.executeSql(this.centralDbPath, 'ROLLBACK'); } catch (e) { void e; }
      throw e;
    }

    await this.backupCentralIfNeeded();
    return { entities: graph.entities.length, relations: graph.relations.length };
  }

  private async syncToCentralSafe(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    try {
      await this.syncToCentral();
    } catch (err) {
      console.warn('Central memory sync failed:', err);
    }
  }

  async syncFromCentral(): Promise<{ entities: number; relations: number }> {
    if (!this.projectSchemaReady) await this.ensureProjectSchema();
    await this.ensureCentralSchema();
    let eCount = 0, rCount = 0;
    try {
      const centEntities = await this.sqliteManager.queryData(this.centralDbPath, 'entities', {}, 10000, 0, 'updated_at', 'DESC');
      const centRelations = await this.sqliteManager.queryData(this.centralDbPath, 'relations', {}, 10000, 0);
      const aliasResult = await this.sqliteManager.queryData(this.memoryDbName, 'entity_aliases', {}, 100000);
      if (!aliasResult.success) throw new Error(aliasResult.error);
      const aliases = new Map<string, string>((aliasResult.data?.rows || []).map(value => {
        const row = memoryRowSchemas.entity_aliases.parse(value);
        return [row.alias, row.canonical_name];
      }));
      const centralRelations: Relation[] = (centRelations.data?.rows || []).map(row => this.rowToRelation(row));
      if (centEntities.success && centEntities.data) {
        for (const row of centEntities.data.rows) {
          const ent = this.rowToEntity(row);
          ent.observations = this.cleanObservations(ent, centralRelations);
          ent.name = aliases.get(ent.name) || ent.name;
          const result = await this.sqliteManager.executeSql(this.memoryDbName, this.mergeEntitySql(),
            [ent.name, ent.entityType, JSON.stringify(ent.observations), ent.createdAt, ent.updatedAt]);
          if (!result.success) throw new Error(result.error);
          eCount++;
        }
      }
      if (centRelations.success && centRelations.data) {
        for (const row of centRelations.data.rows) {
          const rel = this.rowToRelation(row);
          rel.from = aliases.get(rel.from) || rel.from;
          rel.to = aliases.get(rel.to) || rel.to;
          const result = await this.sqliteManager.executeSql(this.memoryDbName,
            'INSERT OR IGNORE INTO relations(from_entity, to_entity, relation_type, created_at) VALUES (?, ?, ?, ?)',
            [rel.from, rel.to, rel.relationType, rel.createdAt]);
          if (!result.success) throw new Error(result.error);
          rCount += result.data?.changes || 0;
        }
      }
    } catch (e) { throw new Error(`Central memory import failed: ${(e as Error).message}`); }
    return { entities: eCount, relations: rCount };
  }

  private mergeEntitySql(): string {
    return `INSERT INTO entities(name, entity_type, observations, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        entity_type = CASE WHEN excluded.updated_at > entities.updated_at THEN excluded.entity_type ELSE entities.entity_type END,
        observations = (SELECT json_group_array(value) FROM (
          SELECT value FROM (
            SELECT value, CAST(key AS INTEGER) AS position FROM json_each(entities.observations)
            UNION ALL SELECT value, json_array_length(entities.observations) + CAST(key AS INTEGER)
            FROM json_each(excluded.observations))
          GROUP BY value ORDER BY MIN(position))),
        created_at = MIN(entities.created_at, excluded.created_at),
        updated_at = MAX(entities.updated_at, excluded.updated_at)`;
  }

  private cleanObservations(entity: Entity, relations: Array<{ from: string; to: string; relationType: string }>): string[] {
    const annotations = new Set<string>();
    for (const relation of relations) {
      if (relation.from === entity.name) annotations.add(`[[${relation.to}]] — ${relation.relationType}`);
      if (relation.to === entity.name) annotations.add(`[[${relation.from}]] — ${relation.relationType} (incoming)`);
    }
    return uniqueObservations(entity.observations.filter(observation => !annotations.has(observation.trim())));
  }

  async dedupEntities(): Promise<{ merged: number; removed: number }> {
    if (!this.projectSchemaReady) await this.ensureProjectSchema();
    let merged = 0, removed = 0;
    const changedEntities: Entity[] = [];
    const removedNames: string[] = [];
    const begin = await this.sqliteManager.executeSql(this.memoryDbName, 'BEGIN IMMEDIATE');
    if (!begin.success) throw new Error(begin.error || 'Could not begin deduplication');
    try {
      const res = await this.sqliteManager.queryData(this.memoryDbName, 'entities', {}, 100000, 0, 'updated_at', 'DESC');
      if (!res.success || !res.data) throw new Error(res.error || 'Could not read entities');
      const entities = res.data.rows.map(row => this.rowToEntity(row));
      // group by normalized name
      const groups = new Map<string, Entity[]>();
      for (const e of entities) {
        const key = e.name.trim().toLowerCase();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(e);
      }
      for (const [, group] of groups) {
        // keep the first (earliest created), merge observations into it
        const survivor = group.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
        const allObs = new Set<string>();
        for (const e of group) {
          const relations = await this.getRelationsForEntity(e.name);
          for (const o of this.cleanObservations(e, relations)) allObs.add(o);
        }
        const mergedObs = [...allObs];
        const updatedAt = new Date().toISOString();
        const update = await this.sqliteManager.updateData(this.memoryDbName, 'entities', { name: survivor.name }, {
          observations: JSON.stringify(mergedObs),
          updated_at: updatedAt,
        });
        if (!update.success) throw new Error(update.error);
        changedEntities.push({ ...survivor, observations: mergedObs, updatedAt });
        if (group.length > 1) merged++;
        // delete the others
        for (const e of group) {
          if (e.name === survivor.name) continue;
          const alias = await this.sqliteManager.executeSql(this.memoryDbName,
            'INSERT INTO entity_aliases(alias, canonical_name) VALUES (?, ?) ON CONFLICT(alias) DO UPDATE SET canonical_name=excluded.canonical_name',
            [e.name, survivor.name]);
          if (!alias.success) throw new Error(alias.error);
          const retarget = await this.sqliteManager.executeSql(this.memoryDbName,
            'UPDATE entity_aliases SET canonical_name=? WHERE canonical_name=?', [survivor.name, e.name]);
          if (!retarget.success) throw new Error(retarget.error);
          const moved = await this.sqliteManager.executeSql(this.memoryDbName,
            `INSERT OR IGNORE INTO relations(from_entity, to_entity, relation_type, created_at)
             SELECT CASE WHEN from_entity=? THEN ? ELSE from_entity END,
                    CASE WHEN to_entity=? THEN ? ELSE to_entity END, relation_type, created_at
             FROM relations WHERE from_entity=? OR to_entity=?`,
            [e.name, survivor.name, e.name, survivor.name, e.name, e.name]);
          if (!moved.success) throw new Error(moved.error);
          const provenance = await this.sqliteManager.executeSql(this.memoryDbName,
            `INSERT OR IGNORE INTO observation_provenance(entity_name, observation, source, retrieved_at, confidence, freshness)
             SELECT ?, observation, source, retrieved_at, confidence, freshness FROM observation_provenance WHERE entity_name=?`,
            [survivor.name, e.name]);
          if (!provenance.success) throw new Error(provenance.error);
          const operations = [
            this.sqliteManager.deleteData(this.memoryDbName, 'relations', { from_entity: e.name }),
            this.sqliteManager.deleteData(this.memoryDbName, 'relations', { to_entity: e.name }),
            this.sqliteManager.deleteData(this.memoryDbName, 'observation_provenance', { entity_name: e.name }),
            this.sqliteManager.executeSql(this.memoryDbName, 'DELETE FROM vec_entities WHERE rowid IN (SELECT rowid FROM entities WHERE name=?)', [e.name]),
          ];
          for (const result of await Promise.all(operations)) if (!result.success) throw new Error(result.error);
          const deletion = await this.sqliteManager.deleteData(this.memoryDbName, 'entities', { name: e.name });
          if (!deletion.success) throw new Error(deletion.error);
          removedNames.push(e.name);
          removed++;
        }
      }
      const commit = await this.sqliteManager.executeSql(this.memoryDbName, 'COMMIT');
      if (!commit.success) throw new Error(commit.error);
    } catch (error) {
      await this.sqliteManager.executeSql(this.memoryDbName, 'ROLLBACK');
      throw error;
    }
    for (const name of removedNames) this.obsidianMirror.removeEntity(name);
    for (const entity of changedEntities) {
      await this.upsertVec(this.memoryDbName, entity.name, `${entity.name} ${entity.entityType} ${entity.observations.join(' ')}`);
      this.obsidianMirror.syncEntity(entity, await this.getRelationsForEntity(entity.name));
    }
    const graph = await this.readStore(this.memoryDbName, { limit: 100000 });
    for (const relation of graph.relations) this.obsidianMirror.syncRelation(relation);
    await this.syncToCentralSafe();
    return { merged, removed };
  }

  getCentralDatabaseId(): string {
    return this.centralDbPath;
  }

  static buildBackupName(date: Date): string {
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    return `${dd}${mm}${date.getFullYear()}_memory.db`;
  }

  static parseBackupName(filename: string): Date | null {
    const match = /^(\d{2})(\d{2})(\d{4})_memory\.db$/.exec(basename(filename));
    if (!match) return null;
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    const date = new Date(year, month - 1, day);
    if (isNaN(date.getTime()) || date.getDate() !== day || date.getMonth() !== month - 1 || date.getFullYear() !== year) {
      return null;
    }
    return date;
  }

  static selectBackupsToPrune(filenames: string[], maxKeep: number): string[] {
    if (maxKeep < 0) maxKeep = 0;
    const dated = filenames
      .map(name => ({ name, date: MemoryManager.parseBackupName(name) }))
      .filter((entry): entry is { name: string; date: Date } => entry.date !== null)
      .sort((a, b) => b.date.getTime() - a.date.getTime());
    return dated.slice(maxKeep).map(entry => entry.name).reverse();
  }

  private getBackupDir(): string {
    return joinPath(dirname(this.centralDbPath), 'backup');
  }

  private async migrateLegacyCentralDatabase(): Promise<void> {
    const legacyPath = path.join(homedir(), 'memory.db');
    if (this.centralDbPath === legacyPath) return;
    if (!fs.existsSync(legacyPath) || fs.existsSync(this.centralDbPath)) return;

    try {
      fs.mkdirSync(dirname(this.centralDbPath), { recursive: true });
      const migration = await this.sqliteManager.backupDatabase(legacyPath, this.centralDbPath);
      if (!migration.success) throw new Error(migration.error || 'Central memory snapshot failed');

      // Verify the copy is readable before touching the original
      const probe = await this.sqliteManager.executeSql(this.centralDbPath, 'SELECT COUNT(*) as count FROM entities');
      if (!probe.success || typeof probe.data?.rows?.[0]?.count !== 'number') {
        throw new Error(probe.error || 'central database probe failed');
      }

      fs.mkdirSync(this.getBackupDir(), { recursive: true });
      const seedBackup = joinPath(this.getBackupDir(), MemoryManager.buildBackupName(new Date()));
      if (!fs.existsSync(seedBackup)) {
        const backup = await this.sqliteManager.backupDatabase(this.centralDbPath, seedBackup);
        if (!backup.success) throw new Error(backup.error || 'Central memory seed backup failed');
        this.pruneBackupsSync();
      }

      console.error(`Migrated central memory to ${this.centralDbPath}; retained legacy database for recovery`);
    } catch (err) {
      console.error(`Central memory migration failed; continuing with legacy path ${legacyPath}:`, err);
      this.centralDbPath = legacyPath;
    }
  }

  private pruneBackupsSync(): void {
    try {
      const backupDir = this.getBackupDir();
      if (!fs.existsSync(backupDir)) return;
      const stale = MemoryManager.selectBackupsToPrune(fs.readdirSync(backupDir), MAX_CENTRAL_BACKUPS);
      for (const name of stale) {
        try { fs.unlinkSync(joinPath(backupDir, name)); } catch (e) { void e; }
      }
    } catch (err) {
      console.warn('Backup pruning failed:', err);
    }
  }

  private async backupCentralIfNeeded(): Promise<void> {
    try {
      if (!fs.existsSync(this.centralDbPath)) return;
      const backupDir = this.getBackupDir();
      fs.mkdirSync(backupDir, { recursive: true });

      const todayBackup = joinPath(backupDir, MemoryManager.buildBackupName(new Date()));
      if (!fs.existsSync(todayBackup)) {
        const backup = await this.sqliteManager.backupDatabase(this.centralDbPath, todayBackup);
        if (!backup.success) throw new Error(backup.error || 'Central memory backup failed');
      }
      this.pruneBackupsSync();
    } catch (err) {
      console.warn('Central memory backup failed:', err);
    }
  }

  async setupProjectFiles(): Promise<void> {
    const manageProjectFiles = process.env.NODE_ENV !== 'test';
    if (!manageProjectFiles) return;

    const targetRoot = this.targetRoot;

    // Pre-commit hook initialization — only on explicit request
    try {
      await execAsync('which pre-commit');
      await execAsync('git rev-parse --git-dir 2>/dev/null', { cwd: targetRoot });
    } catch {
      throw new Error('pre-commit and a Git repository are required in the project root');
    }

    try {
      const preCommitConfigPath = path.join(targetRoot, '.pre-commit-config.yaml');

      if (!fs.existsSync(preCommitConfigPath)) {
        const hasPython = fs.existsSync(path.join(targetRoot, 'requirements.txt')) ||
                          fs.existsSync(path.join(targetRoot, 'pyproject.toml')) ||
                          fs.existsSync(path.join(targetRoot, 'setup.py'));
        const hasNode = fs.existsSync(path.join(targetRoot, 'package.json'));

        const repos = [`  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v4.6.0
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer
      - id: check-yaml
      - id: check-added-large-files
        args: [--maxkb=500]
      - id: check-merge-conflict
      - id: detect-private-key`];

        if (hasPython) {
          repos.push(`  - repo: https://github.com/psf/black
    rev: 24.4.2
    hooks:
      - id: black
        args: [--line-length=100]

  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v0.11.0
    hooks:
      - id: ruff
        args: [--fix]`);
        }

        if (hasNode) {
          repos.push(`  - repo: https://github.com/pre-commit/mirrors-prettier
    rev: v3.1.0
    hooks:
      - id: prettier
        types_or: [javascript, jsx, ts, tsx, css, less, html, json, markdown]`);
        }

        repos.push(`  - repo: local
    hooks:
      - id: project-guardian-auto-combine
        name: Auto-combine scattered memory.db files
        entry: >
            bash -c 'find . -mindepth 2 -type f -name memory.db | while read db; do sqlite3 memory.db "ATTACH DATABASE \\"$db\\" AS nested; INSERT OR IGNORE INTO entities SELECT * FROM nested.entities; INSERT OR IGNORE INTO relations SELECT * FROM nested.relations;"; rm "$db"; done'
        language: system
        always_run: true
        pass_filenames: false`);

        const preCommitContent = `repos:\n${repos.join('\n\n')}\n`;
        fs.writeFileSync(preCommitConfigPath, preCommitContent, 'utf8');
        const ac = new AbortController();
        const timeoutId = setTimeout(() => ac.abort(), 30000);
        try {
          await execFileAsync('pre-commit', ['install'], { cwd: targetRoot, signal: ac.signal });
        } finally {
          clearTimeout(timeoutId);
        }
      }
    } catch (err) {
      throw new Error(`Failed to set up pre-commit hooks: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Gitignore initialization — append only entries that are not already ignored
    try {
      const guardianEntries = [
        'memory.db',
        'memory.db-journal',
        '.claude/',
        '.vscode/',
        '.idea/',
        '.gemini/',
        '.cursor/',
        '.env',
        '.env.*',
        '!.env.example',
      ];
      const gitignorePath = path.join(targetRoot, '.gitignore');
      const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
      const missing = guardianEntries.filter(entry => !existing.split(/\r?\n/).some(line => line.trim() === entry));
      if (missing.length > 0) {
        const block = `\n# Project Guardian\n${missing.join('\n')}\n`;
        if (!fs.existsSync(gitignorePath)) {
          fs.writeFileSync(gitignorePath, `# Project Guardian\n${guardianEntries.join('\n')}\n`, 'utf8');
        } else {
          fs.appendFileSync(gitignorePath, block, 'utf8');
        }
      }
    } catch (err) {
      console.warn('Failed to update .gitignore:', err);
    }
  }

  async initializeMemoryDatabase(): Promise<void> {
    // Note: Database will be created automatically when first accessed
    const manageProjectFiles = process.env.NODE_ENV !== 'test';

    const targetRoot = this.targetRoot;

    // Central memory is always available, regardless of configuration
    if (manageProjectFiles) try {
      await this.migrateLegacyCentralDatabase();
      await this.ensureCentralSchema();
    } catch (err) {
      console.warn('Central memory initialization failed:', err);
    }

    await this.ensureProjectSchema();

    // Scattered DB consolidation — DESTRUCTIVE (merges nested memory.db files
    // into the root and deletes them, destroying per-project isolation).
    // Disabled by default; opt in with GUARDIAN_AUTO_MERGE=1.
    if (manageProjectFiles && process.env.GUARDIAN_AUTO_MERGE === '1' && targetRoot !== (process.env.HOME || '')) {
      const rootDbPath = path.join(targetRoot, 'memory.db');
      let mergeCount = 0;
      const MAX_MERGE = 100;

      const findProcess = spawn('find', [targetRoot, '-mindepth', '2', '-type', 'f', '-name', 'memory.db']);
      const rl = createInterface({ input: findProcess.stdout });

      try {
        for await (const line of rl) {
          if (mergeCount >= MAX_MERGE) {
            console.warn(`Scattered DB merge capped at ${MAX_MERGE} files, skipping rest`);
            findProcess.kill();
            break;
          }
          const dbPath = line.trim();
          if (!dbPath || dbPath === rootDbPath) continue;
          
          try {
            const escapedPath = dbPath.replace(/'/g, "''");
            await this.sqliteManager.executeSql(this.memoryDbName, `ATTACH DATABASE '${escapedPath}' AS nested`);
            await this.sqliteManager.executeSql(this.memoryDbName, `INSERT OR IGNORE INTO entities SELECT * FROM nested.entities`);
            await this.sqliteManager.executeSql(this.memoryDbName, `INSERT OR IGNORE INTO relations SELECT * FROM nested.relations`);
            await this.sqliteManager.executeSql(this.memoryDbName, `DETACH DATABASE nested`);
            
            fs.unlinkSync(dbPath);
            mergeCount++;
          } catch (mergeErr) {
            console.error(`Failed to merge scattered database ${dbPath}:`, mergeErr);
            try { await this.sqliteManager.executeSql(this.memoryDbName, `DETACH DATABASE nested`); } catch (e) { void e; }
          }
        }
      } catch (e) {
        console.warn('Scattered DB scan failed:', e);
      }
    }

    await this.syncToCentralSafe();
  }

  private isJunkEntity(name: string, observations: string[]): boolean {
    const n = (name || '').trim().toLowerCase();
    if (!n) return true;
    if (n.startsWith('debug:') || n.startsWith('test_') || n.startsWith('test-')) return true;
    if (n.startsWith('perf_run_') || n.startsWith('perf-run-') || n.startsWith('perf run') || n.startsWith('perf_warm_')) return true;
    if (/^[a-z]{1,3}_-?\d+/.test(n)) return true;
    if (observations.length === 1 && observations[0].trim().toLowerCase() === 'perf') return true;
    if (n.includes('test') && (n.includes('entity') || n.includes('write') || n.includes('vault'))) return true;
    return false;
  }

  async createEntity(name: string, entityType: string, observations: string[], provenance?: Array<ObservationProvenance | undefined>): Promise<Entity> {
    if (!this.projectSchemaReady) await this.ensureProjectSchema();
    if (this.isJunkEntity(name, observations)) {
      throw new Error(`Refusing to create junk/test entity: ${name}`);
    }
    const now = new Date().toISOString();

    // Check if entity already exists
    const existing = await this.sqliteManager.queryData(this.memoryDbName, 'entities', { name });
    if (existing.success && existing.data && existing.data.rows.length > 0) {
      throw new Error(`Entity '${name}' already exists`);
    }

    const sanitizedInputs = observations.map(o => sanitizePrivateContent(o).trim());
    const sanitizedObservations = uniqueObservations(sanitizedInputs);
    const observationsJson = JSON.stringify(sanitizedObservations);

    const insertResult = await this.sqliteManager.insertData(this.memoryDbName, 'entities', [{
      name,
      entity_type: entityType,
      observations: observationsJson,
      created_at: now,
      updated_at: now
    }]);

    if (!insertResult.success) {
      throw new Error(`Failed to create entity: ${insertResult.error || insertResult.message}`);
    }

    // best-effort vector embed (name + observations)
    const text = `${name} ${entityType} ${sanitizedObservations.join(' ')}`;
    await this.upsertVec(this.memoryDbName, name, text);

    // P1-C2: provenance sidecar (best-effort, never fails the create)
    await recordObservationProvenance(this.sqliteManager, this.memoryDbName, name, sanitizedInputs, provenance);

    // Obsidian vault mirror (best-effort) — include relations for graph edges
    const entityRelations = await this.getRelationsForEntity(name);
    this.obsidianMirror.syncEntity({
      name,
      entityType,
      observations: sanitizedObservations,
      createdAt: now,
      updatedAt: now,
    }, entityRelations);

    // Auto-sync to central (best-effort)
    await this.syncToCentralSafe();

    return {
      name,
      entityType,
      observations: sanitizedObservations,
      createdAt: now,
      updatedAt: now
    };
  }

  async createEntities(entities: Array<{ name: string; entityType: string; observations: string[]; provenance?: Array<ObservationProvenance | undefined> }>): Promise<Entity[]> {
    if (!this.projectSchemaReady) await this.ensureProjectSchema();
    const results: Entity[] = [];
    // Reasons for per-entity failures, surfaced to the caller instead of being
    // visible only on stderr.
    this.lastCreateFailures = [];
    // single transaction for batch — avoids N fsyncs
    await this.sqliteManager.executeSql(this.memoryDbName, 'BEGIN TRANSACTION');
    try {
      for (const entity of entities) {
        try {
          const created = await this.createEntity(entity.name, entity.entityType, entity.observations, entity.provenance);
          results.push(created);
        } catch (error) {
          this.lastCreateFailures.push({
            name: entity.name,
            reason: error instanceof Error ? error.message : String(error)
          });
          console.error(`Failed to create entity ${entity.name}:`, error);
        }
      }
      await this.sqliteManager.executeSql(this.memoryDbName, 'COMMIT');
    } catch (e) {
      try { await this.sqliteManager.executeSql(this.memoryDbName, 'ROLLBACK'); } catch (e) { void e; }
      throw e;
    }

    if (results.length > 0) await this.syncToCentralSafe();
    return results;
  }

  /** Failure reasons from the most recent createEntities call. */
  getLastCreateFailures(): Array<{ name: string; reason: string }> {
    return this.lastCreateFailures;
  }

  async createRelation(from: string, to: string, relationType: string): Promise<Relation> {
    if (!this.projectSchemaReady) await this.ensureProjectSchema();
    // Verify entities exist
    const fromEntity = await this.sqliteManager.queryData(this.memoryDbName, 'entities', { name: from });
    const toEntity = await this.sqliteManager.queryData(this.memoryDbName, 'entities', { name: to });

    if (!fromEntity.success || !fromEntity.data || fromEntity.data.rows.length === 0) {
      throw new Error(`Entity '${from}' does not exist`);
    }
    if (!toEntity.success || !toEntity.data || toEntity.data.rows.length === 0) {
      throw new Error(`Entity '${to}' does not exist`);
    }

    const now = new Date().toISOString();

    // Dedup: skip if this relation already exists
    const existing = await this.sqliteManager.queryData(this.memoryDbName, 'relations', { from_entity: from, to_entity: to, relation_type: relationType });
    if (existing.success && existing.data && existing.data.rows.length > 0) {
      return { from, to, relationType, createdAt: (existing.data.rows[0] as { created_at: string }).created_at || now };
    }

    const insertResult = await this.sqliteManager.insertData(this.memoryDbName, 'relations', [{
      from_entity: from,
      to_entity: to,
      relation_type: relationType,
      created_at: now
    }]);

    if (!insertResult.success) {
      throw new Error(`Failed to create relation: ${insertResult.error || insertResult.message}`);
    }

    // Obsidian vault mirror (best-effort)
    this.obsidianMirror.syncRelation({ from, to, relationType, createdAt: now });
    // Re-sync both entities so their notes include the new relation as a wikilink
    try {
      const fromEnt = await this.sqliteManager.queryData(this.memoryDbName, 'entities', { name: from });
      if (fromEnt.success && fromEnt.data && fromEnt.data.rows.length > 0) {
        const row = fromEnt.data.rows[0];
        const rels = await this.getRelationsForEntity(from);
        this.obsidianMirror.syncEntity(this.rowToEntity(row), rels);
      }
      const toEnt = await this.sqliteManager.queryData(this.memoryDbName, 'entities', { name: to });
      if (toEnt.success && toEnt.data && toEnt.data.rows.length > 0) {
        const row = toEnt.data.rows[0];
        const rels = await this.getRelationsForEntity(to);
        this.obsidianMirror.syncEntity(this.rowToEntity(row), rels);
      }
    } catch (e) { void e; }

    await this.syncToCentralSafe();

    return {
      from,
      to,
      relationType,
      createdAt: now
    };
  }

  private async getRelationsForEntity(name: string): Promise<Array<{ from: string; to: string; relationType: string }>> {
    try {
      const r = await this.sqliteManager.executeSql(this.memoryDbName, `SELECT from_entity, to_entity, relation_type FROM relations WHERE from_entity=? OR to_entity=?`, [name, name]);
      if (r.success && r.data) {
        return (r.data.rows ?? []).map(value => {
          const row = memoryRowSchemas.relations.omit({ created_at: true }).parse(value);
          return { from: row.from_entity, to: row.to_entity, relationType: row.relation_type };
        });
      }
    } catch (e) { void e; }
    return [];
  }

  private async syncVaultNoteToSqlite(filename: string, content: string): Promise<void> {
    if (!this.projectSchemaReady) await this.ensureProjectSchema();
    const vault = this.obsidianMirror;
    const parsed = vault.parseNote(content);
    if (!parsed) return;
    if (this.isJunkEntity(parsed.name, parsed.observations)) return;
    const { name } = parsed;
    const relations = await this.getRelationsForEntity(name);
    let entityType = parsed.entityType;
    let observations = this.cleanObservations({ ...parsed, createdAt: '', updatedAt: '' }, relations)
      .map(value => sanitizePrivateContent(value));
    const existing = await this.sqliteManager.queryData(this.memoryDbName, 'entities', { name });
    if (!existing.success) throw new Error(existing.error);
    const now = new Date().toISOString();
    const noteUpdated = Date.parse(parsed.updatedAt ?? '');
    const noteCreated = Date.parse(parsed.createdAt ?? '');
    let updatedAt = Number.isFinite(noteUpdated) ? new Date(noteUpdated).toISOString() : now;
    let createdAt = Number.isFinite(noteCreated) ? new Date(noteCreated).toISOString() : now;
    if (existing.success && existing.data && existing.data.rows.length > 0) {
      const row = memoryRowSchemas.entities.parse(existing.data.rows[0]);
      const current = this.cleanObservations(this.rowToEntity(row), relations);
      const earliestCreated = Math.min(Date.parse(row.created_at), Date.parse(createdAt));
      createdAt = Number.isFinite(earliestCreated) ? new Date(earliestCreated).toISOString() : createdAt;
      const latestUpdated = Math.max(Date.parse(row.updated_at), Number.isFinite(noteUpdated) ? noteUpdated : Date.parse(row.updated_at));
      updatedAt = Number.isFinite(latestUpdated) ? new Date(latestUpdated).toISOString() : updatedAt;
      const matchesBase = parsed.mirrorHash
        ? parsed.mirrorHash === observationHash({ entityType: row.entity_type, observations: current })
        : parsed.updatedAt === row.updated_at;
      if (!matchesBase) {
        if (!current.every(value => observations.includes(value))) observations = uniqueObservations([...current, ...observations]);
        entityType = row.entity_type;
      }
      const changed = row.entity_type !== entityType || JSON.stringify(current) !== JSON.stringify(observations);
      if (changed) updatedAt = new Date(Math.max(Date.parse(updatedAt), Date.parse(now))).toISOString();
      if (changed || row.created_at !== createdAt || row.updated_at !== updatedAt
          || JSON.stringify(this.safeParseObservations(row.observations)) !== JSON.stringify(observations)) {
        const update = await this.sqliteManager.updateData(this.memoryDbName, 'entities', {
          name, created_at: row.created_at, updated_at: row.updated_at, observations: row.observations, entity_type: row.entity_type,
        }, {
          entity_type: entityType,
          observations: JSON.stringify(observations),
          created_at: createdAt,
          updated_at: updatedAt,
        });
        if (!update.success || update.data?.changes !== 1) throw new Error('Vault import changed concurrently; retry sync');
      }
    } else {
      const insert = await this.sqliteManager.insertData(this.memoryDbName, 'entities', [{
          name,
          entity_type: entityType,
          observations: JSON.stringify(observations),
          created_at: createdAt,
          updated_at: updatedAt,
      }]);
      if (!insert.success) throw new Error(insert.error);
    }
    await this.upsertVec(this.memoryDbName, name, `${name} ${entityType} ${observations.join(' ')}`);
    if (vault.readNote(filename) !== content) throw new Error('Vault note changed during import; retry sync');
    vault.syncEntity({ name, entityType, observations, createdAt, updatedAt }, relations, true, filename);
    const currentContent = vault.readNote(filename);
    if (currentContent === null) throw new Error('Vault note disappeared during import');
    const mirrored = vault.parseNote(currentContent);
    if (!mirrored || observationHash(mirrored) !== observationHash({ entityType, observations })) {
      throw new Error('Vault note changed before publication; retry sync');
    }
    this.vaultNotes.set(filename, {
      hash: createHash('sha256').update(currentContent).digest('hex'), name,
      version: observationHash({ entityType, observations }),
    });
  }

  /** Poll the vault for changes and sync to SQLite. */
  private async syncVaultToSqlite(): Promise<void> {
    if (this.vaultSync) return this.vaultSync;
    this.vaultSync = this.importVaultSnapshot();
    try { await this.vaultSync; }
    finally { this.vaultSync = null; }
  }

  private async importVaultSnapshot(): Promise<void> {
    const vault = this.obsidianMirror;
    if (!vault.isEnabled()) return;
    const vaultPath = vault.getVaultPath();
    if (!vaultPath) return;
    if (!this.projectSchemaReady) await this.ensureProjectSchema();
      const files = vault.listNotes();
      const snapshot = new Map<string, string>();
      for (const filename of files) {
        const content = vault.readNote(filename);
        if (content === null) throw new Error('Incomplete vault snapshot; no deletions applied');
        snapshot.set(filename, content);
      }
      const currentSet = new Set(files);
      for (const [filename, relation] of this.vaultRelations) {
        if (!currentSet.has(filename)) {
          await this.deleteRelation(relation.from, relation.to, relation.relationType);
          this.vaultRelations.delete(filename);
        }
      }
      for (const [fname, previous] of this.vaultNotes) {
        if (!currentSet.has(fname)) {
          const existing = await this.sqliteManager.queryData(this.memoryDbName, 'entities', { name: previous.name });
          if (!existing.success) throw new Error(existing.error);
          const row = existing.data?.rows[0];
          if (row && observationHash(this.rowToEntity(row)) === previous.version) await this.deleteEntity(previous.name);
          else if (row) vault.syncEntity(this.rowToEntity(row), await this.getRelationsForEntity(previous.name));
          this.vaultNotes.delete(fname);
        }
      }
      for (const [fname, content] of snapshot) {
        const hash = createHash('sha256').update(content).digest('hex');
        if (this.vaultNotes.get(fname)?.hash !== hash) {
          await this.syncVaultNoteToSqlite(fname, content);
        }
      }
      for (const [filename, content] of snapshot) {
        const relation = vault.parseRelation(content);
        if (!relation) continue;
        const insert = await this.sqliteManager.executeSql(this.memoryDbName,
          `INSERT OR IGNORE INTO relations(from_entity, to_entity, relation_type, created_at)
           SELECT ?, ?, ?, ? WHERE EXISTS(SELECT 1 FROM entities WHERE name=?)
           AND EXISTS(SELECT 1 FROM entities WHERE name=?)`,
          [relation.from, relation.to, relation.relationType, relation.createdAt, relation.from, relation.to]);
        if (!insert.success) throw new Error(insert.error);
        this.vaultRelations.set(filename, relation);
      }
  }

  private startVaultWatcher(): void {
    // initial sync
    this.syncVaultToSqlite().catch(error => console.error('[obsidian] import failed:', error.message));
    this.vaultWatcher = setInterval(() => {
      this.syncVaultToSqlite().catch(error => console.error('[obsidian] import failed:', error.message));
    }, 2000);
    // don't keep process alive solely for watcher
    if (this.vaultWatcher.unref) this.vaultWatcher.unref();
  }

  /** Import entity notes without clearing SQLite or inferring deletions on startup. */
  async rebuildFromVault(): Promise<void> {
    await this.syncVaultToSqlite();
  }

  async backfillVault(): Promise<void> {
    if (!this.obsidianMirror.isEnabled()) return;
    if (!this.projectSchemaReady) await this.ensureProjectSchema();
    console.error('[obsidian] backfill start, vault=', this.obsidianMirror.getVaultPath());
    try {
      const entitiesResult = await this.sqliteManager.queryData(this.memoryDbName, 'entities', {}, 100000, 0, 'updated_at', 'DESC');
      const relationsResult = await this.sqliteManager.queryData(this.memoryDbName, 'relations', {}, 100000, 0);
      const entities = (entitiesResult.success && entitiesResult.data)
        ? entitiesResult.data.rows.map(row => this.rowToEntity(row)) : [];
      const relations = (relationsResult.success && relationsResult.data)
        ? relationsResult.data.rows.map(row => this.rowToRelation(row)) : [];
      for (const e of entities) {
        const rels = relations.filter((r: Relation) => r.from === e.name || r.to === e.name).map((r: Relation) => ({ from: r.from, to: r.to, relationType: r.relationType }));
        this.obsidianMirror.syncEntity(e, rels);
      }
      for (const r of relations) this.obsidianMirror.syncRelation(r);
      await this.obsidianMirror.flushSync();
    } catch (e) { throw new Error(`Vault backfill failed: ${(e as Error).message}`); }
  }

  // Obsidian vault control (exposed to MCP tools)
  obsidianStatus(): { enabled: boolean; vaultPath: string | null; noteCount: number } {
    const enabled = this.obsidianMirror.isEnabled();
    const vaultPath = this.obsidianMirror.getVaultPath();
    let noteCount = 0;
    if (vaultPath) {
    try { noteCount = this.obsidianMirror.listNotes().length; } catch (error) {
      console.warn('Could not count vault notes:', error);
    }
    }
    return { enabled, vaultPath, noteCount };
  }

  async obsidianSync(): Promise<{ synced: boolean; noteCount: number }> {
    if (!this.obsidianMirror.isEnabled()) return { synced: false, noteCount: 0 };
    await this.obsidianMirror.pullSync();
    await this.syncVaultToSqlite();
    await this.obsidianMirror.flushSync();
    const noteCount = this.obsidianMirror.isEnabled() ? this.obsidianMirror.listNotes().length : 0;
    return { synced: true, noteCount };
  }

  async obsidianRebuild(): Promise<{ rebuilt: boolean; noteCount: number }> {
    await this.rebuildFromVault();
    const noteCount = this.obsidianMirror.isEnabled() ? this.obsidianMirror.listNotes().length : 0;
    return { rebuilt: true, noteCount };
  }

  async obsidianBackfill(): Promise<{ backfilled: boolean; noteCount: number }> {
    await this.backfillVault();
    const noteCount = this.obsidianMirror.isEnabled() ? this.obsidianMirror.listNotes().length : 0;
    return { backfilled: true, noteCount };
  }

  stopVaultWatcher(): void {
    if (this.vaultWatcher) { clearInterval(this.vaultWatcher); this.vaultWatcher = null; }
  }

  async createRelations(relations: Array<{ from: string; to: string; relationType: string }>): Promise<Relation[]> {
    if (!this.projectSchemaReady) await this.ensureProjectSchema();
    const results: Relation[] = [];
    await this.sqliteManager.executeSql(this.memoryDbName, 'BEGIN TRANSACTION');
    try {
      for (const relation of relations) {
        try {
          const created = await this.createRelation(relation.from, relation.to, relation.relationType);
          results.push(created);
        } catch (error) {
          console.error(`Failed to create relation ${relation.from} -> ${relation.to}:`, error);
        }
      }
      await this.sqliteManager.executeSql(this.memoryDbName, 'COMMIT');
    } catch (e) {
      try { await this.sqliteManager.executeSql(this.memoryDbName, 'ROLLBACK'); } catch (e) { void e; }
      throw e;
    }

    if (results.length > 0) await this.syncToCentralSafe();
    return results;
  }

  async addObservation(entityName: string, contents: string[], provenance?: Array<ObservationProvenance | undefined>): Promise<Entity> {
    if (!this.projectSchemaReady) await this.ensureProjectSchema();
    // Get current entity
    const result = await this.sqliteManager.queryData(this.memoryDbName, 'entities', { name: entityName });
    if (!result.success || !result.data || result.data.rows.length === 0) {
      throw new Error(`Entity '${entityName}' does not exist`);
    }

    const entity = memoryRowSchemas.entities.parse(result.data.rows[0]);
    const sanitizedContents = contents.map(c => sanitizePrivateContent(c));
    const currentObservations = this.safeParseObservations(entity.observations);
    const updatedObservations = uniqueObservations([...currentObservations, ...sanitizedContents]);
    const now = new Date().toISOString();

    await this.sqliteManager.updateData(
      this.memoryDbName,
      'entities',
      { name: entityName },
      {
        observations: JSON.stringify(updatedObservations),
        updated_at: now
      }
    );

    // re-embed with updated observations
    const text = `${entityName} ${entity.entity_type} ${updatedObservations.join(' ')}`;
    await this.upsertVec(this.memoryDbName, entityName, text);

    // P1-C2: provenance sidecar (best-effort, never fails the write)
    await recordObservationProvenance(this.sqliteManager, this.memoryDbName, entityName, sanitizedContents, provenance);

    // Obsidian vault mirror (best-effort) — include relations for graph edges
    const updatedRelations = await this.getRelationsForEntity(entity.name);
    this.obsidianMirror.syncEntity({
      name: entity.name,
      entityType: entity.entity_type,
      observations: updatedObservations,
      createdAt: entity.created_at,
      updatedAt: now,
    }, updatedRelations);

    await this.syncToCentralSafe();

    return {
      name: entity.name,
      entityType: entity.entity_type,
      observations: updatedObservations,
      createdAt: entity.created_at,
      updatedAt: now
    };
  }

  async addObservations(observations: Array<{ entityName: string; contents: string[]; provenance?: Array<ObservationProvenance | undefined> }>): Promise<Entity[]> {
    if (!this.projectSchemaReady) await this.ensureProjectSchema();
    const results: Entity[] = [];
    await this.sqliteManager.executeSql(this.memoryDbName, 'BEGIN TRANSACTION');
    try {
      for (const obs of observations) {
        try {
          const updated = await this.addObservation(obs.entityName, obs.contents, obs.provenance);
          results.push(updated);
        } catch (error) {
          console.error(`Failed to add observations to entity ${obs.entityName}:`, error);
        }
      }
      await this.sqliteManager.executeSql(this.memoryDbName, 'COMMIT');
    } catch (e) {
      try { await this.sqliteManager.executeSql(this.memoryDbName, 'ROLLBACK'); } catch (e) { void e; }
      throw e;
    }

    if (results.length > 0) await this.syncToCentralSafe();
    return results;
  }

  async deleteEntity(entityName: string): Promise<void> {
    if (!this.projectSchemaReady) await this.ensureProjectSchema();
    // capture rowid for vec before delete
    let rowid: number | null = null;
    try {
      const r = await this.sqliteManager.executeSql(this.memoryDbName, `SELECT rowid FROM entities WHERE name=?`, [entityName]);
      if (r.success && r.data?.rows?.length) rowid = z.number().int().parse(r.data.rows[0].rowid);
    } catch (e) { void e; }
    await this.sqliteManager.executeSql(this.memoryDbName, 'BEGIN TRANSACTION');
    try {
      await this.sqliteManager.deleteData(this.memoryDbName, 'relations',
        { from_entity: entityName });
      await this.sqliteManager.deleteData(this.memoryDbName, 'relations',
        { to_entity: entityName });
      if (rowid !== null) {
        try { await this.sqliteManager.executeSql(this.memoryDbName, `DELETE FROM vec_entities WHERE rowid=?`, [rowid]); } catch (e) { void e; }
      }
      await this.sqliteManager.deleteData(this.memoryDbName, 'entities',
        { name: entityName });
      await this.sqliteManager.executeSql(this.memoryDbName, 'COMMIT');
      // Obsidian vault mirror (best-effort)
      this.obsidianMirror.removeEntity(entityName);
      await this.syncToCentralSafe();
    } catch (error) {
      await this.sqliteManager.executeSql(this.memoryDbName, 'ROLLBACK');
      throw error;
    }
  }

  async deleteEntities(entityNames: string[]): Promise<void> {
    for (const name of entityNames) {
      await this.deleteEntity(name);
    }
    await this.syncToCentralSafe();
  }

  async deleteObservation(entityName: string, observations: string[]): Promise<Entity> {
    if (!this.projectSchemaReady) await this.ensureProjectSchema();
    // Get current entity
    const result = await this.sqliteManager.queryData(this.memoryDbName, 'entities', { name: entityName });
    if (!result.success || !result.data || result.data.rows.length === 0) {
      throw new Error(`Entity '${entityName}' does not exist`);
    }

    const entity = memoryRowSchemas.entities.parse(result.data.rows[0]);
    const currentObservations = this.safeParseObservations(entity.observations);
    const updatedObservations = currentObservations.filter((obs: string) => !observations.includes(obs));
    const now = new Date().toISOString();

    await this.sqliteManager.updateData(
      this.memoryDbName,
      'entities',
      { name: entityName },
      {
        observations: JSON.stringify(updatedObservations),
        updated_at: now
      }
    );

    const text = `${entityName} ${entity.entity_type} ${updatedObservations.join(' ')}`;
    await this.upsertVec(this.memoryDbName, entityName, text);

    return {
      name: entity.name,
      entityType: entity.entity_type,
      observations: updatedObservations,
      createdAt: entity.created_at,
      updatedAt: now
    };
  }

  async deleteObservations(deletions: Array<{ entityName: string; observations: string[] }>): Promise<Entity[]> {
    if (!this.projectSchemaReady) await this.ensureProjectSchema();
    const results: Entity[] = [];
    await this.sqliteManager.executeSql(this.memoryDbName, 'BEGIN TRANSACTION');
    try {
      for (const deletion of deletions) {
        try {
          const updated = await this.deleteObservation(deletion.entityName, deletion.observations);
          results.push(updated);
        } catch (error) {
          console.error(`Failed to delete observations from entity ${deletion.entityName}:`, error);
        }
      }
      await this.sqliteManager.executeSql(this.memoryDbName, 'COMMIT');
    } catch (e) {
      try { await this.sqliteManager.executeSql(this.memoryDbName, 'ROLLBACK'); } catch (e) { void e; }
      throw e;
    }

    if (results.length > 0) await this.syncToCentralSafe();
    return results;
  }

  async deleteRelation(from: string, to: string, relationType: string): Promise<void> {
    const deletion = await this.sqliteManager.deleteData(this.memoryDbName, 'relations', {
      from_entity: from,
      to_entity: to,
      relation_type: relationType
    });
    if (!deletion.success) throw new Error(deletion.error);
    this.obsidianMirror.removeRelation(from, to, relationType);
    for (const name of new Set([from, to])) {
      const entity = await this.openNode(name);
      if (entity) this.obsidianMirror.syncEntity(entity, await this.getRelationsForEntity(name));
    }
  }

  async deleteRelations(relations: Array<{ from: string; to: string; relationType: string }>): Promise<void> {
    for (const relation of relations) {
      await this.deleteRelation(relation.from, relation.to, relation.relationType);
    }
    await this.syncToCentralSafe();
  }

  private rowToEntity(value: DatabaseRow): Entity {
    const row = memoryRowSchemas.entities.parse(value);
    return {
      name: row.name,
      entityType: row.entity_type,
      observations: this.safeParseObservations(row.observations),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private rowToRelation(value: DatabaseRow): Relation {
    const row = memoryRowSchemas.relations.parse(value);
    return {
      from: row.from_entity,
      to: row.to_entity,
      relationType: row.relation_type,
      createdAt: row.created_at
    };
  }

  private mergeGraphs(graphs: KnowledgeGraph[]): KnowledgeGraph {
    const entities = new Map<string, Entity>();
    const relations = new Map<string, Relation>();
    for (const graph of graphs) {
      for (const entity of graph.entities) {
        // Project entries win over central mirrors
        if (!entities.has(entity.name)) entities.set(entity.name, entity);
      }
      for (const relation of graph.relations) {
        const key = `${relation.from}\u0000${relation.to}\u0000${relation.relationType}`;
        if (!relations.has(key)) relations.set(key, relation);
      }
    }
    const edges = [...relations.values()];
    return { entities: [...entities.values()].map(entity => ({ ...entity, observations: this.cleanObservations(entity, edges) })), relations: edges };
  }

  async readStore(database: string, opts?: { limit?: number; offset?: number }): Promise<KnowledgeGraph> {
    const limit = opts?.limit ?? 5000;
    const offset = opts?.offset;
    const entitiesResult = await this.sqliteManager.queryData(database, 'entities', {}, limit, offset, 'updated_at', 'DESC');
    const relationsResult = await this.sqliteManager.queryData(database, 'relations', {}, limit, offset);
    const relations: Relation[] = (relationsResult.success && relationsResult.data)
        ? relationsResult.data.rows.map(row => this.rowToRelation(row))
        : [];
    const entities: Entity[] = (entitiesResult.success && entitiesResult.data)
      ? entitiesResult.data.rows.map(row => this.rowToEntity(row)) : [];
    return { entities: entities.map(entity => ({ ...entity, observations: this.cleanObservations(entity, relations) })), relations };
  }

  async readGraph(opts?: { limit?: number; offset?: number }): Promise<KnowledgeGraph> {
    const limit = opts?.limit ?? 5000;
    const offset = opts?.offset;
    const projectResult = await this.sqliteManager.queryData(this.memoryDbName, 'entities', {}, limit, offset, 'updated_at', 'DESC');
    const projectRelations = await this.sqliteManager.queryData(this.memoryDbName, 'relations', {}, limit, offset);
    const centralResult = await this.sqliteManager.queryData(this.centralDbPath, 'entities', {}, limit, offset, 'updated_at', 'DESC');
    const centralRelations = await this.sqliteManager.queryData(this.centralDbPath, 'relations', {}, limit, offset);

    return this.mergeGraphs([
      {
        entities: (projectResult.success && projectResult.data)
          ? projectResult.data.rows.map(row => this.rowToEntity(row))
          : [],
        relations: (projectRelations.success && projectRelations.data)
          ? projectRelations.data.rows.map(row => this.rowToRelation(row))
          : []
      },
      {
        entities: (centralResult.success && centralResult.data)
          ? centralResult.data.rows.map(row => this.rowToEntity(row))
          : [],
        relations: (centralRelations.success && centralRelations.data)
          ? centralRelations.data.rows.map(row => this.rowToRelation(row))
          : []
      }
    ]);
  }

  async vacuumDatabases(): Promise<void> {
    await this.sqliteManager.vacuumDatabase(this.memoryDbName);
    await this.sqliteManager.vacuumDatabase(this.centralDbPath);
    // schedule next monthly VACUUM (30d) - fire-and-forget
    setTimeout(() => this.vacuumDatabases().catch(() => {}), 30 * 24 * 60 * 60 * 1000);
  }

  async readGraphStream(cursor?: string, limit: number = 500): Promise<{ entities: Entity[]; relations: Relation[]; nextCursor: string | null }> {
    const capped = Math.min(Math.max(limit, 1), 1000);
    let decoded: { updated_at: string; name: string } | null = null;
    if (cursor) {
      try {
        const json = Buffer.from(cursor, 'base64url').toString('utf8');
        decoded = z.object({ updated_at: z.string(), name: z.string() }).parse(JSON.parse(json));
      } catch (e) { void e; }
    }
    // Use updated_at DESC, name ASC as tie-breaker
    const whereClause = decoded ? `WHERE (updated_at < ? OR (updated_at = ? AND name > ?))` : '';
    const params: unknown[] = decoded ? [decoded.updated_at, decoded.updated_at, decoded.name] : [];
    const projSql = `SELECT * FROM entities ${whereClause} ORDER BY updated_at DESC, name ASC LIMIT ${capped + 1}`;
    const [projRes, centRes] = await Promise.all([
      this.sqliteManager.executeSql(this.memoryDbName, projSql, params),
      this.sqliteManager.executeSql(this.centralDbPath, projSql, params),
    ]);
    const toEnts = (r: DatabaseOperationResult<SqlExecutionData>) => r.success ? (r.data?.rows ?? []).map(row => this.rowToEntity(row)) : [];
    const merged = this.mergeGraphs([{ entities: toEnts(projRes), relations: [] }, { entities: toEnts(centRes), relations: [] }]);
    // Sort merged by updated_at DESC, name ASC and slice
    merged.entities.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name));
    const hasMore = merged.entities.length > capped;
    const page = hasMore ? merged.entities.slice(0, capped) : merged.entities;
    let nextCursor: string | null = null;
    if (hasMore && page.length > 0) {
      const last = page[page.length - 1];
      nextCursor = Buffer.from(JSON.stringify({ updated_at: last.updatedAt, name: last.name })).toString('base64url');
    }
    // Fetch relations for page entities (bounded)
    const names = page.map(e => e.name);
    let relations: Relation[] = [];
    if (names.length > 0) {
      const placeholders = names.map(() => '?').join(',');
      const relSql = `SELECT * FROM relations WHERE from_entity IN (${placeholders}) OR to_entity IN (${placeholders}) LIMIT ${capped * 2}`;
      const relParams = [...names, ...names];
      const [pr, cr] = await Promise.all([
        this.sqliteManager.executeSql(this.memoryDbName, relSql, relParams),
        this.sqliteManager.executeSql(this.centralDbPath, relSql, relParams),
      ]);
      const toRels = (r: DatabaseOperationResult<SqlExecutionData>) => r.success ? (r.data?.rows ?? []).map(row => this.rowToRelation(row)) : [];
      relations = [...toRels(pr), ...toRels(cr)];
    }
    return { entities: page, relations, nextCursor };
  }

  private async vecSearchDb(dbName: string, query: string, limit: number): Promise<Entity[]> {
    if (process.env.NODE_ENV === 'test' && !process.env.ENABLE_VECTOR_TEST) return [];
    try {
      const vec = await embedText(query);
      const vecStr = toVecString(vec);
      // vec0 KNN: embedding MATCH vecStr
      const sql = `SELECT e.* FROM entities e JOIN (SELECT rowid, distance FROM vec_entities WHERE embedding MATCH ? ORDER BY distance LIMIT ${limit}) v ON e.rowid = v.rowid`;
      const res = await this.sqliteManager.executeSql(dbName, sql, [vecStr]);
      if (!res.success || !res.data) return [];
      return (res.data.rows ?? []).map(row => this.rowToEntity(row));
    } catch (e) {
      console.warn(`vec search failed for ${dbName}:`, (e as Error).message);
      return [];
    }
  }

  private async searchRelationsBoth(query: string): Promise<Relation[]> {
    const searchTerm = `%${query.toLowerCase()}%`;
    const relationsQuery = `SELECT * FROM relations WHERE LOWER(relation_type) LIKE ? OR LOWER(from_entity) LIKE ? OR LOWER(to_entity) LIKE ?`;
    const [pr, cr] = await Promise.all([
      this.sqliteManager.executeSql(this.memoryDbName, relationsQuery, [searchTerm, searchTerm, searchTerm]),
      this.sqliteManager.executeSql(this.centralDbPath, relationsQuery, [searchTerm, searchTerm, searchTerm])
    ]);
    const toRels = (r: DatabaseOperationResult<SqlExecutionData>) => r.success ? (r.data?.rows ?? []).map(row => this.rowToRelation(row)) : [];
    return [...toRels(pr), ...toRels(cr)];
  }

  async searchNodes(query: string, limit: number = 20, mode: string = 'keyword', detailLevel: string = 'full'): Promise<SearchResult> {
    const cappedLimit = Math.min(Math.max(limit, 1), 100);
    const effMode = (mode as string) || 'keyword';
    let rawResult: SearchResult;
    if (effMode === 'vector') {
      const [p, c] = await Promise.all([this.vecSearchDb(this.memoryDbName, query, cappedLimit), this.vecSearchDb(this.centralDbPath, query, cappedLimit)]);
      const rels = await this.searchRelationsBoth(query);
      rawResult = this.mergeGraphs([{ entities: p, relations: [] }, { entities: c, relations: [] }, { entities: [], relations: rels }]);
    } else if (effMode === 'hybrid') {
      // FTS + vector RRF
      const fts = await this.searchNodes(query, cappedLimit, 'keyword', 'full');
      const vecP = await this.vecSearchDb(this.memoryDbName, query, cappedLimit);
      const vecC = await this.vecSearchDb(this.centralDbPath, query, cappedLimit);
      const vecEntities = [...vecP, ...vecC];
      // RRF k=60
      const k = 60;
      const scores = new Map<string, { e: Entity; score: number }>();
      const ftsList = fts.entities;
      ftsList.forEach((e, i) => {
        const s = 1 / (k + i + 1);
        scores.set(e.name, { e: e as Entity, score: s });
      });
      vecEntities.forEach((e, i) => {
        const s = 1 / (k + i + 1);
        const prev = scores.get(e.name);
        if (prev) prev.score += s;
        else scores.set(e.name, { e, score: s });
      });
      const ranked = [...scores.values()].sort((a, b) => b.score - a.score).slice(0, cappedLimit).map(v => v.e);
      // relations from keyword search
      rawResult = { entities: ranked, relations: fts.relations };
    } else {
      // keyword default
      const sanitizedQuery = query.replace(/[^\p{L}\p{N}_\s]/gu, ' ').trim().replace(/\s+/g, ' OR ');
      
      // Fallback to basic LIKE if query is empty after sanitization
      if (!sanitizedQuery) {
        return { entities: [], relations: [], detailLevel: detailLevel === 'compact' || detailLevel === 'summary' ? detailLevel : 'full' };
      }

      // Search entities using FTS5 BM25 ranking
      const entitiesQuery = `
        SELECT e.* 
        FROM entities e
        JOIN entities_fts fts ON e.rowid = fts.rowid
        WHERE entities_fts MATCH ?
        ORDER BY bm25(entities_fts)
        LIMIT ${cappedLimit}
      `;

      // Relations don't have FTS, keep LIKE but scoped to the sanitized terms
      const searchTerm = `%${query.toLowerCase()}%`;
      const relationsQuery = `
        SELECT * FROM relations
        WHERE LOWER(relation_type) LIKE ? OR LOWER(from_entity) LIKE ? OR LOWER(to_entity) LIKE ?
      `;

      const [projectEntities, projectRelations, centralEntities, centralRelations] = await Promise.all([
        this.sqliteManager.executeSql(this.memoryDbName, entitiesQuery, [sanitizedQuery]),
        this.sqliteManager.executeSql(this.memoryDbName, relationsQuery, [searchTerm, searchTerm, searchTerm]),
        this.sqliteManager.executeSql(this.centralDbPath, entitiesQuery, [sanitizedQuery]),
        this.sqliteManager.executeSql(this.centralDbPath, relationsQuery, [searchTerm, searchTerm, searchTerm])
      ]);

      const toEntities = (result: DatabaseOperationResult<SqlExecutionData>) =>
        result.success ? (result.data?.rows ?? []).map(row => this.rowToEntity(row)) : [];
      const toRelations = (result: DatabaseOperationResult<SqlExecutionData>) =>
        result.success ? (result.data?.rows ?? []).map(row => this.rowToRelation(row)) : [];

      rawResult = this.mergeGraphs([
        { entities: toEntities(projectEntities), relations: toRelations(projectRelations) },
        { entities: toEntities(centralEntities), relations: toRelations(centralRelations) }
      ]);
    }

    if (detailLevel === 'compact') {
      const compactEntities: CompactEntity[] = (rawResult.entities as Entity[]).map(e => ({
        name: e.name,
        entityType: e.entityType,
        observationCount: e.observations?.length ?? 0,
        preview: e.observations?.length > 0 ? e.observations[e.observations.length - 1].slice(0, 120) : undefined,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      }));
      return {
        entities: compactEntities,
        relations: rawResult.relations,
        detailLevel: 'compact',
      };
    }
    if (detailLevel === 'summary') {
      const summaryEntities: Entity[] = (rawResult.entities as Entity[]).map(e => ({
        ...e,
        observations: (e.observations ?? []).slice(-2).map(o => o.length > 200 ? o.slice(0, 197) + '...' : o),
      }));
      return {
        entities: summaryEntities,
        relations: rawResult.relations,
        detailLevel: 'summary',
      };
    }
    return {
      ...rawResult,
      detailLevel: 'full',
    };
  }

  async openNode(name: string): Promise<Entity | null> {
    const result = await this.sqliteManager.queryData(this.memoryDbName, 'entities', { name });
    if (!result.success || !result.data || result.data.rows.length === 0) {
      const centralResult = await this.sqliteManager.queryData(this.centralDbPath, 'entities', { name });
      if (!centralResult.success || !centralResult.data || centralResult.data.rows.length === 0) {
        return null;
      }
      const cRow = centralResult.data.rows[0];
      return this.rowToEntity(cRow);
    }

    const row = result.data.rows[0];
    return this.rowToEntity(row);
  }

  private safeParseObservations(json: string): string[] {
    try {
      const parsed: unknown = JSON.parse(json);
      return z.array(z.string()).parse(parsed);
    } catch {
      return [];
    }
  }

  async openNodes(names: string[]): Promise<Entity[]> {
    const entities: Entity[] = [];

    for (const name of names) {
      const entity = await this.openNode(name);
      if (entity) {
        entities.push(entity);
      }
    }

    return entities;
  }

  async getFileContext(filePath: string): Promise<FileContextResult> {
    if (!this.projectSchemaReady) await this.ensureProjectSchema();
    const cleanPath = filePath.replace(/^\.\//, '').trim();
    const candidateNames = [
      cleanPath.startsWith('file:') ? cleanPath : `file:${cleanPath}`,
      cleanPath,
    ];

    let entity: Entity | null = null;
    let foundName = candidateNames[0];

    for (const name of candidateNames) {
      entity = await this.openNode(name);
      if (entity) {
        foundName = name;
        break;
      }
    }

    const relQuery = `SELECT * FROM relations WHERE from_entity = ? OR to_entity = ?`;
    const [pRel, cRel] = await Promise.all([
      this.sqliteManager.executeSql(this.memoryDbName, relQuery, [foundName, foundName]),
      this.sqliteManager.executeSql(this.centralDbPath, relQuery, [foundName, foundName]),
    ]);

    const toRels = (r: DatabaseOperationResult<SqlExecutionData>) => r.success ? (r.data?.rows ?? []).map(row => this.rowToRelation(row)) : [];
    const allRelations: Relation[] = [...toRels(pRel), ...toRels(cRel)];
    const uniqueRelations = allRelations.filter((r, idx, arr) =>
      arr.findIndex(x => x.from === r.from && x.to === r.to && x.relationType === r.relationType) === idx
    );

    const linkedTasks = uniqueRelations
      .filter(r => r.relationType === 'implements' || r.relationType === 'modified_by')
      .map(r => r.from === foundName ? r.to : r.from);

    const linkedBugs = uniqueRelations
      .filter(r => r.relationType === 'blocks' || r.relationType === 'affects')
      .map(r => r.from === foundName ? r.to : r.from);

    const recentObservations = entity ? entity.observations.slice(-5) : [];

    return {
      filePath: cleanPath,
      entityName: foundName,
      existsInMemory: Boolean(entity),
      entity: entity ?? undefined,
      recentObservations,
      relations: uniqueRelations,
      linkedTasks: [...new Set(linkedTasks)],
      linkedBugs: [...new Set(linkedBugs)],
    };
  }

  async getTimeline(options: { since?: string; entityType?: string; limit?: number } = {}): Promise<TimelineResult> {
    if (!this.projectSchemaReady) await this.ensureProjectSchema();
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);

    let sql = 'SELECT name, entity_type, observations, created_at, updated_at FROM entities WHERE 1=1';
    const params: unknown[] = [];

    if (options.entityType) {
      sql += ' AND entity_type = ?';
      params.push(options.entityType);
    }
    if (options.since) {
      sql += ' AND updated_at >= ?';
      params.push(options.since);
    }
    sql += ' ORDER BY updated_at DESC LIMIT ?';
    params.push(limit);

    const [pRes, cRes] = await Promise.all([
      this.sqliteManager.executeSql(this.memoryDbName, sql, params),
      this.sqliteManager.executeSql(this.centralDbPath, sql, params),
    ]);

    const toRows = (r: DatabaseOperationResult<SqlExecutionData>) => r.success ? (r.data?.rows ?? []).map(row => memoryRowSchemas.entities.parse(row)) : [];
    const combinedRows = [...toRows(pRes), ...toRows(cRes)];

    const seen = new Set<string>();
    const entries: TimelineEntry[] = [];

    for (const row of combinedRows) {
      if (seen.has(row.name)) continue;
      seen.add(row.name);

      const obsList: string[] = this.safeParseObservations(row.observations);
      const recentObs = obsList.slice(-3).reverse();
      if (recentObs.length === 0) {
        entries.push({
          entityName: row.name,
          entityType: row.entity_type,
          observation: 'Entity updated',
          timestamp: row.updated_at || row.created_at,
        });
      } else {
        for (const obs of recentObs) {
          const match = obs.match(/^\[(.*?)\]/);
          const timestamp = match ? match[1] : (row.updated_at || row.created_at);
          entries.push({
            entityName: row.name,
            entityType: row.entity_type,
            observation: obs,
            timestamp,
          });
        }
      }
    }

    entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const cappedEntries = entries.slice(0, limit);

    return {
      entries: cappedEntries,
      total: cappedEntries.length,
    };
  }

  async createMission(input: CreateMissionInput, dbSelector: 'project' | 'central' = 'project'): Promise<Mission> {
    const dbTarget = dbSelector === 'central' ? this.centralDbPath : this.memoryDbName;
    await this.ensureMissionsSchema(dbTarget);

    const now = new Date().toISOString();
    const id = `msn_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 9)}`;
    const title = input.title;
    const description = input.description ?? null;
    const originAgent = input.originAgent ?? 'agent';
    const targetAgent = input.targetAgent ?? 'any';
    const priority = input.priority ?? 'normal';
    const payloadStr = input.payload !== undefined ? JSON.stringify(input.payload) : null;
    const status = 'queued';

    const insertRes = await this.sqliteManager.executeSql(
      dbTarget,
      `INSERT INTO missions (id, title, description, origin_agent, target_agent, status, priority, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, title, description, originAgent, targetAgent, status, priority, payloadStr, now, now]
    );

    if (!insertRes.success) {
      throw new Error(`Failed to create mission: ${insertRes.error}`);
    }

    return {
      id,
      title,
      description: input.description,
      originAgent,
      targetAgent,
      status,
      priority,
      payload: input.payload,
      createdAt: now,
      updatedAt: now,
    };
  }

  async listMissions(filter: ListMissionsInput = {}, dbSelector: 'project' | 'central' = 'project'): Promise<Mission[]> {
    const dbTarget = dbSelector === 'central' ? this.centralDbPath : this.memoryDbName;
    await this.ensureMissionsSchema(dbTarget);

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.id) {
      conditions.push('id = ?');
      params.push(filter.id);
    }
    if (filter.status) {
      conditions.push('status = ?');
      params.push(filter.status);
    }
    if (filter.targetAgent) {
      conditions.push('target_agent = ?');
      params.push(filter.targetAgent);
    }
    if (filter.originAgent) {
      conditions.push('origin_agent = ?');
      params.push(filter.originAgent);
    }
    if (filter.claimedBy) {
      conditions.push('claimed_by = ?');
      params.push(filter.claimedBy);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;
    params.push(limit, offset);

    const queryRes = await this.sqliteManager.executeSql(
      dbTarget,
      `SELECT * FROM missions ${whereClause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      params
    );

    if (!queryRes.success || !queryRes.data) {
      throw new Error(`Failed to list missions: ${queryRes.error}`);
    }

    return (queryRes.data.rows || []).map(row => this.mapMissionRow(row));
  }

  async updateMission(input: UpdateMissionInput, dbSelector: 'project' | 'central' = 'project'): Promise<Mission> {
    const isClaim = input.claimedBy !== undefined;
    if (isClaim && (typeof input.claimedBy !== 'string' || !input.claimedBy.trim() || input.claimedBy.trim().length > 100)) {
      throw new Error('Failed to update mission: claimedBy must be a non-empty string of at most 100 characters');
    }
    if (input.status === 'claimed' && !isClaim) {
      throw new Error('Failed to update mission: claimed status requires claimedBy');
    }
    if (isClaim && input.status !== undefined && input.status !== 'claimed' && input.status !== 'in_progress') {
      throw new Error('Failed to update mission: claims require claimed or in_progress status');
    }
    const dbTarget = dbSelector === 'central' ? this.centralDbPath : this.memoryDbName;
    await this.ensureMissionsSchema(dbTarget);

    const now = new Date().toISOString();
    const updates: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];

    if (input.status !== undefined) {
      updates.push('status = ?');
      params.push(input.status);
      if (input.status === 'completed' || input.status === 'failed' || input.status === 'cancelled') {
        updates.push('completed_at = ?');
        params.push(now);
      }
    }

    if (input.claimedBy !== undefined) {
      updates.push('claimed_by = ?');
      params.push(input.claimedBy.trim());
      updates.push('claimed_at = ?');
      params.push(now);
      if (!input.status) {
        updates.push('status = ?');
        params.push('claimed');
      }
    }

    if (input.result !== undefined) {
      updates.push('result = ?');
      params.push(JSON.stringify(input.result));
    }

    if (input.error !== undefined) {
      updates.push('error = ?');
      params.push(input.error);
    }

    params.push(input.id);

    const updateRes = await this.sqliteManager.executeSql(
      dbTarget,
      `UPDATE missions SET ${updates.join(', ')} WHERE id = ?${isClaim ? " AND status = 'queued' AND claimed_by IS NULL AND claimed_at IS NULL" : ''}`,
      params
    );

    if (!updateRes.success) {
      throw new Error(`Failed to update mission: ${updateRes.error}`);
    }

    const rows = await this.sqliteManager.executeSql(dbTarget, `SELECT * FROM missions WHERE id = ?`, [input.id]);
    if (!rows.success || !rows.data?.rows?.length) {
      throw new Error(`Mission not found: ${input.id}`);
    }
    if (isClaim && updateRes.data?.changes !== 1) {
      throw new Error(`Failed to update mission: mission is not available for claiming: ${input.id}`);
    }

    return this.mapMissionRow(rows.data.rows[0]);
  }

  private mapMissionRow(value: DatabaseRow): Mission {
    const row = z.object({
      id: z.string(), title: z.string(), description: z.string().nullable(),
      origin_agent: z.string(), target_agent: z.string(),
      status: z.enum(['queued', 'claimed', 'in_progress', 'completed', 'failed', 'cancelled']),
      priority: z.enum(['low', 'normal', 'high', 'urgent']),
      payload: z.string().nullable(), result: z.string().nullable(), error: z.string().nullable(),
      claimed_by: z.string().nullable(), claimed_at: z.string().nullable(), completed_at: z.string().nullable(),
      created_at: z.string(), updated_at: z.string(),
    }).parse(value);
    let payload: unknown = undefined;
    if (row.payload) {
      try { payload = JSON.parse(row.payload); } catch { payload = row.payload; }
    }
    let result: unknown = undefined;
    if (row.result) {
      try { result = JSON.parse(row.result); } catch { result = row.result; }
    }

    return {
      id: row.id,
      title: row.title,
      description: row.description || undefined,
      originAgent: row.origin_agent,
      targetAgent: row.target_agent,
      status: row.status,
      priority: row.priority,
      payload,
      result,
      error: row.error || undefined,
      claimedBy: row.claimed_by || undefined,
      claimedAt: row.claimed_at || undefined,
      completedAt: row.completed_at || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
