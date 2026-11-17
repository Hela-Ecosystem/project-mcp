import { readFileSync } from 'fs';
import { MCP_SERVER_VERSION } from '../src/version';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

describe('Advertised MCP server version', () => {
  test('matches package.json', () => {
    expect(MCP_SERVER_VERSION).toBe(pkg.version);
  });
});
