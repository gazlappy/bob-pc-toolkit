'use strict';

// Explorer tweaks — small, per-user, fully reversible shell tweaks.
//
// First one: hide the "Gallery" item Windows 11 added to the File Explorer
// navigation pane. It is a shell namespace folder (a known CLSID); setting
// System.IsPinnedToNameSpaceTree to 0 under that CLSID in HKCU hides it, and
// removing the value restores the default. No admin — it is all under the
// current user's hive — and it only means anything on Windows 11, so the tool
// reports "not available" on Windows 10.

const ps = require('./ps');

const GALLERY_CLSID = '{e88865ea-0e1c-4e20-9aa6-edcd0212c87c}';
const GALLERY_KEY = `HKCU:\\Software\\Classes\\CLSID\\${GALLERY_CLSID}`;
const PIN_VALUE = 'System.IsPinnedToNameSpaceTree';
// The Gallery arrived with Windows 11 23H2-era builds.
const MIN_BUILD = 22621;

async function galleryStatus() {
  const raw = await ps.json(`
$cv = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion' -ErrorAction SilentlyContinue
$build = [int]$cv.CurrentBuildNumber
$val = $null
try { $val = (Get-ItemProperty -Path '${GALLERY_KEY}' -Name '${PIN_VALUE}' -ErrorAction Stop).'${PIN_VALUE}' } catch {}
[pscustomobject]@{
  build     = $build
  supported = ($build -ge ${MIN_BUILD})
  present   = ($val -ne $null)
  hidden    = ($val -eq 0)
} | ConvertTo-Json -Compress
`);
  return {
    supported: Boolean(raw && raw.supported),
    build: (raw && raw.build) || 0,
    hidden: Boolean(raw && raw.hidden),
  };
}

async function setGalleryHidden(hidden) {
  await ps.mutate(`
${ps.payload({ key: GALLERY_KEY, value: PIN_VALUE, hidden: Boolean(hidden) })}
if ($Payload.hidden) {
  if (-not (Test-Path $Payload.key)) { New-Item -Path $Payload.key -Force | Out-Null }
  New-ItemProperty -Path $Payload.key -Name $Payload.value -PropertyType DWord -Value 0 -Force | Out-Null
} else {
  # Restore the default by removing the override, and tidy the key if it is now empty.
  if (Test-Path $Payload.key) {
    Remove-ItemProperty -Path $Payload.key -Name $Payload.value -Force -ErrorAction SilentlyContinue
    $k = Get-Item -Path $Payload.key
    if ($k.ValueCount -eq 0 -and $k.SubKeyCount -eq 0) { Remove-Item -Path $Payload.key -Force }
  }
}
`);
  return { hidden: Boolean(hidden) };
}

// The change only shows once File Explorer reloads.
async function restartExplorer() {
  await ps.run(
    "Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 600; if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }",
    { timeout: 20000 }
  );
  return true;
}

module.exports = { galleryStatus, setGalleryHidden, restartExplorer, __internals: { GALLERY_KEY, PIN_VALUE } };
