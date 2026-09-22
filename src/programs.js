'use strict';

// Installed programs, read from the same Uninstall keys the registry scan
// walks. Uninstalling the things you no longer use reclaims far more space
// than any cache ever will, so this exists to make the big ones easy to find.
//
// Uninstalling normally launches the program's own uninstaller and gets out of
// the way. Forced removal, for when that uninstaller will not run, is further
// down — and even that parks files in quarantine rather than deleting them.

const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const { app } = require('electron');
const ps = require('./ps');
const walker = require('./walk');
const files = require('./files');
const backup = require('./backup');

const LIST_SCRIPT = `
$roots = @(
  @{ hive = 'HKLM'; sub = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall';              scope = 'machine' },
  @{ hive = 'HKLM'; sub = 'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'; scope = 'machine32' },
  @{ hive = 'HKCU'; sub = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall';              scope = 'user' }
)

$out = New-Object System.Collections.ArrayList
foreach ($root in $roots) {
  $psRoot = $root.hive + ':\\' + $root.sub
  if (-not (Test-Path -LiteralPath $psRoot)) { continue }
  foreach ($child in (Get-ChildItem -LiteralPath $psRoot -ErrorAction SilentlyContinue)) {
    $p = Get-ItemProperty -LiteralPath $child.PSPath -ErrorAction SilentlyContinue
    if (-not $p) { continue }
    if (-not $p.DisplayName) { continue }
    [void]$out.Add([pscustomobject]@{
      key             = [string]$child.PSChildName
      scope           = $root.scope
      name            = [string]$p.DisplayName
      version         = [string]$p.DisplayVersion
      publisher       = [string]$p.Publisher
      installDate     = [string]$p.InstallDate
      estimatedKb     = [int]$p.EstimatedSize
      installLocation = [string]$p.InstallLocation
      uninstallString = [string]$p.UninstallString
      systemComponent = [int]$p.SystemComponent
      windowsInstaller = [int]$p.WindowsInstaller
      parentKeyName   = [string]$p.ParentKeyName
    })
  }
}
@($out) | ConvertTo-Json -Depth 4 -Compress
`;

let cache = new Map();
// Every registered install location, hidden components included, so a forced
// removal can tell when a folder is shared with something else.
let allLocations = [];

const UNINSTALL_ROOTS = {
  machine: { hive: 'HKLM', sub: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall' },
  machine32: { hive: 'HKLM', sub: 'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall' },
  user: { hive: 'HKCU', sub: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall' },
};

/** "20240117" → "17 Jan 2024". Left alone if it is not that shape. */
function formatInstallDate(raw) {
  const match = String(raw || '').match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * Splits an uninstall command into a program and its arguments.
 * Handles the three shapes that actually occur:
 *   "C:\Program Files\App\unins000.exe" /SILENT
 *   C:\Program Files\App\unins000.exe /SILENT
 *   MsiExec.exe /X{GUID}
 */
function splitCommand(command) {
  const text = String(command || '').trim();
  if (!text) return null;

  if (text.startsWith('"')) {
    const close = text.indexOf('"', 1);
    if (close === -1) return null;
    return { exe: text.slice(1, close), args: text.slice(close + 1).trim() };
  }

  const match = text.match(/^(.*?\.(?:exe|com|bat|cmd))(\s|$)/i);
  if (match) return { exe: match[1], args: text.slice(match[1].length).trim() };

  // No extension and no quotes: only safe to treat the whole thing as the
  // program when it has no spaces to be ambiguous about.
  if (!text.includes(' ')) return { exe: text, args: '' };
  return null;
}

async function list() {
  const rows = ps.arr(await ps.json(LIST_SCRIPT, { timeout: 120000 }));

  cache = new Map();
  allLocations = rows
    .filter((row) => row.installLocation)
    .map((row) => ({ id: `${row.scope}::${row.key}`, name: row.name, location: row.installLocation }));

  const programs = [];
  for (const row of rows) {
    // SystemComponent entries are hidden from Add/Remove Programs, and an
    // entry with a parent is a component of another product, not its own
    // installation — showing either just pads the list with things the user
    // cannot meaningfully act on.
    if (row.systemComponent === 1) continue;
    if (row.parentKeyName) continue;

    const command = splitCommand(row.uninstallString);
    const id = `${row.scope}::${row.key}`;
    programs.push({
      id,
      name: row.name,
      version: row.version || null,
      publisher: row.publisher || null,
      installedOn: formatInstallDate(row.installDate),
      // EstimatedSize is in KB and is whatever the installer chose to write —
      // often absent, sometimes wrong. "Measure" replaces it with the truth.
      estimatedBytes: row.estimatedKb > 0 ? row.estimatedKb * 1024 : null,
      measuredBytes: null,
      installLocation: row.installLocation || null,
      canUninstall: Boolean(command),
      scope: row.scope,
      msi: row.windowsInstaller === 1,
    });
    cache.set(id, { ...row, command });
  }

  programs.sort((a, b) => (b.estimatedBytes ?? 0) - (a.estimatedBytes ?? 0));

  // Mark the ones whose folder is gone: leftovers the Registry tab can clear.
  await walker.pool(programs, 24, async (program) => {
    if (!program.installLocation) return;
    try {
      await fs.access(program.installLocation);
    } catch {
      program.missing = true;
    }
  });

  return programs;
}

/** Walks a program's install folder for its real size on disk. */
async function measure(id) {
  const entry = cache.get(id);
  if (!entry) throw new Error('That program is no longer in the list. Refresh and try again.');

  const location = entry.installLocation;
  if (!location) throw new Error('This program did not record where it is installed.');

  const resolved = path.resolve(location);
  // A program that claims to live at a drive root would have us measure the
  // whole disk, so refuse anything that shallow.
  if (resolved.split(path.sep).filter(Boolean).length < 2) {
    throw new Error('That install location is too broad to measure safely.');
  }

  const totals = await walker.measure(resolved);
  return { id, bytes: totals.bytes, files: totals.files };
}

/** Launches the program's own uninstaller. */
async function uninstall(id) {
  const entry = cache.get(id);
  if (!entry) throw new Error('That program is no longer in the list. Refresh and try again.');
  if (!entry.command) throw new Error('This program did not register an uninstaller.');

  await ps.mutate(
    `
${ps.payload({ exe: entry.command.exe, args: entry.command.args })}
  if ($Payload.args) {
    Start-Process -FilePath $Payload.exe -ArgumentList $Payload.args | Out-Null
  } else {
    Start-Process -FilePath $Payload.exe | Out-Null
  }
`,
    { timeout: 30000 }
  );

  return { launched: entry.name };
}

// --- forced removal -------------------------------------------------------
//
// For programs whose own uninstaller is gone, crashes, or wants an installer
// source that no longer exists. Nothing is deleted: the folder and its
// shortcuts are parked in quarantine and the Add/Remove Programs key is
// exported to a restore point before it goes, so one Restore puts the lot back.
// The space is only freed when that restore point is discarded.

function normalise(target) {
  return path.resolve(target).toLowerCase().replace(/\\+$/, '');
}

function isInside(child, parent) {
  const c = normalise(child);
  const p = normalise(parent);
  return c === p || c.startsWith(`${p}\\`);
}

/** Folders a forced removal may never take, nor any folder containing one. */
async function protectedFolders() {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFiles86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

  const list = [
    process.env.SystemRoot || 'C:\\Windows',
    programFiles,
    programFiles86,
    path.join(programFiles, 'Common Files'),
    path.join(programFiles86, 'Common Files'),
    path.join(programFiles, 'WindowsApps'),
    process.env.ProgramData || 'C:\\ProgramData',
    path.dirname(home),
    home,
    local,
    roaming,
    path.join(local, 'Programs'),
    path.join(local, 'Temp'),
    // This app itself, however it is being run.
    path.dirname(process.execPath),
    app.getAppPath(),
    app.getPath('userData'),
  ];
  if (process.env.PORTABLE_EXECUTABLE_DIR) list.push(process.env.PORTABLE_EXECUTABLE_DIR);

  // Desktop, Documents and friends, wherever OneDrive has moved them.
  for (const root of await files.availableRoots()) list.push(root.path);
  return list;
}

/** Why `folder` must not be removed, or null if it may be. */
async function folderRefusal(folder, programId) {
  const target = normalise(folder);
  if (/^[a-z]:$/.test(target)) return 'That is the root of a drive.';

  for (const guarded of await protectedFolders()) {
    if (normalise(guarded) === target) return `${folder} is a protected Windows or user folder.`;
    if (isInside(guarded, folder)) return `${folder} contains ${guarded}, which must not be touched.`;
  }

  // A folder shared with anything else registered is off limits in both
  // directions: removing it would take the other program's files, and removing
  // a folder that sits inside another program's would break that one.
  for (const other of allLocations) {
    if (other.id === programId) continue;
    if (isInside(other.location, folder)) {
      return `${folder} also holds ${other.name}, which is installed at ${other.location}.`;
    }
    if (isInside(folder, other.location)) {
      return `${folder} is part of ${other.name}'s installation at ${other.location}.`;
    }
  }

  return null;
}

/**
 * Works out exactly what a forced removal would do, without doing any of it.
 * The renderer shows this to the user before asking them to confirm, and the
 * removal itself recomputes it rather than trusting a plan from earlier.
 */
async function forcePlan(id) {
  const entry = cache.get(id);
  if (!entry) throw new Error('That program is no longer in the list. Refresh and try again.');

  const root = UNINSTALL_ROOTS[entry.scope];
  const plan = {
    id,
    name: entry.name,
    scope: entry.scope,
    registry: { hive: root.hive, subKey: `${root.sub}\\${entry.key}` },
    folder: null,
    shortcuts: [],
    processes: [],
    needsAdmin: root.hive === 'HKLM',
    isAdmin: await isAdmin(),
    refusals: [],
    canForce: false,
  };

  // The cheap refusals come first. Measuring the folder and searching for its
  // shortcuts takes real time, and there is no point paying it for a removal
  // that could not go ahead anyway.
  if (entry.windowsInstaller === 1) {
    plan.refusals.push(
      'This was installed by Windows Installer. Removing its entry by hand leaves Windows Installer ' +
        "believing it is still there, which blocks reinstalling it. Use Microsoft's Program Install " +
        'and Uninstall troubleshooter instead — it is built for exactly this.'
    );
  }
  if (plan.needsAdmin && !plan.isAdmin) {
    plan.refusals.push('This was installed for all users, so removing it needs administrator rights.');
  }

  // Where the files are. The recorded install location is best; failing that,
  // the folder the uninstaller lives in is nearly always the program's own.
  let folderPath = entry.installLocation || null;
  let derived = false;
  if (!folderPath && entry.command && path.isAbsolute(entry.command.exe)) {
    folderPath = path.dirname(entry.command.exe);
    derived = true;
  }

  if (folderPath) {
    const resolved = path.resolve(folderPath);
    let exists = false;
    try {
      exists = (await fs.stat(resolved)).isDirectory();
    } catch {
      exists = false;
    }
    plan.folder = { path: resolved, exists, derived, bytes: 0, files: 0 };

    if (exists) {
      const refusal = await folderRefusal(resolved, id);
      if (refusal) plan.refusals.push(refusal);
    }
  }

  if (plan.refusals.length) return plan;

  if (plan.folder && plan.folder.exists) {
    const totals = await walker.measure(plan.folder.path);
    plan.folder.bytes = totals.bytes;
    plan.folder.files = totals.files;
  }

  const probe = await ps.json(`
${ps.payload({ folder: plan.folder && plan.folder.exists ? plan.folder.path : null, search: plan.folder ? plan.folder.path : null })}
$ignore = [System.StringComparison]::OrdinalIgnoreCase

$processes = @()
if ($Payload.folder) {
  $prefix = $Payload.folder.TrimEnd('\\') + '\\'
  $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, $ignore)
  } | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; pid = [int]$_.ProcessId } })
}

# Shortcuts pointing into the folder. Searched even when the folder is already
# gone, since those are exactly the broken ones left behind.
#
# Start Menus are searched through their subfolders, which is where programs
# put them. Desktops are searched at the top level only: nothing installs a
# shortcut into a folder on the desktop, and recursing a OneDrive-synced one
# took six seconds on a real machine to find a single extra shortcut, inside a
# project folder, that was not a program's anyway.
$shortcuts = @()
if ($Payload.search) {
  $prefix = $Payload.search.TrimEnd('\\') + '\\'
  $wsh = New-Object -ComObject WScript.Shell
  $places = @(
    @{ special = 'StartMenu'; deep = $true },
    @{ special = 'CommonStartMenu'; deep = $true },
    @{ special = 'Desktop'; deep = $false },
    @{ special = 'CommonDesktopDirectory'; deep = $false }
  )
  foreach ($place in $places) {
    $dir = [Environment]::GetFolderPath($place.special)
    if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { continue }
    Get-ChildItem -LiteralPath $dir -Recurse:$place.deep -Filter '*.lnk' -File -ErrorAction SilentlyContinue | ForEach-Object {
      $target = $null
      try { $target = $wsh.CreateShortcut($_.FullName).TargetPath } catch { }
      if ($target -and ($target.TrimEnd('\\') + '\\').StartsWith($prefix, $ignore)) {
        $shortcuts += $_.FullName
      }
    }
  }
}

[pscustomobject]@{ processes = @($processes); shortcuts = @($shortcuts) } | ConvertTo-Json -Depth 4 -Compress
`);

  plan.processes = ps.arr(probe && probe.processes);
  plan.shortcuts = [...new Set(ps.arr(probe && probe.shortcuts))];

  if (plan.processes.length) {
    const names = [...new Set(plan.processes.map((proc) => proc.name))].join(', ');
    plan.refusals.push(`Still running: ${names}. Close ${plan.processes.length === 1 ? 'it' : 'them'} first.`);
  }

  plan.canForce = plan.refusals.length === 0;
  return plan;
}

// Elevation cannot change for the life of a process — restarting as
// administrator starts a new one — so this is asked once.
let adminStatus = null;
async function isAdmin() {
  if (adminStatus === null) {
    const result = await ps.json(`
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
[pscustomobject]@{ admin = (New-Object System.Security.Principal.WindowsPrincipal($identity)).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator) } | ConvertTo-Json -Compress`);
    adminStatus = Boolean(result && result.admin);
  }
  return adminStatus;
}

/** An error message without its closing full stop, for embedding in a sentence. */
function clause(error) {
  return String((error && error.message) || error).trim().replace(/[.\s]+$/, '');
}

async function removeRegistryKey(registry) {
  await ps.mutate(`
${ps.payload({ path: `${registry.hive}:\\${registry.subKey}` })}
  if (Test-Path -LiteralPath $Payload.path) {
    Remove-Item -LiteralPath $Payload.path -Recurse -Force
  }
`);
}

/** Drops Start Menu folders emptied by moving their shortcuts out. */
async function pruneEmptyShortcutFolders(moved) {
  const startMenus = [
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.ProgramData || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ].map(normalise);

  for (const entry of moved) {
    if (entry.type !== 'file') continue;
    const parent = path.dirname(entry.from);
    // Only a subfolder of a Start Menu, never the Start Menu or Desktop itself.
    if (!startMenus.some((menu) => normalise(parent).startsWith(`${menu}\\`))) continue;
    try {
      await fs.rmdir(parent); // succeeds only when empty
    } catch {
      /* still has other shortcuts in it */
    }
  }
}

/**
 * Removes a program whose uninstaller will not run.
 *
 * Order matters. The restore point is written first, listing every planned
 * move, so a crash part way through still leaves a record of where everything
 * went. The folder is parked next, because it is the step most likely to fail
 * (a file still in use) and failing there changes nothing. The registry key
 * goes last; if that fails, the moves are undone.
 */
async function forceRemove(id) {
  const plan = await forcePlan(id);
  if (!plan.canForce) throw new Error(plan.refusals.join(' '));

  const restorePoint = await backup.create({
    kind: 'program',
    label: `Program: ${plan.name}`,
    items: [
      {
        hive: plan.registry.hive,
        subKey: plan.registry.subKey,
        description: `Add/Remove Programs entry for ${plan.name}`,
      },
    ],
  });
  const backupId = restorePoint.id;

  const planned = [];
  if (plan.folder && plan.folder.exists) {
    planned.push({
      from: plan.folder.path,
      to: path.join(backup.quarantineDir(plan.folder.path, backupId), path.basename(plan.folder.path)),
      type: 'folder',
      bytes: plan.folder.bytes,
      description: `Install folder for ${plan.name}`,
    });
  }
  plan.shortcuts.forEach((shortcut, index) => {
    planned.push({
      from: shortcut,
      to: path.join(backup.quarantineDir(shortcut, backupId), 'shortcuts', `${index}-${path.basename(shortcut)}`),
      type: 'file',
      bytes: 0,
      description: `Shortcut: ${path.basename(shortcut, '.lnk')}`,
    });
  });

  await backup.setMoved(backupId, planned, 'pending');

  const done = [];

  /** Moves everything back. Returns whatever could not be moved. */
  const undo = async () => {
    const stranded = [];
    for (const entry of [...done].reverse()) {
      try {
        await fs.mkdir(path.dirname(entry.from), { recursive: true });
        await fs.rename(entry.to, entry.from);
      } catch {
        stranded.push(entry);
      }
    }
    return stranded;
  };

  /** Drops the restore point, once nothing of the user's is left in quarantine. */
  const abandon = async () => {
    await backup.setMoved(backupId, [], 'failed');
    await backup.remove(backupId);
    // Parking created the quarantine folders before anything moved into them.
    await backup.cleanQuarantineDirs(planned);
  };

  // The folder: all or nothing.
  const folderMove = planned.find((entry) => entry.type === 'folder');
  if (folderMove) {
    try {
      await fs.mkdir(path.dirname(folderMove.to), { recursive: true });
      await fs.rename(folderMove.from, folderMove.to);
      done.push(folderMove);
    } catch (error) {
      await abandon();
      const inUse = ['EBUSY', 'EPERM', 'EACCES'].includes(error.code);
      throw new Error(
        inUse
          ? `Could not move ${folderMove.from} — a file in it is in use or protected. Nothing was changed.`
          : `Could not move ${folderMove.from}: ${clause(error)}. Nothing was changed.`
      );
    }
  }

  // Shortcuts: cosmetic, so one that will not move does not stop the rest.
  const skippedShortcuts = [];
  for (const entry of planned.filter((item) => item.type === 'file')) {
    try {
      await fs.mkdir(path.dirname(entry.to), { recursive: true });
      await fs.rename(entry.from, entry.to);
      done.push(entry);
    } catch {
      skippedShortcuts.push(entry.from);
    }
  }

  try {
    await removeRegistryKey(plan.registry);
  } catch (error) {
    const stranded = await undo();
    if (stranded.length) {
      // Something would not go back. Keep the restore point pointing at
      // exactly those items: deleting it now would leave them in quarantine
      // with nothing to say they are there.
      await backup.setMoved(backupId, stranded, 'failed');
      throw new Error(
        `Could not remove the Add/Remove Programs entry (${clause(error)}), and ` +
          `${stranded.length} item${stranded.length === 1 ? '' : 's'} could not be put back. ` +
          'Nothing is lost — restore them from the Backups tab.'
      );
    }
    await abandon();
    throw new Error(`Could not remove the Add/Remove Programs entry: ${clause(error)}. Everything was put back.`);
  }

  await backup.setMoved(backupId, done, 'done');
  await pruneEmptyShortcutFolders(done);
  cache.delete(id);

  return {
    backupId,
    name: plan.name,
    bytes: folderMove && done.includes(folderMove) ? folderMove.bytes : 0,
    shortcutsMoved: done.filter((entry) => entry.type === 'file').length,
    skippedShortcuts,
  };
}

function reveal(id) {
  const entry = cache.get(id);
  if (!entry || !entry.installLocation) throw new Error('This program did not record where it is installed.');
  const { shell } = require('electron');
  shell.openPath(path.resolve(entry.installLocation));
  return true;
}

module.exports = {
  list,
  measure,
  uninstall,
  reveal,
  forcePlan,
  forceRemove,
  __internals: { splitCommand, formatInstallDate, folderRefusal, isInside },
};
