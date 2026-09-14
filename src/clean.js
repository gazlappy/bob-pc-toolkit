'use strict';

// Disk cleanup: scan known junk locations, report what is there, and only
// remove what the user has explicitly ticked.
//
// Two rules keep this safe:
//   1. The renderer never sends a path. It sends a target id, and the paths are
//      resolved here from the table below.
//   2. Every path is checked against PROTECTED before anything is deleted, so a
//      badly expanded glob can never take out a drive root or C:\Windows.

const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const ps = require('./ps');
const walker = require('./walk');

const home = os.homedir();
const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
const windir = process.env.SystemRoot || 'C:\\Windows';
const programData = process.env.ProgramData || 'C:\\ProgramData';
const systemDrive = process.env.SystemDrive || 'C:';

// Directories that must never be emptied, whatever a glob expands to.
const PROTECTED = new Set(
  [
    systemDrive + '\\',
    windir,
    path.join(windir, 'System32'),
    path.join(windir, 'SysWOW64'),
    home,
    path.dirname(home),
    localAppData,
    appData,
    programData,
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ].map((p) => path.resolve(p).toLowerCase().replace(/\\+$/, '') || p.toLowerCase())
);

// mode 'contents' empties a folder but keeps the folder itself.
// mode 'files'    removes only the files matching the final path segment.
const TARGETS = [
  {
    id: 'user-temp',
    label: 'Your temporary files',
    description: 'Scratch files left behind by apps and installers in your profile.',
    group: 'Windows',
    safety: 'Safe. Windows and apps recreate these on demand.',
    paths: [
      { path: path.join(localAppData, 'Temp'), mode: 'contents' },
      { path: os.tmpdir(), mode: 'contents' },
    ],
  },
  {
    id: 'windows-temp',
    label: 'System temporary files',
    description: 'The machine-wide temp folder used by services and installers.',
    group: 'Windows',
    needsAdmin: true,
    safety: 'Safe. Files still in use are skipped automatically.',
    paths: [{ path: path.join(windir, 'Temp'), mode: 'contents' }],
  },
  {
    id: 'windows-update',
    label: 'Windows Update cache',
    description: 'Downloaded update packages that have already been installed.',
    group: 'Windows',
    needsAdmin: true,
    safety: 'Safe, and often the biggest single win. Windows re-downloads if it ever needs them again.',
    paths: [{ path: path.join(windir, 'SoftwareDistribution', 'Download'), mode: 'contents' }],
  },
  {
    id: 'delivery-optimisation',
    label: 'Delivery Optimisation cache',
    description: 'Update files Windows keeps around to share with other PCs on your network.',
    group: 'Windows',
    needsAdmin: true,
    safety: 'Safe.',
    paths: [
      {
        path: path.join(
          windir,
          'ServiceProfiles',
          'NetworkService',
          'AppData',
          'Local',
          'Microsoft',
          'Windows',
          'DeliveryOptimization',
          'Cache'
        ),
        mode: 'contents',
      },
    ],
  },
  {
    id: 'prefetch',
    label: 'Prefetch data',
    description: 'Launch-timing data Windows collects to speed up app startup.',
    group: 'Windows',
    needsAdmin: true,
    safety: 'Safe, but not worth much. Apps may open slightly slower the first time after clearing.',
    paths: [{ path: path.join(windir, 'Prefetch', '*.pf'), mode: 'files' }],
  },
  {
    id: 'crash-dumps',
    label: 'Crash dumps and error reports',
    description: 'Memory dumps and Windows Error Reporting queues from crashed programs.',
    group: 'Windows',
    safety: 'Safe unless you are actively debugging a crash.',
    paths: [
      { path: path.join(localAppData, 'CrashDumps'), mode: 'contents' },
      { path: path.join(localAppData, 'Microsoft', 'Windows', 'WER', 'ReportArchive'), mode: 'contents' },
      { path: path.join(localAppData, 'Microsoft', 'Windows', 'WER', 'ReportQueue'), mode: 'contents' },
      { path: path.join(programData, 'Microsoft', 'Windows', 'WER', 'ReportArchive'), mode: 'contents' },
      { path: path.join(programData, 'Microsoft', 'Windows', 'WER', 'ReportQueue'), mode: 'contents' },
      { path: path.join(windir, 'Minidump'), mode: 'contents', needsAdmin: true },
    ],
  },
  {
    id: 'thumbnails',
    label: 'Thumbnail and icon cache',
    description: 'Explorer’s cached picture thumbnails and program icons.',
    group: 'Windows',
    safety: 'Safe. Explorer rebuilds these, though files in use will be skipped until you sign out.',
    paths: [
      { path: path.join(localAppData, 'Microsoft', 'Windows', 'Explorer', 'thumbcache_*.db'), mode: 'files' },
      { path: path.join(localAppData, 'Microsoft', 'Windows', 'Explorer', 'iconcache_*.db'), mode: 'files' },
    ],
  },
  {
    id: 'chrome-cache',
    label: 'Chrome cache',
    description: 'Cached pages and images. Bookmarks, passwords, history and logins are untouched.',
    group: 'Browsers',
    safety: 'Safe. Sites will load a little slower the first time.',
    paths: [
      { path: path.join(localAppData, 'Google', 'Chrome', 'User Data', '*', 'Cache', 'Cache_Data'), mode: 'contents' },
      { path: path.join(localAppData, 'Google', 'Chrome', 'User Data', '*', 'Code Cache'), mode: 'contents' },
      { path: path.join(localAppData, 'Google', 'Chrome', 'User Data', '*', 'GPUCache'), mode: 'contents' },
      { path: path.join(localAppData, 'Google', 'Chrome', 'User Data', 'ShaderCache'), mode: 'contents' },
    ],
  },
  {
    id: 'edge-cache',
    label: 'Edge cache',
    description: 'Cached pages and images. Bookmarks, passwords, history and logins are untouched.',
    group: 'Browsers',
    safety: 'Safe. Sites will load a little slower the first time.',
    paths: [
      { path: path.join(localAppData, 'Microsoft', 'Edge', 'User Data', '*', 'Cache', 'Cache_Data'), mode: 'contents' },
      { path: path.join(localAppData, 'Microsoft', 'Edge', 'User Data', '*', 'Code Cache'), mode: 'contents' },
      { path: path.join(localAppData, 'Microsoft', 'Edge', 'User Data', '*', 'GPUCache'), mode: 'contents' },
      { path: path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'ShaderCache'), mode: 'contents' },
    ],
  },
  {
    id: 'firefox-cache',
    label: 'Firefox cache',
    description: 'Cached pages and images. Your profile, logins and history are untouched.',
    group: 'Browsers',
    safety: 'Safe.',
    paths: [
      { path: path.join(localAppData, 'Mozilla', 'Firefox', 'Profiles', '*', 'cache2'), mode: 'contents' },
      { path: path.join(localAppData, 'Mozilla', 'Firefox', 'Profiles', '*', 'startupCache'), mode: 'contents' },
    ],
  },
  {
    id: 'brave-cache',
    label: 'Brave cache',
    description: 'Cached pages and images. Bookmarks, passwords and logins are untouched.',
    group: 'Browsers',
    safety: 'Safe.',
    paths: [
      {
        path: path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data', '*', 'Cache', 'Cache_Data'),
        mode: 'contents',
      },
      {
        path: path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data', '*', 'Code Cache'),
        mode: 'contents',
      },
    ],
  },
  {
    id: 'recycle-bin',
    label: 'Recycle Bin',
    description: 'Everything you have already deleted, across all drives.',
    group: 'Other',
    special: 'recycle-bin',
    safety: 'This is the last stop — emptying it is permanent.',
    warn: true,
    paths: [],
  },
];

const byId = new Map(TARGETS.map((target) => [target.id, target]));

function isProtected(candidate) {
  const normalised = path.resolve(candidate).toLowerCase().replace(/\\+$/, '');
  if (normalised.length < 8) return true;
  return PROTECTED.has(normalised) || PROTECTED.has(normalised + '\\');
}

// Expands a single '*' segment (no '**' support — nothing here needs it).
async function expand(pattern) {
  const segments = path.resolve(pattern).split(path.sep);
  let results = [segments.shift() + path.sep];

  for (const segment of segments) {
    if (!segment) continue;
    if (!segment.includes('*')) {
      results = results.map((base) => path.join(base, segment));
      continue;
    }
    const matcher = new RegExp(
      '^' + segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
      'i'
    );
    const next = [];
    for (const base of results) {
      let children;
      try {
        children = await fs.readdir(base, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        if (matcher.test(child.name)) next.push(path.join(base, child.name));
      }
    }
    results = next;
    if (!results.length) return [];
  }

  return results;
}

const sizeOf = walker.measure;

// Resolves a target's globs to real, existing, non-protected paths.
async function resolvePaths(target) {
  const resolved = [];
  // %TEMP% and %LOCALAPPDATA%\Temp are normally the same folder, so paths are
  // deduplicated to keep from counting or clearing anything twice.
  const seen = new Set();

  for (const entry of target.paths) {
    for (const candidate of await expand(entry.path)) {
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      if (entry.mode === 'contents' && isProtected(candidate)) continue;
      try {
        await fs.lstat(candidate);
      } catch {
        continue;
      }
      seen.add(key);
      resolved.push({ path: candidate, mode: entry.mode });
    }
  }
  return resolved;
}

async function recycleBinStats() {
  const data = await ps.json(`
$total = 0.0
$count = 0
Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction SilentlyContinue | ForEach-Object {
  $bin = Join-Path $_.DeviceID '$Recycle.Bin'
  if (Test-Path -LiteralPath $bin) {
    Get-ChildItem -LiteralPath $bin -Recurse -Force -File -ErrorAction SilentlyContinue | ForEach-Object {
      if ($_.Name -ne 'desktop.ini') {
        $total += [double]$_.Length
        $count += 1
      }
    }
  }
}
[pscustomobject]@{ bytes = $total; files = $count } | ConvertTo-Json -Compress
`);
  return { bytes: Number((data && data.bytes) || 0), files: Number((data && data.files) || 0) };
}

async function scanTarget(target) {
  const summary = {
    id: target.id,
    label: target.label,
    description: target.description,
    group: target.group,
    safety: target.safety,
    warn: Boolean(target.warn),
    needsAdmin: Boolean(target.needsAdmin),
    bytes: 0,
    files: 0,
    locations: [],
  };

  if (target.special === 'recycle-bin') {
    Object.assign(summary, await recycleBinStats().catch(() => ({ bytes: 0, files: 0 })));
    summary.locations = ['All drives'];
    return summary;
  }

  const resolved = await resolvePaths(target);
  const sizes = await Promise.all(resolved.map((entry) => sizeOf(entry.path)));
  resolved.forEach((entry, index) => {
    summary.bytes += sizes[index].bytes;
    summary.files += sizes[index].files;
    summary.locations.push(entry.path);
  });
  return summary;
}

// Targets are scanned concurrently: most are tiny and finish instantly, so
// running them in series meant waiting on the temp folder before even looking
// at the browser caches.
async function scan(onProgress) {
  const results = new Array(TARGETS.length);
  let done = 0;

  await walker.pool(
    TARGETS.map((target, index) => ({ target, index })),
    6,
    async ({ target, index }) => {
      results[index] = await scanTarget(target);
      done += 1;
      if (onProgress) onProgress({ index: done, total: TARGETS.length, label: target.label });
    }
  );

  if (onProgress) onProgress({ index: TARGETS.length, total: TARGETS.length, label: 'Done' });
  return results;
}

async function removePath(target, report) {
  const before = await sizeOf(target);
  try {
    await fs.rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 60 });
  } catch {
    /* fall through to the re-measure below */
  }
  const after = await sizeOf(target);
  report.bytes += Math.max(0, before.bytes - after.bytes);
  report.files += Math.max(0, before.files - after.files);
  if (after.files > 0 || after.bytes > 0) report.skipped += after.files || 1;
}

async function clean(ids, onProgress) {
  const selected = ids.map((id) => byId.get(id)).filter(Boolean);
  const report = { bytes: 0, files: 0, skipped: 0, targets: [] };

  for (let index = 0; index < selected.length; index += 1) {
    const target = selected[index];
    if (onProgress) onProgress({ index, total: selected.length, label: target.label });

    const before = { bytes: report.bytes, files: report.files };

    if (target.special === 'recycle-bin') {
      const stats = await recycleBinStats().catch(() => ({ bytes: 0, files: 0 }));
      await ps
        .mutate(`Clear-RecycleBin -Force -Confirm:$false -ErrorAction SilentlyContinue`)
        .catch(() => {});
      const after = await recycleBinStats().catch(() => ({ bytes: 0, files: 0 }));
      report.bytes += Math.max(0, stats.bytes - after.bytes);
      report.files += Math.max(0, stats.files - after.files);
    } else {
      for (const resolved of await resolvePaths(target)) {
        if (resolved.mode === 'contents') {
          if (isProtected(resolved.path)) continue;
          let children;
          try {
            children = await fs.readdir(resolved.path, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const child of children) {
            await removePath(path.join(resolved.path, child.name), report);
          }
        } else {
          await removePath(resolved.path, report);
        }
      }
    }

    report.targets.push({
      id: target.id,
      label: target.label,
      bytes: report.bytes - before.bytes,
      files: report.files - before.files,
    });
  }

  if (onProgress) onProgress({ index: selected.length, total: selected.length, label: 'Done' });
  return report;
}

// Exposed so the guard and the delete accounting can be exercised against a
// sandbox folder rather than against real cleanup locations.
const _internals = { isProtected, expand, resolvePaths, removePath, sizeOf };

module.exports = { scan, clean, TARGETS, _internals };
