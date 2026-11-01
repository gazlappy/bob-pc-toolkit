'use strict';

// What is running right now, as programs rather than a wall of process names, and
// the means to do something about it. Reads the same counters as Task Manager.
// Ending a program only ever takes a key from the last listing, and processes
// Windows can't run without, along with BOB itself, are never offered.

const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const { shell } = require('electron');
const ps = require('./ps');

const CORES = os.cpus().length || 1;

// Ending any of these crashes or signs out the PC.
const CRITICAL = new Set([
  'system', 'registry', 'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe', 'services.exe', 'lsass.exe', 'lsaiso.exe',
  'svchost.exe', 'dwm.exe', 'fontdrvhost.exe', 'sihost.exe', 'memcompression', 'secure system', 'spoolsv.exe', 'audiodg.exe',
  'msmpeng.exe', 'nissrv.exe', 'securityhealthservice.exe', 'ctfmon.exe', 'dllhost.exe', 'wudfhost.exe', 'conhost.exe',
  'taskhostw.exe', 'runtimebroker.exe', 'explorer.exe', 'system idle process',
]);

const LIST_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$perf = @{}
foreach ($p in (Get-CimInstance Win32_PerfFormattedData_PerfProc_Process)) { $perf[[int]$p.IDProcess] = $p }
$services = @{}
foreach ($s in (Get-CimInstance Win32_Service -Filter "State='Running'")) {
  if (-not $services[[int]$s.ProcessId]) { $services[[int]$s.ProcessId] = [string]$s.DisplayName }
}
@(Get-CimInstance Win32_Process | ForEach-Object {
  $id = [int]$_.ProcessId
  $c = $perf[$id]
  [pscustomobject]@{
    id = $id
    parent = [int]$_.ParentProcessId
    name = [string]$_.Name
    path = [string]$_.ExecutablePath
    cpu = $(if ($c) { [double]$c.PercentProcessorTime } else { 0 })
    mem = $(if ($c) { [double]$c.WorkingSetPrivate } else { [double]$_.WorkingSetSize })
    io = $(if ($c) { [double]$c.IODataBytesPersec } else { 0 })
    service = [string]$services[$id]
  }
}) | ConvertTo-Json -Depth 3 -Compress
`;

const details = new Map();
const signatures = new Map();
let signing = false;
let latest = new Map();

function runAlone(script, timeout) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      resolve(String(stdout || ''));
    });
  });
}

async function describe(paths) {
  const fresh = paths.filter((p) => !details.has(p));
  if (!fresh.length) return;
  const rows = ps.arr(await ps.json(`
${ps.payload(fresh)}
$ErrorActionPreference = 'SilentlyContinue'
@(@($Payload) | ForEach-Object {
  $v = (Get-Item -LiteralPath $_).VersionInfo
  [pscustomobject]@{ path = [string]$_; product = [string]$v.FileDescription; publisher = [string]$v.CompanyName }
}) | ConvertTo-Json -Compress
`, { timeout: 20000 }).catch(() => []));
  for (const row of rows) details.set(row.path, { product: row.product, publisher: row.publisher });
  for (const p of fresh) if (!details.has(p)) details.set(p, { product: '', publisher: '' });
}

// Checking a signature can take a second a file, so it runs in its own process in
// the background and the list picks the answers up as they arrive.
async function checkSignatures(paths) {
  if (signing) return;
  const fresh = paths.filter((p) => !signatures.has(p)).slice(0, 25);
  if (!fresh.length) return;
  signing = true;
  const out = await runAlone(`
${ps.payload(fresh)}
$ErrorActionPreference = 'SilentlyContinue'
@(@($Payload) | ForEach-Object { [pscustomobject]@{ path = [string]$_; status = [string](Get-AuthenticodeSignature -LiteralPath $_).Status } }) | ConvertTo-Json -Compress
`, 120000);
  signing = false;
  try {
    for (const row of ps.arr(JSON.parse(out))) signatures.set(row.path, row.status);
  } catch {
    /* tried again on the next listing */
  }
  for (const p of fresh) if (!signatures.has(p)) signatures.set(p, 'Unknown');
}

function ownTree(rows) {
  const own = new Set([process.pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (!own.has(row.id) && own.has(row.parent)) {
        own.add(row.id);
        grew = true;
      }
    }
  }
  for (const row of rows) {
    const self = rows.find((r) => r.id === process.pid);
    if (self && row.id === self.parent && row.name.toLowerCase() === 'bob.exe') own.add(row.id);
  }
  return own;
}

async function list() {
  const rows = ps.arr(await ps.json(LIST_SCRIPT, { timeout: 15000 }));
  if (!rows.length) throw new Error('Could not read what is running.');
  const own = ownTree(rows);
  const groups = new Map();
  const windows = (process.env.SystemRoot || 'C:\\Windows').toLowerCase();
  for (const row of rows) {
    if (row.id === 0) continue;
    const key = (row.path || row.name).toLowerCase();
    let g = groups.get(key);
    if (!g) {
      g = { key, name: row.name, path: row.path, cpu: 0, mem: 0, io: 0, count: 0, pids: [], services: [], own: false };
      groups.set(key, g);
    }
    g.cpu += row.cpu / CORES;
    g.mem += row.mem;
    g.io += row.io;
    g.count += 1;
    g.pids.push(row.id);
    if (row.service && !g.services.includes(row.service)) g.services.push(row.service);
    if (own.has(row.id)) g.own = true;
  }
  const out = [...groups.values()].filter((g) => !g.own);
  latest = new Map(out.map((g) => [g.key, g]));

  const paths = out.map((g) => g.path).filter(Boolean);
  await describe(paths);
  // Store apps are signed as a whole package, so their files alone always read as unsigned.
  checkSignatures(paths.filter((p) => !p.toLowerCase().startsWith(`${windows}\\`) && !/\\windowsapps\\/i.test(p)));

  return out.map((g) => {
    const lower = g.name.toLowerCase();
    const info = g.path ? details.get(g.path) || {} : {};
    const signature = g.path ? signatures.get(g.path) : null;
    return {
      key: g.key,
      name: info.product || g.name.replace(/\.exe$/i, ''),
      file: g.name,
      path: g.path,
      publisher: info.publisher || '',
      cpu: Math.min(100, g.cpu),
      mem: g.mem,
      io: g.io,
      count: g.count,
      services: g.services,
      windows: !g.path || g.path.toLowerCase().startsWith(`${windows}\\`),
      critical: CRITICAL.has(lower),
      unsigned: signature === 'NotSigned' || signature === 'HashMismatch' || signature === 'NotTrusted',
    };
  });
}

function taskkill(pid) {
  return new Promise((resolve) => {
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15000 }, (error, stdout, stderr) => {
      resolve(error ? String(stderr || error.message).trim() : null);
    });
  });
}

async function end(key) {
  await list();
  const group = latest.get(key);
  if (!group) return { ended: 0, failed: [], gone: true };
  if (CRITICAL.has(group.name.toLowerCase())) throw new Error(`${group.name} is part of Windows, so BOB won't end it.`);
  let ended = 0;
  const failed = [];
  for (const pid of group.pids) {
    const error = await taskkill(pid);
    // Ending a parent takes its children too, so a later copy may already be gone.
    if (!error || /not found/i.test(error)) ended += 1;
    else failed.push(error);
  }
  return { ended, failed };
}

function reveal(key) {
  const group = latest.get(key);
  if (!group || !group.path) throw new Error('Windows does not say where this program is.');
  shell.showItemInFolder(path.normalize(group.path));
  return true;
}

module.exports = { list, end, reveal };
