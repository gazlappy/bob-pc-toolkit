'use strict';

// Reads and controls startup programs the same way Task Manager does.
//
// Enabling/disabling never touches the Run entry itself. Windows keeps the
// on/off state in a separate "StartupApproved" key, as a 12-byte blob whose
// first byte is 2 for enabled and 3 for disabled (the remaining bytes are the
// time it was disabled). Writing that blob is exactly what Task Manager's
// Startup tab does, so a disable here is fully reversible and shows up there.

const { app, shell } = require('electron');
const ps = require('./ps');
const backup = require('./backup');

const APPROVED_HKCU = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved';
const APPROVED_HKLM = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved';

// The last listing, so the renderer only ever sends us an id and we resolve the
// registry path ourselves rather than trusting a path handed to us by the UI.
let cache = new Map();
const iconCache = new Map();

const LIST_SCRIPT = `
function Get-ApprovalMap($keyPath) {
  $map = @{}
  if (Test-Path $keyPath) {
    $key = Get-Item $keyPath
    foreach ($valueName in $key.GetValueNames()) {
      $bytes = $key.GetValue($valueName)
      if ($bytes -is [byte[]] -and $bytes.Length -ge 1) {
        # Odd first byte means disabled (3), even means enabled (2).
        $map[$valueName] = (($bytes[0] -band 1) -eq 0)
      }
    }
  }
  return $map
}

$locations = @(
  @{ id = 'hkcu-run';     reg = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';              approval = '${APPROVED_HKCU}\\Run';   label = 'Registry (you)';               scope = 'user' },
  @{ id = 'hklm-run';     reg = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';              approval = '${APPROVED_HKLM}\\Run';   label = 'Registry (all users)';         scope = 'machine' },
  @{ id = 'hklm-run32';   reg = 'HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Run'; approval = '${APPROVED_HKLM}\\Run32'; label = 'Registry (all users, 32-bit)'; scope = 'machine' },
  @{ id = 'hkcu-runonce'; reg = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce';          approval = '';                        label = 'Run once (you)';               scope = 'user' },
  @{ id = 'hkcu-run32';   reg = 'HKCU:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Run'; approval = '${APPROVED_HKCU}\\Run32'; label = 'Registry (you, 32-bit)'; scope = 'user' },
  @{ id = 'hkcu-policy';  reg = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer\\Run'; approval = ''; label = 'Set by policy (you)'; scope = 'user' },
  @{ id = 'hklm-policy';  reg = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer\\Run'; approval = ''; label = 'Set by policy (all users)'; scope = 'machine' },
  @{ id = 'hklm-runonce'; reg = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce';          approval = '';                        label = 'Run once (all users)';         scope = 'machine' }
)

$entries = New-Object System.Collections.ArrayList

# Store-type apps register their own startup tasks, which Task Manager lists too.
$appRoot = 'HKCU:\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\SystemAppData'
# In its own try, so trouble here can't lose the ordinary startup items below.
try {
if (Test-Path -LiteralPath $appRoot) {
  $packages = @{}
  foreach ($p in (Get-AppxPackage -ErrorAction SilentlyContinue)) { $packages[[string]$p.PackageFamilyName] = $p }
  foreach ($family in (Get-ChildItem -LiteralPath $appRoot -ErrorAction SilentlyContinue)) {
    $package = $packages[[string]$family.PSChildName]
    if (-not $package) { continue }
    $tasks = @(Get-ChildItem -LiteralPath $family.PSPath -ErrorAction SilentlyContinue | Where-Object { $null -ne (Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue).State })
    if (-not $tasks.Count) { continue }
    $manifest = Get-AppxPackageManifest -Package $package -ErrorAction SilentlyContinue
    $display = if ($manifest) { [string]$manifest.Package.Properties.DisplayName } else { '' }
    $company = if ($manifest) { [string]$manifest.Package.Properties.PublisherDisplayName } else { '' }
    if (-not $display -or $display -like 'ms-resource*') { $display = ([string]$package.Name -replace '^[^.]+\\.', '') -creplace '([a-z])([A-Z])', '$1 $2' }
    if ($company -like 'ms-resource*') { $company = '' }
    foreach ($task in $tasks) {
      $state = [int](Get-ItemProperty -LiteralPath $task.PSPath).State
      $exe = ''
      if ($manifest) {
        $node = $manifest.SelectNodes("//*[local-name()='StartupTask']") | Where-Object { $_.GetAttribute('TaskId') -eq $task.PSChildName } | Select-Object -First 1
        if ($node -and $node.ParentNode.GetAttribute('Executable')) { $exe = Join-Path $package.InstallLocation $node.ParentNode.GetAttribute('Executable') }
      }
      $part = ([string]$task.PSChildName -replace 'StartupTask$', '') -replace ('^' + [regex]::Escape(($display -replace ' ', ''))), ''
      $label = if ($tasks.Count -gt 1 -and $part) { $display + ' (' + ($part -creplace '([a-z])([A-Z])', '$1 $2') + ')' } else { $display }
      [void]$entries.Add([pscustomobject]@{
        kind        = 'packaged'
        locationId  = 'packaged'
        location    = 'Windows Store-type app'
        scope       = 'user'
        registryKey = [string]($appRoot + '\\' + $family.PSChildName + '\\' + $task.PSChildName)
        approvalKey = ''
        valueName   = [string]($family.PSChildName + '\\' + $task.PSChildName)
        name        = $label
        command     = $exe
        filePath    = ''
        enabled     = ($state -eq 2 -or $state -eq 4)
        approvable  = ($state -le 2)
        publisher   = $company
      })
    }
  }
}
} catch { }

foreach ($location in $locations) {
  if (-not (Test-Path $location.reg)) { continue }
  $approvals = @{}
  if ($location.approval) { $approvals = Get-ApprovalMap $location.approval }
  $key = Get-Item $location.reg
  foreach ($valueName in $key.GetValueNames()) {
    if ([string]::IsNullOrWhiteSpace($valueName)) { continue }
    $enabled = $true
    if ($approvals.ContainsKey($valueName)) { $enabled = $approvals[$valueName] }
    [void]$entries.Add([pscustomobject]@{
      kind        = 'registry'
      locationId  = $location.id
      location    = $location.label
      scope       = $location.scope
      registryKey = $location.reg
      approvalKey = $location.approval
      valueName   = $valueName
      name        = $valueName
      command     = [string]$key.GetValue($valueName)
      filePath    = ''
      enabled     = $enabled
      approvable  = [bool]$location.approval
    })
  }
}

$folders = @(
  @{ id = 'folder-user';   path = [Environment]::GetFolderPath('Startup');       approval = '${APPROVED_HKCU}\\StartupFolder'; label = 'Startup folder (you)';       scope = 'user' },
  @{ id = 'folder-common'; path = [Environment]::GetFolderPath('CommonStartup'); approval = '${APPROVED_HKLM}\\StartupFolder'; label = 'Startup folder (all users)'; scope = 'machine' }
)

$wsh = New-Object -ComObject WScript.Shell

foreach ($folder in $folders) {
  if ([string]::IsNullOrWhiteSpace($folder.path) -or -not (Test-Path $folder.path)) { continue }
  $approvals = Get-ApprovalMap $folder.approval
  Get-ChildItem -LiteralPath $folder.path -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Name -eq 'desktop.ini') { return }
    $target = $_.FullName
    if ($_.Extension -eq '.lnk') {
      try { $target = $wsh.CreateShortcut($_.FullName).TargetPath } catch { }
    }
    $enabled = $true
    if ($approvals.ContainsKey($_.Name)) { $enabled = $approvals[$_.Name] }
    [void]$entries.Add([pscustomobject]@{
      kind        = 'folder'
      locationId  = $folder.id
      location    = $folder.label
      scope       = $folder.scope
      registryKey = ''
      approvalKey = $folder.approval
      valueName   = $_.Name
      name        = [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
      command     = $target
      filePath    = $_.FullName
      enabled     = $enabled
      approvable  = $true
    })
  }
}

@($entries) | ConvertTo-Json -Depth 4 -Compress
`;

const TASKS_SCRIPT = `
$tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
  @($_.Triggers) | Where-Object {
    $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' -or $_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger'
  }
})

@($tasks | ForEach-Object {
  $action = @($_.Actions) | Where-Object { $_.Execute } | Select-Object -First 1
  [pscustomobject]@{
    name        = [string]$_.TaskName
    taskPath    = [string]$_.TaskPath
    state       = [string]$_.State
    author      = [string]$_.Author
    description = [string]$_.Description
    command     = if ($action) { [string]$action.Execute } else { '' }
    arguments   = if ($action) { [string]$action.Arguments } else { '' }
  }
}) | ConvertTo-Json -Depth 4 -Compress
`;

function expandEnvironment(value) {
  return String(value || '').replace(/%([^%]+)%/g, (match, name) => {
    const found = process.env[name] ?? process.env[name.toUpperCase()];
    return found === undefined ? match : found;
  });
}

// Pulls the executable out of a command line such as:  "C:\a b\x.exe" --flag
function executableFrom(command) {
  const text = expandEnvironment(command).trim();
  if (!text) return '';
  if (text.startsWith('"')) {
    const close = text.indexOf('"', 1);
    return close === -1 ? text.slice(1) : text.slice(1, close);
  }
  const match = text.match(/^(.*?\.(?:exe|com|bat|cmd|scr|vbs|lnk))(?:\s|$)/i);
  if (match) return match[1];
  const space = text.indexOf(' ');
  return space === -1 ? text : text.slice(0, space);
}

async function describeFiles(paths) {
  if (!paths.length) return {};
  const rows = ps.arr(
    await ps.json(`
${ps.payload(paths)}
@(@($Payload) | ForEach-Object {
  $target = $_
  $info = $null
  $exists = Test-Path -LiteralPath $target -PathType Leaf
  if ($exists) {
    try { $info = (Get-Item -LiteralPath $target -ErrorAction Stop).VersionInfo } catch { }
  }
  [pscustomobject]@{
    path      = $target
    exists    = $exists
    publisher = if ($info) { [string]$info.CompanyName } else { '' }
    product   = if ($info) { [string]$info.FileDescription } else { '' }
  }
}) | ConvertTo-Json -Depth 3 -Compress
`)
  );

  const map = {};
  for (const row of rows) map[String(row.path).toLowerCase()] = row;
  return map;
}

async function runningNow() {
  const rows = ps.arr(await ps.json(`
$ErrorActionPreference = 'SilentlyContinue'
$own = @{}
foreach ($p in (Get-CimInstance Win32_PerfFormattedData_PerfProc_Process)) { $own[[int]$p.IDProcess] = [double]$p.WorkingSetPrivate }
@(Get-Process | Where-Object { $_.Path } | Group-Object Path | ForEach-Object {
  $bytes = 0
  foreach ($p in $_.Group) { $bytes += [double]$own[[int]$p.Id] }
  [pscustomobject]@{ path = [string]$_.Name; count = $_.Count; bytes = $bytes }
}) | ConvertTo-Json -Compress
`, { timeout: 15000 }).catch(() => []));
  const map = {};
  for (const row of rows) map[String(row.path).toLowerCase()] = { count: row.count, bytes: row.bytes };
  return map;
}

// Windows times every boot and names what held it up, but only shows admins. These
// are its own figures: 100 is the boot, 101 a program, 102 a driver, 103 a service.
const BOOT_SCRIPT = `
$ErrorActionPreference = 'Stop'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$since = (Get-Date).AddDays(-30)
$events = @()
try {
  $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-Diagnostics-Performance/Operational'; Id = 100,101,102,103; StartTime = $since } -MaxEvents 500)
} catch { }
$rows = foreach ($e in $events) {
  $d = @{}
  foreach ($n in ([xml]$e.ToXml()).Event.EventData.Data) { $d[[string]$n.Name] = [string]$n.'#text' }
  [pscustomobject]@{
    id = [int]$e.Id
    when = $e.TimeCreated.ToString('o')
    total = [double]$d['BootTime']
    main = [double]$d['MainPathBootTime']
    post = [double]$d['BootPostBootTime']
    name = $d['FriendlyName']
    file = $d['Name']
    slower = [double]$d['DegradationTime']
  }
}
[pscustomobject]@{ admin = $admin; rows = @($rows) } | ConvertTo-Json -Depth 3 -Compress
`;

async function bootReport() {
  const data = await ps.json(BOOT_SCRIPT, { timeout: 30000 }).catch(() => null);
  if (!data) return { readable: false, admin: false, boots: [], history: [], slow: [] };
  const rows = ps.arr(data.rows);
  const history = rows.filter((r) => r.id === 100 && r.total > 0).map((r) => ({ when: r.when, total: r.total, main: r.main, post: r.post }));
  const boots = history.slice(0, 5);
  const byFile = new Map();
  for (const r of rows) {
    if (r.id === 100 || !r.file) continue;
    const key = r.file.toLowerCase();
    const item = byFile.get(key) || { file: r.file, name: r.name || r.file, kind: { 101: 'Program', 102: 'Driver', 103: 'Service' }[r.id], times: 0, total: 0, worst: 0, last: r.when };
    item.times += 1;
    item.total += r.slower;
    item.worst = Math.max(item.worst, r.slower);
    if (r.when > item.last) item.last = r.when;
    byFile.set(key, item);
  }
  const slow = [...byFile.values()]
    .map((item) => ({ file: item.file, name: item.name, kind: item.kind, times: item.times, worst: item.worst, typical: Math.round(item.total / item.times), last: item.last }))
    .sort((a, b) => b.typical - a.typical);
  return { readable: Boolean(rows.length), admin: Boolean(data.admin), boots, history, slow };
}

async function iconFor(filePath) {
  const key = filePath.toLowerCase();
  if (iconCache.has(key)) return iconCache.get(key);
  let dataUrl = null;
  try {
    const image = await app.getFileIcon(filePath, { size: 'normal' });
    if (image && !image.isEmpty()) dataUrl = image.toDataURL();
  } catch {
    dataUrl = null;
  }
  iconCache.set(key, dataUrl);
  return dataUrl;
}

// Enumerating scheduled tasks costs well over a second, so it is a separate
// call: the renderer paints the startup list first and fills this in after.
async function tasks() {
  const rawTasks = await ps
    .json(TASKS_SCRIPT)
    .then(ps.arr)
    .catch(() => []);

  return rawTasks.map((task) => ({
    ...task,
    id: `task::${task.taskPath}${task.name}`,
    enabled: String(task.state).toLowerCase() !== 'disabled',
    builtIn: String(task.taskPath || '')
      .toLowerCase()
      .startsWith('\\microsoft\\'),
  }));
}

async function list() {
  const rawEntries = await ps.json(LIST_SCRIPT).then(ps.arr);

  const entries = rawEntries.map((entry) => ({
    ...entry,
    id: `${entry.locationId}::${entry.valueName}`,
    command: expandEnvironment(entry.command),
    executable: executableFrom(entry.command),
  }));

  const executables = [...new Set(entries.map((entry) => entry.executable).filter(Boolean))];
  const [details, running] = await Promise.all([describeFiles(executables), runningNow()]);
  const icons = new Map();
  await Promise.all(
    executables.map(async (filePath) => {
      icons.set(filePath.toLowerCase(), await iconFor(filePath));
    })
  );

  cache = new Map();
  for (const entry of entries) {
    const detail = details[entry.executable.toLowerCase()] || {};
    entry.publisher = entry.publisher || detail.publisher || '';
    entry.product = entry.kind === 'packaged' ? '' : detail.product || '';
    entry.running = running[entry.executable.toLowerCase()] || null;
    entry.missing = entry.executable ? detail.exists === false : false;
    entry.icon = icons.get(entry.executable.toLowerCase()) || null;
    cache.set(entry.id, entry);
  }

  return { entries };
}

function requireEntry(id) {
  const entry = cache.get(id);
  if (!entry) throw new Error('That startup item is no longer in the list. Refresh and try again.');
  return entry;
}

async function setEnabled(id, enabled) {
  const entry = requireEntry(id);
  if (!entry.approvable) {
    throw new Error('This one cannot be switched off from here. Run-once entries remove themselves after running, and policy entries are set by whoever manages this PC.');
  }
  if (entry.kind === 'packaged') {
    await ps.mutate(`
${ps.payload({ key: entry.registryKey, state: enabled ? 2 : 1 })}
  Set-ItemProperty -LiteralPath $Payload.key -Name State -Value ([int]$Payload.state) -Type DWord -Force
`);
    entry.enabled = Boolean(enabled);
    return entry;
  }
  await ps.mutate(`
${ps.payload({ key: entry.approvalKey, name: entry.valueName, enabled: Boolean(enabled) })}
  if (-not (Test-Path $Payload.key)) { New-Item -Path $Payload.key -Force | Out-Null }
  if ($Payload.enabled) {
    $bytes = [byte[]](2,0,0,0,0,0,0,0,0,0,0,0)
  } else {
    $bytes = [byte[]]([byte[]](3,0,0,0) + [System.BitConverter]::GetBytes((Get-Date).ToFileTime()))
  }
  New-ItemProperty -Path $Payload.key -Name $Payload.name -Value $bytes -PropertyType Binary -Force | Out-Null
`);
  entry.enabled = Boolean(enabled);
  return entry;
}

async function remove(id) {
  const entry = requireEntry(id);
  if (entry.kind === 'packaged') throw new Error('This belongs to an installed app. Switch it off here, or uninstall the app in Programs.');

  // Registry entries are written to a restore point first, so removing one is
  // recoverable from the Backups tab rather than being permanent.
  let backupId = null;
  if (entry.kind === 'registry') {
    const hive = entry.registryKey.startsWith('HKLM') ? 'HKLM' : 'HKCU';
    const subKey = entry.registryKey.replace(/^HK(LM|CU):\\/, '');
    const restorePoint = await backup.create({
      kind: 'startup',
      label: `Startup entry: ${entry.product || entry.name}`,
      items: [
        {
          hive,
          subKey,
          valueName: entry.valueName,
          description: `${entry.location} — ${entry.command}`,
        },
      ],
    });
    backupId = restorePoint.id;
  }

  if (entry.kind === 'folder') {
    // Shortcuts go to the Recycle Bin, so a mistake is recoverable.
    const error = await shell.trashItem(entry.filePath).then(
      () => null,
      (err) => err
    );
    if (error) throw new Error(`Could not remove the shortcut: ${error.message}`);
  } else {
    await ps.mutate(`
${ps.payload({ key: entry.registryKey, name: entry.valueName })}
  Remove-ItemProperty -LiteralPath $Payload.key -Name $Payload.name -Force
`);
  }

  if (entry.approvalKey) {
    // Leave no orphaned approval value behind.
    await ps
      .mutate(`
${ps.payload({ key: entry.approvalKey, name: entry.valueName })}
  if (Test-Path $Payload.key) {
    Remove-ItemProperty -LiteralPath $Payload.key -Name $Payload.name -Force -ErrorAction SilentlyContinue
  }
`)
      .catch(() => {});
  }

  cache.delete(id);
  return { backupId, recoverable: entry.kind === 'folder' ? 'recycle-bin' : backupId ? 'backup' : null };
}

async function reveal(id) {
  const entry = requireEntry(id);
  if (entry.kind === 'packaged') throw new Error('Windows keeps Store-type apps in a protected folder.');
  const target = entry.kind === 'folder' ? entry.filePath : entry.executable;
  if (!target) throw new Error('There is no file to show for this item.');
  shell.showItemInFolder(target);
  return true;
}

async function setTaskEnabled(taskPath, taskName, enabled) {
  await ps.mutate(`
${ps.payload({ taskPath, taskName, enabled: Boolean(enabled) })}
  if ($Payload.enabled) {
    Enable-ScheduledTask -TaskPath $Payload.taskPath -TaskName $Payload.taskName | Out-Null
  } else {
    Disable-ScheduledTask -TaskPath $Payload.taskPath -TaskName $Payload.taskName | Out-Null
  }
`);
  return true;
}

module.exports = {
  list,
  tasks,
  bootReport,
  setEnabled,
  remove,
  reveal,
  setTaskEnabled,
  __scripts: { LIST: LIST_SCRIPT, TASKS: TASKS_SCRIPT },
};
