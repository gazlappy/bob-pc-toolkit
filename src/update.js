'use strict';

// Self-update for the portable BOB.exe.
//
// You publish two files to a place every copy can reach — a web link (https://…)
// or a shared/synced folder (a UNC path, or a OneDrive/Dropbox folder): the new
// `BOB.exe` and a small `version.json` describing it. Each BOB reads the
// version.json, and if it names a newer version, downloads the exe, checks it
// against the SHA-256 in the manifest, and swaps itself for the new one on exit.
//
// The source is whatever you set in the Update tab; nothing is fetched from
// anywhere else, and a download that fails its hash is thrown away. Self-replace
// only works on the portable build (there is a real BOB.exe on disk to swap).

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const isUrl = (s) => /^https?:\/\//i.test(String(s || ''));

// Where updates come from unless the user overrides it in the Update tab. Points
// at the latest GitHub release's assets (version.json + BOB.exe), which are
// public downloads, so any copy updates with no login. "…/releases/latest/
// download/<name>" always resolves to the newest release's asset.
const DEFAULT_SOURCE = 'https://github.com/gazlappy/bob-pc-toolkit/releases/latest/download';

// Read the app's own version from the bundled package.json. app.getVersion()
// is unreliable when run from source (it can report Electron's version), but the
// package.json ships inside the app in both dev and the packaged build.
const APP_VERSION = (() => {
  try {
    return require('../package.json').version;
  } catch {
    return app.getVersion();
  }
})();

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function getConfig() {
  const s = readSettings();
  const custom = (s.updateSource || '').trim();
  return {
    source: custom || DEFAULT_SOURCE,
    isDefault: !custom,
    current: APP_VERSION,
    portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE),
  };
}

function setSource(source) {
  const s = readSettings();
  s.updateSource = String(source || '').trim();
  writeSettings(s);
  return getConfig();
}

// Fetches a URL into a Buffer, following redirects; onData(received,total?) for progress.
function httpGet(url, onData) {
  return new Promise((resolve, reject) => {
    const lib = url.toLowerCase().startsWith('https') ? https : http;
    const req = lib.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(httpGet(new URL(res.headers.location, url).href, onData));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const total = Number(res.headers['content-length']) || 0;
      const chunks = [];
      let got = 0;
      res.on('data', (c) => {
        chunks.push(c);
        got += c.length;
        if (onData) onData(got, total);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timed out reaching the update source')));
  });
}

function readLocation(loc, onData) {
  if (isUrl(loc)) return httpGet(loc, onData);
  return fs.promises.readFile(loc);
}

function joinSource(base, name) {
  if (isUrl(base)) return base.replace(/\/+$/, '') + '/' + name;
  return path.join(base, name);
}

// Compares dotted numeric versions: 1 if a>b, -1 if a<b, 0 if equal.
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function check() {
  const { source, current } = getConfig();
  if (!source) {
    throw new Error('No update source set yet. Enter the web link or shared folder where the new BOB is published, and Save.');
  }
  const manifestLoc = /\.json$/i.test(source) ? source : joinSource(source, 'version.json');
  let manifest;
  try {
    manifest = JSON.parse((await readLocation(manifestLoc)).toString('utf8'));
  } catch (e) {
    // No manifest where we looked usually just means nothing has been published
    // yet (a GitHub repo with no releases 404s here) — report that calmly rather
    // than as an error. A genuinely wrong/unreachable source still surfaces.
    if (/\b404\b|not found|ENOENT|no such file/i.test(e.message)) {
      return { current, latest: current, newer: false, noRelease: true, notes: '', date: '', exeLoc: '', sha256: '', size: 0 };
    }
    throw new Error(`Could not read update info from the source — check the link/folder is right and reachable. (${e.message})`);
  }
  const latest = String(manifest.version || '').trim();
  if (!latest) throw new Error('The update info at that source has no version number.');

  const base = /\.json$/i.test(source) ? source.replace(/[^/\\]+$/, '') : source;
  const exeName = manifest.exe || 'BOB.exe';
  const exeLoc = isUrl(exeName) ? exeName : joinSource(base, exeName);

  return {
    current,
    latest,
    newer: compareVersions(latest, current) > 0,
    notes: manifest.notes || '',
    date: manifest.date || '',
    exeLoc,
    sha256: String(manifest.sha256 || '').toLowerCase(),
    size: Number(manifest.size) || 0,
  };
}

// Downloads/copies the new exe and verifies its hash. Returned separately from
// the swap so the risky integrity step is testable on its own.
async function downloadVerified(info, onData) {
  const buf = await readLocation(info.exeLoc, onData);
  if (info.sha256) {
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (got !== info.sha256) {
      throw new Error('The downloaded file did not match the expected checksum — update cancelled, nothing was changed.');
    }
  }
  return buf;
}

function swapScript(oldPath, newPath) {
  const q = (p) => `'${String(p).replace(/'/g, "''")}'`;
  return `
$old = ${q(oldPath)}
$new = ${q(newPath)}
$log = Join-Path $env:TEMP 'bob-update.log'
function Log($m) { try { "$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss')) $m" | Out-File -LiteralPath $log -Append -Encoding utf8 } catch {} }
Log "update swap start: old=$old new=$new"

# Wait until no process is still running the old exe (BOB has fully closed).
# This is reliable even in a OneDrive/synced folder, where a file-lock probe
# never clears because the sync engine keeps its own handle on the file.
for ($i = 0; $i -lt 240; $i++) {
  $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $old })
  if ($running.Count -eq 0) { break }
  Start-Sleep -Milliseconds 500
}
if (-not (Test-Path -LiteralPath $new)) { Log "new build missing - aborting"; exit 1 }

# Rename the old exe aside first, then move the new one into place. Never delete
# the old copy before the new one is in place, so a failure can never leave the
# folder with no working BOB.exe. Retry because OneDrive / antivirus may hold the
# file briefly after the process exits.
$oldLeaf = [System.IO.Path]::GetFileName($old)
$bak = "$old.old"
$bakLeaf = "$oldLeaf.old"
$done = $false
for ($i = 0; $i -lt 60; $i++) {
  try {
    if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $old) { Rename-Item -LiteralPath $old -NewName $bakLeaf -ErrorAction Stop }
    Move-Item -LiteralPath $new -Destination $old -Force -ErrorAction Stop
    Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue
    $done = $true
    break
  } catch {
    Log "attempt $i failed: $($_.Exception.Message)"
    # If old was moved aside but new did not land, restore old so BOB still runs.
    if ((Test-Path -LiteralPath $bak) -and -not (Test-Path -LiteralPath $old)) {
      try { Rename-Item -LiteralPath $bak -NewName $oldLeaf -ErrorAction SilentlyContinue } catch {}
    }
    Start-Sleep -Milliseconds 1000
  }
}
if ($done) { Log "swap OK"; Start-Process -FilePath $old }
else { Log "swap FAILED after retries - the new build is at $new" }
`;
}

async function apply(onProgress) {
  const info = await check();
  if (!info.newer) throw new Error(`Already on the latest version (${info.current}).`);
  const target = process.env.PORTABLE_EXECUTABLE_FILE;
  if (!target) {
    throw new Error('Self-update only works on the portable BOB.exe. Replace the file manually when running from source.');
  }

  const newExe = path.join(path.dirname(target), 'BOB.new.exe');
  const buf = await downloadVerified(info, (got, total) => {
    if (onProgress) onProgress({ phase: 'download', got, total });
  });
  await fs.promises.writeFile(newExe, buf);

  const helper = path.join(os.tmpdir(), `bob-update-${Date.now()}.ps1`);
  await fs.promises.writeFile(helper, swapScript(target, newExe), 'utf8');
  spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', helper], {
    detached: true,
    stdio: 'ignore',
  }).unref();

  if (onProgress) onProgress({ phase: 'restart' });
  setTimeout(() => app.quit(), 500);
  return { applied: true, version: info.latest };
}

module.exports = {
  getConfig,
  setSource,
  check,
  apply,
  __internals: { compareVersions, downloadVerified, swapScript, joinSource },
};
