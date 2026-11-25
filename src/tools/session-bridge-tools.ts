import { Tool } from '@modelcontextprotocol/sdk/types.js';

export const sessionBridgeTools: Tool[] = [
  {
    name: 'harness_sessions',
    description:
      'List local agent-harness session stores or sync their session metadata into the knowledge graph. Select action: list (read-only paths/presence/format notes) sync (redacted titles, summaries, timestamps; supports dryRun), or repair_timestamps (opt-in cleanup of legacy year +032971 markers; reports only unless apply is true).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'sync', 'repair_timestamps'],
          description: 'Operation to perform',
        },
        harnesses: {
          type: 'array',
          items: { type: 'string', enum: ['opencode', 'kilocode', 'zed', 'delta', 'antigravity', 'cursor', 'vscode', 'codex'] },
          description: 'Harnesses to sync (default: all found)',
        },
        project: { type: 'string', description: 'Substring filter on session project/directory' },
        since: { type: 'number', description: 'Only sessions updated after this ms epoch' },
        limit: { type: 'number', description: 'Max sessions per harness (default 50, max 500)' },
        dryRun: { type: 'boolean', description: 'Report what would sync without writing' },
        apply: { type: 'boolean', description: 'repair_timestamps only: write the repair (default false = dry run)' },
        includeArchived: { type: 'boolean', description: 'Include archived sessions (default false)' },
      },
      required: ['action'],
    },
  },
];
