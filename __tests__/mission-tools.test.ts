import { SQLiteManager } from '../src/sqlite-manager';
import { MemoryManager } from '../src/memory-manager';
import { RequestHandlers } from '../src/handlers/request-handlers';
import { ImportExportManager } from '../src/import-export';
import { PromptHandlers } from '../src/prompts/prompt-handlers';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { z } from 'zod';

describe('Fleet Mission Ledger Tools', () => {
  let sqliteManager: SQLiteManager;
  let memoryManager: MemoryManager;
  let requestHandlers: RequestHandlers;
  let testDbPath: string;
  let savedEnvironment: NodeJS.ProcessEnv;

  beforeEach(async () => {
    savedEnvironment = { ...process.env };
    testDbPath = mkdtempSync(join(tmpdir(), 'guardian-mission-tools-'));
    process.env.NODE_ENV = 'test';
    process.env.GUARDIAN_CENTRAL_DB = join(testDbPath, 'central.db');
    delete process.env.HELA_GENOME_OBSIDIAN_VAULT;
    delete process.env.HELA_GENOME_OBSIDIAN_SYNC_CMD;
    delete process.env.HELA_GENOME_OBSIDIAN_PULL_CMD;
    sqliteManager = new SQLiteManager(testDbPath);
    memoryManager = new MemoryManager(sqliteManager, testDbPath);
    const importExport = new ImportExportManager(sqliteManager);
    const promptHandlers = new PromptHandlers();
    requestHandlers = new RequestHandlers(sqliteManager, memoryManager, importExport, promptHandlers);

    await memoryManager.initializeMemoryDatabase();
  });

  afterEach(async () => {
    await sqliteManager.closeAllConnections();
    rmSync(testDbPath, { recursive: true, force: true });
    process.env = savedEnvironment;
  });

  describe('MemoryManager Mission Operations', () => {
    test('should create a mission with defaults', async () => {
      const mission = await memoryManager.createMission({
        title: 'Deploy shared-caddy updates',
      });

      expect(mission.id).toMatch(/^msn_/);
      expect(mission.title).toBe('Deploy shared-caddy updates');
      expect(mission.status).toBe('queued');
      expect(mission.originAgent).toBe('agent');
      expect(mission.targetAgent).toBe('any');
      expect(mission.priority).toBe('normal');
      expect(mission.createdAt).toBeDefined();
    });

    test('should create and list missions with filters', async () => {
      await memoryManager.createMission({
        title: 'Desktop PipeWire sync',
        originAgent: 'mema',
        targetAgent: 'frea',
        priority: 'high',
        payload: { audioSink: 'easyeffects_sink' },
      });

      await memoryManager.createMission({
        title: 'Postgres VACUUM run',
        originAgent: 'orchestrator',
        targetAgent: 'mema',
        priority: 'normal',
      });

      const freaMissions = await memoryManager.listMissions({ targetAgent: 'frea' });
      expect(freaMissions.length).toBe(1);
      expect(freaMissions[0].title).toBe('Desktop PipeWire sync');
      expect(freaMissions[0].payload).toEqual({ audioSink: 'easyeffects_sink' });

      const memaMissions = await memoryManager.listMissions({ targetAgent: 'mema' });
      expect(memaMissions.length).toBe(1);
      expect(memaMissions[0].title).toBe('Postgres VACUUM run');
    });

    test('should update mission lifecycle (claim -> start -> complete)', async () => {
      const mission = await memoryManager.createMission({
        title: 'Build BitMusic package',
        targetAgent: 'frea',
      });

      const claimed = await memoryManager.updateMission({
        id: mission.id,
        claimedBy: 'frea',
      });

      expect(claimed.status).toBe('claimed');
      expect(claimed.claimedBy).toBe('frea');
      expect(claimed.claimedAt).toBeDefined();

      await expect(memoryManager.updateMission({
        id: mission.id, claimedBy: 'frea', status: 'in_progress',
      })).resolves.toMatchObject({ status: 'in_progress', claimedAt: claimed.claimedAt });
      const completed = await memoryManager.updateMission({
        id: mission.id,
        status: 'completed',
        claimedBy: 'frea',
        result: { deb: 'bitmusic_1.8.30frea8_amd64.deb', exitCode: 0 },
      });

      expect(completed.status).toBe('completed');
      expect(completed.completedAt).toBeDefined();
      expect(completed.result).toEqual({ deb: 'bitmusic_1.8.30frea8_amd64.deb', exitCode: 0 });
    });

    test('should handle mission failure with error', async () => {
      const mission = await memoryManager.createMission({
        title: 'Run CVE scan',
      });

      await memoryManager.updateMission({ id: mission.id, claimedBy: 'frea' });
      await memoryManager.updateMission({ id: mission.id, status: 'in_progress', claimedBy: 'frea' });
      const failed = await memoryManager.updateMission({
        id: mission.id,
        status: 'failed',
        claimedBy: 'frea',
        error: 'Container daemon unreachable',
      });

      expect(failed.status).toBe('failed');
      expect(failed.error).toBe('Container daemon unreachable');
      expect(failed.completedAt).toBeDefined();
    });

    test.each(['queued', 'claimed', 'in_progress', 'completed', 'failed', 'cancelled'] as const)(
      'can cancel a %s mission',
      async status => {
        const { id } = await memoryManager.createMission({ title: 'Cancel mission' });
        const claimedBy = 'agent-A';
        if (status !== 'queued' && status !== 'cancelled') {
          await memoryManager.updateMission({ id, claimedBy });
          if (status !== 'claimed') await memoryManager.updateMission({ id, status: 'in_progress', claimedBy });
          if (status === 'completed' || status === 'failed') {
            await memoryManager.updateMission({ id, status, claimedBy, result: { ok: status === 'completed' } });
          }
        }
        if (status === 'cancelled') await memoryManager.updateMission({ id, status: 'cancelled' });
        expect(await memoryManager.listMissions({ id })).toMatchObject([{ status }]);

        const update = (agent?: string) => requestHandlers.handleToolCall('update_mission', {
          id, status: 'cancelled', claimedBy: agent,
        });
        const active = status === 'claimed' || status === 'in_progress';
        if (active) {
          await expect(update()).rejects.toThrow('requires claimedBy');
          await expect(update('agent-B')).rejects.toThrow('does not match');
        }
        await expect(update(active ? claimedBy : undefined)).resolves.toMatchObject({
          data: { status: 'cancelled', completedAt: expect.any(String) },
        });
      },
    );
  });

  describe('RequestHandlers Tool Calls', () => {
    test('rejects the issue #39 sequence without leaving a stuck queued mission', async () => {
      const { id } = await memoryManager.createMission({ title: 'Issue #39' });
      const update = (args: Record<string, unknown>) => requestHandlers.handleToolCall('update_mission', { id, ...args });

      await expect(update({ claimedBy: 'agent-A', status: 'claimed' })).resolves.toMatchObject({
        data: { status: 'claimed', claimedBy: 'agent-A' },
      });
      await expect(update({ claimedBy: 'agent-B', status: 'claimed' })).rejects.toThrow('not available for claiming');
      await expect(update({ status: 'completed', result: { ok: true } })).rejects.toThrow('claimedBy');
      await expect(update({ status: 'queued' })).rejects.toThrow('requeue');
      await expect(update({ claimedBy: 'agent-B', status: 'claimed' })).rejects.toThrow('not available for claiming');
      await expect(update({ status: 'completed', claimedBy: 'agent-A', result: { ok: true } })).rejects.toThrow('cannot transition');

      const [stored] = await memoryManager.listMissions({ id });
      expect(stored).toMatchObject({ status: 'claimed', claimedBy: 'agent-A' });
      expect(stored.completedAt).toBeUndefined();
      expect(stored.result).toBeUndefined();
    });

    test('only the current claimant may finish an in-progress mission', async () => {
      const { id } = await memoryManager.createMission({ title: 'Check finish ownership' });
      const update = (args: Record<string, unknown>) => requestHandlers.handleToolCall('update_mission', { id, ...args });
      await update({ claimedBy: 'agent-A' });
      await update({ status: 'in_progress', claimedBy: 'agent-A' });

      await expect(update({ status: 'completed', claimedBy: 'agent-B', result: { ok: true } })).rejects.toThrow('does not match');
      await expect(update({ status: 'failed', claimedBy: 'agent-B', error: 'wrong agent' })).rejects.toThrow('does not match');
      await expect(update({ status: 'completed', claimedBy: 'agent-A' })).rejects.toThrow('requires a result');
      await expect(update({ status: 'completed', claimedBy: 'agent-A', result: null })).rejects.toThrow('requires a result');
      expect(await memoryManager.listMissions({ id })).toMatchObject([{ status: 'in_progress', claimedBy: 'agent-A' }]);

      await expect(update({ status: 'completed', claimedBy: 'agent-A', result: { ok: true } })).resolves.toMatchObject({
        data: { status: 'completed', claimedBy: 'agent-A', result: { ok: true } },
      });
      await expect(update({ status: 'queued' })).rejects.toThrow('requeue');
      expect(await memoryManager.listMissions({ id })).toMatchObject([{ status: 'completed', claimedBy: 'agent-A' }]);

      await expect(update({ action: 'requeue' })).resolves.toMatchObject({ data: { status: 'queued' } });
      const [queued] = await memoryManager.listMissions({ id });
      expect(queued.claimedBy).toBeUndefined();
      expect(queued.claimedAt).toBeUndefined();
      expect(queued.completedAt).toBeUndefined();
      expect(queued.result).toBeUndefined();
      await expect(update({ claimedBy: 'agent-B' })).resolves.toMatchObject({
        data: { status: 'claimed', claimedBy: 'agent-B' },
      });
    });

    test('create_mission and list_missions via handleToolCall', async () => {
      const createRes = await requestHandlers.handleToolCall('create_mission', {
        title: 'Global orchestrator test',
        originAgent: 'system',
        targetAgent: 'worker-1',
        priority: 'urgent',
        payload: { task: 'verify-fleet' },
      });

      expect(createRes).toMatchObject({ success: true, data: { title: 'Global orchestrator test' } });

      const listRes = await requestHandlers.handleToolCall('list_missions', {
        targetAgent: 'worker-1',
      });

      expect(listRes).toMatchObject({ success: true, data: [expect.objectContaining({ priority: 'urgent' })] });
    });

    test('update_mission via handleToolCall', async () => {
      const createRes = await requestHandlers.handleToolCall('create_mission', {
        title: 'Test mission for update',
      });
      const { id } = z.object({ data: z.object({ id: z.string() }) }).parse(createRes).data;
      await requestHandlers.handleToolCall('update_mission', { id, claimedBy: 'agent-alpha' });

      const updateRes = await requestHandlers.handleToolCall('update_mission', {
        id,
        status: 'in_progress',
        claimedBy: 'agent-alpha',
      });

      expect(updateRes).toMatchObject({ success: true, data: { status: 'in_progress', claimedBy: 'agent-alpha' } });
    });

    test.each([
      { claimedBy: '' },
      { claimedBy: '   ' },
      { claimedBy: null },
      { claimedBy: 'x'.repeat(101) },
      { status: 'claimed' },
      { status: 'completed', claimedBy: 'agent-alpha' },
      { status: 'failed' },
      { status: 'in_progress', claimedBy: 'agent-alpha' },
      { status: 'claimed', claimedBy: 'agent-alpha', result: {} },
      { action: 'requeue', status: 'cancelled' },
    ])('rejects invalid claims via tool validation: %j', async (claim) => {
      const mission = await memoryManager.createMission({ title: 'Invalid claim test' });
      await expect(requestHandlers.handleToolCall('update_mission', { id: mission.id, ...claim })).rejects.toThrow('Tool execution failed:');
      expect((await memoryManager.listMissions({ id: mission.id }))[0]).toMatchObject({ status: 'queued' });
    });

    test('returns a tool error when a mission is already claimed', async () => {
      const mission = await memoryManager.createMission({ title: 'Exclusive tool claim' });
      const first = await requestHandlers.handleToolCall('update_mission', { id: mission.id, claimedBy: 'first' });
      expect(first).toHaveProperty('success', true);
      await expect(requestHandlers.handleToolCall('update_mission', { id: mission.id, claimedBy: 'second' })).rejects.toThrow('not available for claiming');
      expect((await memoryManager.listMissions({ id: mission.id }))[0].claimedBy).toBe('first');
    });

    test('backward compatibility: entities and relations still work flawlessly', async () => {
      const createEntityRes = await requestHandlers.handleToolCall('create_entity', {
        entities: [
          { name: 'CoreService', entityType: 'service', observations: ['Runs HTTP gateway'] }
        ]
      });
      expect(createEntityRes).toHaveProperty('success', true);

      const graphRes = await requestHandlers.handleToolCall('read_graph', {});
      expect(graphRes).toMatchObject({ success: true, data: { entities: expect.arrayContaining([expect.objectContaining({ name: 'CoreService' })]) } });
    });
  });
});
