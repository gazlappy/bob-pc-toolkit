'use strict';

// Finds large or long-forgotten files in the folders where clutter collects.
// Nothing here is ever deleted outright — the only action is "move to the
// Recycle Bin", so anything removed by mistake can be put back.

const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { shell } = require('electron');
const ps = require('./ps');
const walker = require('./walk');

const home = os.homedir();

// These folders are frequently redirected — OneDrive moves Desktop, Documents
// and Pictures out of the profile — so the real location is read from Windows
// rather than assumed to sit under the home directory. Downloads has no
// .NET SpecialFolder, so it comes from its known-folder GUID in the registry.
const ROOTS = [
  { id: 'downloads', label: 'Downloads', default: true, guid: '{374DE290-123F-4565-9164-39C4925E467B}', fallback: 'Downloads' },
  { id: 'desktop', label: 'Desktop', default: true, special: 'Desktop', fallback: 'Desktop' },
  { id: 'documents', label: 'Documents', default: false, special: 'MyDocuments', fallback: 'Documents' },
  { id: 'videos', label: 'Videos', default: false, special: 'MyVideos', fallback: 'Videos' },
  { id: 'pictures', label: 'Pictures', default: false, special: 'MyPictures', fallback: 'Pictures' },
];

const MAX_DEPTH = 8;
const MAX_ENTRIES = 200000;
const MAX_RESULTS = 400;

let resolvedPaths = null;

async function resolveKnownFolders() {
  if (resolvedPaths) return resolvedPaths;

  const paths = {};
  try {
    const data = await ps.json(`
$shellFolders = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'
$result = @{}
${ROOTS.filter((root) => root.special)
  .map((root) => `$result['${root.id}'] = [Environment]::GetFolderPath('${root.special}')`)
  .join('\n')}
${ROOTS.filter((root) => root.guid)
  .map(
    (root) =>
      `$raw = (Get-ItemProperty -LiteralPath $shellFolders -Name '${root.guid}' -ErrorAction SilentlyContinue).'${root.guid}'
if ($raw) { $result['${root.id}'] = [Environment]::ExpandEnvironmentVariables($raw) }`
  )
  .join('\n')}
[pscustomobject]$result | ConvertTo-Json -Compress
`);
    for (const [id, value] of Object.entries(data || {})) {
      if (typeof value === 'string' && value.trim()) paths[id] = value.trim();
    }
  } catch {
    /* fall back to the profile-relative guesses below */
  }

  resolvedPaths = paths;
  return paths;
}

async function availableRoots() {
  const known = await resolveKnownFolders();
  const found = [];
  const seen = new Set();

  for (const root of ROOTS) {
    const target = known[root.id] || path.join(home, root.fallback);
    const key = path.resolve(target).toLowerCase();
    if (seen.has(key)) continue;
    try {
      const stat = await fs.stat(target);
      if (!stat.isDirectory()) continue;
    } catch {
      continue; // moved, removed, or an offline OneDrive folder
    }
    seen.add(key);
    found.push({ id: root.id, label: root.label, path: target, default: root.default });
  }

  return found;
}

async function scan(
  { rootIds = ['downloads', 'desktop'], minBytes = 100 * 1024 * 1024, olderThanDays = 0 } = {},
  onProgress
) {
  const roots = (await availableRoots()).filter((root) => rootIds.includes(root.id));
  const cutoff = olderThanDays > 0 ? Date.now() - olderThanDays * 86400000 : null;

  const results = [];
  let truncated = false;

  // Roots are walked concurrently, and each walk is itself concurrent — the
  // sequential version spent almost all its time waiting on one stat at a time.
  // A folder synced by OneDrive can hold six figures of files, so the count is
  // reported as it climbs rather than leaving the view on a bare "Scanning…".
  let seen = 0;
  let lastReport = 0;
  const tick = (folder) => {
    seen += 1;
    if (onProgress && seen - lastReport >= 2000) {
      lastReport = seen;
      onProgress({ seen, matched: results.length, folder });
    }
  };

  await Promise.all(
    roots.map(async (root) => {
      const outcome = await walker.walk(
        root.path,
        (full, stats, dir) => {
          tick(dir);
          if (stats.size < minBytes) return;
          const lastUsed = Math.max(stats.mtimeMs, stats.atimeMs);
          if (cutoff !== null && lastUsed > cutoff) return;
          results.push({
            path: full,
            name: path.basename(full),
            folder: dir,
            root: root.label,
            bytes: stats.size,
            modified: stats.mtimeMs,
            lastUsed,
          });
        },
        { maxDepth: MAX_DEPTH, maxEntries: MAX_ENTRIES }
      );
      if (outcome.truncated) truncated = true;
    })
  );

  results.sort((a, b) => b.bytes - a.bytes);
  return {
    files: results.slice(0, MAX_RESULTS),
    total: results.length,
    totalBytes: results.reduce((sum, file) => sum + file.bytes, 0),
    truncated: truncated || results.length > MAX_RESULTS,
    roots: roots.map((root) => root.path),
  };
}

// Moves the given files to the Recycle Bin. Only paths inside one of the known
// roots are accepted, so a stray path from the UI cannot reach anywhere else.
async function trash(paths) {
  const roots = (await availableRoots()).map((root) => root.path.toLowerCase());
  const moved = [];
  const failed = [];

  for (const candidate of paths) {
    const resolved = path.resolve(candidate);
    const inRoot = roots.some(
      (root) => resolved.toLowerCase() === root || resolved.toLowerCase().startsWith(root + path.sep)
    );
    if (!inRoot) {
      failed.push({ path: candidate, error: 'Outside the scanned folders.' });
      continue;
    }
    try {
      await shell.trashItem(resolved);
      moved.push(resolved);
    } catch (error) {
      failed.push({ path: candidate, error: error.message });
    }
  }

  return { moved, failed };
}

function reveal(target) {
  shell.showItemInFolder(path.resolve(target));
  return true;
}

module.exports = { scan, trash, reveal, availableRoots };
