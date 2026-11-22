# Changelog

All notable changes to Project Guardian MCP.

## [3.1.3] - 2026-11-22

### Fixed
- Harness sync can no longer store a fabricated date. Zero, missing and seconds-based timestamps are normalised or skipped with a reported reason, and rows already written with the bogus `+032971` year are repaired in place. (`project-mcp#38`)
- `get_timeline` reads the real timestamp, accepts a numeric `since` in milliseconds or seconds, sorts by time, and no longer treats a leading `[TAG]` in an observation as its date.
- The dry run applies the same watermarks as a real sync, so it reports what would actually be imported.

## [3.1.2] - 2026-11-22

### Fixed
- Mission lifecycle is guarded. Transitions follow `queued → claimed → in_progress → completed | failed`, any state can be cancelled, and `action: "requeue"` clears claim fields and returns a mission to `queued`. Acting on an active claim requires the claimant named, so one agent cannot complete another agent's mission, and claims carry a 30-minute lease that allows a crashed agent's mission to be reclaimed. Completion requires a non-null result; conflicting or inconsistent updates are rejected instead of stored. (`project-mcp#39`)

## [3.1.1] - 2026-11-22

### Fixed
- Deletions survive the sync boundary. Entity tombstones are reconciled in both directions, central rows are removed (or blocked from being re-inserted by a trigger), and `sync_central_memory` reports how many entities/relations it deleted or skipped instead of silently re-adding them. `set_project_root` no longer imports another project into a fresh root. (`project-mcp#37`)

## [3.1.0] - 2026-11-22

### Fixed
- `delete_entities` is durable. Project deletions are recorded in a tombstone table that `syncFromCentral` respects, so a deleted entity no longer reappears from the central DB on the next sync or root switch; counts come from SQLite `changes` and missing names are reported individually. (`project-mcp#35`)
- `security_scan` no longer opens live SQLite files. Reading `memory.db-wal`/`-shm` closed a descriptor and released SQLite's WAL locks, letting the next opener checkpoint and delete the WAL so later writes went to unlinked files. Databases and their sidecars are skipped by every walker; reproduced the lost write before the fix. (`project-mcp#36`)

## [3.0.7] - 2026-11-22

### Added
- Genome drains the search-feedback spool Enzyme writes. `search_feedback` and `search_priors` now ingest `~/.local/state/hela/search-feedback.jsonl` before answering, so the implicit follow-up signals Enzyme observes become rows in `source_feedback` without giving Enzyme write access to the table. The file is claimed by rename, so two processes cannot import the same line twice; records that fail to insert are put back rather than lost. (`researcher-mcp#35`)

## [3.0.6] - 2026-11-19

### Added
- Search-source feedback loop (Genome side). `source_feedback` table in the central database (`id`, `recorded_at`, `query_class`, `source`, `used`, `query`, `note`, indexed on `(query_class, source)`) records which search source produced the result a caller actually used. Two new tools: `search_feedback` records one decision, `search_priors` returns the derived per-class multipliers with sample counts and the sources still exploring. Queries and notes are truncated to 512 characters, never stored whole.
- Prior derivation rule with a collapse guard: once a `(query_class, source)` cell has at least 5 samples, a Beta-smoothed success rate `p = (used + 1) / (n + 2)` maps to `clamp(1 + 1.0 * (p - 0.5), 0.5, 1.5)`; below that the static prior stands. A source with no samples in a class that already has 5, or whose newest sample is over 30 days old, is floored at 1.0 and lifted by a 0.15 exploration bonus, so a source that stopped being sampled can always be picked again and recover. Eleven tests, three of which fail if the guard is removed.

### Changed
- `SQLiteManager.SCHEMA_VERSION` bumped to 2 for the `source_feedback` migration.

## [3.0.5] - 2026-11-19

### Added
- `npm run vault:conflicts`: audits the sync conflict archive and collapses the safely decidable cases. Bodies that differ only in frontmatter are archived (the note is not rewritten, so its newer timestamps survive); notes whose body moved on since the conflict, and every body-divergent conflict, are listed in a review sheet instead of guessed. Dry run by default; `--apply` archives, copying the previous note and the manifest into `.hela-sync/resolved/`.

## [3.0.4] - 2026-11-19

### Added
- Schema revision tracking: both databases are stamped with `PRAGMA user_version` after their schema is created, a rerun is a no-op, and a file written by a newer build is refused instead of being partially understood. Covered by three tests.

## [3.0.3] - 2026-11-19

### Changed
- npm audit fix clears two moderate advisories; no API change.

## [3.0.2] - 2026-11-18

### Fixed
- The advertised MCP server version now comes from one `MCP_SERVER_VERSION` constant used by ServerInfo, `/healthz`, `/discovery`, and `server/discover`, so a `package.json` bump can no longer leave the server reporting an old number.

### Tests
- Added `__tests__/version.test.ts` asserting the constant equals `package.json.version`.

## [3.0.1] - 2026-11-13

### Fixed
- Ported production and test runners away from Unix-only commands and added the Windows guard.
- Preserved entity failure details and canonical vault relation ordering.

### Security
- Declared the distributed server under GPL-3.0-or-later.

### Memory safety and correctness (2026-11-06)
- Added baseline-based two-way vault sync with SSH support, conflict/recovery archives, serialized locks, and stale-snapshot checks. Destructive `rsync --delete` mirror hooks are rejected.
- Fixed relation bullets being reimported as observations, repeated central relation inserts, and unsafe test inheritance of real central/vault paths. Managed note imports preserve concurrent observation edits and ignore hidden recovery files.
- Replaced database-file copies with integrity-checked SQLite online backups and new-destination-only restores; retained legacy migration sources.
- Made mission claims exclusive through a conditional SQL update, with independent-connection and multi-process contention tests. Separate local ledger copies are not distributed locks.
- Updated record schemas for the declared Zod 4 dependency; clean lockfile installs now build and pass the same regression suite as existing installations.

### Fixed
- **`read_graph_stream` dispatch** — the tool was registered and documented but missing from the memory dispatch list, causing `Unknown tool`; added regression coverage.
- **`set_project_root` schema init** — switching roots now resets the schema-ready flag so the new project database is initialized before writes.
- **Unicode search** — `search_nodes` keeps letters and numbers in any script instead of stripping non-ASCII characters.
- **Missing guidance handlers** — `release-planning` and `risk-assessment` now return prompts like the other 25 frameworks.
- **Read-only SQL results** — `execute_sql` now returns rows for `PRAGMA`, `EXPLAIN`, `VALUES`, and CTE (`WITH`) queries instead of only `SELECT`.

### Security
- **Workspace path guard** — `import_data`/`export_data` reject absolute and traversal paths by default; opt out with `HELA_GENOME_ALLOW_EXTERNAL_PATHS=true`.
- **Identifier validation** — table, condition, update, and order column names are validated before interpolation into SQL.
- **Raw SQL write guard** — CTE writes and write-capable `PRAGMA` statements are rejected unless `HELA_GENOME_ALLOW_SQL_WRITE=true`; read-only PRAGMAs remain allowed.

## [3.0.0] - 2026-10-31

### Changed
- **Version reset to 3.0.0** — per-server version metadata baseline reset (Phase 7). All `package.json`, MCP `ServerInfo.version`, and HTTP metadata now report `3.0.0`. This is a metadata/interface baseline reset; for `hela-plastid` it is not an upgrade from the previous `4.2.0` advert.

## [2.0.0-beta-3] - 2026-10-14

### Added
- **Claude-Mem: Progressive Disclosure Retrieval** — `search_nodes` with `detailLevel: compact|summary|full` (compact yields ~50 tokens/entity with `observationCount` and preview).
- **Claude-Mem: Pre-file Context** — new MCP tool `get_file_context` (38 tools total, was 36) to look up prior modifications, linked tasks (`implements`), and linked bugs before file edits.
- **Claude-Mem: Chronological Timeline** — new MCP tool `get_timeline` with `entityType` and `since` temporal filters.
- **Claude-Mem: Privacy Guardrails** — automated stripping of `<private>...</private>` and `<!-- private -->` tags before SQLite storage or vector embedding.
- **Claude-Mem: Zero-Touch Lifecycle Hooks** — `hooks/session-start.mjs` (Tier 1 session brief) and `hooks/post-tool-run.mjs` (automatic git/edit observation capture via built-in `node:sqlite`).
- **Tests** — 14 test suites, 139 passing tests (added `__tests__/claude-mem-features.test.ts`).

## [2.0.0-beta-2] - 2026-08-27

### Added
- **Scale: Cursor streaming** — `readGraphStream(cursor base64url {updated_at,name}, limit 500 cap 1000)` + `MCP read_graph_stream` + `GET /api/graph/stream?cursor=&limit=` (34 tools total, was 33) + `POST /api/vacuum` (`fa033ec`/`c2dd6ca`/`e43ca01`)
- **UI: Virtual + streaming LOD** — `react-window 1.8.11` `FixedSizeList 420h 56h` for `>50` entities (was 50-slice SHOW MORE), central view incremental streaming 500/page, auto-collapse `>300` (cluster) `>400` disable orbs (`c2dd6ca`)
- **UI: >1k physics freeze** — `cooldownTicks 0 d3AlphaDecay 1 d3VelocityDecay 1` when `nodes>1000` (deck.gl WebGL TODO for 10k)
- **DB: VACUUM + journal cap** — `PRAGMA journal_size_limit=67108864` (64M) + `vacuumDatabase()` + `vacuumDatabases()` self-schedule 30d (`fa033ec`)

### Changed
- **UI bundle** — `index-B2DK7m-f.js 403k` (was `COU8SsoH.js` 391k / `B2DK7m-f` after phase2)
- **E2E** — `93/93` still pass (10 suites), `GET /api/graph/stream` + `POST /api/vacuum` + `hybrid search vector` + `stream pagination` verified live

## [2.0.0-beta-1] - 2026-08-27

### Added
- **Vector Hybrid RAG (POC)** — `sqlite-vec` `vec0(embedding float[384])` + `@xenova/transformers` `all-MiniLM-L6-v2` local 384d (`2772572`), `vector-manager.ts` lazy pipeline, `ensureProjectSchema`/`ensureCentralSchema` vec table + `createRequire` Jest fix
- **MCP: `search_nodes` hybrid** — `mode: keyword|vector|hybrid` (default `hybrid` RRF `k=60` merging FTS BM25 + vec cosine), `vectorSearch` KNN `MATCH`, `GET /api/search?q=&mode=&limit=` (`673a238`)
- **UI: Hybrid search** — `SEARCH ENTITIES` now `fetch /api/search` when `q≥2` with `HYBRID|KEYWORD|VECTOR` select, `filteredNodes = searchResults ?? baseFiltered` (`COU8SsoH.js`)
- **Backfill** — `scripts/backfill_vec.mjs` real embeddings `central 105` + `project 76` vec rows
- **E2E** — `__tests__/e2e-vector.test.ts` `2/2` pass, `93/93` total, mock `Float32Array` realm fix

### Fixed
- **Jest vec load** — `import.meta.resolve` failure via `createRequire` fallback for `sqlite-vec` (`b4d4b1d`)

## [1.1.0] - 2026-08-26

### Added
- **UI: Observation orbs** — each observation as cyan hollow orb, amber clustered per-entity with expand/collapse (`ec4bb7f`), default `false` (`8529a36`), expand-all/collapse-all
- **UI: Always-visible entity browser** — persistent A-Z list filtered by name/group with `obs•links` counts (`2d93547`)
- **UI: Desktop-only gate** — mobile overlay at `<768px` or `<1024px+touch` with blur backdrop (`0398ef8`)
- **MCP: `close_ui` / `stop_ui`** — mirror `start_ui`, 33 tools total (was 31) (`4268fcb`)
- **API: Pagination** — `readStore`/`readGraph` `{limit,offset}` (default 5000, validated), `searchNodes` `limit` (20 default, 100 cap), `GET /api/graph/:view?limit=&offset=` (`e6872cd`)
- **DB: WAL** — `journal_mode=WAL`, `synchronous=NORMAL`, `cache_size=-64000`, `temp_store=MEMORY`, `busy_timeout=5000` per connection

### Fixed
- **UI 404** — `join(process.cwd(),'ui','dist')` fallback to `MCPservers/.../ui/dist` + SPA fallback (`e736e1c`)
- **UI layout** — right panel flex sibling (was absolute overlay) → no out-of-screen graph (`c2085a3`)
- **Memory: `no such table: entities`** — lazy `ensureProjectSchema()` on fresh 0-byte DB (`6f1f712`)
- **Memory: Batch transactions** — `syncToCentral` + bulk `createEntities/createRelations/addObservations` single `BEGIN/COMMIT`, `sqlite insertData` batch (100 rows 8ms)

### Security
- **Audit 24→0** — `sqlite3 5.1.7→6.0.1`, `@typescript-eslint/parser+plugin 6→8` (`e6872cd`)

### Docs
- **README** synced to 33 tools (7 DB +10 memory +1 guidance +12 runtime +3 UI), 9 suites 91 tests, WAL/pagination notes (`13621ae`)

## [1.0.0] - prior
- Initial 31 tools, 11 resources, 27 prompts, FTS5, central mirror `~/memory/memory.db`, daily backup, pre-commit on-demand.
