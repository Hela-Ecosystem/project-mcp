import { build } from 'esbuild';
import { spawn, ChildProcess } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { MemoryManager } from '../src/memory-manager';
import { SQLiteManager } from '../src/sqlite-manager';
import { UpdateMissionInput } from '../src/types';

describe('Exclusive mission claims', () => {
  let root: string;
  let savedEnvironment: NodeJS.ProcessEnv;
  let connections: SQLiteManager[];
  let children: ChildProcess[];

  beforeEach(() => {
    savedEnvironment = { ...process.env };
    root = mkdtempSync(join(tmpdir(), 'guardian-mission-claims-'));
    process.env.NODE_ENV = 'test';
    process.env.GUARDIAN_CENTRAL_DB = join(root, 'central.db');
    delete process.env.HELA_GENOME_OBSIDIAN_VAULT;
    delete process.env.HELA_GENOME_OBSIDIAN_SYNC_CMD;
    delete process.env.HELA_GENOME_OBSIDIAN_PULL_CMD;
    connections = [];
    children = [];
  });

  afterEach(async () => {
    await Promise.all(children.filter(child => child.exitCode === null).map(child => new Promise<void>(resolve => {
      child.once('exit', () => resolve());
      child.kill();
    })));
    await Promise.all(connections.map(connection => connection.closeAllConnections()));
    rmSync(root, { recursive: true, force: true });
    process.env = savedEnvironment;
  });

  function manager(): MemoryManager {
    const connection = new SQLiteManager(root);
    connections.push(connection);
    return new MemoryManager(connection, root);
  }

  test.each([
    { claimedBy: '' },
    { claimedBy: ' \t ' },
    { claimedBy: null },
    { claimedBy: 123 },
    { claimedBy: 'x'.repeat(101) },
    { status: 'claimed' },
    ...['queued', 'completed', 'failed', 'cancelled'].map(status => ({ status, claimedBy: 'worker' })),
  ])('rejects invalid direct API claims: %j', async claim => {
    const memory = manager();
    const mission = await memory.createMission({ title: 'Validate claim' });
    await expect(memory.updateMission({ id: mission.id, ...claim } as UpdateMissionInput)).rejects.toThrow('Failed to update mission:');
    expect((await memory.listMissions({ id: mission.id }))[0]).toEqual(mission);
  });

  test('preserves missing mission error for claim and lifecycle updates', async () => {
    const memory = manager();
    await expect(memory.updateMission({ id: 'missing', claimedBy: 'worker' })).rejects.toThrow('Mission not found: missing');
    await expect(memory.updateMission({ id: 'missing', status: 'completed' })).rejects.toThrow('Mission not found: missing');
  });

  test('never reassigns a claim, including after completion or requeueing', async () => {
    const memory = manager();
    const mission = await memory.createMission({ title: 'Keep claim owner' });
    const claimed = await memory.updateMission({ id: mission.id, status: 'in_progress', claimedBy: ' worker ' });
    expect(claimed.claimedBy).toBe('worker');
    for (const status of ['in_progress', 'completed', 'queued'] as const) {
      const before = await memory.updateMission({ id: mission.id, status, result: { status } });
      for (const claimedBy of ['worker', 'other']) {
        await expect(memory.updateMission({ id: mission.id, claimedBy, result: { overwritten: true }, error: 'overwrite' })).rejects.toThrow('not available for claiming');
        expect((await memory.listMissions({ id: mission.id }))[0]).toEqual(before);
      }
      expect(before.claimedAt).toBe(claimed.claimedAt);
    }
  });

  test.each(['in_progress', 'completed', 'failed', 'cancelled'] as const)('rejects claims on unclaimed %s missions', async status => {
    const memory = manager();
    const mission = await memory.createMission({ title: 'Nonqueued claim' });
    const before = await memory.updateMission({ id: mission.id, status });
    await expect(memory.updateMission({ id: mission.id, claimedBy: 'worker' })).rejects.toThrow('not available for claiming');
    expect((await memory.listMissions({ id: mission.id }))[0]).toEqual(before);
  });

  test('exactly one independent connection wins simultaneous claims on the same SQLite file', async () => {
    const creator = manager();
    await creator.createMission({ title: 'Warm database schema' });
    const workers = Array.from({ length: 8 }, () => manager());
    await Promise.all(workers.map(worker => worker.listMissions()));
    for (let round = 0; round < 5; round++) {
      const mission = await creator.createMission({ title: `Contended mission ${round}` });
      const attempts = await Promise.allSettled(workers.map((worker, index) => worker.updateMission({
        id: mission.id,
        claimedBy: `worker-${index}`,
        ...(index % 2 ? { status: 'in_progress' as const } : {}),
      })));
      const winners = attempts.filter(attempt => attempt.status === 'fulfilled');
      expect(winners).toHaveLength(1);
      for (const attempt of attempts) {
        if (attempt.status === 'rejected') expect(attempt.reason.message).toContain('not available for claiming');
      }
      const stored = (await creator.listMissions({ id: mission.id }))[0];
      if (winners[0].status === 'fulfilled') expect(stored).toEqual(winners[0].value);
    }
  });

  test('exactly one separate process wins claims against the same SQLite file', async () => {
    const memory = manager();
    const mission = await memory.createMission({ title: 'Cross-process claim' });
    const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const bundled = await build({
      stdin: {
        resolveDir: projectRoot,
        contents: `
          import { SQLiteManager } from './src/sqlite-manager.ts';
          import { MemoryManager } from './src/memory-manager.ts';
          const sqlite = new SQLiteManager(process.env.CLAIM_DB_DIR);
          const memory = new MemoryManager(sqlite, process.env.CLAIM_DB_DIR);
          await memory.listMissions();
          process.send({ ready: true });
          process.once('message', async () => {
            try {
              const mission = await memory.updateMission({ id: process.env.CLAIM_ID, claimedBy: process.env.CLAIM_AGENT });
              process.send({ success: true, mission });
            } catch (error) {
              process.send({ success: false, error: error.message });
            } finally {
              await sqlite.closeAllConnections();
              process.disconnect();
            }
          });
        `,
      },
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'esm',
      write: false,
    });
    const attempts = Array.from({ length: 4 }, (_, index) => {
      const child = spawn(process.execPath, ['--input-type=module'], {
        cwd: projectRoot,
        env: { ...process.env, NODE_OPTIONS: '', CLAIM_DB_DIR: root, CLAIM_ID: mission.id, CLAIM_AGENT: `process-${index}` },
        stdio: ['pipe', 'ignore', 'pipe', 'ipc'],
      });
      child.stdin!.end(bundled.outputFiles[0].text);
      children.push(child);
      let stderr = '';
      child.stderr!.on('data', chunk => { stderr += chunk; });
      let ready!: () => void;
      let settle!: (value: any) => void;
      let failReady!: (error: Error) => void;
      let failResult!: (error: Error) => void;
      const readiness = new Promise<void>((resolve, reject) => { ready = resolve; failReady = reject; });
      const result = new Promise<any>((resolve, reject) => { settle = resolve; failResult = reject; });
      child.on('message', (message: any) => { if (message.ready) ready(); else settle(message); });
      child.once('error', error => { failReady(error); failResult(error); });
      child.once('exit', code => {
        if (code !== 0) {
          const error = new Error(`Claim worker exited ${code}: ${stderr}`);
          failReady(error);
          failResult(error);
        }
      });
      return { child, readiness, result };
    });
    const resultsPromise = Promise.all(attempts.map(attempt => attempt.result));
    await Promise.all(attempts.map(attempt => attempt.readiness));
    attempts.forEach(attempt => attempt.child.send('claim'));
    const results = await resultsPromise;
    const winners = results.filter(result => result.success);
    expect(winners).toHaveLength(1);
    for (const loser of results.filter(result => !result.success)) expect(loser.error).toContain('not available for claiming');
    expect((await memory.listMissions({ id: mission.id }))[0]).toEqual(winners[0].mission);
  }, 30000);
});
