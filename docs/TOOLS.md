# HeLa Genome: canonical tools

Server version **3.3.0**. Generated from the ecosystem schema catalog; regenerate with `npm run docs:generate -- --servers` in the ecosystem checkout.

Only names advertised by `tools/list` are listed here. Older aliases in migration examples are not additional tools. Runtime namespace prefixes are optional and do not change these server-local names.

## `analyze_git_changes`

Analyze bounded Git changes and untracked files in the current workspace. since defaults to "0": uncommitted changes against HEAD. Use "1" for the last commit, "N" for N commits ago, or a Git date

## `cache`

Read or mutate the optional Redis companion cache. Select action: get, set, delete, or scan. Keys must use the mema:<category>:<name> namespace.

Actions: `get`, `set`, `delete`, `scan`.

## `create_mission`

Create a mission or task in the fleet mission ledger for cross-agent coordination

## `delete_data`

Delete records from memory.db table

## `execute_sql`

Canonical memory-graph SQL inspection (use instead of hela-ribosome opencode_db). Execute raw SQL query on the project or central memory database (database: 'project' | 'central', default 'project')

## `export_data`

Export memory.db table data to file

## `get_file_context`

Get historical memory, recent modifications, linked tasks, and open bugs for a specific file path before editing or reading

## `get_project_guidance`

Invoke a project guidance framework to receive specialized instructions and checklists for specific workflows (e.g., project-setup, sprint-planning, code-review, etc.). This allows the AI to autonomously fetch and follow established project management protocols.

## `get_session_context`

Summarize active tasks, open bugs, recent changes, and blockers from project memory

## `get_timeline`

Get recent observations and project activity, newest first

## `harness_sessions`

List local agent-harness session stores or sync their session metadata into the knowledge graph. Select action: list (read-only paths/presence/format notes) sync (redacted titles, summaries, timestamps; supports dryRun), or repair_timestamps (opt-in cleanup of legacy year +032971 markers; reports only unless apply is true).

Actions: `list`, `sync`, `repair_timestamps`.

## `import_data`

Import data from file into memory.db table

## `initialize_memory`

Initialize the project memory system and database schema

## `insert_data`

Insert records into a project or central memory table (database: 'project' | 'central', default 'project')

## `inspect_untrusted_text`

Normalize untrusted text and detect common prompt-injection indicators

## `list_missions`

Query missions from the fleet mission ledger filtered by status, agent, or target

## `memory_edit`

Create or delete knowledge-graph entities, relations, and observations. Select the operation with action: create_entities, create_relations, add_observations, delete_entities, delete_observations, or delete_relations.

Actions: `create_entities`, `create_relations`, `add_observations`, `delete_entities`, `delete_observations`, `delete_relations`.

## `obsidian_vault`

Control the optional Obsidian vault mirror (human-facing view of project memory). Select action: status, sync, rebuild, backfill, sync_central, sync_from_central, or dedup. Requires HELA_GENOME_OBSIDIAN_VAULT for vault actions.

Actions: `status`, `sync`, `rebuild`, `backfill`, `sync_central`, `sync_from_central`, `dedup`.

## `open_node`

Get detailed information about project entity/entities

## `query_data`

Canonical memory-graph table query (use instead of hela-ribosome opencode_db). Query data from project or central memory tables (database: 'project' | 'central', default 'project')

## `read_graph`

Read one bounded page of the project knowledge graph (default 500 entities). Follow nextCursor for more; use read_graph_stream for keyset streaming.

## `read_graph_stream`

Stream the knowledge graph with cursor pagination (500/page, updated_at DESC). Returns entities, relations, nextCursor.

## `search_feedback`

Record which search source produced the result a caller actually used, so hela-enzyme can learn its per-source ranking priors instead of relying on static constants. Call once per source that returned results: used=true for the source whose result you used, used=false for sources you saw and passed over.

## `search_nodes`

Search project entities and relations with hybrid RAG and progressive disclosure

## `search_priors`

Return the learned per-class search-source multipliers derived from search_feedback, with sample counts and which sources are still exploring (carrying the exploration bonus so an unsampled source can be picked again).

## `security_scan`

Scan for likely hardcoded credentials without exposing values, or scan a container image for HIGH/CRITICAL vulnerabilities with Trivy. Select action: secrets or container.

Actions: `secrets`, `container`.

## `set_project_root`

Switch the active memory database to the given absolute project path without importing or publishing memory

## `setup_pre_commit`

Create a .pre-commit-config.yaml in the active project root and install the Git hooks, on demand. Requires pre-commit to be installed

## `sync_central_memory`

Publish the active project graph to central memory, reconcile entity deletions in both stores, and report skipped entities and relations

## `update_data`

Update records in memory.db table

## `update_mission`

Claim a queued mission or reclaim an expired claim with status "claimed" and claimedBy. Claims are exclusive and expire 30 minutes after claimedAt. The current claimant can move a live claim to in_progress, then completed or failed. Cancel from any state, naming the claimant for an active claim. Operators can use action "requeue" to reset a mission and clear its claim and outcome.

Actions: `requeue`.
