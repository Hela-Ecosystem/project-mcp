import { build } from 'esbuild';
import { spawn, ChildProcess } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { MemoryManager } from '../src/memory-manager';
import { SQLiteManager } from '../src/sqlite-manager';
import { MISSION_CLAIM_LEASE_MINUTES, UpdateMissionInput } from '../src/types';

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

  test.each(['claimed', 'in_progress'] as const)(
    'can reclaim an expired %s mission and rejects updates from the previous claimant',
    async status => {
      const memory = manager();
      const { id } = await memory.createMission({ title: 'Reclaim expired mission' });
      const claimed = await memory.updateMission({ id, claimedBy: ' worker ' });
      expect(claimed.claimedBy).toBe('worker');
      if (status === 'in_progress') await memory.updateMission({ id, status, claimedBy: 'worker' });

      for (const claimedBy of ['worker', 'other']) {
        await expect(memory.updateMission({ id, claimedBy })).rejects.toThrow('not available for claiming');
      }
      const expiredClaimedAt = await ageClaim(id);
      const transition = status === 'claimed' ? { status: 'in_progress' as const } : { status: 'failed' as const };
      await expect(memory.updateMission({ id, claimedBy: 'worker', ...transition })).rejects.toThrow('lease has expired');

      const reclaimed = await memory.updateMission({ id, claimedBy: 'other' });
      expect(reclaimed).toMatchObject({ status: 'claimed', claimedBy: 'other' });
      expect(Date.parse(reclaimed.claimedAt ?? '')).toBeGreaterThan(Date.parse(expiredClaimedAt));
      await expect(memory.updateMission({ id, status: 'in_progress', claimedBy: 'worker' })).rejects.toThrow('does not match');
      await expect(memory.updateMission({ id, status: 'in_progress', claimedBy: 'other' })).resolves.toMatchObject({
        status: 'in_progress', claimedBy: 'other', claimedAt: reclaimed.claimedAt,
      });
    },
  );

  async function ageClaim(id: string): Promise<string> {
    const expiredAt = new Date(Date.now() - MISSION_CLAIM_LEASE_MINUTES * 60_000 - 1000).toISOString();
    const update = await connections[0].executeSql('memory', 'UPDATE missions SET claimed_at = ? WHERE id = ?', [expiredAt, id]);
    expect(update).toMatchObject({ success: true, data: { changes: 1 } });
    return expiredAt;
  }

  test.each(['completed', 'failed', 'cancelled'] as const)('rejects new claims on %s missions even after the lease', async status => {
    const memory = manager();
    const { id } = await memory.createMission({ title: 'Terminal claim' });
    await memory.updateMission({ id, claimedBy: 'worker' });
    await memory.updateMission({ id, status: 'in_progress', claimedBy: 'worker' });
    await memory.updateMission({ id, status, claimedBy: 'worker', ...(status === 'completed' ? { result: {} } : {}) });
    const claimedAt = await ageClaim(id);
    await expect(memory.updateMission({ id, claimedBy: 'other' })).rejects.toThrow('not available for claiming');
    expect(await memory.listMissions({ id })).toMatchObject([{ status, claimedBy: 'worker', claimedAt }]);
  });

  test('explicit requeue repairs a legacy stuck queued mission', async () => {
    const memory = manager();
    const mission = await memory.createMission({ title: 'Recover a legacy mission', payload: { preserve: true } });
    const { id, createdAt } = mission;
    const seed = await connections[0].executeSql('memory',
      'UPDATE missions SET claimed_by = ?, claimed_at = ?, completed_at = ?, result = ?, error = ? WHERE id = ?',
      ['agent-A', createdAt, createdAt, '{"ok":true}', 'stale error', id]);
    expect(seed).toMatchObject({ success: true, data: { changes: 1 } });
    await expect(memory.updateMission({ id, claimedBy: 'agent-B' })).rejects.toThrow('not available for claiming');
    const requeued = await memory.updateMission({ id, action: 'requeue' });
    expect(requeued).toEqual({ ...mission, updatedAt: requeued.updatedAt });
    await expect(memory.updateMission({ id, claimedBy: 'agent-B' })).resolves.toMatchObject({
      status: 'claimed', claimedBy: 'agent-B',
    });
  });

  test('exactly one independent connection wins simultaneous claims on the same SQLite file', async () => {
    const creator = manager();
    await creator.createMission({ title: 'Warm database schema' });
    const workers = Array.from({ length: 8 }, () => manager());
    await Promise.all(workers.map(worker => worker.listMissions()));
    for (let round = 0; round < 5; round++) {
      const mission = await creator.createMission({ title: `Contended mission ${round}` });
      if (round % 2) {
        await creator.updateMission({ id: mission.id, claimedBy: 'expired-worker' });
        await ageClaim(mission.id);
      }
      const attempts = await Promise.allSettled(workers.map((worker, index) => worker.updateMission({
        id: mission.id,
        claimedBy: `worker-${index}`,
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
