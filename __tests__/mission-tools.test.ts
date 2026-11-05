import { SQLiteManager } from '../src/sqlite-manager';
import { MemoryManager } from '../src/memory-manager';
import { RequestHandlers } from '../src/handlers/request-handlers';
import { ImportExportManager } from '../src/import-export';
import { PromptHandlers } from '../src/prompts/prompt-handlers';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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

    test('should update mission lifecycle (claim -> complete)', async () => {
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

      const completed = await memoryManager.updateMission({
        id: mission.id,
        status: 'completed',
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

      const failed = await memoryManager.updateMission({
        id: mission.id,
        status: 'failed',
        error: 'Container daemon unreachable',
      });

      expect(failed.status).toBe('failed');
      expect(failed.error).toBe('Container daemon unreachable');
      expect(failed.completedAt).toBeDefined();
    });
  });

  describe('RequestHandlers Tool Calls', () => {
    test('create_mission and list_missions via handleToolCall', async () => {
      const createRes = await requestHandlers.handleToolCall('create_mission', {
        title: 'Global orchestrator test',
        originAgent: 'system',
        targetAgent: 'worker-1',
        priority: 'urgent',
        payload: { task: 'verify-fleet' },
      });

      expect(createRes.success).toBe(true);
      expect(createRes.data.title).toBe('Global orchestrator test');

      const listRes = await requestHandlers.handleToolCall('list_missions', {
        targetAgent: 'worker-1',
      });

      expect(listRes.success).toBe(true);
      expect(listRes.data.length).toBe(1);
      expect(listRes.data[0].priority).toBe('urgent');
    });

    test('update_mission via handleToolCall', async () => {
      const createRes = await requestHandlers.handleToolCall('create_mission', {
        title: 'Test mission for update',
      });

      const updateRes = await requestHandlers.handleToolCall('update_mission', {
        id: createRes.data.id,
        status: 'in_progress',
        claimedBy: 'agent-alpha',
      });

      expect(updateRes.success).toBe(true);
      expect(updateRes.data.status).toBe('in_progress');
      expect(updateRes.data.claimedBy).toBe('agent-alpha');
    });

    test.each([
      { claimedBy: '' },
      { claimedBy: '   ' },
      { claimedBy: null },
      { claimedBy: 'x'.repeat(101) },
      { status: 'claimed' },
      { status: 'completed', claimedBy: 'agent-alpha' },
    ])('rejects invalid claims via tool validation: %j', async (claim) => {
      const mission = await memoryManager.createMission({ title: 'Invalid claim test' });
      await expect(requestHandlers.handleToolCall('update_mission', { id: mission.id, ...claim })).rejects.toThrow('Tool execution failed:');
      expect((await memoryManager.listMissions({ id: mission.id }))[0]).toMatchObject({ status: 'queued' });
    });

    test('returns a tool error when a mission is already claimed', async () => {
      const mission = await memoryManager.createMission({ title: 'Exclusive tool claim' });
      const first = await requestHandlers.handleToolCall('update_mission', { id: mission.id, claimedBy: 'first' });
      expect(first.success).toBe(true);
      await expect(requestHandlers.handleToolCall('update_mission', { id: mission.id, claimedBy: 'second' })).rejects.toThrow('not available for claiming');
      expect((await memoryManager.listMissions({ id: mission.id }))[0].claimedBy).toBe('first');
    });

    test('backward compatibility: entities and relations still work flawlessly', async () => {
      const createEntityRes = await requestHandlers.handleToolCall('create_entity', {
        entities: [
          { name: 'CoreService', entityType: 'service', observations: ['Runs HTTP gateway'] }
        ]
      });
      expect(createEntityRes.success).toBe(true);

      const graphRes = await requestHandlers.handleToolCall('read_graph', {});
      expect(graphRes.success).toBe(true);
      expect(graphRes.data.entities.some((e: any) => e.name === 'CoreService')).toBe(true);
    });
  });
});
