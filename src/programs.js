'use strict';

// Installed programs, read from the same Uninstall keys the registry scan
// walks. Uninstalling the things you no longer use reclaims far more space
// than any cache ever will, so this exists to make the big ones easy to find.
//
// Nothing here uninstalls anything itself: it launches the program's own
// uninstaller and gets out of the way.

const path = require('path');
const fs = require('fs/promises');
const ps = require('./ps');
const walker = require('./walk');

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

function reveal(id) {
  const entry = cache.get(id);
  if (!entry || !entry.installLocation) throw new Error('This program did not record where it is installed.');
  const { shell } = require('electron');
  shell.openPath(path.resolve(entry.installLocation));
  return true;
}

module.exports = { list, measure, uninstall, reveal, __internals: { splitCommand, formatInstallDate } };
