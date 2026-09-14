'use strict';

// Finds files whose contents are byte-for-byte identical.
//
// Hashing everything would be unbearably slow, so candidates are narrowed in
// three passes, each cheaper than the one after it:
//
//   1. group by exact size   — no reads at all; most files are unique by size
//   2. hash the first 64 KB  — one short read; separates same-size-different-file
//   3. hash the whole file   — only ever runs on files that survived both
//
// On a real Downloads/Desktop pair this takes the work from "hash every byte"
// down to hashing a few percent of them.
//
// Nothing is ever deleted outright: copies go to the Recycle Bin, and a group
// can never have every one of its copies removed at once.

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const walker = require('./walk');
const files = require('./files');

const PARTIAL_BYTES = 64 * 1024;
const HASH_CONCURRENCY = 8;
const MAX_GROUPS = 300;

/**
 * Folders whose duplicates are meant to be there. Deleting a copy out of
 * node_modules or a .git object store breaks the thing that owns it, and these
 * are exactly what a Documents folder full of code projects is made of.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '__pycache__',
  'venv',
  '.venv',
  'obj',
  'bin',
  '$recycle.bin',
  'system volume information',
]);

/** SHA-256 of a file, or of its first `limit` bytes. Null if unreadable. */
function hashFile(filePath, limit = Infinity) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    const options = limit === Infinity ? {} : { start: 0, end: limit - 1 };
    const stream = fs.createReadStream(filePath, options);

    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', () => resolve(null)); // locked, vanished, or no permission
  });
}

/** Splits a list into buckets by a key, dropping any bucket with one member. */
async function regroup(groups, keyOf) {
  const out = [];
  for (const group of groups) {
    const buckets = new Map();
    for (const file of group) {
      const key = await keyOf(file);
      if (key === null) continue; // unreadable — cannot be proven a duplicate
      const bucket = buckets.get(key);
      if (bucket) bucket.push(file);
      else buckets.set(key, [file]);
    }
    for (const bucket of buckets.values()) {
      if (bucket.length > 1) out.push(bucket);
    }
  }
  return out;
}

let lastScan = { groups: [], byPath: new Map() };

async function scan({ rootIds = [], minBytes = 1024 * 1024 } = {}, onProgress) {
  const roots = (await files.availableRoots()).filter((root) => rootIds.includes(root.id));
  if (!roots.length) throw new Error('Pick at least one folder to search.');

  const report = (payload) => onProgress && onProgress(payload);

  // --- pass 1: collect, grouped by size -----------------------------------
  report({ phase: 'listing', scanned: 0, candidates: 0 });

  const bySize = new Map();
  let scanned = 0;

  await Promise.all(
    roots.map((root) =>
      walker.walk(
        root.path,
        (full, stats) => {
          scanned += 1;
          if (scanned % 2000 === 0) report({ phase: 'listing', scanned, candidates: bySize.size });
          if (stats.size < minBytes) return;

          const entry = {
            path: full,
            name: path.basename(full),
            folder: path.dirname(full),
            root: root.label,
            bytes: stats.size,
            modified: stats.mtimeMs,
          };
          const bucket = bySize.get(stats.size);
          if (bucket) bucket.push(entry);
          else bySize.set(stats.size, [entry]);
        },
        {
          shouldEnter: (dir) => !SKIP_DIRS.has(path.basename(dir).toLowerCase()),
        }
      )
    )
  );

  let groups = [...bySize.values()].filter((group) => group.length > 1);
  const sameSizeFiles = groups.reduce((sum, group) => sum + group.length, 0);

  // --- pass 2: first 64 KB ------------------------------------------------
  let hashed = 0;
  const tick = (phase, total) => {
    hashed += 1;
    if (hashed % 25 === 0) report({ phase, scanned, done: hashed, total });
  };

  report({ phase: 'sampling', scanned, done: 0, total: sameSizeFiles });
  const partialCache = new Map();
  await walker.pool(
    groups.flat(),
    HASH_CONCURRENCY,
    async (file) => {
      partialCache.set(file.path, await hashFile(file.path, PARTIAL_BYTES));
      tick('sampling', sameSizeFiles);
    }
  );
  groups = await regroup(groups, (file) => partialCache.get(file.path) ?? null);

  // --- pass 3: whole file -------------------------------------------------
  const toHash = groups.flat();
  // A file smaller than the sample was already read end to end in pass 2.
  const needFullHash = toHash.filter((file) => file.bytes > PARTIAL_BYTES);

  hashed = 0;
  report({ phase: 'hashing', scanned, done: 0, total: needFullHash.length });
  const fullCache = new Map();
  await walker.pool(needFullHash, HASH_CONCURRENCY, async (file) => {
    fullCache.set(file.path, await hashFile(file.path));
    tick('hashing', needFullHash.length);
  });
  groups = await regroup(groups, (file) =>
    file.bytes > PARTIAL_BYTES ? (fullCache.get(file.path) ?? null) : (partialCache.get(file.path) ?? null)
  );

  // --- results ------------------------------------------------------------
  const result = groups
    .map((group) => {
      const sorted = [...group].sort((a, b) => a.modified - b.modified);
      return {
        id: `${sorted[0].bytes}:${fullCache.get(sorted[0].path) ?? partialCache.get(sorted[0].path)}`,
        bytes: sorted[0].bytes,
        count: sorted.length,
        // Keeping one copy is the point, so only the extras count as waste.
        wastedBytes: sorted[0].bytes * (sorted.length - 1),
        files: sorted,
      };
    })
    .sort((a, b) => b.wastedBytes - a.wastedBytes);

  const shown = result.slice(0, MAX_GROUPS);

  lastScan = { groups: shown, byPath: new Map() };
  for (const group of shown) {
    for (const file of group.files) lastScan.byPath.set(file.path.toLowerCase(), group.id);
  }

  report({ phase: 'done', scanned });

  return {
    groups: shown,
    totalGroups: result.length,
    truncated: result.length > shown.length,
    duplicateFiles: result.reduce((sum, group) => sum + group.count - 1, 0),
    wastedBytes: result.reduce((sum, group) => sum + group.wastedBytes, 0),
    scannedFiles: scanned,
    sameSizeFiles,
    fullyHashed: needFullHash.length,
  };
}

/**
 * Moves the given copies to the Recycle Bin.
 *
 * Refuses outright if the selection would empty a group — losing every copy of
 * a file is the one mistake this screen must not allow, and checking it here
 * rather than only in the UI means a stale selection cannot slip past.
 */
async function trash(paths) {
  const remaining = new Map();
  for (const group of lastScan.groups) remaining.set(group.id, group.files.length);

  for (const candidate of paths) {
    const groupId = lastScan.byPath.get(String(candidate).toLowerCase());
    if (groupId === undefined) continue;
    remaining.set(groupId, remaining.get(groupId) - 1);
  }

  const emptied = [...remaining.entries()].filter(([, left]) => left <= 0);
  if (emptied.length > 0) {
    throw new Error(
      `That would delete every copy in ${emptied.length} group${emptied.length === 1 ? '' : 's'}. ` +
        'Leave at least one copy of each file.'
    );
  }

  const outcome = await files.trash(paths);

  // Drop what actually went, so a second pass sees the real remaining counts.
  const gone = new Set(outcome.moved.map((p) => p.toLowerCase()));
  for (const group of lastScan.groups) {
    group.files = group.files.filter((file) => !gone.has(file.path.toLowerCase()));
    group.count = group.files.length;
    group.wastedBytes = group.bytes * Math.max(0, group.files.length - 1);
  }
  lastScan.groups = lastScan.groups.filter((group) => group.files.length > 1);

  return outcome;
}

module.exports = { scan, trash, __internals: { hashFile, SKIP_DIRS } };
