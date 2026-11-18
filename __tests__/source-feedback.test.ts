import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SQLiteManager } from '../src/sqlite-manager.js';
import {
  computeSourcePriors,
  EXPLORATION_BONUS,
  getSourcePriors,
  MIN_SAMPLES,
  readSourceFeedbackStats,
  recordSourceFeedback,
  SOURCE_FEEDBACK_TABLE,
  STATIC_PRIORS,
  type SourceFeedbackStat,
} from '../src/source-feedback.js';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-06-01T00:00:00.000Z');
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString();

const stat = (
  query_class: string,
  source: string,
  samples: number,
  used: number,
  daysAgo = 1,
): SourceFeedbackStat => ({ query_class, source, samples, used, last_recorded_at: iso(daysAgo) });

describe('source_feedback storage', () => {
  let directory: string;
  let manager: SQLiteManager;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'hela-feedback-'));
    manager = new SQLiteManager(directory);
  });

  afterEach(async () => {
    await manager.closeAllConnections();
    rmSync(directory, { recursive: true, force: true });
  });

  it('records a decision and reads it back', async () => {
    const recorded = await recordSourceFeedback(manager, 'memory', {
      query_class: 'technical',
      source: 'google',
      used: true,
      query: 'mcp protocol version negotiation',
      note: 'first hit answered it',
    });
    expect(recorded.query_class).toBe('technical');
    expect(recorded.used).toBe(true);

    const rows = await manager.executeSql(
      'memory',
      `SELECT query_class, source, used, query, note FROM ${SOURCE_FEEDBACK_TABLE}`,
    );
    expect(rows.success).toBe(true);
    expect(rows.data?.rows).toEqual([
      {
        query_class: 'technical',
        source: 'google',
        used: 1,
        query: 'mcp protocol version negotiation',
        note: 'first hit answered it',
      },
    ]);
  });

  it('aggregates samples per (query_class, source)', async () => {
    for (const used of [true, true, false]) {
      await recordSourceFeedback(manager, 'memory', { query_class: 'news', source: 'news_monitor', used });
    }
    await recordSourceFeedback(manager, 'memory', { query_class: 'news', source: 'wikipedia', used: false });

    const stats = await readSourceFeedbackStats(manager, 'memory');
    expect(stats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ query_class: 'news', source: 'news_monitor', samples: 3, used: 2 }),
        expect.objectContaining({ query_class: 'news', source: 'wikipedia', samples: 1, used: 0 }),
      ]),
    );
    const scoped = await readSourceFeedbackStats(manager, 'memory', 'academic');
    expect(scoped).toEqual([]);
  });

  it('truncates a long query instead of storing it whole', async () => {
    await recordSourceFeedback(manager, 'memory', {
      query_class: 'general',
      source: 'google',
      used: true,
      query: 'x'.repeat(4000),
      note: 'y'.repeat(4000),
    });
    const rows = await manager.executeSql('memory', `SELECT query, note FROM ${SOURCE_FEEDBACK_TABLE}`);
    const row = rows.data?.rows?.[0] as { query: string; note: string };
    expect(row.query).toHaveLength(512);
    expect(row.note).toHaveLength(512);
  });

  it('rejects invalid input', async () => {
    await expect(
      recordSourceFeedback(manager, 'memory', { query_class: 'gossip', source: 'google', used: true }),
    ).rejects.toThrow();
    await expect(
      recordSourceFeedback(manager, 'memory', { query_class: 'news', source: 'bing', used: true }),
    ).rejects.toThrow();
    await expect(
      recordSourceFeedback(manager, 'memory', { query_class: 'news', source: 'google' }),
    ).rejects.toThrow();
    await expect(
      recordSourceFeedback(manager, 'memory', { query_class: 'news', source: 'google', used: 'yes' }),
    ).rejects.toThrow();
  });

  it('search_priors round-trips through the database', async () => {
    for (let i = 0; i < MIN_SAMPLES + 1; i++) {
      await recordSourceFeedback(manager, 'memory', { query_class: 'definition', source: 'wikipedia', used: true });
    }
    const priors = await getSourcePriors(manager, 'memory', { query_class: 'definition' });
    expect(priors.classes).toHaveLength(1);
    const wikipedia = priors.classes[0].sources.wikipedia;
    expect(wikipedia.mode).toBe('learned');
    expect(wikipedia.samples).toBe(MIN_SAMPLES + 1);
    expect(priors.constants.MIN_SAMPLES).toBe(MIN_SAMPLES);
  });
});

describe('prior derivation', () => {
  it('leaves a class with too few samples on its static multipliers', () => {
    const priors = computeSourcePriors([stat('technical', 'google', MIN_SAMPLES - 1, 0)], NOW);
    const technical = priors.technical;
    expect(technical.samples).toBe(MIN_SAMPLES - 1);
    for (const source of ['google', 'wikipedia', 'news_monitor', 'academic_search'] as const) {
      expect(technical.sources[source].mode).toBe('static');
      expect(technical.sources[source].multiplier).toBeCloseTo(STATIC_PRIORS.technical[source]);
    }
    expect(technical.exploring).toEqual([]);
  });

  it('raises a consistently used source and lowers an ignored one', () => {
    const priors = computeSourcePriors(
      [stat('general', 'google', 20, 19), stat('general', 'wikipedia', 20, 0)],
      NOW,
    );
    expect(priors.general.sources.google.mode).toBe('learned');
    expect(priors.general.sources.google.multiplier).toBeGreaterThan(STATIC_PRIORS.general.google);
    expect(priors.general.sources.wikipedia.mode).toBe('learned');
    expect(priors.general.sources.wikipedia.multiplier).toBeLessThan(STATIC_PRIORS.general.wikipedia);
    // Beta-smoothed: (0 + 1) / (20 + 2) = 0.04545 => 1 + (0.04545 - 0.5)
    expect(priors.general.sources.wikipedia.multiplier).toBeCloseTo(0.5454, 3);
  });

  it('never leaves a multiplier outside the clamp', () => {
    const priors = computeSourcePriors(
      [stat('general', 'google', 10_000, 10_000), stat('general', 'wikipedia', 10_000, 0)],
      NOW,
    );
    expect(priors.general.sources.google.multiplier).toBeLessThanOrEqual(1.5);
    expect(priors.general.sources.wikipedia.multiplier).toBeGreaterThanOrEqual(0.5);
  });

  // --- collapse guard ------------------------------------------------------
  // Removing the `isStarved || isStale` branch in computeSourcePriors makes
  // each of the three tests below fail.

  it('COLLAPSE GUARD: a source with zero samples in a sampled class gets the exploration bonus', () => {
    const priors = computeSourcePriors([stat('news', 'google', MIN_SAMPLES, MIN_SAMPLES)], NOW);
    const wikipedia = priors.news.sources.wikipedia;
    expect(wikipedia.samples).toBe(0);
    expect(wikipedia.mode).toBe('exploring');
    // Static news prior for wikipedia is 0.4 — the guard lifts it over 1.0.
    expect(wikipedia.multiplier).toBeCloseTo(1 + EXPLORATION_BONUS);
    expect(wikipedia.multiplier).toBeGreaterThan(STATIC_PRIORS.news.wikipedia);
    expect(priors.news.exploring).toContain('wikipedia');
  });

  it('COLLAPSE GUARD: a source whose newest sample is older than 30 days returns to exploring', () => {
    const priors = computeSourcePriors(
      [stat('general', 'google', 50, 50, 1), stat('general', 'wikipedia', 50, 0, 31)],
      NOW,
    );
    const wikipedia = priors.general.sources.wikipedia;
    expect(wikipedia.mode).toBe('exploring');
    expect(wikipedia.multiplier).toBeCloseTo(1 + EXPLORATION_BONUS);
    // A sample one day inside the window is still trusted and stays down.
    const fresh = computeSourcePriors(
      [stat('general', 'google', 50, 50, 1), stat('general', 'wikipedia', 50, 0, 29)],
      NOW,
    );
    expect(fresh.general.sources.wikipedia.mode).toBe('learned');
    expect(fresh.general.sources.wikipedia.multiplier).toBeLessThan(1);
  });

  it('COLLAPSE GUARD: an ignored source can out-rank the incumbent again once it goes stale', () => {
    // google is used more often than not (28/50 => p 0.558 => multiplier 1.058),
    // wikipedia was sampled 50 times and never used, so it collapses to 0.519.
    const collapsed = computeSourcePriors(
      [stat('general', 'google', 50, 28, 1), stat('general', 'wikipedia', 50, 0, 1)],
      NOW,
    );
    expect(collapsed.general.sources.wikipedia.multiplier).toBeLessThan(
      collapsed.general.sources.google.multiplier,
    );
    // Once wikipedia has gone unsampled for longer than the staleness window it
    // recovers to 1.15 and out-ranks the incumbent, so it gets sampled again.
    const recovered = computeSourcePriors(
      [stat('general', 'google', 50, 28, 1), stat('general', 'wikipedia', 50, 0, 45)],
      NOW,
    );
    expect(recovered.general.sources.wikipedia.multiplier).toBeCloseTo(1 + EXPLORATION_BONUS);
    expect(recovered.general.sources.wikipedia.multiplier).toBeGreaterThan(
      recovered.general.sources.google.multiplier,
    );
  });
});

describe('configured database path outside the managed directory', () => {
  it('creates the parent of an absolute database path instead of failing with SQLITE_CANTOPEN', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hela-feedback-path-'));
    // A nested path that does not exist yet: mimicking GUARDIAN_CENTRAL_DB pointing
    // at ~/memory/memory.db on a machine where ~/memory was never created.
    const nested = join(directory, 'not', 'yet', 'created', 'memory.db');
    const manager = new SQLiteManager(directory);
    try {
      const result = await manager.executeSql(nested, 'SELECT 1 AS ok');
      expect(result.success).toBe(true);
      expect(existsSync(nested)).toBe(true);
    } finally {
      await manager.closeAllConnections();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
