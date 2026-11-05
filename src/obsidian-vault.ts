import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { createHash, randomUUID } from 'crypto';

export interface VaultEntityNote {
  name: string;
  entityType: string;
  observations: string[];
  createdAt?: string;
  updatedAt?: string;
  mirrorHash?: string;
}

export function uniqueObservations(observations: string[]): string[] {
  return [...new Set(observations.map(value => value.trim()).filter(Boolean))];
}

export function observationHash(entity: Pick<VaultEntityNote, 'entityType' | 'observations'>): string {
  return createHash('sha256').update(JSON.stringify([entity.entityType, uniqueObservations(entity.observations)])).digest('hex');
}

/**
 * Optional Obsidian vault mirror for HeLa Genome.
 *
 * Enabled by HELA_GENOME_OBSIDIAN_VAULT. When set, entity writes are mirrored
 * as Markdown notes with YAML frontmatter into the vault, so humans can browse
 * and edit project memory in Obsidian while SQLite stays the query engine.
 *
 * Best-effort: never throws into the calling memory operation.
 */

export class ObsidianVaultMirror {
  private vaultPath: string | null;
  private syncCmd: string | null;
  private pullCmd: string | null;

  constructor() {
    const v = process.env.HELA_GENOME_OBSIDIAN_VAULT;
    this.vaultPath = v && v.trim() ? v.trim() : null;
    this.syncCmd = process.env.HELA_GENOME_OBSIDIAN_SYNC_CMD?.trim() || null;
    this.pullCmd = process.env.HELA_GENOME_OBSIDIAN_PULL_CMD?.trim() || null;
    if (this.vaultPath) {
      try { fs.mkdirSync(this.vaultPath, { recursive: true }); } catch (e) { console.error('vault mkdir failed', e); }
    }
  }

  private syncTimer: NodeJS.Timeout | null = null;
  private pendingSync: Promise<void> = Promise.resolve();

  private runCmd(cmd: string, label: string): Promise<void> {
    if (/\brsync\b/.test(cmd) && /--delete\b/.test(cmd)) {
      return Promise.reject(new Error('Destructive rsync vault hooks are unsupported; use vault-sync.js'));
    }
    return new Promise((resolve, reject) => {
      exec(cmd, { timeout: 60000, maxBuffer: 1024 * 1024 }, (err) => {
        if (err) reject(new Error(`Obsidian ${label} hook failed (${err.code || 'process error'})`));
        else resolve();
      });
    });
  }

  private enqueueSync(cmd: string, label: string): Promise<void> {
    const sync = this.pendingSync.catch(() => {}).then(() => this.runCmd(cmd, label));
    this.pendingSync = sync;
    return sync;
  }

  async pullSync(): Promise<void> {
    if (this.vaultPath && this.pullCmd) await this.enqueueSync(this.pullCmd, 'pull');
  }

  /** Debounced remote sync — collapses rapid writes into one push. */
  private triggerSync(): void {
    if (!this.syncCmd) return;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      this.enqueueSync(this.syncCmd!, 'sync').catch(error => console.error(error.message));
    }, 5000);
    this.syncTimer.unref();
  }

  /** Immediate sync (used for backfill completion and shutdown). */
  async flushSync(): Promise<void> {
    if (!this.vaultPath) return;
    if (this.syncTimer) { clearTimeout(this.syncTimer); this.syncTimer = null; }
    if (this.syncCmd) await this.enqueueSync(this.syncCmd, 'sync');
    else await this.pendingSync;
  }

  isEnabled(): boolean {
    return this.vaultPath !== null;
  }

  getVaultPath(): string | null {
    return this.vaultPath;
  }

  listNotes(): string[] {
    if (!this.vaultPath) return [];
    const out: string[] = [];
    const walk = (dir: string, rel: string) => {
      let entries: string[];
      entries = fs.readdirSync(dir);
      for (const e of entries) {
        if (e.startsWith('.')) continue;
        const full = path.join(dir, e);
        const r = rel ? `${rel}/${e}` : e;
        const st = fs.lstatSync(full);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) walk(full, r);
        else if (st.isFile() && e.endsWith('.md')) out.push(r);
      }
    };
    walk(this.vaultPath, '');
    return out;
  }

  readNote(filename: string): string | null {
    if (!this.vaultPath) return null;
    const resolved = path.resolve(this.vaultPath, filename);
    if (!resolved.startsWith(path.resolve(this.vaultPath) + path.sep)) return null;
    try {
      if (fs.lstatSync(resolved).isSymbolicLink()) return null;
      return fs.readFileSync(resolved, 'utf8');
    } catch {
      return null;
    }
  }

  /** Parse a vault note into { name, entityType, observations } or null. */
  parseNote(content: string): VaultEntityNote | null {
    content = content.replace(/\r\n/g, '\n');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
    if (!fmMatch) return null;
    const fm = fmMatch[1];
    const nameMatch = fm.match(/^name:\s*(.+)$/m);
    const typeMatch = fm.match(/^type:\s*(.+)$/m);
    if (!nameMatch) return null;
    let name: string;
    let entityType: string;
    try { name = JSON.parse(nameMatch[1].trim()); } catch { name = nameMatch[1].trim().replace(/^"|"$/g, ''); }
    try { entityType = typeMatch ? JSON.parse(typeMatch[1].trim()) : 'concept'; } catch { entityType = typeMatch ? typeMatch[1].trim().replace(/^"|"$/g, '') : 'concept'; }
    if (typeof name !== 'string' || !name.trim() || typeof entityType !== 'string' || !entityType.trim()) return null;
    const body = content.slice(fmMatch[0].length);
    if (!/^##\s+Observations\s*$/mi.test(body)) return null;
    const observations: string[] = [];
    const relationBullets = new Set<string>();
    let section = '';
    for (const line of body.split('\n')) {
      const heading = line.match(/^##\s+(.+?)\s*$/);
      if (heading) { section = heading[1].toLowerCase(); continue; }
      const m = line.match(/^- (.+)$/);
      if (section === 'relations' && m) relationBullets.add(m[1].trim());
      if (section !== 'observations') continue;
      if (m) observations.push(m[1].trim());
      else if (/^  /.test(line) && observations.length) observations[observations.length - 1] += '\n' + line.slice(2);
    }
    return {
      name, entityType,
      observations: uniqueObservations(observations.filter(value => !relationBullets.has(value))),
      createdAt: fm.match(/^created:\s*(.+)$/m)?.[1].trim(),
      updatedAt: fm.match(/^updated:\s*(.+)$/m)?.[1].trim(),
      mirrorHash: fm.match(/^mirror_hash:\s*([a-f0-9]{64})$/m)?.[1],
    };
  }

  parseRelation(content: string): { from: string; to: string; relationType: string; createdAt: string } | null {
    const frontmatter = content.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n/)?.[1];
    if (!frontmatter) return null;
    const value = (key: string): string | null => {
      const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
      if (!match) return null;
      try {
        const parsed = JSON.parse(match[1]);
        return typeof parsed === 'string' && parsed.trim() ? parsed : null;
      } catch { return null; }
    };
    const from = value('from');
    const to = value('to');
    const relationType = value('relation');
    const createdAt = frontmatter.match(/^created:\s*(.+)$/m)?.[1].trim();
    return from && to && relationType && createdAt && !isNaN(Date.parse(createdAt))
      ? { from, to, relationType, createdAt } : null;
  }

  private archive(filename: string, content: string): void {
    if (!this.vaultPath) return;
    const hash = createHash('sha256').update(content).digest('hex');
    const directory = path.join(this.vaultPath, '.hela-conflicts', hash);
    fs.mkdirSync(directory, { recursive: true });
    try {
      fs.writeFileSync(path.join(directory, path.basename(filename)), content, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  private atomicWrite(filePath: string, content: string, expected: string | null): void {
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
      const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
      if (current !== expected) throw new Error('Vault note changed before publication');
      fs.renameSync(temporary, filePath);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  private safeName(name: string): string {
    let s = (name || '').replace(/[/\\:*?"<>|]/g, '_').trim().replace(/\.+$/, '');
    if (!s) s = 'entity';
    return s.slice(0, 120);
  }

  syncEntity(entity: { name: string; entityType: string; observations: string[]; createdAt: string; updatedAt: string }, relations?: Array<{ from: string; to: string; relationType: string }>, acceptEdits = false, filename?: string): void {
    if (!this.vaultPath) return;
    // Skip junk/test entities
    const n = (entity.name || '').trim().toLowerCase();
    if (!n) return;
    if (n.startsWith('debug:') || n.startsWith('test_') || n.startsWith('test-')) return;
    if (n.startsWith('perf_run_') || n.startsWith('perf-run-') || n.startsWith('perf run') || n.startsWith('perf_warm_')) return;
    if (/^[a-z]{1,3}_-?\d+/.test(n)) return;
    if (entity.observations.length === 1 && entity.observations[0].trim().toLowerCase() === 'perf') return;
    if (n.includes('test') && (n.includes('entity') || n.includes('write') || n.includes('vault'))) return;
    try {
      let filePath = path.resolve(this.vaultPath, filename || `${this.safeName(entity.name)}.md`);
      if (!filePath.startsWith(path.resolve(this.vaultPath) + path.sep)) throw new Error('Invalid vault filename');
      if (fs.existsSync(filePath)) {
        const owner = this.parseNote(fs.readFileSync(filePath, 'utf8'));
        if (!owner || owner.name !== entity.name) {
          const suffix = createHash('sha256').update(entity.name).digest('hex').slice(0, 12);
          filePath = path.join(this.vaultPath, `${this.safeName(entity.name)}-${suffix}.md`);
        }
      }
      const frontmatter = [
        '---',
        `name: ${JSON.stringify(entity.name)}`,
        `type: ${JSON.stringify(entity.entityType)}`,
        `created: ${entity.createdAt}`,
        `updated: ${entity.updatedAt}`,
        `source: hela-genome`,
        `mirror_hash: ${observationHash(entity)}`,
        '---',
        '',
      ].join('\n');
      const outgoing = (relations || []).filter((r) => r.from === entity.name);
      const incoming = (relations || []).filter((r) => r.to === entity.name);
      const body = [
        `# ${entity.name}`,
        '',
        `**Type:** ${entity.entityType}`,
        '',
        '## Observations',
        '',
        ...(entity.observations.length ? uniqueObservations(entity.observations).map((o) => `- ${o.replace(/\n/g, '\n  ')}`) : ['_(none)_']),
        '',
        '## Relations',
        '',
        ...new Set(outgoing.map((r) => `- [[${r.to}]] — ${r.relationType}`)),
        ...new Set(incoming.map((r) => `- [[${r.from}]] — ${r.relationType} (incoming)`)),
        ...((outgoing.length || incoming.length) ? [] : ['_(none)_']),
        '',
      ].join('\n');
      const content = frontmatter + body;
      let previous: string | null = null;
      if (fs.existsSync(filePath)) {
        previous = fs.readFileSync(filePath, 'utf8');
        if (previous === content) return;
        const parsed = this.parseNote(previous);
        const storedHash = previous.match(/^mirror_hash:\s*([a-f0-9]{64})$/m)?.[1];
        const edited = !parsed || (storedHash ? storedHash !== observationHash(parsed) : observationHash(parsed) !== observationHash(entity));
        if (edited && !acceptEdits) {
          this.archive(path.basename(filePath), content);
          return;
        }
        this.archive(path.basename(filePath), previous);
      }
      this.atomicWrite(filePath, content, previous);
      this.triggerSync();
    } catch (e) {
      console.error('[obsidian] note write failed:', (e as NodeJS.ErrnoException).code || 'invalid note');
    }
  }

  removeEntity(name: string): void {
    if (!this.vaultPath) return;
    try {
      for (const filename of this.listNotes()) {
        const content = this.readNote(filename);
        const relation = content === null ? null : this.parseRelation(content);
        if (content !== null && (this.parseNote(content)?.name === name || relation?.from === name || relation?.to === name)) {
          this.archive(filename, content);
          fs.unlinkSync(path.join(this.vaultPath, filename));
        }
      }
      this.triggerSync();
    } catch (e) {
      void e;
    }
  }

  removeRelation(from: string, to: string, relationType: string): void {
    if (!this.vaultPath) return;
    for (const filename of this.listNotes()) {
      const content = this.readNote(filename);
      const relation = content === null ? null : this.parseRelation(content);
      if (content !== null && relation?.from === from && relation.to === to && relation.relationType === relationType) {
        this.archive(filename, content);
        fs.unlinkSync(path.join(this.vaultPath, filename));
        this.triggerSync();
      }
    }
  }

  syncRelation(relation: { from: string; to: string; relationType: string; createdAt: string }): void {
    if (!this.vaultPath) return;
    try {
      const filePath = path.join(this.vaultPath, `${this.safeName(relation.from)}__${this.safeName(relation.relationType)}__${this.safeName(relation.to)}.md`);
      const content = [
        '---',
        `from: ${JSON.stringify(relation.from)}`,
        `to: ${JSON.stringify(relation.to)}`,
        `relation: ${JSON.stringify(relation.relationType)}`,
        `created: ${relation.createdAt}`,
        `source: hela-genome`,
        '---',
        '',
        `# ${relation.from} → ${relation.to}`,
        '',
        `Relation: **${relation.relationType}**`,
        '',
      ].join('\n');
      const previous = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
      if (previous === content) return;
      if (previous !== null) this.archive(path.basename(filePath), previous);
      this.atomicWrite(filePath, content, previous);
      this.triggerSync();
    } catch (e) {
      void e;
    }
  }
}
