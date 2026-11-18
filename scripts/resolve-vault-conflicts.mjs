#!/usr/bin/env node
/**
 * Resolve or inventory Genome vault-mirror conflicts.
 *
 * The conflict-aware sync archives every divergent variant instead of picking a
 * winner. That is the right default — choosing wrong destroys an edit — but it
 * leaves a queue. This tool splits the queue by what can be decided safely:
 *
 *   frontmatter-only  bodies identical, only timestamps/hashes differ
 *                     -> keep the newest variant (default), body is unchanged
 *   body-divergent    real differences -> review sheet, never auto-picked
 *
 * Default is a dry run. Writes require --apply, and every touched note is
 * copied into `.hela-sync/resolved/<sha>/` before it changes.
 *
 * Usage:
 *   node scripts/resolve-vault-conflicts.mjs --vault <path> [--apply] [--sheet <file>] [--json]
 */

import fs from 'node:fs';
import path from 'node:path';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseArgs(argv) {
  const options = { apply: false, json: false, sheet: null, vault: process.env.HELA_GENOME_OBSIDIAN_VAULT ?? null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--sheet') options.sheet = argv[++i];
    else if (arg === '--vault') options.vault = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.vault) throw new Error('Provide --vault <path> or set HELA_GENOME_OBSIDIAN_VAULT');
  if (!fs.existsSync(path.join(options.vault, '.hela-sync', 'conflicts'))) {
    throw new Error(`No .hela-sync/conflicts under ${options.vault}`);
  }
  return options;
}

function splitFrontmatter(text) {
  const match = text.match(FRONTMATTER);
  if (!match) return { frontmatter: '', body: text };
  return { frontmatter: match[1], body: text.slice(match[0].length) };
}

function updatedAt(frontmatter) {
  const match = frontmatter.match(/^updated:\s*"?([^"\n]+)"?\s*$/m);
  return match ? Date.parse(match[1].trim()) : NaN;
}

function newestVariants(variants) {
  return [...variants].sort((a, b) => {
    const byDate = (Number.isNaN(b.updated) ? 0 : b.updated) - (Number.isNaN(a.updated) ? 0 : a.updated);
    return byDate || b.mtime - a.mtime;
  });
}

function readConflicts(conflictRoot) {
  const entries = [];
  for (const directory of fs.readdirSync(conflictRoot, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const dir = path.join(conflictRoot, directory.name);
    const manifestFile = fs.readdirSync(dir).find((name) => name.endsWith('.json'));
    let manifest = {};
    if (manifestFile) {
      try { manifest = JSON.parse(fs.readFileSync(path.join(dir, manifestFile), 'utf8')); } catch { /* keep defaults */ }
    }
    const variants = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.bin'))
      .map((name) => {
        const file = path.join(dir, name);
        const text = fs.readFileSync(file, 'utf8');
        const { frontmatter, body } = splitFrontmatter(text);
        return { name, file, text, body, updated: updatedAt(frontmatter), mtime: fs.statSync(file).mtimeMs };
      });
    entries.push({ id: directory.name, dir, manifest, variants });
  }
  return entries;
}

function classify(entry) {
  if (entry.manifest.deletion) return 'deletion';
  if (entry.variants.length === 0) return 'empty';
  if (entry.variants.length === 1) return 'single';
  const bodies = new Set(entry.variants.map((variant) => variant.body));
  return bodies.size === 1 ? 'frontmatter-only' : 'body-divergent';
}

function resolveFrontmatterOnly(entry, vault, apply) {
  const [winner] = newestVariants(entry.variants);
  const target = entry.manifest.path ? path.join(vault, entry.manifest.path) : null;
  if (!target) return { status: 'skipped', reason: 'manifest has no path' };
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  const currentBody = current === null ? null : splitFrontmatter(current).body;
  // The note on disk is the last synced state. Collapsing is only safe when its body
  // already equals a variant body: then the only thing changing is frontmatter. If the
  // note has moved on since (129 cases on the real vault), a blind write would revert
  // real content, so it goes back to review instead.
  const matchesVariantBody = currentBody !== null && entry.variants.some((variant) => variant.body === currentBody);
  const bodyUnchanged = currentBody === null || matchesVariantBody;
  if (!bodyUnchanged) {
    return { status: 'needs-review', path: entry.manifest.path, reason: 'current note body matches no archived variant' };
  }
  if (apply) {
    const archive = path.join(vault, '.hela-sync', 'resolved', entry.id);
    fs.mkdirSync(archive, { recursive: true });
    if (current !== null) fs.writeFileSync(path.join(archive, 'previous.md'), current, 'utf8');
    fs.writeFileSync(path.join(archive, 'chosen.bin'), winner.text, 'utf8');
    const manifestFile = fs.readdirSync(entry.dir).find((name) => name.endsWith('.json'));
    if (manifestFile) fs.copyFileSync(path.join(entry.dir, manifestFile), path.join(archive, manifestFile));
    // The note on disk already carries the same body. Rewriting it would roll its
    // frontmatter back to an older timestamp, so only archive the conflict.
    if (current !== null) {
      fs.rmSync(entry.dir, { recursive: true, force: true });
      return { status: 'archived', path: entry.manifest.path, bodyUnchanged, winner: winner.name };
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, winner.text, 'utf8');
    fs.rmSync(entry.dir, { recursive: true, force: true });
  }
  return { status: apply ? 'collapsed' : 'would-collapse', path: entry.manifest.path, bodyUnchanged, winner: winner.name };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const entries = readConflicts(path.join(options.vault, '.hela-sync', 'conflicts'));
  const buckets = { 'frontmatter-only': [], 'body-divergent': [], deletion: [], single: [], empty: [] };
  for (const entry of entries) buckets[classify(entry)].push(entry);

  const repeated = new Map();
  for (const entry of entries) {
    const key = entry.manifest.path ?? entry.id;
    repeated.set(key, (repeated.get(key) ?? 0) + 1);
  }
  const repeats = [...repeated.entries()].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1]);

  const collapsed = buckets['frontmatter-only'].map((entry) => resolveFrontmatterOnly(entry, options.vault, options.apply));
  const changedBody = collapsed.filter((item) => item.bodyUnchanged === false);
  const archivedOnly = collapsed.filter((item) => item.status === 'archived');
  const needsReview = collapsed.filter((item) => item.status === 'needs-review');

  const summary = {
    vault: options.vault,
    applied: options.apply,
    total: entries.length,
    frontmatterOnly: buckets['frontmatter-only'].length,
    bodyDivergent: buckets['body-divergent'].length,
    deletions: buckets.deletion.length,
    repeats: repeats.length,
    worstRepeat: repeats[0] ?? null,
    collapsed: collapsed.filter((item) => item.status === 'collapsed').length,
    wouldCollapse: collapsed.filter((item) => item.status === 'would-collapse').length,
    skipped: collapsed.filter((item) => item.status === 'skipped').length,
    archived: archivedOnly.length,
    needsReview: needsReview.length,
    bodyChangedSurprises: changedBody.length,
  };

  if (options.sheet) {
    const lines = [
      '# Vault conflict review sheet',
      '',
      `Generated ${new Date().toISOString()} from \`${path.join(options.vault, '.hela-sync', 'conflicts')}\`.`,
      '',
      'Bodies differ, so nothing here is auto-picked. Fill the decision column and apply it deliberately.',
      '',
      '| Note | Conflicts | Variants (bytes · updated) | Decision (local/remote/merge/keep-both) |',
      '| --- | --- | --- | --- |',
      ...needsReview.map((item) => ({ manifest: { path: item.path }, variants: [] })),
      ...buckets['body-divergent']
        .sort((a, b) => (repeated.get(b.manifest.path) ?? 0) - (repeated.get(a.manifest.path) ?? 0))
        .map((entry) => {
          const variants = entry.variants
            .map((variant) => `${variant.body.length}B${Number.isNaN(variant.updated) ? '' : ' · ' + new Date(variant.updated).toISOString().slice(0, 10)}`)
            .join(' / ');
          return `| \`${entry.manifest.path ?? entry.id}\` | ${repeated.get(entry.manifest.path) ?? 1} | ${variants} |  |`;
        }),
    ];
    fs.writeFileSync(options.sheet, lines.join('\n') + '\n');
  }

  if (options.json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`vault: ${summary.vault} (${options.apply ? 'APPLY' : 'dry run'})`);
    console.log(`conflicts: ${summary.total} — frontmatter-only ${summary.frontmatterOnly}, body-divergent ${summary.bodyDivergent}, deletions ${summary.deletions}`);
    console.log(`repeated notes: ${summary.repeats}${summary.worstRepeat ? ` (worst ${summary.worstRepeat[1]}x ${summary.worstRepeat[0]})` : ''}`);
    console.log(`${options.apply ? 'archived' : 'would archive'}: ${options.apply ? summary.archived : summary.wouldCollapse}; skipped ${summary.skipped}; needs review ${summary.needsReview}`);
    if (summary.bodyChangedSurprises > 0) {
      console.log(`WARNING: ${summary.bodyChangedSurprises} frontmatter-only conflicts had a body that did not match the current note; inspect resolved/ before trusting them`);
    }
    if (options.sheet) console.log(`review sheet: ${options.sheet} (${summary.bodyDivergent + summary.needsReview} rows)`);
    if (!options.apply) console.log('dry run only; pass --apply to collapse the frontmatter-only bucket');
  }
}

try {
  main();
} catch (error) {
  console.error(`[resolve-vault-conflicts] ${error.message}`);
  process.exitCode = 1;
}
