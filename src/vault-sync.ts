import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

type Hashes = Record<string, string | null>;
type VaultFile = { hash: string; data: string };
type Baseline = { version: 1; generation: string; files: Hashes };
type Snapshot = {
  id: string;
  files: Record<string, VaultFile>;
  state: Baseline | null;
  stateHash: string | null;
};
type Operation = { path: string; expected: string | null; data: string | null };
type Archive = { path: string; data: string };
type Command = {
  action: 'open' | 'snapshot' | 'apply' | 'close';
  token: string;
  maxBytes: number;
  peerId?: string;
  expected?: Hashes;
  operations?: Operation[];
  archives?: Archive[];
  state?: Baseline;
  stateHash?: string | null;
};

export interface VaultSyncOptions {
  remote?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Runs under both locks, after snapshots and before writes. */
  beforeApply?: (result: Readonly<VaultSyncResult>) => void | Promise<void>;
  /** Explicit repair policy; undefined leaves the conflict unresolved. Originals are archived. */
  resolveConflict?: (name: string, local: Buffer | null, peer: Buffer | null) => Buffer | undefined;
}

export interface VaultSyncResult {
  copied: number;
  deleted: number;
  conflicts: string[];
}

export class VaultSyncError extends Error {
  constructor(public readonly code: string) {
    super(`Vault sync failed: ${code}`);
    this.name = 'VaultSyncError';
  }
}

// Self-contained so the identical endpoint can run through SSH's stdin without installation.
async function vaultCommand(directory: string, command: Command): Promise<unknown> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const crypto = await import('node:crypto');
  const root = path.resolve(directory);
  const metadata = '.hela-sync';
  const hash = (data: Buffer | string): string => crypto.createHash('sha256').update(data).digest('hex');
  const fail = (code: string): never => { throw new Error(code); };
  const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
  const validPath = (name: string): boolean => name.length > 0 && !name.includes('\\') &&
    !name.includes('\0') && name.split('/').every(part => part.length > 0 && !part.startsWith('.'));
  const isId = (value: string | undefined): value is string => !!value && /^[0-9a-f-]{36}$/.test(value);

  function directoryPath(absolute: string, create = false): void {
    let current = path.parse(absolute).root;
    for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      let stat;
      try { stat = fs.lstatSync(current); }
      catch (error) {
        if (!create || !absent(error)) throw error;
        try { fs.mkdirSync(current, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        stat = fs.lstatSync(current);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_PATH');
    }
  }

  function location(relative: string, create = false): string {
    if (relative.includes('\\') || relative.includes('\0') ||
        relative.split('/').some(part => !part || part === '.' || part === '..')) fail('UNSAFE_PATH');
    const target = path.resolve(root, relative);
    if (!target.startsWith(root + path.sep)) fail('UNSAFE_PATH');
    directoryPath(path.dirname(target), create);
    return target;
  }

  function read(relative: string): Buffer | null {
    let fd: number | undefined;
    try {
      const target = location(relative);
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('UNSAFE_PATH');
      if (stat.size > command.maxBytes) fail('LIMIT_EXCEEDED');
      fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) fail('STALE_SNAPSHOT');
      const data = fs.readFileSync(fd);
      const after = fs.fstatSync(fd);
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs)
        fail('STALE_SNAPSHOT');
      if (data.length > command.maxBytes) fail('LIMIT_EXCEEDED');
      return data;
    } catch (error) {
      if (absent(error)) return null;
      throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }

  function currentHash(relative: string): string | null {
    const data = read(relative);
    return data === null ? null : hash(data);
  }

  function atomicWrite(relative: string, data: Buffer, expected: string | null): void {
    const target = location(relative, true);
    if (currentHash(relative) !== expected) fail('STALE_SNAPSHOT');
    const temporary = path.join(path.dirname(target), `.hela-write-${crypto.randomUUID()}`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      if (currentHash(relative) !== expected) fail('STALE_SNAPSHOT');
      fs.renameSync(temporary, target);
      const parent = fs.openSync(path.dirname(target), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY |
        fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch (error) { if (!absent(error)) throw error; }
    }
  }

  function archive(relative: string, data: Buffer): void {
    if (!/^\.hela-sync\/(conflicts|recovery)\/[a-f0-9]{64}\/[a-f0-9]{64}\.(bin|json)$/.test(relative))
      fail('UNSAFE_PATH');
    const existing = read(relative);
    if (existing !== null) {
      if (!existing.equals(data)) fail('INVALID_STATE');
    } else atomicWrite(relative, data, null);
  }

  function scan(): Record<string, VaultFile> {
    const files: Record<string, VaultFile> = Object.create(null);
    let bytes = 0;
    function visit(relative: string): void {
      const absolute = relative ? location(relative) : root;
      directoryPath(absolute);
      for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.')) continue;
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (!validPath(name)) fail('UNSAFE_PATH');
        if (entry.isSymbolicLink()) fail('UNSAFE_PATH');
        if (entry.isDirectory()) visit(name);
        else if (entry.isFile()) {
          const data = read(name);
          if (data === null) fail('STALE_SNAPSHOT');
          bytes += data!.length + Buffer.byteLength(name) + 128;
          if (bytes > command.maxBytes / 2 || Object.keys(files).length >= 10000) fail('LIMIT_EXCEEDED');
          files[name] = { hash: hash(data!), data: data!.toString('base64') };
        } else fail('UNSAFE_PATH');
      }
    }
    visit('');
    return files;
  }

  function parseState(data: Buffer | null): Baseline | null {
    if (data === null) return null;
    let state: Baseline;
    try { state = JSON.parse(data.toString('utf8')); } catch { return fail('INVALID_STATE'); }
    if (state?.version !== 1 || !isId(state.generation) || !state.files || typeof state.files !== 'object' ||
        Array.isArray(state.files) || Object.entries(state.files).some(([name, value]) =>
          !validPath(name) || (value !== null && (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)))))
      fail('INVALID_STATE');
    return state;
  }

  directoryPath(root);
  if (!isId(command.token)) fail('INVALID_COMMAND');
  const lock = `${metadata}/lock`;
  const owner = `${lock}/owner`;
  directoryPath(path.join(root, metadata), command.action === 'open');

  if (command.action === 'open') {
    try { fs.mkdirSync(location(lock), { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('VAULT_LOCKED');
      throw error;
    }
    try {
      atomicWrite(owner, Buffer.from(command.token), null);
      let id = read(`${metadata}/id`)?.toString('utf8');
      if (id === undefined) {
        id = crypto.randomUUID();
        atomicWrite(`${metadata}/id`, Buffer.from(id), null);
      }
      if (!isId(id)) fail('INVALID_STATE');
      return { id };
    } catch (error) {
      try { fs.unlinkSync(location(owner)); } catch { /* An incomplete lock remains fail-closed. */ }
      try { fs.rmdirSync(location(lock)); } catch { /* Never remove another owner's lock recursively. */ }
      throw error;
    }
  }

  if (read(owner)?.toString('utf8') !== command.token) fail('VAULT_LOCKED');
  if (command.action === 'close') {
    fs.unlinkSync(location(owner));
    fs.rmdirSync(location(lock));
    return null;
  }
  if (!isId(command.peerId)) fail('INVALID_COMMAND');
  const statePath = `${metadata}/state/${command.peerId}.json`;
  const stateData = read(statePath);
  if (command.action === 'snapshot') {
    return {
      id: read(`${metadata}/id`)!.toString('utf8'), files: scan(), state: parseState(stateData),
      stateHash: stateData === null ? null : hash(stateData),
    } satisfies Snapshot;
  }

  const files = scan();
  const expected = command.expected!;
  if (!expected || Object.keys(files).length !== Object.keys(expected).length ||
      Object.entries(files).some(([name, file]) => expected[name] !== file.hash) ||
      (stateData === null ? null : hash(stateData)) !== command.stateHash) fail('STALE_SNAPSHOT');
  parseState(Buffer.from(JSON.stringify(command.state)));
  for (const operation of command.operations ?? []) {
    if (!validPath(operation.path)) fail('UNSAFE_PATH');
    if (currentHash(operation.path) !== operation.expected) fail('STALE_SNAPSHOT');
    if (operation.data !== null && Buffer.byteLength(operation.data, 'base64') > command.maxBytes)
      fail('LIMIT_EXCEEDED');
  }
  for (const item of command.archives ?? []) archive(item.path, Buffer.from(item.data, 'base64'));
  const finalHashes: Hashes = { ...expected };
  for (const operation of command.operations ?? []) {
    const original = read(operation.path);
    if ((original === null ? null : hash(original)) !== operation.expected) fail('STALE_SNAPSHOT');
    if (original !== null) {
      const key = hash(operation.path);
      archive(`${metadata}/recovery/${key}/${hash(original)}.bin`, original);
      const record = Buffer.from(JSON.stringify({ path: operation.path, hash: hash(original) }));
      archive(`${metadata}/recovery/${key}/${hash(record)}.json`, record);
    }
    if (operation.data === null) {
      if (currentHash(operation.path) !== operation.expected) fail('STALE_SNAPSHOT');
      if (operation.expected !== null) fs.unlinkSync(location(operation.path));
      delete finalHashes[operation.path];
    } else {
      const data = Buffer.from(operation.data, 'base64');
      atomicWrite(operation.path, data, operation.expected);
      finalHashes[operation.path] = hash(data);
    }
  }
  const finalFiles = scan();
  if (Object.keys(finalFiles).length !== Object.keys(finalHashes).length ||
      Object.entries(finalFiles).some(([name, file]) => finalHashes[name] !== file.hash)) fail('STALE_SNAPSHOT');
  const nextState = Buffer.from(JSON.stringify(command.state));
  if (currentHash(statePath) !== hash(nextState)) atomicWrite(statePath, nextState, command.stateHash ?? null);
  return null;
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^(UNSAFE_PATH|STALE_SNAPSHOT|LIMIT_EXCEEDED|INVALID_STATE|INVALID_COMMAND|VAULT_LOCKED)$/.test(message)
    ? message : 'VAULT_UNAVAILABLE';
}

function sshCommand(remote: string, directory: string, command: Command, timeoutMs: number): Promise<unknown> {
  const script = `(${vaultCommand.toString()})(${JSON.stringify(directory)},${JSON.stringify(command)})` +
    `.then(result=>process.stdout.write(JSON.stringify({ok:true,result})))` +
    `.catch(error=>{const code=/^[A-Z_]+$/.test(error.message)?error.message:'VAULT_UNAVAILABLE';` +
    `process.stdout.write(JSON.stringify({ok:false,code}));process.exitCode=1;});`;
  if (Buffer.byteLength(script) > command.maxBytes) throw new VaultSyncError('LIMIT_EXCEEDED');
  return new Promise((resolveResult, reject) => {
    const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', '--', remote,
      'node --input-type=module -'], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let output = '';
    let bytes = 0;
    let failure: string | undefined;
    const stop = (code: string): void => { failure ??= code; child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('SSH_TIMEOUT'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > command.maxBytes) stop('LIMIT_EXCEEDED');
      else output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > command.maxBytes) stop('LIMIT_EXCEEDED');
    });
    child.stdin.on('error', () => stop('SSH_FAILED'));
    child.on('error', () => { failure ??= 'SSH_FAILED'; });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) return reject(new VaultSyncError(failure));
      try {
        const response = JSON.parse(output);
        if (code !== 0 || response.ok !== true) {
          const allowed = errorCode(new Error(response.code));
          return reject(new VaultSyncError(response.ok === false ? allowed : 'SSH_FAILED'));
        }
        resolveResult(response.result);
      } catch { reject(new VaultSyncError('SSH_FAILED')); }
    });
    child.stdin.end(script);
  });
}

const digest = (data: string): string => createHash('sha256').update(data).digest('hex');
const hashes = (snapshot: Snapshot): Hashes => Object.fromEntries(
  Object.entries(snapshot.files).map(([name, file]) => [name, file.hash]));

/** Reconcile regular, non-hidden vault files. Conflicts are archived, never chosen automatically. */
export async function syncVaults(localDir: string, peerDir: string, options: VaultSyncOptions = {}): Promise<VaultSyncResult> {
  const timeoutMs = options.timeoutMs ?? 30000;
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  if (![localDir, peerDir].every(value => typeof value === 'string' && value.length > 0 && !value.includes('\0')) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000 ||
      !Number.isInteger(maxBytes) || maxBytes < 16384 || maxBytes > 64 * 1024 * 1024 ||
      (options.resolveConflict !== undefined && typeof options.resolveConflict !== 'function') ||
      (options.remote !== undefined && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(options.remote)))
    throw new VaultSyncError('INVALID_ARGUMENT');
  const local = resolve(localDir);
  const peer = options.remote ? peerDir : resolve(peerDir);
  if (!options.remote && (local === peer || local.startsWith(peer + sep) || peer.startsWith(local + sep)))
    throw new VaultSyncError('OVERLAPPING_VAULTS');
  const token = randomUUID();
  const common = { token, maxBytes };
  const runLocal = (command: Command): Promise<unknown> => vaultCommand(local, command);
  const runPeer = (command: Command): Promise<unknown> => options.remote
    ? sshCommand(options.remote, peer, command, timeoutMs) : vaultCommand(peer, command);
  let localOpened = false;
  let peerAttempted = false;
  let failure: unknown;
  let result: VaultSyncResult | undefined;
  try {
    const localIdentity = await runLocal({ ...common, action: 'open' }) as { id: string };
    localOpened = true;
    peerAttempted = true;
    const peerIdentity = await runPeer({ ...common, action: 'open' }) as { id: string };
    if (localIdentity.id === peerIdentity.id) throw new VaultSyncError('DUPLICATE_VAULT_ID');
    const left = await runLocal({ ...common, action: 'snapshot', peerId: peerIdentity.id }) as Snapshot;
    const right = await runPeer({ ...common, action: 'snapshot', peerId: localIdentity.id }) as Snapshot;
    if (left.id !== localIdentity.id || right.id !== peerIdentity.id) throw new VaultSyncError('STALE_SNAPSHOT');
    const baseline: Hashes = left.state && right.state && left.state.generation === right.state.generation &&
      JSON.stringify(left.state.files) === JSON.stringify(right.state.files) ? left.state.files : Object.create(null);
    const next: Hashes = { ...baseline };
    const localOps: Operation[] = [];
    const peerOps: Operation[] = [];
    const archives: Archive[] = [];
    result = { copied: 0, deleted: 0, conflicts: [] };
    const names = [...new Set([...Object.keys(left.files), ...Object.keys(right.files), ...Object.keys(baseline)])].sort();
    for (const name of names) {
      const a = left.files[name]?.hash ?? null;
      const b = right.files[name]?.hash ?? null;
      const base = baseline[name];
      if (a === b) { next[name] = a; continue; }
      let destination: Operation[] | undefined;
      let source: VaultFile | undefined;
      let expected: string | null = null;
      if (base !== undefined && a === base) {
        destination = localOps; source = right.files[name]; expected = a;
      } else if (base !== undefined && b === base) {
        destination = peerOps; source = left.files[name]; expected = b;
      } else if (base === undefined && (a === null || b === null)) {
        destination = a === null ? localOps : peerOps;
        source = a === null ? right.files[name] : left.files[name];
      }
      if (destination) {
        destination.push({ path: name, expected, data: source?.data ?? null });
        next[name] = source?.hash ?? null;
        if (source) result.copied++; else result.deleted++;
      } else {
        const versions = [a, b].sort();
        const key = digest(JSON.stringify([name, versions]));
        const record = JSON.stringify({ path: name, hashes: versions, deletion: a === null || b === null });
        archives.push({ path: `.hela-sync/conflicts/${key}/${digest(record)}.json`, data: Buffer.from(record).toString('base64') });
        for (const file of [left.files[name], right.files[name]]) if (file)
          archives.push({ path: `.hela-sync/conflicts/${key}/${file.hash}.bin`, data: file.data });
        const resolved = options.resolveConflict?.(name,
          left.files[name] ? Buffer.from(left.files[name].data, 'base64') : null,
          right.files[name] ? Buffer.from(right.files[name].data, 'base64') : null);
        if (resolved !== undefined) {
          if (!Buffer.isBuffer(resolved)) throw new VaultSyncError('INVALID_ARGUMENT');
          if (resolved.length > maxBytes) throw new VaultSyncError('LIMIT_EXCEEDED');
          const mergedHash = createHash('sha256').update(resolved).digest('hex');
          for (const [operations, expected] of [[localOps, a], [peerOps, b]] as const) {
            if (expected !== mergedHash) {
              operations.push({ path: name, expected, data: resolved.toString('base64') });
              result.copied++;
            }
          }
          next[name] = mergedHash;
        } else result.conflicts.push(name);
      }
    }
    const unchanged = left.state && right.state && left.state.generation === right.state.generation &&
      JSON.stringify(left.state.files) === JSON.stringify(next) && JSON.stringify(right.state.files) === JSON.stringify(next);
    const state: Baseline = { version: 1, generation: unchanged ? left.state!.generation : randomUUID(), files: next };
    await options.beforeApply?.(Object.freeze({ ...result, conflicts: [...result.conflicts] }));
    await runLocal({ ...common, action: 'apply', peerId: right.id, expected: hashes(left),
      operations: localOps, archives, state, stateHash: left.stateHash });
    await runPeer({ ...common, action: 'apply', peerId: left.id, expected: hashes(right),
      operations: peerOps, archives, state, stateHash: right.stateHash });
  } catch (error) { failure = error; }
  finally {
    if (peerAttempted) {
      try { await runPeer({ ...common, action: 'close' }); }
      catch (error) { failure ??= error; }
    }
    if (localOpened) {
      try { await runLocal({ ...common, action: 'close' }); }
      catch (error) { failure ??= error; }
    }
  }
  if (failure) throw failure instanceof VaultSyncError ? failure : new VaultSyncError(errorCode(failure));
  return result!;
}

async function main(): Promise<void> {
  const values: Record<string, string> = Object.create(null);
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!['--vault', '--peer', '--remote'].includes(flag) || !value || value.startsWith('--') || values[flag])
      throw new VaultSyncError('INVALID_ARGUMENT');
    values[flag] = value;
  }
  if (!values['--vault'] || !values['--peer']) throw new VaultSyncError('INVALID_ARGUMENT');
  const report = await syncVaults(values['--vault'], values['--peer'], { remote: values['--remote'] });
  console.log(JSON.stringify({ copied: report.copied, deleted: report.deleted, conflicts: report.conflicts.length }));
  if (report.conflicts.length) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof VaultSyncError ? error.message : 'Vault sync failed: VAULT_UNAVAILABLE');
    process.exitCode = 1;
  });
}
