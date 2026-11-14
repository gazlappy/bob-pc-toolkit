'use strict';

// Explorer tweaks: small, per-user, fully reversible changes to File Explorer, the
// taskbar and Start. Every one is a single documented value under the current
// user's own registry hive, so none needs admin and none touches another account.
// Turning a tweak off puts back exactly what Windows had: either its default value
// or no value at all.
//
// The renderer only ever sends an id and on/off. Keys and values come from here.

const ps = require('./ps');

const ADVANCED = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced';
const EXPLORER = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer';
const WIN11 = 22000;

// on: the value that switches the tweak on. off: the value that switches it off,
// or null to remove the value so Windows falls back to its default.
const TWEAKS = [
  { id: 'extensions', group: 'File Explorer', name: 'Show file extensions', desc: 'Shows .exe, .pdf, .jpg and the rest after every file name. Makes a disguised file like "invoice.pdf.exe" easy to spot.', key: ADVANCED, value: 'HideFileExt', on: 0, off: 1 },
  { id: 'hidden', group: 'File Explorer', name: 'Show hidden files and folders', desc: 'Shows AppData and other hidden items, slightly faded.', key: ADVANCED, value: 'Hidden', on: 1, off: 2 },
  { id: 'system', group: 'File Explorer', name: 'Show protected system files', desc: 'Also shows the files Windows hides for its own safety. Turn it back off before handing the PC over.', key: ADVANCED, value: 'ShowSuperHidden', on: 1, off: 0 },
  { id: 'thispc', group: 'File Explorer', name: 'Open File Explorer at This PC', desc: 'Starts on the drives rather than on Home or Quick access.', key: ADVANCED, value: 'LaunchTo', on: 1, off: null },
  { id: 'fullpath', group: 'File Explorer', name: 'Show the full path in the title', desc: 'The window or tab title shows the whole folder path, not just its name.', key: `${EXPLORER}\\CabinetState`, value: 'FullPath', on: 1, off: 0 },
  { id: 'norecent', group: 'File Explorer', name: 'Hide recent files in Home', desc: 'Stops recently opened files being listed when File Explorer opens.', key: EXPLORER, value: 'ShowRecent', on: 0, off: null },
  { id: 'compact', group: 'File Explorer', name: 'Compact view', desc: 'Takes out the extra space Windows 11 puts between files and folders.', key: ADVANCED, value: 'UseCompactMode', on: 1, off: 0, minBuild: WIN11 },
  { id: 'gallery', group: 'File Explorer', name: 'Hide Gallery in the sidebar', desc: 'Removes the Gallery photo view Windows 11 pins to the File Explorer sidebar.', key: 'HKCU:\\Software\\Classes\\CLSID\\{e88865ea-0e1c-4e20-9aa6-edcd0212c87c}', value: 'System.IsPinnedToNameSpaceTree', on: 0, off: null, tidy: true, minBuild: 22621 },
  { id: 'classicmenu', group: 'File Explorer', name: 'Classic right-click menu', desc: 'Right-click shows the full menu straight away, without "Show more options".', kind: 'key', key: 'HKCU:\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}', minBuild: WIN11 },

  { id: 'taskbarleft', group: 'Taskbar and Start', name: 'Start button on the left', desc: 'Moves Start and the taskbar icons to the left, as on Windows 10.', key: ADVANCED, value: 'TaskbarAl', on: 0, off: 1, minBuild: WIN11 },
  { id: 'nosearchbox', group: 'Taskbar and Start', name: 'Hide the taskbar search box', desc: 'Frees the space. Pressing the Windows key and typing still searches.', key: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Search', value: 'SearchboxTaskbarMode', on: 0, off: null },
  { id: 'notaskview', group: 'Taskbar and Start', name: 'Hide the Task View button', desc: 'Win + Tab still opens Task View.', key: ADVANCED, value: 'ShowTaskViewButton', on: 0, off: 1 },
  { id: 'seconds', group: 'Taskbar and Start', name: 'Show seconds on the clock', desc: 'Adds seconds to the taskbar clock.', key: ADVANCED, value: 'ShowSecondsInSystemClock', on: 1, off: 0 },
  { id: 'endtask', group: 'Taskbar and Start', name: '"End task" on taskbar right-click', desc: 'Adds End task to the menu when you right-click a running program on the taskbar.', key: `${ADVANCED}\\TaskbarDeveloperSettings`, value: 'TaskbarEndTask', on: 1, off: 0, minBuild: 22631 },
  { id: 'nowebsearch', group: 'Taskbar and Start', name: 'No web results in Start search', desc: 'Start search only looks on this PC, not on Bing. Takes effect after signing out and in.', key: 'HKCU:\\Software\\Policies\\Microsoft\\Windows\\Explorer', value: 'DisableSearchBoxSuggestions', on: 1, off: null },
];

const BY_ID = new Map(TWEAKS.map((t) => [t.id, t]));

const READ_SCRIPT = `
${ps.payload(TWEAKS.map((t) => ({ id: t.id, kind: t.kind || 'value', key: t.key, value: t.value || '' })))}
$ErrorActionPreference = 'SilentlyContinue'
$build = [int](Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').CurrentBuildNumber
$rows = foreach ($t in @($Payload)) {
  $now = $null
  if ($t.kind -eq 'key') {
    $now = [int](Test-Path -LiteralPath ($t.key + '\\InprocServer32'))
  } else {
    $k = Get-Item -LiteralPath $t.key
    if ($k -and ($k.GetValueNames() -contains $t.value)) { $now = [int]$k.GetValue($t.value) }
  }
  [pscustomobject]@{ id = $t.id; now = $now }
}
[pscustomobject]@{ build = $build; rows = @($rows) } | ConvertTo-Json -Depth 3 -Compress
`;

async function list() {
  const raw = await ps.json(READ_SCRIPT, { timeout: 30000 });
  if (!raw) throw new Error('Could not read the Explorer settings.');
  const now = new Map(ps.arr(raw.rows).map((r) => [r.id, r.now]));
  const build = Number(raw.build) || 0;
  return {
    build,
    tweaks: TWEAKS.filter((t) => !t.minBuild || build >= t.minBuild).map((t) => ({
      id: t.id,
      group: t.group,
      name: t.name,
      desc: t.desc,
      on: t.kind === 'key' ? now.get(t.id) === 1 : now.get(t.id) === t.on,
    })),
  };
}

async function set(id, on) {
  const t = BY_ID.get(id);
  if (!t) throw new Error('Unknown tweak.');
  const want = Boolean(on);
  try {
    if (t.kind === 'key') {
      await ps.mutate(`
${ps.payload({ key: t.key, on: want })}
if ($Payload.on) {
  New-Item -Path ($Payload.key + '\\InprocServer32') -Force | Out-Null
  Set-Item -LiteralPath ($Payload.key + '\\InprocServer32') -Value ''
} elseif (Test-Path -LiteralPath $Payload.key) {
  Remove-Item -LiteralPath $Payload.key -Recurse -Force
}
`);
    } else {
      const target = want ? t.on : t.off;
      await ps.mutate(`
${ps.payload({ key: t.key, value: t.value, remove: target === null, data: target === null ? 0 : target, tidy: Boolean(t.tidy) })}
if ($Payload.remove) {
  if (Test-Path -LiteralPath $Payload.key) {
    Remove-ItemProperty -LiteralPath $Payload.key -Name $Payload.value -Force -ErrorAction SilentlyContinue
    $k = Get-Item -LiteralPath $Payload.key
    if ($Payload.tidy -and $k.ValueCount -eq 0 -and $k.SubKeyCount -eq 0) { Remove-Item -LiteralPath $Payload.key -Force }
  }
} else {
  if (-not (Test-Path -LiteralPath $Payload.key)) { New-Item -Path $Payload.key -Force | Out-Null }
  New-ItemProperty -LiteralPath $Payload.key -Name $Payload.value -PropertyType DWord -Value ([int]$Payload.data) -Force | Out-Null
}
`);
    }
  } catch (error) {
    if (/access|denied|not allowed|unauthorized/i.test(error.message)) throw new Error(`Windows would not let BOB change "${t.name}". Restart BOB as admin and try again.`);
    throw error;
  }
  return { id, on: want };
}

// Most of these only show once File Explorer reloads.
async function restartExplorer() {
  await ps.run(
    "Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 600; if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }",
    { timeout: 20000 }
  );
  return true;
}

module.exports = { list, set, restartExplorer, TWEAKS };
