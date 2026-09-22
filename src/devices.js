'use strict';

// Devices & drivers: every device with the driver it is running, and the ones
// with a problem flagged — the Device Manager yellow-bangs. Read-only.
//
// Two CIM classes are joined: Win32_PnPEntity has each device's status and its
// ConfigManagerErrorCode (0 = fine, anything else is a problem), and
// Win32_PnPSignedDriver has the driver version, date and provider. They join on
// the device's PnP id.

const ps = require('./ps');

// ConfigManagerErrorCode → what it means for a technician. Only the codes that
// actually turn up are spelled out; the rest fall back to a generic line.
const ERROR_TEXT = {
  1: 'Not configured correctly.',
  3: 'The driver may be corrupt, or the system is low on resources.',
  10: 'This device cannot start.',
  12: 'Not enough free resources for this device.',
  14: 'Needs a restart to work.',
  18: 'Its drivers need reinstalling.',
  19: 'Its registry configuration is corrupt.',
  21: 'Windows is removing it.',
  22: 'Disabled.',
  24: 'Not present, not working, or its driver is missing.',
  28: 'No drivers are installed for this device.',
  31: 'Not working because its driver could not load.',
  33: 'Windows cannot determine which resources it needs.',
  37: 'Its driver returned a failure when starting.',
  39: 'Its driver is missing or corrupt.',
  43: 'Windows stopped it after it reported a problem.',
  45: 'Not connected.',
  52: 'Its driver is not signed.',
};

// Classes worth showing first — the ones a technician actually cares about.
const CLASS_ORDER = [
  'Display',
  'Net',
  'DiskDrive',
  'SCSIAdapter',
  'HDC',
  'Media',
  'AudioEndpoint',
  'USB',
  'Bluetooth',
  'Processor',
  'System',
  'Monitor',
  'Keyboard',
  'Mouse',
  'HIDClass',
  'Printer',
  'Camera',
];

const LIST_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'

$drivers = @{}
foreach ($d in Get-CimInstance Win32_PnPSignedDriver) {
  if ($d.DeviceID) { $drivers[$d.DeviceID] = $d }
}

@(Get-CimInstance Win32_PnPEntity | Where-Object { $_.Present -ne $false } | ForEach-Object {
  $d = $drivers[$_.PNPDeviceID]
  [pscustomobject]@{
    name           = [string]$_.Name
    class          = [string]$_.PNPClass
    manufacturer   = [string]$_.Manufacturer
    error          = [int]$_.ConfigManagerErrorCode
    driverVersion  = if ($d) { [string]$d.DriverVersion } else { $null }
    driverDate     = if ($d -and $d.DriverDate) { $d.DriverDate.ToString('yyyy-MM-dd') } else { $null }
    driverProvider = if ($d) { [string]$d.DriverProviderName } else { $null }
  }
}) | ConvertTo-Json -Depth 3 -Compress
`;

async function list() {
  const rows = ps.arr(await ps.json(LIST_SCRIPT, { timeout: 60000 }));

  const devices = rows
    .filter((r) => r.name)
    .map((r) => ({
      name: r.name,
      class: r.class || 'Other',
      manufacturer: r.manufacturer || null,
      errorCode: r.error || 0,
      problem: r.error ? ERROR_TEXT[r.error] || `Reported a problem (code ${r.error}).` : null,
      driverVersion: r.driverVersion || null,
      driverDate: r.driverDate || null,
      driverProvider: r.driverProvider || null,
    }));

  const problems = devices.filter((d) => d.problem);

  // Group by class, interesting classes first, the rest alphabetical.
  const byClass = new Map();
  for (const device of devices) {
    if (!byClass.has(device.class)) byClass.set(device.class, []);
    byClass.get(device.class).push(device);
  }
  const groups = [...byClass.entries()]
    .map(([name, items]) => ({
      name,
      items: items.sort((a, b) => a.name.localeCompare(b.name)),
      order: CLASS_ORDER.indexOf(name),
    }))
    .sort((a, b) => {
      const ao = a.order === -1 ? CLASS_ORDER.length : a.order;
      const bo = b.order === -1 ? CLASS_ORDER.length : b.order;
      return ao - bo || a.name.localeCompare(b.name);
    });

  return {
    problems,
    groups,
    total: devices.length,
    withDrivers: devices.filter((d) => d.driverVersion).length,
  };
}

module.exports = { list, __internals: { ERROR_TEXT } };
