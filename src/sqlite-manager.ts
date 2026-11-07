import sqlite3 from 'sqlite3';
import {
  existsSync, statSync, mkdirSync, openSync, closeSync,
  lstatSync, realpathSync, mkdtempSync, rmSync, readSync, chmodSync, linkSync
} from 'fs';
import { join, isAbsolute, resolve, dirname, basename } from 'path';
import { 
  DatabaseInfo, 
  TableInfo, 
  ColumnInfo, 
  IndexInfo, 
  QueryResult, 
  DatabaseOperationResult, DatabaseRow, QueryData, SqlExecutionData, TableSchema
} from './types.js';

interface SQLiteBackup {
  step(pages: number, callback: (error: Error | null, complete: boolean) => void): void;
  finish(callback: () => void): void;
}

type BackupDatabase = sqlite3.Database & {
  backup(path: string, callback: (error: Error | null) => void): SQLiteBackup;
};

export class SQLiteManager {
  private connections: Map<string, sqlite3.Database> = new Map();
  private databasesPath: string;
  private defaultDatabaseName: string = 'memory';
  private readonly MAX_CONNECTIONS = 20;

  constructor(databasesPath: string = './databases') {
    this.databasesPath = databasesPath;
    this.ensureDatabasesDirectory();
    this.initializeDefaultDatabase();
  }

  private assertSafeIdentifier(value: unknown, kind: string): string {
    if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
      throw new Error(`Invalid ${kind}`);
    }
    return value;
  }

  private assertSafeColumns(values: unknown, kind: string): void {
    if (values === undefined || values === null) return;
    if (typeof values !== 'object' || Array.isArray(values)) throw new Error(`Invalid ${kind}`);
    for (const key of Object.keys(values)) this.assertSafeIdentifier(key, kind);
  }

  private ensureDatabasesDirectory(): void {
    if (!existsSync(this.databasesPath)) {
      mkdirSync(this.databasesPath, { recursive: true });
    }
  }

  private initializeDefaultDatabase(): void {
    try {
      const dbPath = this.getDatabasePath(this.defaultDatabaseName);
      if (!existsSync(dbPath)) {
        closeSync(openSync(dbPath, 'a'));
      }
    } catch (error) {
      console.error('Failed to initialize default database:', error);
    }
  }

  async switchDatabasesPath(newPath: string): Promise<void> {
    await this.closeAllConnections();
    this.databasesPath = newPath;
    this.ensureDatabasesDirectory();
    this.initializeDefaultDatabase();
  }

  getDatabasesPath(): string {
    return this.databasesPath;
  }

  private getDatabasePath(name: string): string {
    if (isAbsolute(name)) return name;
    return join(this.databasesPath, `${name}.db`);
  }

  private async getConnection(name: string): Promise<sqlite3.Database> {
    if (this.connections.has(name)) {
      return this.connections.get(name)!;
    }
    if (this.connections.size >= this.MAX_CONNECTIONS) {
      for (const [key] of this.connections) {
        if (key !== this.defaultDatabaseName) {
          await this.closeConnection(key);
          break;
        }
      }
    }
    const dbPath = this.getDatabasePath(name);
    const db = new sqlite3.Database(dbPath);
    this.connections.set(name, db);
    // Performance: WAL + NORMAL + 64MB cache + 64MB journal cap + memory temp
    try {
      await this.runQuery(db, 'PRAGMA journal_mode=WAL');
      await this.runQuery(db, 'PRAGMA synchronous=NORMAL');
      await this.runQuery(db, 'PRAGMA cache_size=-64000');
      await this.runQuery(db, 'PRAGMA journal_size_limit=67108864');
      await this.runQuery(db, 'PRAGMA temp_store=MEMORY');
      await this.runQuery(db, 'PRAGMA busy_timeout=5000');
    } catch (error) {
      console.warn('SQLite performance pragmas failed:', error);
    }
    // Vector extension — best-effort, for vec0 KNN (Jest's import.meta.resolve fails, so use createRequire fallback)
    try {
      const { createRequire } = await import('module');
      const require = createRequire(import.meta.url);
      const plat = process.platform;
      const arc = process.arch;
      const ext = plat === 'win32' ? 'dll' : plat === 'darwin' ? 'dylib' : 'so';
      const pkgName = `sqlite-vec-${plat === 'win32' ? 'windows' : plat}-${arc}`;
      const loadablePath = require.resolve(`${pkgName}/vec0.${ext}`);
      await new Promise<void>((resolve, reject) => {
        db.loadExtension(loadablePath, error => error ? reject(error) : resolve());
      });
    } catch {
      // fallback to package's loader (may fail in Jest due to import.meta.resolve)
      try {
        const vec = await import('sqlite-vec');
        await new Promise<void>((resolve, reject) => {
          db.loadExtension(vec.getLoadablePath(), error => error ? reject(error) : resolve());
        });
      } catch (e2) {
        console.warn('[vec] load failed for', name, (e2 as Error).message);
      }
    }
    return db;
  }

  async createDatabase(name: string): Promise<DatabaseOperationResult<{ name: string; path: string }>> {
    try {
      const startTime = Date.now();
      const dbPath = this.getDatabasePath(name);
      
      if (existsSync(dbPath)) {
        return {
          success: false,
          message: `Database '${name}' already exists`,
          error: 'Database already exists'
        };
      }

      const db = new sqlite3.Database(dbPath);
      await new Promise<void>((resolve, reject) => {
        db.close((err) => (err ? reject(err) : resolve()));
      });

      const executionTime = Date.now() - startTime;
      return {
        success: true,
        message: `Database '${name}' created successfully`,
        data: { name, path: dbPath },
        executionTime
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to create database '${name}'`,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  async listDatabases(): Promise<DatabaseOperationResult<DatabaseInfo[]>> {
    try {
      const startTime = Date.now();
      const databases: DatabaseInfo[] = [];

      if (existsSync(this.databasesPath)) {
        const { readdirSync } = await import('fs');
        const files = readdirSync(this.databasesPath);
        
        for (const file of files) {
          if (file.endsWith('.db')) {
            const name = file.replace('.db', '');
            const path = join(this.databasesPath, file);
            const stats = statSync(path);
            
            databases.push({
              name,
              type: 'sqlite',
              path,
              size: stats.size,
              createdAt: stats.birthtime.toISOString(),
              modifiedAt: stats.mtime.toISOString()
            });
          }
        }
      }

      const executionTime = Date.now() - startTime;
      return {
        success: true,
        message: `Found ${databases.length} databases`,
        data: databases,
        executionTime
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to list databases',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  async dropDatabase(name: string): Promise<DatabaseOperationResult> {
    try {
      const startTime = Date.now();
      const dbPath = this.getDatabasePath(name);
      
      if (!existsSync(dbPath)) {
        return {
          success: false,
          message: `Database '${name}' does not exist`,
          error: 'Database not found'
        };
      }

      await this.closeConnection(name);
      const { unlinkSync } = await import('fs');
      unlinkSync(dbPath);
      
      const executionTime = Date.now() - startTime;
      return {
        success: true,
        message: `Database '${name}' dropped successfully`,
        executionTime
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to drop database '${name}'`,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  async createTable(
    database: string, 
    tableName: string, 
    schema: TableSchema
  ): Promise<DatabaseOperationResult> {
    try {
      const startTime = Date.now();
      const db = await this.getConnection(database);
      
      // Build CREATE TABLE SQL
      let sql = `CREATE TABLE IF NOT EXISTS ${tableName} (`;
      const columns: string[] = [];
      
      for (const column of schema.columns) {
        let columnDef = `${column.name} ${column.type}`;
        
        if (column.constraints) {
          columnDef += ' ' + column.constraints.join(' ');
        }
        
        if (column.defaultValue) {
          columnDef += ` DEFAULT ${column.defaultValue}`;
        }
        
        columns.push(columnDef);
      }
      
      sql += columns.join(', ');
      
      if (schema.primaryKey && schema.primaryKey.length > 0) {
        sql += `, PRIMARY KEY (${schema.primaryKey.join(', ')})`;
      }
      
      sql += ')';
      
      await this.runQuery(db, sql);
      
      // Create indexes if specified
      if (schema.indexes) {
        for (const index of schema.indexes) {
          const indexSql = `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${index.name} ON ${tableName} (${index.columns.join(', ')})`;
          await this.runQuery(db, indexSql);
        }
      }
      
      const executionTime = Date.now() - startTime;
      return {
        success: true,
        message: `Table '${tableName}' created successfully`,
        executionTime
      };
    } catch (error) {
      console.error(`Failed to create table '${tableName}':`, error);
      return {
        success: false,
        message: `Failed to create table '${tableName}'`,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  async listTables(database: string): Promise<DatabaseOperationResult<string[]>> {
    try {
      const startTime = Date.now();
      const db = await this.getConnection(database);
      
      const result = await this.query<{ name: string }>(db, `
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `);
      
      const tables = result.rows.map(row => row.name);
      const executionTime = Date.now() - startTime;
      
      return {
        success: true,
        message: `Found ${tables.length} tables`,
        data: tables,
        executionTime
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to list tables',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  async describeTable(database: string, tableName: string): Promise<DatabaseOperationResult<TableInfo>> {
    try {
      const startTime = Date.now();
      const db = await this.getConnection(database);
      const table = this.assertSafeIdentifier(tableName, 'table name');
      
      // Get table schema
      const schemaResult = await this.query<{ name: string; type: string; notnull: number; dflt_value: string | null }>(db, `PRAGMA table_info(${table})`);
      
      const columns: ColumnInfo[] = schemaResult.rows.map(row => ({
        name: row.name,
        type: row.type,
        nullable: row.notnull === 0,
        defaultValue: row.dflt_value ?? undefined,
        constraints: []
      }));
      
      // Get indexes
      const indexesResult = await this.query<{ name: string; unique: number; type?: string }>(db, `PRAGMA index_list(${table})`);
      const indexes: IndexInfo[] = [];
      
      for (const indexRow of indexesResult.rows) {
        const indexColumnsResult = await this.query<{ name: string }>(db, `PRAGMA index_info(${indexRow.name})`);
        indexes.push({
          name: indexRow.name,
          columns: indexColumnsResult.rows.map(col => col.name),
          unique: indexRow.unique === 1,
          type: indexRow.type || 'btree'
        });
      }
      
      // Get row count
      const countResult = await this.query<{ count: number }>(db, `SELECT COUNT(*) as count FROM ${table}`);
      const rowCount = countResult.rows[0].count;
      
      const tableInfo: TableInfo = {
        name: tableName,
        columns,
        indexes,
        rowCount,
        size: 0 // SQLite doesn't provide table size easily
      };
      
      const executionTime = Date.now() - startTime;
      return {
        success: true,
        message: `Table '${tableName}' described successfully`,
        data: tableInfo,
        executionTime
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to describe table '${tableName}'`,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  async dropTable(database: string, tableName: string): Promise<DatabaseOperationResult> {
    try {
      const startTime = Date.now();
      const db = await this.getConnection(database);
      const table = this.assertSafeIdentifier(tableName, 'table name');
      
      await this.runQuery(db, `DROP TABLE IF EXISTS ${table}`);
      
      const executionTime = Date.now() - startTime;
      return {
        success: true,
        message: `Table '${tableName}' dropped successfully`,
        executionTime
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to drop table '${tableName}'`,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  async insertData(database: string, tableName: string, records: DatabaseRow[]): Promise<DatabaseOperationResult<{ insertedCount: number }>> {
    try {
      const startTime = Date.now();
      const db = await this.getConnection(database);
      const table = this.assertSafeIdentifier(tableName, 'table name');
      
      if (records.length === 0) {
        return {
          success: false,
          message: 'No records to insert',
          error: 'Empty records array'
        };
      }
      
      const columns = Object.keys(records[0]);
      for (const column of columns) this.assertSafeIdentifier(column, 'column name');
      const placeholders = columns.map(() => '?').join(', ');
      const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;
      
      let insertedCount = 0;
      const useTransaction = records.length > 1;
      if (useTransaction) await this.runQuery(db, 'BEGIN TRANSACTION');
      try {
        for (const record of records) {
          const values = columns.map(col => record[col]);
          await this.runQuery(db, sql, values);
          insertedCount++;
        }
        if (useTransaction) await this.runQuery(db, 'COMMIT');
      } catch (e) {
        if (useTransaction) try { await this.runQuery(db, 'ROLLBACK'); } catch (rollbackError) {
          console.warn('SQLite rollback failed:', rollbackError);
        }
        throw e;
      }
      
      const executionTime = Date.now() - startTime;
      return {
        success: true,
        message: `${insertedCount} records inserted successfully`,
        data: { insertedCount },
        executionTime
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to insert data',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  async queryData(
    database: string, 
    tableName: string, 
    conditions?: DatabaseRow,
    limit?: number, 
    offset?: number,
    orderBy?: string,
    orderDirection?: string
  ): Promise<DatabaseOperationResult<QueryData>> {
    try {
      const startTime = Date.now();
      const db = await this.getConnection(database);
      const table = this.assertSafeIdentifier(tableName, 'table name');
      this.assertSafeColumns(conditions, 'condition column');
      
      let sql = `SELECT * FROM ${table}`;
      const params: unknown[] = [];
      
      if (conditions && Object.keys(conditions).length > 0) {
        const whereClause = Object.keys(conditions).map(key => `${key} = ?`).join(' AND ');
        sql += ` WHERE ${whereClause}`;
        params.push(...Object.values(conditions));
      }
      
      if (orderBy) {
        const column = this.assertSafeIdentifier(orderBy, 'order column');
        const dir = orderDirection === 'DESC' ? 'DESC' : 'ASC';
        sql += ` ORDER BY ${column} ${dir}`;
      }
      
      if (limit !== undefined) {
        if (!Number.isInteger(limit) || limit < 0) throw new Error('Invalid limit');
        sql += ` LIMIT ${limit}`;
        if (offset !== undefined) {
          if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid offset');
          sql += ` OFFSET ${offset}`;
        }
      }
      
      const result = await this.query(db, sql, params);
      const executionTime = Date.now() - startTime;
      
      return {
        success: true,
        message: `Query executed successfully`,
        data: {
          columns: result.columns,
          rows: result.rows,
          rowCount: result.rowCount
        },
        executionTime
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to query data',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  async updateData(database: string, tableName: string, conditions: DatabaseRow, updates: DatabaseRow): Promise<DatabaseOperationResult<{ changes: number }>> {
    try {
      const startTime = Date.now();
      const db = await this.getConnection(database);
      const table = this.assertSafeIdentifier(tableName, 'table name');
      this.assertSafeColumns(updates, 'update column');
      this.assertSafeColumns(conditions, 'condition column');
      
      const setClause = Object.keys(updates).map(key => `${key} = ?`).join(', ');
      const whereClause = Object.keys(conditions).map(key => `${key} = ?`).join(' AND ');
      
      const sql = `UPDATE ${table} SET ${setClause} WHERE ${whereClause}`;
      const params = [...Object.values(updates), ...Object.values(conditions)];
      
      const result = await this.runQuery(db, sql, params);
      const executionTime = Date.now() - startTime;
      
      return {
        success: true,
        message: `${result.changes} records updated successfully`,
        data: { changes: result.changes },
        executionTime
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to update data',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  async deleteData(database: string, tableName: string, conditions: DatabaseRow): Promise<DatabaseOperationResult<{ changes: number }>> {
    try {
      const startTime = Date.now();
      const db = await this.getConnection(database);
      const table = this.assertSafeIdentifier(tableName, 'table name');
      this.assertSafeColumns(conditions, 'condition column');
      
      const whereClause = Object.keys(conditions).map(key => `${key} = ?`).join(' AND ');
      const sql = `DELETE FROM ${table} WHERE ${whereClause}`;
      const params = Object.values(conditions);
      
      const result = await this.runQuery(db, sql, params);
      const executionTime = Date.now() - startTime;
      
      return {
        success: true,
        message: `${result.changes} records deleted successfully`,
        data: { changes: result.changes },
        executionTime
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to delete data',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  async countRecords(database: string, tableName: string, conditions?: DatabaseRow): Promise<DatabaseOperationResult<{ count: number }>> {
    try {
      const startTime = Date.now();
      const db = await this.getConnection(database);
      const table = this.assertSafeIdentifier(tableName, 'table name');
      this.assertSafeColumns(conditions, 'condition column');
      
      let sql = `SELECT COUNT(*) as count FROM ${table}`;
      const params: unknown[] = [];
      
      if (conditions) {
        const whereClause = Object.keys(conditions).map(key => `${key} = ?`).join(' AND ');
        sql += ` WHERE ${whereClause}`;
        params.push(...Object.values(conditions));
      }
      
      const result = await this.query<{ count: number }>(db, sql, params);
      const count = result.rows[0].count;
      const executionTime = Date.now() - startTime;
      
      return {
        success: true,
        message: `Count: ${count}`,
        data: { count },
        executionTime
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to count records',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  async executeSql(database: string, query: string, parameters?: unknown[]): Promise<DatabaseOperationResult<SqlExecutionData>> {
    try {
      const startTime = Date.now();
      const db = await this.getConnection(database);
      
      const firstKeyword = query.trim().split(/\s+/, 1)[0]?.toUpperCase();
      const isRowReturning = ['SELECT', 'WITH', 'PRAGMA', 'EXPLAIN', 'VALUES'].includes(firstKeyword);
      
      if (isRowReturning) {
        const result = await this.query(db, query, parameters);
        const executionTime = Date.now() - startTime;
        
        return {
          success: true,
          message: 'SQL query executed successfully',
          data: {
            columns: result.columns,
            rows: result.rows,
            rowCount: result.rowCount
          },
          executionTime
        };
      } else {
        const result = await this.runQuery(db, query, parameters);
        const executionTime = Date.now() - startTime;
        
        return {
          success: true,
          message: 'SQL query executed successfully',
          data: { changes: result.changes },
          executionTime
        };
      }
    } catch (error) {
      return {
        success: false,
        message: 'Failed to execute SQL query',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  async backupDatabase(database: string, backupPath: string): Promise<DatabaseOperationResult<{ backupPath: string }>> {
    try {
      const startTime = Date.now();
      const dbPath = this.getDatabasePath(database);
      
      if (!existsSync(dbPath)) {
        return {
          success: false,
          message: `Database '${database}' does not exist`,
          error: 'Database not found'
        };
      }
      
      await this.snapshotToNewDestination(dbPath, backupPath);
      
      const executionTime = Date.now() - startTime;
      return {
        success: true,
        message: `Database '${database}' backed up successfully`,
        data: { backupPath },
        executionTime
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to backup database',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  async restoreDatabase(backupPath: string, databaseName: string): Promise<DatabaseOperationResult<{ databaseName: string; path: string }>> {
    try {
      const startTime = Date.now();
      
      if (!existsSync(backupPath)) {
        return {
          success: false,
          message: `Backup file '${backupPath}' does not exist`,
          error: 'Backup file not found'
        };
      }
      
      const dbPath = this.getDatabasePath(databaseName);
      this.assertNewDatabaseDestination(dbPath);
      this.assertSQLiteHeader(backupPath);
      await this.snapshotToNewDestination(backupPath, dbPath);
      
      const executionTime = Date.now() - startTime;
      return {
        success: true,
        message: `Database '${databaseName}' restored successfully`,
        data: { databaseName, path: dbPath },
        executionTime
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to restore database',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  private assertNewDatabaseDestination(path: string): string {
    if (typeof path !== 'string' || !path.trim() || path.includes('\0')) {
      throw new Error('Invalid database destination');
    }
    const absolutePath = resolve(path);
    const destination = join(realpathSync(dirname(absolutePath)), basename(absolutePath));
    if (/-(wal|shm|journal)$/i.test(destination)) {
      throw new Error('SQLite sidecar paths cannot be database destinations');
    }
    for (const candidate of [destination, `${destination}-wal`, `${destination}-shm`, `${destination}-journal`]) {
      try {
        lstatSync(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      throw new Error('Destination or SQLite sidecar already exists; restoring an existing database requires an offline operator procedure');
    }
    for (const name of this.connections.keys()) {
      const connectionPath = resolve(this.getDatabasePath(name));
      const canonicalPath = join(realpathSync(dirname(connectionPath)), basename(connectionPath));
      if (canonicalPath === destination) {
        throw new Error('Destination has an active connection; use an offline operator procedure');
      }
    }
    return destination;
  }

  private assertSQLiteHeader(path: string): void {
    if (!statSync(path).isFile()) throw new Error('Backup must be a SQLite database file');
    const descriptor = openSync(path, 'r');
    try {
      const header = Buffer.alloc(16);
      if (readSync(descriptor, header, 0, header.length, 0) !== header.length ||
          !header.equals(Buffer.from('SQLite format 3\0'))) {
        throw new Error('Invalid SQLite database header');
      }
    } finally {
      closeSync(descriptor);
    }
  }

  private async openReadOnlyDatabase(path: string): Promise<sqlite3.Database> {
    return new Promise((resolve, reject) => {
      const db = new sqlite3.Database(path, sqlite3.OPEN_READONLY, error => {
        if (error) reject(error);
        else resolve(db);
      });
    });
  }

  private async closeSnapshotConnection(db: sqlite3.Database): Promise<void> {
    await new Promise<void>((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
  }

  private async snapshotToNewDestination(sourcePath: string, destinationPath: string): Promise<void> {
    const destination = this.assertNewDatabaseDestination(destinationPath);
    if (!statSync(sourcePath).isFile()) throw new Error('Source must be a SQLite database file');
    const temporaryDirectory = mkdtempSync(join(dirname(destination), '.guardian-sqlite-backup-'));
    const snapshotPath = join(temporaryDirectory, 'snapshot.db');
    try {
      const source = await this.openReadOnlyDatabase(sourcePath);
      try {
        source.configure('busyTimeout', 5000);
        await new Promise<void>((resolve, reject) => {
          const backup = (source as BackupDatabase).backup(snapshotPath, error => {
            if (error) return reject(error);
            backup.step(-1, (stepError, complete) => {
              backup.finish(() => {
                if (stepError) reject(stepError);
                else if (!complete) reject(new Error('SQLite backup did not complete'));
                else resolve();
              });
            });
          });
        });
      } finally {
        await this.closeSnapshotConnection(source);
      }

      this.assertSQLiteHeader(snapshotPath);
      const snapshot = await this.openReadOnlyDatabase(snapshotPath);
      try {
        const result = await this.query(snapshot, 'PRAGMA integrity_check');
        if (result.rows.length !== 1 || result.rows[0].integrity_check !== 'ok') {
          throw new Error('SQLite backup integrity validation failed');
        }
      } finally {
        await this.closeSnapshotConnection(snapshot);
      }
      chmodSync(snapshotPath, 0o600);
      this.assertNewDatabaseDestination(destination);
      linkSync(snapshotPath, destination);
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }

  // Helper methods
  private async query<Row extends DatabaseRow = DatabaseRow>(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<QueryResult<Row>> {
    const trimmed = sql.trim().toUpperCase();
    if (trimmed.startsWith('SELECT') && !trimmed.includes('LIMIT')) {
      sql += ' LIMIT 10000';
    }
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      
      db.all<Row>(sql, this.bindParameters(params), (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        
        const executionTime = Date.now() - startTime;
        const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
        
        resolve({
          columns,
          rows: rows || [],
          rowCount: rows ? rows.length : 0,
          executionTime
        });
      });
    });
  }

  private bindParameters(params: unknown[]): Array<string | number | Buffer | null> {
    return params.map(value => {
      if (value === null || value === undefined) return null;
      if (typeof value === 'string' || Buffer.isBuffer(value)) return value;
      if (typeof value === 'boolean') return Number(value);
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      throw new Error('SQL parameters must be finite numbers, strings, booleans, buffers or null');
    });
  }

  private async runQuery(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<sqlite3.RunResult> {
    return new Promise((resolve, reject) => {
      db.run(sql, this.bindParameters(params), function(err) {
        if (err) {
          reject(err);
          return;
        }
        resolve(this);
      });
    });
  }

  async closeConnection(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (connection) {
      return new Promise((resolve) => {
        connection.close((err) => {
          if (err) {
            console.error(`Error closing connection for ${name}:`, err);
          }
          this.connections.delete(name);
          resolve();
        });
      });
    }
  }

  async vacuumDatabase(name: string): Promise<void> {
    const db = await this.getConnection(name);
    await this.runQuery(db, 'VACUUM');
  }

  async closeAllConnections(): Promise<void> {
    const closePromises = Array.from(this.connections.keys()).map(name => this.closeConnection(name));
    await Promise.all(closePromises);
  }
}
