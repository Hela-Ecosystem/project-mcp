/**
 * Search-source feedback loop — storage and prior derivation (Genome side).
 *
 * Enzyme (researcher-mcp) ranks search results with per-source multipliers.
 * Until now those multipliers were static constants, so a source that was
 * systematically useless (or systematically right) could never change its
 * own weight. Genome is the memory backbone, so it owns the record: every
 * caller decision lands in `source_feedback`, and `computeSourcePriors`
 * turns that history into multipliers Enzyme reads back read-only.
 *
 * The rule below is duplicated verbatim in researcher-mcp
 * (`src/sourcePriors.ts`). Shape and constants are duplicated rather than
 * imported because each MCP server builds and deploys independently — the
 * same reason `observation-provenance.ts` duplicates `HelaProvenanceRef`.
 * If you change a constant here, change it there in the same commit.
 */

import { z } from 'zod';
import type { DatabaseOperationResult, SqlExecutionData } from './types.js';

export const SOURCE_FEEDBACK_TABLE = 'source_feedback';

/** Query classes Enzyme's `classifyQuery` can emit. */
export const QUERY_CLASSES = ['news', 'academic', 'technical', 'definition', 'entity', 'general'] as const;
/** Search back-ends Enzyme fans out to. */
export const SEARCH_SOURCES = ['google', 'wikipedia', 'news_monitor', 'academic_search'] as const;

export type QueryClass = (typeof QUERY_CLASSES)[number];
export type SearchSource = (typeof SEARCH_SOURCES)[number];

// ---------------------------------------------------------------------------
// Adaptation constants. Keep in lockstep with researcher-mcp/src/sourcePriors.ts.
// ---------------------------------------------------------------------------

/** Samples needed in a (class, source) cell before its static prior is replaced. */
export const MIN_SAMPLES = 5;
/** Slope from Beta-smoothed success rate to multiplier. 1.0 => p in [0,1] maps to [0.5, 1.5]. */
export const PRIOR_GAIN = 1.0;
/** Lift handed to a source the loop has stopped sampling, so it can be picked again. */
export const EXPLORATION_BONUS = 0.15;
/** Hard bounds on any derived multiplier. */
export const MULTIPLIER_FLOOR = 0.5;
export const MULTIPLIER_CEILING = 1.5;
/** A cell whose newest sample is older than this is treated as unexplored. */
export const STALE_SAMPLE_DAYS = 30;
/** Bounded storage: queries and notes are truncated, never stored whole. */
export const MAX_QUERY_LENGTH = 512;
export const MAX_NOTE_LENGTH = 512;

const MS_PER_DAY = 86_400_000;

/**
 * Enzyme's static per-class multipliers, mirrored so `search_priors` can
 * answer with a complete table instead of holes. Must match
 * `classifyQuery` in researcher-mcp/src/searchQuality.ts.
 */
export const STATIC_PRIORS: Record<QueryClass, Record<SearchSource, number>> = {
  general: { google: 1, wikipedia: 1, news_monitor: 0.65, academic_search: 0.65 },
  news: { google: 0.75, wikipedia: 0.4, news_monitor: 1.5, academic_search: 0.5 },
  academic: { google: 0.75, wikipedia: 0.45, news_monitor: 0.4, academic_search: 1.5 },
  technical: { google: 1.4, wikipedia: 0.45, news_monitor: 0.5, academic_search: 0.8 },
  definition: { google: 0.8, wikipedia: 1.5, news_monitor: 0.4, academic_search: 0.55 },
  entity: { google: 0.8, wikipedia: 1.35, news_monitor: 0.6, academic_search: 0.6 },
};

/** Minimal structural surface of SQLiteManager.executeSql (avoids a cycle). */
export interface SourceFeedbackSqlExecutor {
  executeSql(
    database: string,
    query: string,
    parameters?: unknown[],
  ): Promise<Pick<DatabaseOperationResult<SqlExecutionData>, 'success' | 'error' | 'data'>>;
}

export const SearchFeedbackSchema = z.object({
  query_class: z.enum(QUERY_CLASSES),
  source: z.enum(SEARCH_SOURCES),
  /** true when the caller used a result from this source; false when it saw results and used another. */
  used: z.boolean(),
  query: z.string().min(1).max(4096).optional(),
  note: z.string().max(4096).optional(),
});
export type SearchFeedbackInput = z.infer<typeof SearchFeedbackSchema>;

export const SearchPriorsSchema = z.object({
  query_class: z.enum(QUERY_CLASSES).optional(),
});

const StatsRowSchema = z.object({
  query_class: z.string(),
  source: z.string(),
  samples: z.number(),
  used: z.number(),
  last_recorded_at: z.string().nullable(),
});

/** One (query_class, source) cell of recorded history. */
export interface SourceFeedbackStat {
  query_class: string;
  source: string;
  samples: number;
  used: number;
  last_recorded_at: string | null;
}

export type PriorMode = 'static' | 'learned' | 'exploring';

export interface SourcePrior {
  multiplier: number;
  samples: number;
  used: number;
  mode: PriorMode;
  last_recorded_at: string | null;
}

export interface ClassPriors {
  query_class: QueryClass;
  /** Total samples recorded for the class across all sources. */
  samples: number;
  sources: Record<SearchSource, SourcePrior>;
  /** Sources currently carrying the exploration bonus. */
  exploring: SearchSource[];
}

/** Idempotent schema; safe to call on every startup path. */
export async function ensureSourceFeedbackSchema(
  exec: SourceFeedbackSqlExecutor,
  dbName: string,
): Promise<void> {
  const table = await exec.executeSql(
    dbName,
    `CREATE TABLE IF NOT EXISTS ${SOURCE_FEEDBACK_TABLE} (
      id INTEGER PRIMARY KEY,
      recorded_at TEXT NOT NULL,
      query_class TEXT NOT NULL,
      source TEXT NOT NULL,
      used INTEGER NOT NULL,
      query TEXT,
      note TEXT
    )`,
  );
  if (!table.success) {
    console.warn(`Failed to ensure ${SOURCE_FEEDBACK_TABLE} table:`, table.error);
    return;
  }
  const index = await exec.executeSql(
    dbName,
    `CREATE INDEX IF NOT EXISTS idx_source_feedback_class_source
     ON ${SOURCE_FEEDBACK_TABLE}(query_class, source)`,
  );
  if (!index.success) console.warn(`Failed to create ${SOURCE_FEEDBACK_TABLE} index:`, index.error);
}

function truncate(value: string | undefined, limit: number): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
}

/** Record one caller decision. Throws on a failed write so the tool reports it. */
export async function recordSourceFeedback(
  exec: SourceFeedbackSqlExecutor,
  dbName: string,
  input: unknown,
  now: Date = new Date(),
): Promise<{ recorded_at: string; query_class: QueryClass; source: SearchSource; used: boolean }> {
  const args = SearchFeedbackSchema.parse(input);
  await ensureSourceFeedbackSchema(exec, dbName);
  const recordedAt = now.toISOString();
  const result = await exec.executeSql(
    dbName,
    `INSERT INTO ${SOURCE_FEEDBACK_TABLE} (recorded_at, query_class, source, used, query, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      recordedAt,
      args.query_class,
      args.source,
      args.used ? 1 : 0,
      truncate(args.query, MAX_QUERY_LENGTH),
      truncate(args.note, MAX_NOTE_LENGTH),
    ],
  );
  if (!result.success) throw new Error(result.error || 'source_feedback insert failed');
  return { recorded_at: recordedAt, query_class: args.query_class, source: args.source, used: args.used };
}

/** Aggregate recorded history into one row per (query_class, source). */
export async function readSourceFeedbackStats(
  exec: SourceFeedbackSqlExecutor,
  dbName: string,
  queryClass?: string,
): Promise<SourceFeedbackStat[]> {
  await ensureSourceFeedbackSchema(exec, dbName);
  const where = queryClass ? 'WHERE query_class = ?' : '';
  const result = await exec.executeSql(
    dbName,
    `SELECT query_class, source,
            COUNT(*) AS samples,
            SUM(CASE WHEN used = 1 THEN 1 ELSE 0 END) AS used,
            MAX(recorded_at) AS last_recorded_at
     FROM ${SOURCE_FEEDBACK_TABLE} ${where}
     GROUP BY query_class, source`,
    queryClass ? [queryClass] : [],
  );
  if (!result.success || !result.data) return [];
  return (result.data.rows ?? []).map((row) => StatsRowSchema.parse(row));
}

/**
 * Derive multipliers from recorded history.
 *
 * Per (query_class, source):
 *   - Collapse guard first. A cell with no samples at all while the class has
 *     already reached MIN_SAMPLES, or whose newest sample is older than
 *     STALE_SAMPLE_DAYS, is treated as unexplored: its multiplier is floored at
 *     1.0 and lifted by EXPLORATION_BONUS. Without this, one bad run drives a
 *     source's multiplier down, it stops being ranked high enough to be used,
 *     it therefore stops collecting samples, and the low multiplier becomes
 *     permanent — feedback collapse. The bonus guarantees every source stays
 *     reachable and can recover.
 *   - Otherwise, once samples >= MIN_SAMPLES, a Beta(1,1)-smoothed success rate
 *     p = (used + 1) / (samples + 2) maps to 1 + PRIOR_GAIN * (p - 0.5),
 *     clamped to [MULTIPLIER_FLOOR, MULTIPLIER_CEILING].
 *   - Below MIN_SAMPLES the static prior stands: too little evidence to move.
 */
export function computeSourcePriors(
  stats: SourceFeedbackStat[],
  now: Date = new Date(),
): Record<QueryClass, ClassPriors> {
  const byClass = new Map<string, Map<string, SourceFeedbackStat>>();
  for (const stat of stats) {
    const bucket = byClass.get(stat.query_class) ?? new Map<string, SourceFeedbackStat>();
    bucket.set(stat.source, stat);
    byClass.set(stat.query_class, bucket);
  }

  const out = {} as Record<QueryClass, ClassPriors>;
  for (const queryClass of QUERY_CLASSES) {
    const bucket = byClass.get(queryClass) ?? new Map<string, SourceFeedbackStat>();
    const classTotal = [...bucket.values()].reduce((sum, stat) => sum + stat.samples, 0);
    const sources = {} as Record<SearchSource, SourcePrior>;
    const exploring: SearchSource[] = [];

    for (const source of SEARCH_SOURCES) {
      const stat = bucket.get(source);
      const samples = stat?.samples ?? 0;
      const used = stat?.used ?? 0;
      const lastRecordedAt = stat?.last_recorded_at ?? null;
      const staticPrior = STATIC_PRIORS[queryClass][source];

      const lastMs = lastRecordedAt ? Date.parse(lastRecordedAt) : NaN;
      const isStale = Number.isFinite(lastMs) && now.getTime() - lastMs > STALE_SAMPLE_DAYS * MS_PER_DAY;
      const isStarved = samples === 0 && classTotal >= MIN_SAMPLES;

      let multiplier: number;
      let mode: PriorMode;
      if (isStarved || isStale) {
        multiplier = clampMultiplier(Math.max(staticPrior, 1) + EXPLORATION_BONUS);
        mode = 'exploring';
        exploring.push(source);
      } else if (samples >= MIN_SAMPLES) {
        const p = (used + 1) / (samples + 2);
        multiplier = clampMultiplier(1 + PRIOR_GAIN * (p - 0.5));
        mode = 'learned';
      } else {
        multiplier = staticPrior;
        mode = 'static';
      }
      sources[source] = { multiplier, samples, used, mode, last_recorded_at: lastRecordedAt };
    }
    out[queryClass] = { query_class: queryClass, samples: classTotal, sources, exploring };
  }
  return out;
}

export function clampMultiplier(value: number): number {
  return Math.min(MULTIPLIER_CEILING, Math.max(MULTIPLIER_FLOOR, value));
}

/** `search_priors` payload: the whole table, or one class when asked. */
export async function getSourcePriors(
  exec: SourceFeedbackSqlExecutor,
  dbName: string,
  input: unknown,
  now: Date = new Date(),
): Promise<{
  constants: Record<string, number>;
  classes: ClassPriors[];
  total_samples: number;
}> {
  const args = SearchPriorsSchema.parse(input ?? {});
  const stats = await readSourceFeedbackStats(exec, dbName, args.query_class);
  const priors = computeSourcePriors(stats, now);
  const classes = args.query_class ? [priors[args.query_class]] : QUERY_CLASSES.map((c) => priors[c]);
  return {
    constants: {
      MIN_SAMPLES,
      PRIOR_GAIN,
      EXPLORATION_BONUS,
      MULTIPLIER_FLOOR,
      MULTIPLIER_CEILING,
      STALE_SAMPLE_DAYS,
    },
    classes,
    total_samples: stats.reduce((sum, stat) => sum + stat.samples, 0),
  };
}
