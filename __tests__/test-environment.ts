import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const root = mkdtempSync(join(tmpdir(), 'guardian-jest-'));
const home = join(root, 'home');
mkdirSync(home);
let testIndex = 0;

function isolateEnvironment(): void {
  process.env.NODE_ENV = 'test';
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.GUARDIAN_CENTRAL_DB = join(root, `central-${testIndex++}.db`);
  delete process.env.ENABLE_VECTOR_TEST;
  delete process.env.GUARDIAN_AUTO_MERGE;
  delete process.env.HELA_GENOME_OBSIDIAN_VAULT;
  delete process.env.HELA_GENOME_OBSIDIAN_SYNC_CMD;
  delete process.env.HELA_GENOME_OBSIDIAN_PULL_CMD;
}

isolateEnvironment();
beforeEach(isolateEnvironment);
afterAll(() => rmSync(root, { recursive: true, force: true }));
