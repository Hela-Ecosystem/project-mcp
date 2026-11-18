import { Tool } from '@modelcontextprotocol/sdk/types.js';

const object = (properties: Record<string, object>, required: string[] = []) => ({
  type: 'object' as const, properties, required, additionalProperties: false,
});

export const runtimeTools: Tool[] = [
  { name: 'sync_central_memory', description: 'Sync the active project knowledge graph into the central memory database (~/memory/memory.db by default) so all projects share one searchable map', inputSchema: object({}) },
  { name: 'set_project_root', description: 'Switch the active project memory database to the given absolute project path. Use at session start when the server was launched outside the project directory', inputSchema: object({ path: { type: 'string', description: 'Absolute path to the project root', pattern: '^/' } }, ['path']) },
  { name: 'setup_pre_commit', description: 'Create a .pre-commit-config.yaml in the active project root and install the Git hooks, on demand. Requires pre-commit to be installed', inputSchema: object({}) },
  { name: 'get_session_context', description: 'Summarize active tasks, open bugs, recent changes, and blockers from project memory', inputSchema: object({ limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 } }) },
  { name: 'analyze_git_changes', description: 'Analyze bounded Git changes and untracked files in the current workspace', inputSchema: object({ commit: { type: 'string' }, since: { type: 'string', default: '1' }, includeUntracked: { type: 'boolean', default: true }, maxFiles: { type: 'integer', minimum: 1, maximum: 500, default: 100 } }) },
  { name: 'inspect_untrusted_text', description: 'Normalize untrusted text and detect common prompt-injection indicators', inputSchema: object({ text: { type: 'string', description: 'Untrusted text, maximum 256 KiB' } }, ['text']) },
  {
    name: 'security_scan',
    description:
      'Scan for likely hardcoded credentials without exposing values, or scan a container image for HIGH/CRITICAL vulnerabilities with Trivy. Select action: secrets or container.',
    inputSchema: object({
      action: { type: 'string', enum: ['secrets', 'container'], description: 'Scan type' },
      path: { type: 'string', default: '.', description: 'Workspace-relative path for secrets' },
      exclude: { type: 'array', items: { type: 'string' }, description: 'Basenames to exclude' },
      image: { type: 'string', description: 'Container image reference for container scans' },
      maxFindings: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
    }, ['action']),
  },
  {
    name: 'obsidian_vault',
    description:
      'Control the optional Obsidian vault mirror (human-facing view of project memory). Select action: status, sync, rebuild, backfill, sync_central, sync_from_central, or dedup. Requires HELA_GENOME_OBSIDIAN_VAULT for vault actions.',
    inputSchema: object({
      action: { type: 'string', enum: ['status', 'sync', 'rebuild', 'backfill', 'sync_central', 'sync_from_central', 'dedup'], description: 'Operation' },
    }, ['action']),
  },
  {
    name: 'search_feedback',
    description:
      'Record which search source produced the result a caller actually used, so hela-enzyme can learn its per-source ranking priors instead of relying on static constants. Call once per source that returned results: used=true for the source whose result you used, used=false for sources you saw and passed over.',
    inputSchema: object({
      query_class: { type: 'string', enum: ['news', 'academic', 'technical', 'definition', 'entity', 'general'], description: 'Query class the search was routed as' },
      source: { type: 'string', enum: ['google', 'wikipedia', 'news_monitor', 'academic_search'], description: 'Search back-end this decision is about' },
      used: { type: 'boolean', description: 'true when a result from this source was used, false when it was seen and passed over' },
      query: { type: 'string', maxLength: 4096, description: 'Optional query text; stored truncated to 512 characters' },
      note: { type: 'string', maxLength: 4096, description: 'Optional short reason; stored truncated to 512 characters' },
    }, ['query_class', 'source', 'used']),
  },
  {
    name: 'search_priors',
    description:
      'Return the learned per-class search-source multipliers derived from search_feedback, with sample counts and which sources are still exploring (carrying the exploration bonus so an unsampled source can be picked again).',
    inputSchema: object({
      query_class: { type: 'string', enum: ['news', 'academic', 'technical', 'definition', 'entity', 'general'], description: 'Limit the answer to one class; omit for all' },
    }),
  },
  {
    name: 'cache',
    description:
      'Read or mutate the optional Redis companion cache. Select action: get, set, delete, or scan. Keys must use the mema:<category>:<name> namespace.',
    inputSchema: object({
      action: { type: 'string', enum: ['get', 'set', 'delete', 'scan'] },
      key: { type: 'string', description: 'Required for get, set, and delete' },
      value: { type: 'string', description: 'Required for set' },
      ttlSeconds: { type: 'integer', minimum: 1, maximum: 604800 },
      pattern: { type: 'string', default: 'mema:*', description: 'Required for scan' },
      cursor: { type: 'integer', minimum: 0, default: 0 },
      count: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
    }, ['action']),
  },
];
