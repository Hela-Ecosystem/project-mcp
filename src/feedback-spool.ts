/**
 * Feedback spool ingestion.
 *
 * Enzyme observes which source actually produced a result a caller followed up on,
 * but it must not write the priors table: genome owns `source_feedback` and keeps
 * the writer single. So Enzyme appends one JSON line per observed decision to a
 * spool file, and genome drains it the next time priors are read or feedback is
 * recorded. One writer, one table, no cross-process SQLite writes.
 *
 * Claiming the file by rename means two concurrent genome processes cannot import
 * the same line twice; anything that fails to insert is put back for a later pass.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SpoolRecord {
  query_class: string;
  source: string;
  used: boolean;
  query?: string;
  note?: string;
}

export function feedbackSpoolPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.HELA_SEARCH_FEEDBACK_SPOOL
    || join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"), "hela", "search-feedback.jsonl");
}

export function parseSpoolLines(content: string): { records: SpoolRecord[]; skipped: number } {
  const records: SpoolRecord[] = [];
  let skipped = 0;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed?.query_class !== "string" || typeof parsed?.source !== "string") {
        skipped++;
        continue;
      }
      records.push({
        query_class: parsed.query_class,
        source: parsed.source,
        used: parsed.used !== false,
        query: typeof parsed.query === "string" ? parsed.query : undefined,
        note: typeof parsed.note === "string" ? parsed.note : undefined,
      });
    } catch {
      skipped++;
    }
  }
  return { records, skipped };
}

export async function ingestFeedbackSpool(
  record: (input: SpoolRecord) => Promise<unknown>,
  spoolPath: string = feedbackSpoolPath(),
): Promise<{ imported: number; skipped: number; failed: number }> {
  let content: string;
  try {
    content = await fs.readFile(spoolPath, "utf8");
  } catch {
    return { imported: 0, skipped: 0, failed: 0 };
  }

  const claim = `${spoolPath}.processing-${process.pid}`;
  try {
    await fs.rename(spoolPath, claim);
  } catch {
    // Another process claimed it first; it will import these lines.
    return { imported: 0, skipped: 0, failed: 0 };
  }

  const { records, skipped } = parseSpoolLines(content);
  let imported = 0;
  const failed: SpoolRecord[] = [];
  for (const item of records) {
    try {
      await record(item);
      imported++;
    } catch {
      failed.push(item);
    }
  }

  // Put failures back so a transient lock or schema race does not lose evidence.
  if (failed.length) {
    const lines = failed.map(item => JSON.stringify(item) + "\n").join("");
    try {
      await fs.appendFile(spoolPath, lines, { mode: 0o600 });
    } catch { /* the claim is still removed below; evidence loss is bounded to this file */ }
  }

  try {
    await fs.rm(claim, { force: true });
  } catch { /* best effort */ }

  return { imported, skipped, failed: failed.length };
}
