'use strict';

// Registry scan.
//
// The rule this whole module follows: only report an entry when it names a
// concrete filesystem path that definitively is not there. No heuristics about
// what "looks unused", no orphaned-CLSID hunting, no file-association pruning —
// those are where registry cleaners break machines for no measurable gain.
//
// Two guards keep the false-positive rate down:
//   * a path on a drive that is not currently mounted is ignored, so an
//     unplugged USB stick or a disconnected network share never looks like junk;
//   * anything under a Windows-owned key is left alone.
//
// Everything removed is backed up to a .reg file first — see backup.js.

const fs = require('fs/promises');
const path = require('path');
const ps = require('./ps');
const backup = require('./backup');
const walker = require('./walk');

const CATEGORIES = {
  uninstall: {
    label: 'Leftover uninstall entries',
    description:
      'Entries in Add/Remove Programs for software whose files are gone. They clutter the programs list and can block reinstalls.',
    safety: 'Safe. Removing one only takes it out of the programs list; nothing is uninstalled.',
  },
  appPaths: {
    label: 'App Paths pointing at missing programs',
    description:
      'Shortcut registrations that let a program be launched by name from the Run box. These point at files that no longer exist.',
    safety: 'Safe. Only affects launching that program by its short name.',
  },
  sharedDlls: {
    label: 'Shared DLL references to missing files',
    description: 'Reference counts Windows keeps for shared libraries that are no longer on disk.',
    safety: 'Safe. Purely bookkeeping — nothing reads these except installers.',
  },
  muiCache: {
    label: 'Cached names for programs that are gone',
    description: 'A display-name cache Explorer builds up for every program you run.',
    safety: 'Safe. Rebuilds itself as you use programs.',
  },
  startup: {
    label: 'Startup entries for missing programs',
    description: 'Startup registrations whose program no longer exists, so they fail silently at every sign-in.',
    safety: 'Safe. These already do nothing.',
  },
};

const SCAN_SCRIPT = `
function Read-Values($psPath) {
  $key = Get-Item -LiteralPath $psPath -ErrorAction SilentlyContinue
  if (-not $key) { return @() }
  $rows = New-Object System.Collections.ArrayList
  foreach ($name in $key.GetValueNames()) {
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    [void]$rows.Add([pscustomobject]@{ name = $name; value = [string]$key.GetValue($name) })
  }
  return $rows
}

$result = [ordered]@{}

# --- Add/Remove Programs -------------------------------------------------
$uninstallRoots = @(
  @{ hive = 'HKLM'; sub = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall' },
  @{ hive = 'HKLM'; sub = 'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall' },
  @{ hive = 'HKCU'; sub = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall' }
)
$uninstall = New-Object System.Collections.ArrayList
foreach ($root in $uninstallRoots) {
  $psRoot = $root.hive + ':\\' + $root.sub
  if (-not (Test-Path -LiteralPath $psRoot)) { continue }
  foreach ($child in (Get-ChildItem -LiteralPath $psRoot -ErrorAction SilentlyContinue)) {
    $props = Get-ItemProperty -LiteralPath $child.PSPath -ErrorAction SilentlyContinue
    if (-not $props) { continue }
    [void]$uninstall.Add([pscustomobject]@{
      hive            = $root.hive
      subKey          = $root.sub + '\\' + $child.PSChildName
      keyName         = $child.PSChildName
      displayName     = [string]$props.DisplayName
      publisher       = [string]$props.Publisher
      uninstallString = [string]$props.UninstallString
      installLocation = [string]$props.InstallLocation
      displayIcon     = [string]$props.DisplayIcon
      systemComponent = [int]$props.SystemComponent
      windowsInstaller = [int]$props.WindowsInstaller
    })
  }
}
$result['uninstall'] = @($uninstall)

# --- App Paths -----------------------------------------------------------
$appPathRoots = @(
  @{ hive = 'HKLM'; sub = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths' },
  @{ hive = 'HKLM'; sub = 'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths' },
  @{ hive = 'HKCU'; sub = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths' }
)
$appPaths = New-Object System.Collections.ArrayList
foreach ($root in $appPathRoots) {
  $psRoot = $root.hive + ':\\' + $root.sub
  if (-not (Test-Path -LiteralPath $psRoot)) { continue }
  foreach ($child in (Get-ChildItem -LiteralPath $psRoot -ErrorAction SilentlyContinue)) {
    $target = [string](Get-ItemProperty -LiteralPath $child.PSPath -Name '(default)' -ErrorAction SilentlyContinue).'(default)'
    if (-not $target) {
      $key = Get-Item -LiteralPath $child.PSPath -ErrorAction SilentlyContinue
      if ($key) { $target = [string]$key.GetValue('') }
    }
    [void]$appPaths.Add([pscustomobject]@{
      hive    = $root.hive
      subKey  = $root.sub + '\\' + $child.PSChildName
      keyName = $child.PSChildName
      target  = $target
    })
  }
}
$result['appPaths'] = @($appPaths)

# --- Shared DLLs ---------------------------------------------------------
$result['sharedDlls'] = @(Read-Values 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\SharedDLLs')

# --- MUICache ------------------------------------------------------------
$result['muiCache'] = @(Read-Values 'HKCU:\\SOFTWARE\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\Shell\\MuiCache')

# --- Startup -------------------------------------------------------------
$runKeys = @(
  @{ hive = 'HKCU'; sub = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run' },
  @{ hive = 'HKLM'; sub = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run' },
  @{ hive = 'HKLM'; sub = 'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run' }
)
$runs = New-Object System.Collections.ArrayList
foreach ($root in $runKeys) {
  foreach ($row in (Read-Values ($root.hive + ':\\' + $root.sub))) {
    [void]$runs.Add([pscustomobject]@{ hive = $root.hive; subKey = $root.sub; name = $row.name; value = $row.value })
  }
}
$result['startup'] = @($runs)

[pscustomobject]$result | ConvertTo-Json -Depth 5 -Compress
`;

let mountedDrives = null;
let findingCache = new Map();

async function loadMountedDrives() {
  const data = await ps.json(`
@(Get-CimInstance Win32_LogicalDisk -ErrorAction SilentlyContinue | ForEach-Object { $_.DeviceID }) | ConvertTo-Json -Compress
`);
  mountedDrives = new Set(ps.arr(data).map((drive) => String(drive).toUpperCase().replace(':', '')));
  return mountedDrives;
}

function expandEnvironment(value) {
  return String(value || '').replace(/%([^%]+)%/g, (match, name) => {
    const found = process.env[name] ?? process.env[name.toUpperCase()];
    return found === undefined ? match : found;
  });
}

/**
 * Pulls the executable out of a command line such as:  "C:\a b\x.exe" --flag
 *
 * Returns '' when the command cannot be parsed with confidence. This matters
 * more than it looks: the earlier version fell back to splitting at the first
 * space, which turned "C:\Program Files\...\thing.ico" into "C:\Program" — a
 * path that does not exist, making perfectly healthy entries look like junk.
 * Refusing to guess is what keeps that from happening.
 */
function executableFrom(command) {
  const text = expandEnvironment(command).trim().replace(/^@/, '');
  if (!text) return '';

  if (text.startsWith('"')) {
    const close = text.indexOf('"', 1);
    return close === -1 ? '' : text.slice(1, close);
  }

  // Unquoted: only trust it if a known executable extension terminates the path,
  // which lets the match span embedded spaces correctly.
  const match = text.match(/^(.*?\.(?:exe|com|bat|cmd|scr|msc|cpl|msi))(?:\s|,|$)/i);
  if (match) return match[1];

  // A bare path with no arguments and no spaces is unambiguous.
  if (!text.includes(' ')) return text;

  return '';
}

/**
 * Decides whether a referenced path counts as "definitely missing".
 * Anything unmounted, relative, or not a plain drive path is treated as
 * present, because we cannot prove otherwise.
 */
async function isDefinitelyMissing(target) {
  if (!target) return false;
  const clean = expandEnvironment(target).trim().replace(/^"|"$/g, '');
  if (!clean) return false;

  // UNC paths: a share could simply be offline.
  if (clean.startsWith('\\\\')) return false;

  const drive = clean.match(/^([A-Za-z]):[\\/]/);
  if (!drive) return false; // relative or an odd form — not our business
  if (!mountedDrives || !mountedDrives.has(drive[1].toUpperCase())) return false;

  try {
    await fs.access(clean);
    return false;
  } catch {
    return true;
  }
}

function makeFinding(category, details) {
  return {
    id: `${category}::${details.hive}\\${details.subKey}${details.valueName ? `::${details.valueName}` : ''}`,
    category,
    categoryLabel: CATEGORIES[category].label,
    hive: details.hive,
    subKey: details.subKey,
    valueName: details.valueName || null,
    kind: details.valueName ? 'value' : 'key',
    name: details.name,
    detail: details.detail,
    missingPath: details.missingPath,
    needsAdmin: details.hive === 'HKLM',
  };
}

async function scan(onProgress) {
  const report = (label) => onProgress && onProgress({ label });

  report('Reading the registry');
  await loadMountedDrives();
  const raw = await ps.json(SCAN_SCRIPT, { timeout: 180000 });
  if (!raw) throw new Error('Could not read the registry.');

  const findings = [];

  // --- Uninstall ---------------------------------------------------------
  report('Checking installed programs');
  const uninstallRows = ps.arr(raw.uninstall);
  await walker.pool(uninstallRows, 32, async (row) => {
    // Windows Installer keeps its own product database; deleting an MSI product's
    // ARP key orphans it there, so those are left alone entirely.
    if (row.windowsInstaller === 1) return;

    // SystemComponent entries are hidden from Add/Remove Programs anyway, so
    // removing them is all risk and no visible benefit.
    if (row.systemComponent === 1) return;

    // DisplayIcon is deliberately not used as evidence: a missing icon file is
    // cosmetic and says nothing about whether the program is installed.
    const location = String(row.installLocation || '').trim();

    let evidence = null;
    if (location) {
      // The recorded install folder is the strongest signal available. If it is
      // still there, the program is installed — stop, whatever else is missing.
      if (!(await isDefinitelyMissing(location))) return;
      evidence = location;
    } else {
      const uninstaller = executableFrom(row.uninstallString);
      if (!uninstaller) return;
      if (!(await isDefinitelyMissing(uninstaller))) return;
      evidence = uninstaller;
    }

    findings.push(
      makeFinding('uninstall', {
        hive: row.hive,
        subKey: row.subKey,
        name: row.displayName || row.keyName,
        detail: row.publisher || 'No publisher recorded',
        missingPath: expandEnvironment(evidence),
      })
    );
  });

  // --- App Paths ---------------------------------------------------------
  report('Checking program registrations');
  await walker.pool(ps.arr(raw.appPaths), 32, async (row) => {
    const target = executableFrom(row.target);
    if (!target) return;
    if (!(await isDefinitelyMissing(target))) return;
    findings.push(
      makeFinding('appPaths', {
        hive: row.hive,
        subKey: row.subKey,
        name: row.keyName,
        detail: 'Registered launch name',
        missingPath: expandEnvironment(target),
      })
    );
  });

  // --- Shared DLLs -------------------------------------------------------
  report('Checking shared libraries');
  await walker.pool(ps.arr(raw.sharedDlls), 48, async (row) => {
    if (!(await isDefinitelyMissing(row.name))) return;
    findings.push(
      makeFinding('sharedDlls', {
        hive: 'HKLM',
        subKey: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\SharedDLLs',
        valueName: row.name,
        name: path.basename(row.name),
        detail: path.dirname(row.name),
        missingPath: row.name,
      })
    );
  });

  // --- MUICache ----------------------------------------------------------
  report('Checking cached program names');
  await walker.pool(ps.arr(raw.muiCache), 48, async (row) => {
    // A program shows up here under its own path and, separately, under
    // "<path>.FriendlyAppName" / ".ApplicationCompany". Those are distinct
    // registry values, so each is its own finding — the suffix is surfaced so
    // two rows for the same program do not look like a duplicate.
    const suffix = row.name.match(/\.(FriendlyAppName|ApplicationCompany)$/i);
    const target = suffix ? row.name.slice(0, -suffix[0].length) : row.name;
    if (!/^[A-Za-z]:[\\/]/.test(target)) return;
    if (!(await isDefinitelyMissing(target))) return;

    const what = suffix
      ? suffix[1].toLowerCase() === 'friendlyappname'
        ? 'display name'
        : 'company name'
      : 'cached entry';

    findings.push(
      makeFinding('muiCache', {
        hive: 'HKCU',
        subKey: 'SOFTWARE\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\Shell\\MuiCache',
        valueName: row.name,
        name: `${path.basename(target)} (${what})`,
        detail: row.value ? `${row.value} — ${path.dirname(target)}` : path.dirname(target),
        missingPath: target,
      })
    );
  });

  // --- Startup -----------------------------------------------------------
  report('Checking startup entries');
  await walker.pool(ps.arr(raw.startup), 32, async (row) => {
    const target = executableFrom(row.value);
    if (!target) return;
    if (!(await isDefinitelyMissing(target))) return;
    findings.push(
      makeFinding('startup', {
        hive: row.hive,
        subKey: row.subKey,
        valueName: row.name,
        name: row.name,
        detail: expandEnvironment(row.value),
        missingPath: expandEnvironment(target),
      })
    );
  });

  findingCache = new Map(findings.map((finding) => [finding.id, finding]));

  const groups = Object.entries(CATEGORIES).map(([id, meta]) => {
    const items = findings.filter((finding) => finding.category === id);
    return { id, ...meta, count: items.length, items };
  });

  report('Done');
  return { groups, total: findings.length };
}

/** Removes the given findings, writing a restore point first. */
async function clean(ids) {
  const chosen = ids.map((id) => findingCache.get(id)).filter(Boolean);
  if (!chosen.length) throw new Error('Nothing selected, or the scan is out of date. Scan again.');

  const restorePoint = await backup.create({
    kind: 'registry',
    label: `${chosen.length} registry item${chosen.length === 1 ? '' : 's'}`,
    items: chosen.map((finding) => ({
      hive: finding.hive,
      subKey: finding.subKey,
      valueName: finding.valueName,
      description: `${finding.categoryLabel}: ${finding.name}`,
    })),
  });

  const request = chosen.map((finding) => ({
    psPath: `${finding.hive}:\\${finding.subKey}`,
    valueName: finding.valueName,
  }));

  const outcome = await ps.json(
    `
${ps.payload(request)}
$removed = 0
$failed = New-Object System.Collections.ArrayList
foreach ($item in @($Payload)) {
  try {
    if ($item.valueName) {
      Remove-ItemProperty -LiteralPath $item.psPath -Name $item.valueName -Force -ErrorAction Stop
    } else {
      Remove-Item -LiteralPath $item.psPath -Recurse -Force -ErrorAction Stop
    }
    $removed++
  } catch {
    [void]$failed.Add([pscustomobject]@{ path = $item.psPath; error = $_.Exception.Message })
  }
}
[pscustomobject]@{ removed = $removed; failed = @($failed) } | ConvertTo-Json -Depth 4 -Compress
`,
    { timeout: 120000 }
  );

  for (const finding of chosen) findingCache.delete(finding.id);

  return {
    removed: Number((outcome && outcome.removed) || 0),
    failed: ps.arr(outcome && outcome.failed),
    backupId: restorePoint.id,
  };
}

module.exports = { scan, clean, CATEGORIES, __internals: { executableFrom, isDefinitelyMissing, loadMountedDrives } };
