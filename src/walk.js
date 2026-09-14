'use strict';

// A concurrent directory walker.
//
// The obvious version — readdir, then await stat on each child in turn — spends
// nearly all its time idle: a stat is well under a millisecond, but tens of
// thousands of them in series added up to eighteen seconds on a real Desktop.
// Walking a level at a time with a pool of in-flight operations turns that into
// roughly a second, because the OS can service many at once.

const fs = require('fs/promises');
const path = require('path');

const DIR_CONCURRENCY = 24;
const FILE_CONCURRENCY = 96;

// Runs `worker` over `items` with at most `limit` in flight at once.
async function pool(items, limit, worker) {
  if (!items.length) return;
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

/**
 * Walks `root` breadth-first, calling visit(fullPath, stats, parentDir) for each
 * file. Unreadable directories and files that vanish mid-walk are skipped
 * silently — on a live system that is normal, not exceptional.
 *
 * Symlinks and junctions are never followed, which also rules out cycles.
 *
 * @param {string} root
 * @param {(fullPath: string, stats: import('fs').Stats, dir: string) => void} visit
 * @param {{maxDepth?: number, maxEntries?: number, shouldEnter?: (dir: string) => boolean}} [options]
 * @returns {Promise<{entries: number, truncated: boolean}>}
 */
async function walk(root, visit, options = {}) {
  const { maxDepth = Infinity, maxEntries = Infinity, shouldEnter } = options;

  let level = [{ dir: root, depth: 0 }];
  let entries = 0;
  let truncated = false;

  while (level.length && !truncated) {
    const next = [];

    await pool(level, DIR_CONCURRENCY, async ({ dir, depth }) => {
      if (truncated) return;

      let children;
      try {
        children = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // permission denied, or it disappeared
      }

      const filesHere = [];
      for (const child of children) {
        if (child.isSymbolicLink()) continue;
        if (child.isDirectory()) {
          const full = path.join(dir, child.name);
          if (depth < maxDepth && (!shouldEnter || shouldEnter(full))) {
            next.push({ dir: full, depth: depth + 1 });
          }
        } else {
          filesHere.push(child.name);
        }
      }

      entries += children.length;
      if (entries > maxEntries) truncated = true;

      await pool(filesHere, FILE_CONCURRENCY, async (name) => {
        const full = path.join(dir, name);
        let stats;
        try {
          stats = await fs.lstat(full);
        } catch {
          return;
        }
        visit(full, stats, dir);
      });
    });

    level = next;
  }

  return { entries, truncated };
}

/** Total bytes and file count beneath `target`, or its own size if it is a file. */
async function measure(target) {
  const totals = { bytes: 0, files: 0 };

  let stats;
  try {
    stats = await fs.lstat(target);
  } catch {
    return totals;
  }

  if (!stats.isDirectory()) {
    totals.bytes = stats.size;
    totals.files = 1;
    return totals;
  }

  await walk(target, (_full, fileStats) => {
    totals.bytes += fileStats.size;
    totals.files += 1;
  });

  return totals;
}

module.exports = { walk, measure, pool };
