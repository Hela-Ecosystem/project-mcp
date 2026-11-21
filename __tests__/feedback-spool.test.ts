import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestFeedbackSpool, parseSpoolLines } from '../src/feedback-spool.js';

describe('feedback spool', () => {
  let directory: string;
  let spool: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'genome-spool-'));
    spool = join(directory, 'search-feedback.jsonl');
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  test('parses valid lines and counts malformed ones', () => {
    const { records, skipped } = parseSpoolLines([
      JSON.stringify({ query_class: 'technical', source: 'google', used: true }),
      'not json',
      JSON.stringify({ source: 'google' }),
      '',
    ].join('\n'));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ query_class: 'technical', source: 'google', used: true });
    expect(skipped).toBe(2);
  });

  test('imports a spool and removes the claimed file', async () => {
    writeFileSync(spool, [
      JSON.stringify({ query_class: 'technical', source: 'google', used: true }),
      JSON.stringify({ query_class: 'news', source: 'news_monitor', used: false }),
    ].join('\n') + '\n');

    const seen: any[] = [];
    const result = await ingestFeedbackSpool(async (record) => { seen.push(record); }, spool);

    expect(result).toEqual({ imported: 2, skipped: 0, failed: 0 });
    expect(seen.map(record => record.source)).toEqual(['google', 'news_monitor']);
    expect(existsSync(spool)).toBe(false);
  });

  test('a missing spool is a no-op', async () => {
    const result = await ingestFeedbackSpool(async () => {}, join(directory, 'absent.jsonl'));
    expect(result).toEqual({ imported: 0, skipped: 0, failed: 0 });
  });

  test('failed inserts go back to the spool rather than being lost', async () => {
    writeFileSync(spool, JSON.stringify({ query_class: 'technical', source: 'google', used: true }) + '\n');
    const result = await ingestFeedbackSpool(async () => { throw new Error('database is locked'); }, spool);
    expect(result.imported).toBe(0);
    expect(result.failed).toBe(1);
    expect(existsSync(spool)).toBe(true);
    expect(readFileSync(spool, 'utf8')).toContain('"source":"google"');
  });
});
