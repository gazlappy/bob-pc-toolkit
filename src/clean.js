'use strict';

// Disk cleanup: scan known junk locations, report what is there, and only
// remove what the user has explicitly ticked.
//
// Rules that keep this safe:
//   1. The renderer never sends a path. It sends a target id, and the paths are
//      resolved here from the table below.
//   2. Every path is checked against PROTECTED before anything is deleted, so a
//      badly expanded glob can never take out a drive root or C:\Windows.
//   3. Temp folders only lose items nothing has created or changed for a day,
//      and never the folder BOB itself is running from — an installer or app
//      part-way through using its temp files must not have them pulled away.
//   4. Run as administrator, per-user locations are cleaned in every profile on
//      the PC. A tech elevating with their own admin login on a customer's
//      standard account would otherwise clean the admin's profile, not theirs.
//   5. Where Windows has its own cleaner (Delivery Optimisation, Disk Cleanup's
//      handlers for Windows.old and upgrade files) that is used, not raw deletes.

const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const ps = require('./ps');
const walker = require('./walk');

const windir = process.env.SystemRoot || 'C:\\Windows';
const programData = process.env.ProgramData || 'C:\\ProgramData';
const systemDrive = process.env.SystemDrive || 'C:';
const HOUR = 3600 * 1000;

/* Context: who we are, which profiles, which drives ------------------------- */

const CONTEXT_SCRIPT = `
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$admin = ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$profiles = @(Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList' -ErrorAction SilentlyContinue | ForEach-Object {
  $sid = $_.PSChildName
  if ($sid -like 'S-1-5-21-*') {
    $p = (Get-ItemProperty -LiteralPath $_.PSPath -Name ProfileImagePath -ErrorAction SilentlyContinue).ProfileImagePath
    if ($p) { [pscustomobject]@{ sid = $sid; path = [Environment]::ExpandEnvironmentVariables([string]$p) } }
  }
})
$drives = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.DeviceID })
$procs = @(Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $_.ProcessName.ToLower() } | Sort-Object -Unique)
$do = $null
try { $do = [double](Get-DeliveryOptimizationPerfSnap -ErrorAction Stop).CacheSizeBytes } catch {}
$servicing = (Get-Service TrustedInstaller -ErrorAction SilentlyContinue).Status -eq 'Running'
[pscustomobject]@{
  admin = $admin; sid = [string]$id.User.Value; profiles = $profiles; drives = $drives
  procs = $procs; doBytes = $do; servicing = $servicing
} | ConvertTo-Json -Depth 4 -Compress
`;

async function exists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function getContext() {
  const raw = (await ps.json(CONTEXT_SCRIPT).catch(() => null)) || {};
  const admin = Boolean(raw.admin);
  const home = os.homedir();
  const current = {
    sid: raw.sid || '',
    home,
    local: process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
    roaming: process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
    current: true,
  };
  const profiles = [current];
  if (admin) {
    for (const p of ps.arr(raw.profiles)) {
      if (!p.path || p.path.toLowerCase() === home.toLowerCase() || !(await exists(p.path))) continue;
      profiles.push({
        sid: p.sid,
        home: p.path,
        local: path.join(p.path, 'AppData', 'Local'),
        roaming: path.join(p.path, 'AppData', 'Roaming'),
        current: false,
      });
    }
  }
  const drives = ps.arr(raw.drives).filter((d) => /^[A-Z]:$/i.test(d));
  return {
    admin,
    profiles,
    drives: drives.length ? drives : [systemDrive],
    procs: new Set(ps.arr(raw.procs)),
    doBytes: raw.doBytes == null ? null : Number(raw.doBytes),
    servicing: Boolean(raw.servicing),
  };
}

/* Guards -------------------------------------------------------------------- */

function norm(p) {
  return path.resolve(p).toLowerCase().replace(/\\+$/, '');
}

// Directories that must never be emptied or removed, whatever a glob expands to.
function protectedSet(ctx) {
  const list = [
    windir,
    path.join(windir, 'System32'),
    path.join(windir, 'SysWOW64'),
    programData,
    path.join(systemDrive + '\\', 'Users'),
    path.join(systemDrive + '\\', 'Program Files'),
    path.join(systemDrive + '\\', 'Program Files (x86)'),
  ];
  for (const p of (ctx && ctx.profiles) || []) list.push(p.home, p.local, p.roaming, path.join(p.home, 'AppData'));
  return new Set(list.map(norm));
}

function isProtected(candidate, ctx) {
  const n = norm(candidate);
  // Drive roots ("c:") and anything shallower than one folder under a drive.
  if (n.split('\\').filter(Boolean).length < 2) return true;
  return protectedSet(ctx).has(n);
}

// The folder this copy of BOB runs from — the portable build unpacks into
// %TEMP%, and emptying temp must not take its own files.
const OWN_DIRS = [path.dirname(process.execPath)].map(norm);

function holdsOwnFiles(candidate) {
  const n = norm(candidate);
  return OWN_DIRS.some((own) => own === n || own.startsWith(n + '\\'));
}

/* Target table -------------------------------------------------------------- */

// Entry modes:
//   'contents' empties a folder but keeps the folder itself.
//   'files'    removes only the files matching the final path segment.
//   'self'     removes the folder (or file) itself — only for fixed, known names.
// A target lists per-user entries (`user(profile)`, run for every profile in
// scope) and/or machine-wide entries (`machine(ctx)`).
//
// minAgeHours + ageScope:
//   'item' — a top-level item is only removed if nothing inside it was created
//            or changed within that time (temp folders, installer leftovers).
//   'file' — each file is judged on its own (logs).

const CHROMIUM_CACHE_DIRS = ['Cache\\Cache_Data', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache'];

function chromiumProfileCaches(userData) {
  const out = [];
  for (const sub of CHROMIUM_CACHE_DIRS) out.push({ path: path.join(userData, '*', sub), mode: 'contents' });
  for (const sub of ['ShaderCache', 'GrShaderCache', 'GraphiteDawnCache']) out.push({ path: path.join(userData, sub), mode: 'contents' });
  return out;
}

// Chromium/Electron caches have a recognisable layout; a folder that merely
// happens to be called "Cache" is not touched unless it matches.
async function looksLikeChromiumCache(dir) {
  let names;
  try {
    names = (await fs.readdir(dir)).map((n) => n.toLowerCase());
  } catch {
    return false;
  }
  if (/code cache$/i.test(dir)) return names.includes('js') || names.includes('wasm');
  return names.includes('index') || names.includes('index-dir');
}

// App folders under AppData already covered by their own row, or BOB's own.
const APP_CACHE_SKIP = new Set(['temp', 'packages', 'google', 'microsoft', 'mozilla', 'bravesoftware', 'opera software', 'vivaldi', 'chromium', 'pc cleanup', 'pc-cleanup', 'code', 'spotify', 'steam']);

const TARGETS = [
  {
    id: 'user-temp',
    label: 'Temporary files',
    description: 'Scratch files left behind by apps and installers.',
    group: 'Windows',
    safety: 'Safe. Only items nothing has used for a day are removed, so a running installer or app keeps what it is working on.',
    minAgeHours: 24,
    ageScope: 'item',
    exclude: holdsOwnFiles,
    user: (p) => [
      { path: path.join(p.local, 'Temp'), mode: 'contents' },
      ...(p.current ? [{ path: os.tmpdir(), mode: 'contents' }] : []),
    ],
  },
  {
    id: 'windows-temp',
    label: 'System temporary files',
    description: 'The machine-wide temp folder used by services and installers.',
    group: 'Windows',
    needsAdmin: true,
    safety: 'Safe. Only items untouched for a day are removed; files in use are skipped.',
    minAgeHours: 24,
    ageScope: 'item',
    machine: () => [{ path: path.join(windir, 'Temp'), mode: 'contents' }],
  },
  {
    id: 'windows-update',
    label: 'Windows Update downloads',
    description: 'Update packages Windows has downloaded.',
    group: 'Windows',
    needsAdmin: true,
    special: 'windows-update',
    safety: 'Safe, and often a big win. The update service is paused while it is cleared, and Windows re-downloads anything it still needs.',
    machine: () => [{ path: path.join(windir, 'SoftwareDistribution', 'Download'), mode: 'contents' }],
  },
  {
    id: 'delivery-optimisation',
    label: 'Delivery Optimisation cache',
    description: 'Update files Windows keeps to share with other PCs.',
    group: 'Windows',
    needsAdmin: true,
    special: 'delivery-optimisation',
    safety: "Safe. Cleared with Windows' own Delete-DeliveryOptimizationCache.",
  },
  {
    id: 'crash-dumps',
    label: 'Crash dumps and error reports',
    description: 'Memory dumps and Windows Error Reporting files from crashed programs and blue screens.',
    group: 'Windows',
    safety: 'Safe unless you are about to investigate a crash — read them first in that case.',
    user: (p) => [
      { path: path.join(p.local, 'CrashDumps'), mode: 'contents' },
      { path: path.join(p.local, 'Microsoft', 'Windows', 'WER', 'ReportArchive'), mode: 'contents' },
      { path: path.join(p.local, 'Microsoft', 'Windows', 'WER', 'ReportQueue'), mode: 'contents' },
    ],
    machine: () => [
      { path: path.join(programData, 'Microsoft', 'Windows', 'WER', 'ReportArchive'), mode: 'contents' },
      { path: path.join(programData, 'Microsoft', 'Windows', 'WER', 'ReportQueue'), mode: 'contents' },
      { path: path.join(windir, 'Minidump'), mode: 'contents', needsAdmin: true },
      { path: path.join(windir, 'MEMORY.DMP'), mode: 'files', needsAdmin: true },
      { path: path.join(windir, 'LiveKernelReports'), mode: 'contents', needsAdmin: true },
    ],
  },
  {
    id: 'thumbnails',
    label: 'Thumbnail and icon cache',
    description: 'Explorer’s cached picture thumbnails and program icons.',
    group: 'Windows',
    safety: 'Safe. Explorer rebuilds these; the ones in use are skipped until you sign out.',
    user: (p) => [
      { path: path.join(p.local, 'Microsoft', 'Windows', 'Explorer', 'thumbcache_*.db'), mode: 'files' },
      { path: path.join(p.local, 'Microsoft', 'Windows', 'Explorer', 'iconcache_*.db'), mode: 'files' },
    ],
  },
  {
    id: 'internet-cache',
    label: 'Internet cache (INetCache)',
    description: 'The Windows web cache used by Office, Windows apps and older browsers.',
    group: 'Windows',
    safety: 'Safe. Files in use are skipped.',
    user: (p) => [{ path: path.join(p.local, 'Microsoft', 'Windows', 'INetCache'), mode: 'contents' }],
  },
  {
    id: 'prefetch',
    label: 'Prefetch data',
    description: 'Launch-timing data Windows collects to speed up app startup.',
    group: 'Windows',
    needsAdmin: true,
    optional: true,
    safety: 'Safe but rarely worth it — apps open a little slower until Windows relearns them.',
    machine: () => [{ path: path.join(windir, 'Prefetch', '*.pf'), mode: 'files' }],
  },

  {
    id: 'chrome-cache',
    label: 'Chrome cache',
    description: 'Cached pages, images and graphics. Bookmarks, passwords, history and logins are untouched.',
    group: 'Browsers',
    apps: ['chrome'],
    safety: 'Safe. Sites load a little slower the first time.',
    user: (p) => chromiumProfileCaches(path.join(p.local, 'Google', 'Chrome', 'User Data')),
  },
  {
    id: 'edge-cache',
    label: 'Edge cache',
    description: 'Cached pages, images and graphics. Bookmarks, passwords, history and logins are untouched.',
    group: 'Browsers',
    apps: ['msedge'],
    safety: 'Safe. Sites load a little slower the first time.',
    user: (p) => chromiumProfileCaches(path.join(p.local, 'Microsoft', 'Edge', 'User Data')),
  },
  {
    id: 'firefox-cache',
    label: 'Firefox cache',
    description: 'Cached pages and images. Your profile, logins and history are untouched.',
    group: 'Browsers',
    apps: ['firefox'],
    safety: 'Safe.',
    user: (p) => [
      { path: path.join(p.local, 'Mozilla', 'Firefox', 'Profiles', '*', 'cache2'), mode: 'contents' },
      { path: path.join(p.local, 'Mozilla', 'Firefox', 'Profiles', '*', 'startupCache'), mode: 'contents' },
      { path: path.join(p.local, 'Mozilla', 'Firefox', 'Profiles', '*', 'thumbnails'), mode: 'contents' },
    ],
  },
  {
    id: 'brave-cache',
    label: 'Brave cache',
    description: 'Cached pages and images. Bookmarks, passwords and logins are untouched.',
    group: 'Browsers',
    apps: ['brave'],
    safety: 'Safe.',
    user: (p) => chromiumProfileCaches(path.join(p.local, 'BraveSoftware', 'Brave-Browser', 'User Data')),
  },
  {
    id: 'opera-cache',
    label: 'Opera and Opera GX cache',
    description: 'Cached pages and images. Bookmarks, passwords and logins are untouched.',
    group: 'Browsers',
    apps: ['opera', 'opera_gx'],
    safety: 'Safe.',
    user: (p) => {
      const out = [];
      for (const ed of ['Opera Stable', 'Opera GX Stable']) {
        for (const sub of CHROMIUM_CACHE_DIRS) out.push({ path: path.join(p.local, 'Opera Software', ed, sub), mode: 'contents' });
      }
      return out;
    },
  },
  {
    id: 'vivaldi-cache',
    label: 'Vivaldi and Chromium cache',
    description: 'Cached pages and images. Bookmarks, passwords and logins are untouched.',
    group: 'Browsers',
    apps: ['vivaldi'],
    safety: 'Safe.',
    user: (p) => [
      ...chromiumProfileCaches(path.join(p.local, 'Vivaldi', 'User Data')),
      ...chromiumProfileCaches(path.join(p.local, 'Chromium', 'User Data')),
    ],
  },

  {
    id: 'app-caches',
    label: 'App caches',
    description: 'Web caches of desktop apps built on Chromium/Electron — Discord, Teams, Slack, Dropbox, Notion and the like.',
    group: 'Apps',
    safety: 'Safe. Only folders with Chromium’s cache layout are touched; apps rebuild them. Close an app to clear its share fully.',
    namesFromParent: true,
    user: (p) => {
      const out = [];
      for (const base of [p.roaming, p.local]) {
        for (const sub of ['Cache\\Cache_Data', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache']) {
          out.push({ path: path.join(base, '*', sub), mode: 'contents', validate: looksLikeChromiumCache, skipParents: APP_CACHE_SKIP });
          out.push({ path: path.join(base, '*', 'Partitions', '*', sub), mode: 'contents', validate: looksLikeChromiumCache, skipParents: APP_CACHE_SKIP });
        }
      }
      for (const sub of ['Cache', 'Code Cache', 'GPUCache']) {
        out.push({ path: path.join(p.roaming, 'Microsoft', 'Teams', sub), mode: 'contents' });
      }
      return out;
    },
  },
  {
    id: 'vscode-cache',
    label: 'VS Code caches',
    description: 'Cached extension installers, compiled code and web caches from Visual Studio Code.',
    group: 'Apps',
    apps: ['code'],
    safety: 'Safe. Your extensions and settings stay; VS Code rebuilds the caches.',
    user: (p) => [
      { path: path.join(p.roaming, 'Code', 'CachedExtensionVSIXs'), mode: 'contents' },
      { path: path.join(p.roaming, 'Code', 'CachedData'), mode: 'contents' },
      { path: path.join(p.roaming, 'Code', 'Cache', 'Cache_Data'), mode: 'contents' },
      { path: path.join(p.roaming, 'Code', 'Code Cache'), mode: 'contents' },
      { path: path.join(p.roaming, 'Code', 'GPUCache'), mode: 'contents' },
    ],
  },
  {
    id: 'steam-cache',
    label: 'Steam web cache',
    description: 'The Steam client’s cached store and community pages. Games are untouched.',
    group: 'Apps',
    apps: ['steam', 'steamwebhelper'],
    safety: 'Safe.',
    user: (p) => [{ path: path.join(p.local, 'Steam', 'htmlcache'), mode: 'contents' }],
  },
  {
    id: 'spotify-cache',
    label: 'Spotify cache',
    description: 'Music Spotify cached while streaming. Downloaded playlists are kept.',
    group: 'Apps',
    apps: ['spotify'],
    safety: 'Safe. Songs stream again next time they play.',
    user: (p) => [{ path: path.join(p.local, 'Spotify', 'Data'), mode: 'contents' }],
  },

  {
    id: 'shader-cache',
    label: 'Graphics shader caches',
    description: 'Compiled shaders saved by DirectX and the NVIDIA, AMD and Intel drivers.',
    group: 'Graphics',
    safety: 'Safe. Rebuilt automatically; a game may stutter briefly the first time it runs after.',
    user: (p) => [
      { path: path.join(p.local, 'D3DSCache'), mode: 'contents' },
      { path: path.join(p.local, 'NVIDIA', 'DXCache'), mode: 'contents' },
      { path: path.join(p.local, 'NVIDIA', 'GLCache'), mode: 'contents' },
      { path: path.join(p.local, 'NVIDIA Corporation', 'NV_Cache'), mode: 'contents' },
      { path: path.join(p.local, 'AMD', 'DxCache'), mode: 'contents' },
      { path: path.join(p.local, 'AMD', 'DxcCache'), mode: 'contents' },
      { path: path.join(p.local, 'AMD', 'VkCache'), mode: 'contents' },
      { path: path.join(p.local, 'AMD', 'GLCache'), mode: 'contents' },
      { path: path.join(p.local, 'Intel', 'ShaderCache'), mode: 'contents' },
      { path: path.join(p.home, 'AppData', 'LocalLow', 'Intel', 'ShaderCache'), mode: 'contents' },
    ],
    machine: () => [{ path: path.join(programData, 'NVIDIA Corporation', 'NV_Cache'), mode: 'contents' }],
  },
  {
    id: 'driver-installers',
    label: 'Graphics driver installer leftovers',
    description: 'Driver packages the NVIDIA and AMD installers unpack (C:\\NVIDIA, C:\\AMD) and drivers GeForce Experience downloaded.',
    group: 'Graphics',
    needsAdmin: true,
    safety: 'Safe once the driver is installed — the installers unpack again if run. Anything used in the last day is kept.',
    minAgeHours: 24,
    ageScope: 'item',
    machine: () => [
      { path: path.join(systemDrive + '\\', 'NVIDIA'), mode: 'self' },
      { path: path.join(systemDrive + '\\', 'AMD'), mode: 'self' },
      { path: path.join(programData, 'NVIDIA Corporation', 'Downloader'), mode: 'contents' },
    ],
  },

  {
    id: 'npm-cache',
    label: 'npm cache',
    description: 'Packages npm has downloaded for Node.js projects.',
    group: 'Developer',
    optional: true,
    safety: 'Safe. Packages download again the next time a project installs them (needs internet).',
    user: (p) => [{ path: path.join(p.local, 'npm-cache'), mode: 'contents' }],
  },
  {
    id: 'nuget-cache',
    label: 'NuGet download cache',
    description: 'The HTTP cache .NET uses for NuGet packages. Installed packages are untouched.',
    group: 'Developer',
    optional: true,
    safety: 'Safe. Same as `dotnet nuget locals http-cache --clear`.',
    user: (p) => [
      { path: path.join(p.local, 'NuGet', 'v3-cache'), mode: 'contents' },
      { path: path.join(p.local, 'NuGet', 'plugins-cache'), mode: 'contents' },
    ],
  },
  {
    id: 'pip-cache',
    label: 'Python pip cache',
    description: 'Packages pip has downloaded.',
    group: 'Developer',
    optional: true,
    safety: 'Safe. Same as `pip cache purge`.',
    user: (p) => [{ path: path.join(p.local, 'pip', 'Cache'), mode: 'contents' }],
  },
  {
    id: 'yarn-cache',
    label: 'Yarn and Go build caches',
    description: 'Yarn’s package cache and Go’s build cache.',
    group: 'Developer',
    optional: true,
    safety: 'Safe. Rebuilt on the next install or build.',
    user: (p) => [
      { path: path.join(p.local, 'Yarn', 'Cache'), mode: 'contents' },
      { path: path.join(p.local, 'go-build'), mode: 'contents' },
    ],
  },

  {
    id: 'windows-logs',
    label: 'Old Windows log files',
    description: 'Setup, servicing (CBS/DISM) and update logs older than a week.',
    group: 'System files',
    needsAdmin: true,
    optional: true,
    safety: 'Safe. Keep them if you are diagnosing a failed update — only logs over a week old go.',
    minAgeHours: 24 * 7,
    ageScope: 'file',
    machine: () => [{ path: path.join(windir, 'Logs'), mode: 'contents' }],
  },
  {
    id: 'chkdsk-fragments',
    label: 'Old Check Disk fragments',
    description: 'FOUND.000-style folders of file fragments chkdsk recovered from a damaged disk.',
    group: 'System files',
    needsAdmin: true,
    safety: 'Usually junk, but look inside first if a disk recently lost files.',
    machine: (ctx) => ctx.drives.map((d) => ({ path: path.join(d + '\\', 'found.*'), mode: 'self', validate: async (p) => /^found\.\d{3}$/i.test(path.basename(p)) })),
  },
  {
    id: 'windows-upgrade',
    label: 'Windows upgrade leftovers',
    description: 'Temporary installation and setup files from a Windows version upgrade ($WINDOWS.~BT, $WINDOWS.~WS, ESD).',
    group: 'System files',
    needsAdmin: true,
    special: 'cleanmgr',
    handlers: ['Temporary Setup Files', 'Windows ESD installation files', 'Windows Upgrade Log Files', 'Setup Log Files'],
    safety: "Safe once an upgrade has finished. Removed with Windows' own Disk Cleanup; skipped while Windows Setup is running.",
    machine: () => [
      { path: path.join(systemDrive + '\\', '$WINDOWS.~BT'), mode: 'self' },
      { path: path.join(systemDrive + '\\', '$WINDOWS.~WS'), mode: 'self' },
      { path: path.join(systemDrive + '\\', 'ESD'), mode: 'self' },
    ],
  },
  {
    id: 'windows-old',
    label: 'Previous Windows installation',
    description: 'Windows.old — the copy of the old Windows kept after an upgrade or reinstall.',
    group: 'System files',
    needsAdmin: true,
    warn: true,
    special: 'cleanmgr',
    handlers: ['Previous Installations'],
    safety: "Removes the option to go back to the previous version of Windows (Windows drops it by itself after 10 days). Removed with Windows' own Disk Cleanup.",
    machine: () => [{ path: path.join(systemDrive + '\\', 'Windows.old'), mode: 'self' }],
  },

  {
    id: 'recycle-bin',
    label: 'Recycle Bin',
    description: 'Everything already deleted, on every drive.',
    group: 'Other',
    special: 'recycle-bin',
    warn: true,
    safety: 'This is the last stop — emptying it is permanent.',
  },
];

const byId = new Map(TARGETS.map((target) => [target.id, target]));

/* Resolving paths ------------------------------------------------------------ */

// Expands '*' segments (no '**' — nothing here needs it).
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

function entriesFor(target, ctx) {
  const out = [];
  if (target.user) for (const p of ctx.profiles) for (const e of target.user(p)) out.push({ ...e, profile: p });
  if (target.machine) for (const e of target.machine(ctx)) out.push(e);
  return out.filter((e) => !e.needsAdmin || ctx.admin);
}

// The first folder under AppData (Roaming or Local) for an app-cache path.
function appFolderOf(p) {
  const m = /\\appdata\\(?:roaming|local)\\([^\\]+)/i.exec(p);
  return m ? m[1] : '';
}

// Resolves a target's globs to real, existing, allowed paths.
async function resolvePaths(target, ctx) {
  const resolved = [];
  // %TEMP% and %LOCALAPPDATA%\Temp are normally the same folder, so paths are
  // deduplicated to keep from counting or clearing anything twice.
  const seen = new Set();

  for (const entry of entriesFor(target, ctx)) {
    for (const candidate of await expand(entry.path)) {
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      if ((entry.mode === 'contents' || entry.mode === 'self') && isProtected(candidate, ctx)) continue;
      if (target.exclude && entry.mode === 'self' && target.exclude(candidate)) continue;
      if (entry.skipParents && entry.skipParents.has(appFolderOf(candidate).toLowerCase())) continue;
      if (!(await exists(candidate))) continue;
      if (entry.validate && !(await entry.validate(candidate))) continue;
      seen.add(key);
      resolved.push({ path: candidate, mode: entry.mode, profile: entry.profile });
    }
  }
  return resolved;
}

/* Measuring ------------------------------------------------------------------ */

// What a cleanup of one resolved location would remove, split into what goes
// and what the age rule keeps. Returns the items to delete for the clean pass.
async function plan(target, loc) {
  const cutoff = target.minAgeHours ? Date.now() - target.minAgeHours * HOUR : null;
  const out = { bytes: 0, files: 0, recentBytes: 0, recentFiles: 0, remove: [] };

  const account = (m, p, isFile) => {
    if (cutoff && m.newest > cutoff) {
      out.recentBytes += m.bytes;
      out.recentFiles += m.files;
    } else {
      out.bytes += m.bytes;
      out.files += m.files;
      out.remove.push({ path: p, isFile });
    }
  };

  if (loc.mode === 'files' || loc.mode === 'self') {
    if (target.exclude && target.exclude(loc.path)) return out;
    account(await walker.measure(loc.path), loc.path, loc.mode === 'files');
    return out;
  }

  // 'contents'
  if (!cutoff) {
    const m = await walker.measure(loc.path);
    out.bytes = m.bytes;
    out.files = m.files;
    out.remove.push({ path: loc.path, children: true });
    return out;
  }

  if (target.ageScope === 'file') {
    await walker.walk(loc.path, (full, stats) => {
      const m = { bytes: stats.size, files: 1, newest: walker.touched(stats) };
      account(m, full, true);
    });
    out.prune = loc.path;
    return out;
  }

  let children;
  try {
    children = await fs.readdir(loc.path, { withFileTypes: true });
  } catch {
    return out;
  }
  await walker.pool(children, 8, async (child) => {
    const full = path.join(loc.path, child.name);
    if (target.exclude && target.exclude(full)) return;
    account(await walker.measure(full), full, !child.isDirectory());
  });
  return out;
}

/* Recycle Bin ---------------------------------------------------------------- */

// One $Recycle.Bin\<SID> folder per user per drive: the current user's when not
// elevated (others' are unreadable anyway), every profile's when elevated.
async function recycleBins(ctx) {
  const sids = ctx.admin ? ctx.profiles.map((p) => p.sid).filter(Boolean) : [ctx.profiles[0].sid].filter(Boolean);
  const out = [];
  for (const d of ctx.drives) {
    for (const sid of sids) {
      const bin = path.join(d + '\\', '$Recycle.Bin', sid);
      if (await exists(bin)) out.push(bin);
    }
  }
  return out;
}

// Each deleted item is a $I (info) + $R (data) pair; count items by $I, and
// bytes across both, so "37 files" no longer means 18 things you deleted.
async function recycleBinStats(ctx) {
  const stats = { bytes: 0, files: 0, bins: [] };
  for (const bin of await recycleBins(ctx)) {
    let children;
    try {
      children = await fs.readdir(bin, { withFileTypes: true });
    } catch {
      continue;
    }
    stats.bins.push(bin);
    for (const c of children) {
      if (c.name.toLowerCase() === 'desktop.ini') continue;
      if (/^\$I/i.test(c.name)) stats.files += 1;
      stats.bytes += (await walker.measure(path.join(bin, c.name))).bytes;
    }
  }
  return stats;
}

const REFRESH_BIN_ICON = `
try {
  Add-Type -Namespace BobShell -Name Bin -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHUpdateRecycleBinIcon();' -ErrorAction SilentlyContinue
  [BobShell.Bin]::SHUpdateRecycleBinIcon()
} catch {}
`;

/* Scan ----------------------------------------------------------------------- */

async function scanTarget(target, ctx) {
  const summary = {
    id: target.id,
    label: target.label,
    description: target.description,
    group: target.group,
    safety: target.safety,
    warn: Boolean(target.warn),
    optional: Boolean(target.optional),
    needsAdmin: Boolean(target.needsAdmin),
    blocked: Boolean(target.needsAdmin && !ctx.admin),
    bytes: 0,
    files: 0,
    recentBytes: 0,
    recentFiles: 0,
    minAgeHours: target.minAgeHours || 0,
    running: (target.apps || []).filter((a) => ctx.procs.has(a)),
    locations: [],
    apps: [],
    profiles: 0,
    note: '',
  };
  if (summary.blocked) return summary;

  if (target.special === 'recycle-bin') {
    const s = await recycleBinStats(ctx);
    summary.bytes = s.bytes;
    summary.files = s.files;
    summary.locations = s.bins;
    return summary;
  }
  if (target.special === 'delivery-optimisation') {
    if (ctx.doBytes == null) {
      summary.note = 'Delivery Optimisation is not available on this PC.';
    } else {
      summary.bytes = ctx.doBytes;
      summary.locations = ['Delivery Optimisation service'];
    }
    return summary;
  }

  const resolved = await resolvePaths(target, ctx);
  const plans = await Promise.all(resolved.map((loc) => plan(target, loc)));
  const profiles = new Set();
  const apps = new Set();
  resolved.forEach((loc, i) => {
    const p = plans[i];
    summary.bytes += p.bytes;
    summary.files += p.files;
    summary.recentBytes += p.recentBytes;
    summary.recentFiles += p.recentFiles;
    if (p.bytes || p.recentBytes) {
      summary.locations.push(loc.path);
      if (loc.profile) profiles.add(loc.profile.home);
      if (target.namesFromParent && p.bytes) apps.add(appFolderOf(loc.path));
    }
  });
  summary.profiles = profiles.size;
  summary.apps = [...apps].filter(Boolean).sort((a, b) => a.localeCompare(b));
  if (target.special === 'windows-update' && ctx.servicing) {
    summary.note = 'Windows is installing updates right now — this will be skipped until it finishes.';
  }
  if (target.special === 'cleanmgr' && (ctx.procs.has('setuphost') || ctx.procs.has('setupprep'))) {
    summary.note = 'Windows Setup is running — this will be skipped until it finishes.';
  }
  return summary;
}

// Targets are scanned concurrently: most are tiny and finish instantly, so
// running them in series meant waiting on the temp folder before even looking
// at the browser caches.
async function scan(onProgress) {
  const ctx = await getContext();
  const results = new Array(TARGETS.length);
  let done = 0;

  await walker.pool(
    TARGETS.map((target, index) => ({ target, index })),
    6,
    async ({ target, index }) => {
      results[index] = await scanTarget(target, ctx);
      done += 1;
      if (onProgress) onProgress({ index: done, total: TARGETS.length, label: target.label });
    }
  );

  if (onProgress) onProgress({ index: TARGETS.length, total: TARGETS.length, label: 'Done' });
  return {
    targets: results,
    admin: ctx.admin,
    profiles: ctx.profiles.map((p) => p.home),
  };
}

/* Clean ---------------------------------------------------------------------- */

async function removePath(target, report) {
  const before = await walker.measure(target);
  try {
    await fs.rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 60 });
  } catch {
    /* fall through to the re-measure below */
  }
  const after = await walker.measure(target);
  report.bytes += Math.max(0, before.bytes - after.bytes);
  report.files += Math.max(0, before.files - after.files);
  if (after.files > 0 || after.bytes > 0) report.skipped += after.files || 1;
}

// After file-by-file deletes, drop folders left empty (never `root` itself).
async function pruneEmpty(root) {
  const dirs = [];
  await walker.walk(root, () => {}, { shouldEnter: (d) => (dirs.push(d), true) });
  dirs.sort((a, b) => b.length - a.length);
  for (const d of dirs) {
    try {
      await fs.rmdir(d);
    } catch {
      /* not empty, or in use */
    }
  }
}

async function emptyFolder(dir, report, keep) {
  let children;
  try {
    children = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const child of children) {
    if (keep && keep.includes(child.name.toLowerCase())) continue;
    await removePath(path.join(dir, child.name), report);
  }
}

function psOnce(script, timeout) {
  const encoded = Buffer.from(`$ProgressPreference = 'SilentlyContinue'\n${script}`, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message).trim()));
        resolve(String(stdout || ''));
      });
  });
}

// Disk Cleanup's own handlers, run unattended: tick only the wanted handlers
// under a private StateFlags number, run cleanmgr /sagerun with it, untick.
async function runCleanmgr(handlers) {
  const flag = '0777';
  await psOnce(`
${ps.payload({ handlers, flag })}
$base = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VolumeCaches'
$name = 'StateFlags' + $Payload.flag
$set = @()
try {
  foreach ($h in $Payload.handlers) {
    $k = Join-Path $base $h
    if (Test-Path -LiteralPath $k) {
      New-ItemProperty -LiteralPath $k -Name $name -Value 2 -PropertyType DWord -Force | Out-Null
      $set += $k
    }
  }
  if ($set.Count -gt 0) {
    Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\cleanmgr.exe') -ArgumentList ('/sagerun:' + $Payload.flag) -Wait -WindowStyle Hidden
  }
} finally {
  foreach ($k in $set) { Remove-ItemProperty -LiteralPath $k -Name $name -ErrorAction SilentlyContinue }
}
`, 60 * 60 * 1000);
}

async function cleanTarget(target, ctx, report) {
  if (target.needsAdmin && !ctx.admin) {
    report.note = 'Needs administrator rights.';
    return;
  }

  if (target.special === 'recycle-bin') {
    const before = await recycleBinStats(ctx);
    const scratch = { bytes: 0, files: 0, skipped: 0 };
    for (const bin of before.bins) await emptyFolder(bin, scratch, ['desktop.ini']);
    const after = await recycleBinStats(ctx);
    report.bytes += Math.max(0, before.bytes - after.bytes);
    report.files += Math.max(0, before.files - after.files);
    report.skipped += after.files;
    await ps.run(REFRESH_BIN_ICON).catch(() => {});
    return;
  }

  if (target.special === 'delivery-optimisation') {
    if (ctx.doBytes == null) return;
    await ps.mutate('Delete-DeliveryOptimizationCache -Force -ErrorAction Stop | Out-Null');
    const after = await ps.json('ConvertTo-Json -Compress -InputObject ([double](Get-DeliveryOptimizationPerfSnap).CacheSizeBytes)').catch(() => null);
    report.bytes += Math.max(0, ctx.doBytes - (Number(after) || 0));
    return;
  }

  if (target.special === 'cleanmgr') {
    if (ctx.procs.has('setuphost') || ctx.procs.has('setupprep')) {
      report.note = 'Skipped — Windows Setup is running.';
      return;
    }
    const resolved = await resolvePaths(target, ctx);
    if (!resolved.length) return;
    const before = await Promise.all(resolved.map((l) => walker.measure(l.path)));
    await runCleanmgr(target.handlers);
    const after = await Promise.all(resolved.map((l) => walker.measure(l.path)));
    resolved.forEach((_l, i) => {
      report.bytes += Math.max(0, before[i].bytes - after[i].bytes);
      report.files += Math.max(0, before[i].files - after[i].files);
      report.skipped += after[i].files;
    });
    return;
  }

  // Windows Update: pause the services that write here, clear, restart only
  // what was running. Never while Windows is installing updates.
  let restart = [];
  if (target.special === 'windows-update') {
    if (ctx.servicing) {
      report.note = 'Skipped — Windows is installing updates right now.';
      return;
    }
    const stopped = await ps.json(`
$was = @(foreach ($n in 'wuauserv','bits') { $s = Get-Service $n -ErrorAction SilentlyContinue; if ($s -and $s.Status -eq 'Running') { $n } })
foreach ($n in $was) { Stop-Service -Name $n -Force -ErrorAction SilentlyContinue }
ConvertTo-Json -Compress -InputObject @($was)
`).catch(() => []);
    restart = ps.arr(stopped);
  }

  try {
    for (const loc of await resolvePaths(target, ctx)) {
      const p = await plan(target, loc);
      for (const item of p.remove) {
        if (item.children) {
          if (isProtected(item.path, ctx)) continue;
          await emptyFolder(item.path, report);
        } else {
          if (!item.isFile && isProtected(item.path, ctx)) continue;
          await removePath(item.path, report);
        }
      }
      if (p.prune) await pruneEmpty(p.prune);
      report.kept += p.recentBytes;
    }
  } finally {
    if (restart.length) {
      await ps.run(`${ps.payload({ restart })}\nforeach ($n in $Payload.restart) { Start-Service -Name $n -ErrorAction SilentlyContinue }`).catch(() => {});
    }
  }
}

async function clean(ids, onProgress) {
  const ctx = await getContext();
  const selected = ids.map((id) => byId.get(id)).filter(Boolean);
  const report = { bytes: 0, files: 0, skipped: 0, kept: 0, targets: [] };

  for (let index = 0; index < selected.length; index += 1) {
    const target = selected[index];
    if (onProgress) onProgress({ index, total: selected.length, label: target.label });
    const r = { bytes: 0, files: 0, skipped: 0, kept: 0, note: '' };
    try {
      await cleanTarget(target, ctx, r);
    } catch (err) {
      r.note = err.message;
    }
    report.bytes += r.bytes;
    report.files += r.files;
    report.skipped += r.skipped;
    report.kept += r.kept;
    report.targets.push({ id: target.id, label: target.label, ...r });
  }

  if (onProgress) onProgress({ index: selected.length, total: selected.length, label: 'Done' });
  return report;
}

// Exposed so the guards and the delete accounting can be exercised against a
// sandbox folder rather than against real cleanup locations.
const _internals = { cleanTarget, isProtected, holdsOwnFiles, expand, resolvePaths, removePath, plan, pruneEmpty, getContext, looksLikeChromiumCache, recycleBinStats, sizeOf: walker.measure };

module.exports = { scan, clean, TARGETS, _internals };
