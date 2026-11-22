import { execFile } from 'child_process';
import { promisify } from 'util';
import { readdir, readFile, stat } from 'fs/promises';
import { basename, join, relative } from 'path';
import { createClient, RedisClientType } from 'redis';
import { Buffer } from 'buffer';
import { MemoryManager } from '../memory-manager.js';
import { SQLiteManager } from '../sqlite-manager.js';
import {
  AnalyzeGitChangesInput, CacheDeleteInput, CacheGetInput, CacheScanInput, CacheSetInput,
  GetSessionContextInput, InspectUntrustedTextInput, ScanContainerImageInput, ScanProjectSecretsInput,
} from '../types.js';
import { PathGuard } from './path-guard.js';
import { SECRET_PATTERNS as SHARED_SECRET_PATTERNS } from '../session-bridge/redact.js';

const execFileAsync = promisify(execFile);
const MAX_SECRET_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Line-scannable view of the shared redaction table (project-mcp#40), plus the
 * credential shapes that were already scanner-only. Global flags are stripped
 * so `.test()` on each line stays stateless; the multi-line private-key block
 * is replaced by its header so a single line still matches.
 */
const withoutGlobalFlag = (pattern: RegExp): RegExp =>
  new RegExp(pattern.source, pattern.flags.replace('g', ''));

export const SECRET_SCAN_PATTERNS: Array<[string, RegExp]> = [
  ...SHARED_SECRET_PATTERNS
    .filter(({ name }) => name !== 'private_key')
    .map(({ name, pattern }) => [name, withoutGlobalFlag(pattern)] as [string, RegExp]),
  ['private_key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/],
  ['google_api_key', /AIza[0-9A-Za-z_-]{35}/],
  ['slack_webhook', /https:\/\/hooks\.slack\.com\/services\/T[a-zA-Z0-9_]{8}\/B[a-zA-Z0-9_]{8}\/[a-zA-Z0-9_]{24}/],
];

/**
 * SQLite keeps its WAL locking in `-shm`, and POSIX releases *every* lock the
 * process holds on an inode when any descriptor for it is closed. Reading a live
 * database (or its sidecars) from this process therefore unlocks it, lets the
 * next opener checkpoint and delete the WAL, and turns later writes into writes
 * to unlinked files (project-mcp#36). No walker may open these paths.
 */
const SQLITE_ARTIFACT_RE = /(?:\.db|\.sqlite|\.sqlite3)(?:-(?:wal|shm|journal))?$|\.db-(?:wal|shm|journal)$/i;

export function isSqliteArtifact(fileName: string): boolean {
  return SQLITE_ARTIFACT_RE.test(fileName) || SQLITE_ARTIFACT_RE.test(fileName.split(/[\\/]/).pop() ?? '');
}
const INJECTION_PATTERNS: Array<[string, RegExp]> = [
  ['instruction_override', /\b(?:ignore|disregard|forget)\s+(?:(?:all|any)\s+)?(?:previous|prior|above|earlier|system)\s+(?:instructions?|messages?|rules?|prompts?)\b/i],
  ['system_override', /\b(?:system\s+override|administrative\s+access|disable\s+(?:all\s+)?(?:filters?|safety|guardrails?))\b/i],
  ['persona_override', /\b(?:you\s+are\s+now|adopt\s+the\s+persona|act\s+as\s+(?:a|an))\b/i],
  ['role_mimicry', /(?:\[\s*(?:system|admin)(?:\s+message)?\s*\]|#{1,6}\s*system\b|\b(?:assistant|system)\s*:)/i],
  ['hidden_content', /(?:display\s*:\s*none|font-size\s*:\s*0|visibility\s*:\s*hidden|color\s*:\s*transparent)/i],
  ['remote_exfiltration', /(?:!\[[^\]]*\]\(https?:\/\/|<img\b[^>]*\bsrc\s*=\s*["']?https?:\/\/)/i],
];

/** Git's magic empty tree; the base for a root commit or a one-commit repo. */
export const GIT_EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export class RuntimeCapabilities {
  private redis?: RedisClientType;

  constructor(
    private memoryManager: MemoryManager,
    private sqliteManager: SQLiteManager,
    private pathGuard: PathGuard,
    private redisUrl = process.env.REDIS_URL
  ) {}

  setWorkspaceRoot(root: string): void {
    this.pathGuard = new PathGuard(root);
  }

  async getSessionContext(input: GetSessionContextInput) {
    const graph = await this.memoryManager.readGraph({ scope: input.scope ?? 'project' });
    const entities = graph.entities
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const activeTasks = entities.filter(e => e.entityType === 'task' && !this.isClosed(e.observations, ['[COMPLETE]', '[DONE]'], ['[REOPEN]', '[IN PROGRESS]']));
    const openBugs = entities.filter(e => e.entityType === 'bug' && !this.isClosed(e.observations, ['[FIX]', '[RESOLVED]'], ['[REOPEN]', '[REGRESSION]']));
    const blockers = graph.relations.filter(r => r.relationType === 'blocks');
    return {
      stats: { entities: graph.entities.length, relations: graph.relations.length },
      activeTasks: activeTasks.slice(0, input.limit),
      openBugs: openBugs.slice(0, input.limit),
      recentChanges: entities.slice(0, input.limit),
      blockers: blockers.slice(0, input.limit),
      suggestedNext: blockers.length ? `Resolve ${blockers.length} blocker(s)` : activeTasks[0]?.name ?? null,
    };
  }

  async analyzeGitChanges(input: AnalyzeGitChangesInput) {
    const target = input.commit ?? undefined;
    let base: string;
    if (target) base = `${target}^`;
    else if (/^\d+$/.test(input.since)) base = `HEAD~${input.since}`;
    else base = await this.git(['rev-list', '-1', `--before=${input.since}`, 'HEAD']);
    if (!base) throw new Error(`No commit found before ${input.since}`);
    // A one-commit repo has no HEAD~1 (and the root commit has no parent):
    // diff the empty tree instead of failing, so committed and untracked
    // files are still reported (project-mcp#40).
    if (!(await this.revExists(base))) base = GIT_EMPTY_TREE;
    let output: string;
    try {
      output = await this.git(['diff', '--name-status', '-z', base, ...(target ? [target] : [])]);
    } catch (error) {
      if (!target) throw error;
      output = await this.git(['diff', '--name-status', '-z', GIT_EMPTY_TREE, target]);
    }
    const files = this.parseNameStatus(output);
    if (input.includeUntracked && !input.commit) {
      const untracked = (await this.git(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
      for (const path of untracked) files.push({ path, status: '??' });
    }
    const deduplicated = [...new Map(files.map(file => [file.path, file])).values()];
    return { files: deduplicated.slice(0, input.maxFiles), totalFiles: deduplicated.length, truncated: deduplicated.length > input.maxFiles };
  }

  inspectUntrustedText(input: InspectUntrustedTextInput) {
    const decoded = input.text.replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value))).normalize('NFKC');
    const hidden = [...decoded].some(char => /\p{Cf}/u.test(char));
    const normalizedText = [...decoded].filter(char => !/\p{Cf}/u.test(char) && (char === '\n' || char === '\r' || char === '\t' || !/\p{Cc}/u.test(char))).join('');
    const compact = normalizedText.replace(/\s+/g, ' ');
    const alerts = INJECTION_PATTERNS.filter(([, pattern]) => pattern.test(compact)).map(([name]) => name);
    if (hidden) alerts.unshift('hidden_format_characters');
    for (const token of compact.match(/[A-Za-z0-9_+/=-]{16,}/g) ?? []) {
      try {
        const decodedToken = Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        if (/\b(?:ignore|disregard|system|override|assistant|password|secret|token|forget)\b/i.test(decodedToken)) {
          alerts.push('encoded_instruction_like_content');
          break;
        }
      } catch { /* Invalid base64 is not an indicator. */ }
    }
    return { suspicious: alerts.length > 0, alerts: [...new Set(alerts)], normalizedText, warning: 'Detection is heuristic; normalized text remains untrusted data.' };
  }

  async scanProjectSecrets(input: ScanProjectSecretsInput) {
    const target = this.pathGuard.resolveExistingPath(input.path);
    const findings: Array<{ type: string; file: string; line: number }> = [];
    const errors: string[] = [];
    const excludes = new Set(['.git', 'node_modules', 'venv', '.venv', '__pycache__', ...input.exclude]);
    const files = await this.collectFiles(target, excludes, errors);
    let truncated = false;
    for (const file of files) {
      if (findings.length >= input.maxFindings) { truncated = true; break; }
      try {
        if ((await stat(file)).size > MAX_SECRET_FILE_BYTES) continue;
        const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
        lines.forEach((line, index) => {
          if (findings.length >= input.maxFindings) { truncated = true; return; }
          for (const [type, pattern] of SECRET_SCAN_PATTERNS) {
            if (pattern.test(line)) findings.push({ type, file: this.pathGuard.toRelativePath(file), line: index + 1 });
          }
        });
      } catch { errors.push(`Unable to scan ${this.pathGuard.toRelativePath(file)}`); }
    }
    return { findings, errors: errors.slice(0, 100), complete: errors.length === 0 && !truncated, truncated };
  }

  async scanContainerImage(input: ScanContainerImageInput) {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync('trivy', ['image', '--format', 'json', '--quiet', '--scanners', 'vuln', '--severity', 'HIGH,CRITICAL', '--', input.image], { timeout: 120000, maxBuffer: 8 * 1024 * 1024 }));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new Error(code === 'ENOENT' ? 'Trivy is not installed' : 'Trivy scan failed or timed out');
    }
    const report = JSON.parse(stdout) as { Results?: Array<{ Target?: string; Vulnerabilities?: Array<Record<string, unknown>> }> };
    const findings = (report.Results ?? []).flatMap(result => (result.Vulnerabilities ?? []).map(vulnerability => ({
      target: result.Target ?? input.image,
      id: String(vulnerability.VulnerabilityID ?? ''),
      package: String(vulnerability.PkgName ?? ''),
      installedVersion: String(vulnerability.InstalledVersion ?? ''),
      fixedVersion: String(vulnerability.FixedVersion ?? ''),
      severity: String(vulnerability.Severity ?? ''),
      title: String(vulnerability.Title ?? ''),
    })));
    return { findings: findings.slice(0, input.maxFindings), totalFindings: findings.length, truncated: findings.length > input.maxFindings };
  }

  async cacheGet(input: CacheGetInput) { return { key: input.key, value: await this.withTimeout((await this.redisClient()).get(input.key)) }; }
  async cacheSet(input: CacheSetInput) { await this.withTimeout((await this.redisClient()).set(input.key, input.value, input.ttlSeconds ? { EX: input.ttlSeconds } : undefined)); return { key: input.key, stored: true }; }
  async cacheDelete(input: CacheDeleteInput) { return { key: input.key, deleted: await this.withTimeout((await this.redisClient()).del(input.key)) }; }
  async cacheScan(input: CacheScanInput) {
    const result = await this.withTimeout((await this.redisClient()).scan(input.cursor, { MATCH: input.pattern, COUNT: input.count }));
    return { keys: result.keys, nextCursor: result.cursor, complete: result.cursor === 0 };
  }

  async close(): Promise<void> { if (this.redis?.isOpen) await this.redis.quit(); }

  private isClosed(observations: string[], closed: string[], reopened: string[]): boolean {
    for (const observation of observations.slice().reverse()) {
      const upper = observation.toUpperCase();
      if (reopened.some(marker => upper.includes(marker))) return false;
      if (closed.some(marker => upper.includes(marker))) return true;
    }
    return false;
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd: this.pathGuard.getRoot(), timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  }

  private async revExists(rev: string): Promise<boolean> {
    try {
      await execFileAsync('git', ['rev-parse', '--verify', '--quiet', rev], { cwd: this.pathGuard.getRoot(), timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  private parseNameStatus(output: string): Array<{ path: string; status: string; oldPath?: string }> {
    const records = output.split('\0');
    const files = [];
    for (let i = 0; records[i];) {
      const status = records[i++];
      if (status.startsWith('R') || status.startsWith('C')) files.push({ status, oldPath: records[i++], path: records[i++] });
      else files.push({ status, path: records[i++] });
    }
    return files;
  }

  private async collectFiles(path: string, excludes: Set<string>, errors: string[]): Promise<string[]> {
    const info = await stat(path);
    if (info.isFile()) return isSqliteArtifact(path) ? [] : [path];
    const files: string[] = [];
    try {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || excludes.has(entry.name)) continue;
        // Never open a live SQLite database or its WAL/SHM sidecars (project-mcp#36).
        if (entry.isFile() && isSqliteArtifact(entry.name)) continue;
        const child = join(path, entry.name);
        if (entry.isDirectory()) files.push(...await this.collectFiles(child, excludes, errors));
        else if (entry.isFile()) files.push(child);
      }
    } catch { errors.push(`Unable to scan ${relative(this.pathGuard.getRoot(), path) || basename(path)}`); }
    return files;
  }

  private async redisClient(): Promise<RedisClientType> {
    if (!this.redisUrl) throw new Error('Redis cache unavailable: REDIS_URL is not configured');
    if (!this.redis) this.redis = createClient({ url: this.redisUrl, socket: { connectTimeout: 2000, reconnectStrategy: false }, disableOfflineQueue: true });
    if (!this.redis.isOpen) {
      this.redis.on('error', () => undefined);
      try { await this.redis.connect(); } catch { throw new Error('Redis cache unavailable'); }
    }
    return this.redis;
  }

  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Redis command timed out')), 3000);
    });
    try { return await Promise.race([operation, timeout]); }
    finally { clearTimeout(timer!); }
  }
}
