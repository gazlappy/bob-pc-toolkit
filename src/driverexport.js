'use strict';

// Driver export — save every third-party driver on this machine to a folder
// before a wipe and reinstall, so the hardware that needs an OEM driver
// (Wi-Fi, chipset, fingerprint reader) works the moment Windows is back rather
// than after an evening of hunting vendor sites.
//
// The preview lists the third-party driver packages currently in use, read from
// Win32_PnPSignedDriver (locale-independent, and with the device each one
// drives). The export itself is Export-WindowsDriver, which writes one tidy
// subfolder per package — that is a DISM online operation, so it needs admin.

const os = require('os');
const path = require('path');
const ps = require('./ps');

const LIST_SCRIPT = `
$drivers = @(Get-CimInstance Win32_PnPSignedDriver -ErrorAction SilentlyContinue | Where-Object { $_.InfName -like 'oem*.inf' })
$groups = $drivers | Group-Object InfName | ForEach-Object {
  $first = $_.Group | Where-Object { $_.DriverProviderName } | Select-Object -First 1
  if (-not $first) { $first = $_.Group[0] }
  $dateStr = ''
  if ($first.DriverDate) {
    try { $dateStr = $first.DriverDate.ToString('yyyy-MM-dd') } catch { $dateStr = [string]$first.DriverDate }
  }
  [pscustomobject]@{
    inf         = [string]$_.Name
    provider    = [string]$first.DriverProviderName
    className   = [string]$first.DeviceClass
    version     = [string]$first.DriverVersion
    date        = $dateStr
    deviceName  = [string]$first.DeviceName
    deviceCount = [int]$_.Count
  }
}
@($groups) | ConvertTo-Json -Depth 4 -Compress
`;

function exportScript(dest) {
  return `
${ps.payload({ dest })}
$dest = $Payload.dest
try {
  if (-not (Test-Path -LiteralPath $dest)) { New-Item -ItemType Directory -Path $dest -Force | Out-Null }
  Export-WindowsDriver -Online -Destination $dest -ErrorAction Stop | Out-Null
  $folders = @(Get-ChildItem -LiteralPath $dest -Directory -ErrorAction SilentlyContinue)
  $bytes = 0
  Get-ChildItem -LiteralPath $dest -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { $bytes += $_.Length }
  [pscustomobject]@{ ok = $true; exported = $folders.Count; bytes = $bytes } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{ ok = $false; error = [string]$_.Exception.Message } | ConvertTo-Json -Compress
}
`;
}

function niceClass(className) {
  const c = String(className || '').trim();
  if (!c) return '';
  // Win32_PnPSignedDriver reports the class in upper case (e.g. NET, MEDIA).
  return c.charAt(0).toUpperCase() + c.slice(1).toLowerCase();
}

async function list() {
  const rows = ps.arr(await ps.json(LIST_SCRIPT));
  const packages = rows
    .map((r) => ({
      inf: r.inf,
      provider: r.provider || 'Unknown provider',
      className: niceClass(r.className),
      version: r.version || '',
      date: r.date || '',
      deviceName: r.deviceName || '',
      deviceCount: r.deviceCount || 1,
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.inf.localeCompare(b.inf));

  return { packages, total: packages.length };
}

// Suggests a dated folder on the Desktop so the tech does not have to think
// about where the backup goes.
function suggestedDestination() {
  const stamp = new Date().toISOString().slice(0, 10);
  const desktop = path.join(os.homedir(), 'Desktop');
  return path.join(desktop, `Driver Backup ${stamp}`);
}

async function exportAll(destination) {
  if (!destination) throw new Error('No destination folder was chosen.');
  const result = await ps.json(exportScript(destination), { timeout: 600000 });
  if (!result || result.ok !== true) {
    const message = (result && result.error) || 'The export failed.';
    if (/elevation|access is denied/i.test(message)) {
      throw new Error('Exporting drivers needs administrator rights. Restart as admin from the banner, then try again.');
    }
    throw new Error(message);
  }
  return { exported: result.exported, bytes: result.bytes, destination };
}

module.exports = { list, exportAll, suggestedDestination, __scripts: { LIST: LIST_SCRIPT } };
