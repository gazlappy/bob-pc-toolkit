'use strict';

// Ghost device cleaner — the non-present ("phantom") devices hidden in Device
// Manager that pile up as hardware is swapped: old USB sticks, headsets,
// controllers, replaced NICs, leftover COM ports. They quietly cause driver
// conflicts and duplicate COM assignments. This is the classic
// `set devmgr_show_nonpresent_devices=1` + "show hidden devices" trick, as a
// safe one-click.
//
// Scope is deliberately narrow: only non-present devices in removable-hardware
// classes are listed, never the core system/processor/firmware nodes that also
// report non-present but must be left alone. Removing needs admin, and each
// removal is re-checked server-side (still non-present, still a safe class)
// before it runs.

const ps = require('./ps');

// Removable-hardware classes that legitimately accumulate ghosts.
const SAFE_CLASSES = [
  'USB', 'USBDevice', 'Net', 'Ports', 'DiskDrive', 'Volume', 'Bluetooth',
  'Image', 'Media', 'MEDIA', 'WPD', 'Monitor', 'HIDClass', 'Mouse',
  'Keyboard', 'PrintQueue', 'AudioEndpoint', 'SmartCardReader',
];

// Friendlier names for the raw PnP class strings.
const CLASS_LABEL = {
  USB: 'USB',
  USBDevice: 'USB',
  Net: 'Network',
  Ports: 'Ports (COM/LPT)',
  DiskDrive: 'Disk drives',
  Volume: 'Volumes',
  Bluetooth: 'Bluetooth',
  Image: 'Cameras & scanners',
  Media: 'Audio/video',
  MEDIA: 'Audio/video',
  WPD: 'Portable devices',
  Monitor: 'Monitors',
  HIDClass: 'Human interface (HID)',
  Mouse: 'Mice',
  Keyboard: 'Keyboards',
  PrintQueue: 'Printers',
  AudioEndpoint: 'Audio endpoints',
  SmartCardReader: 'Smart card readers',
};

const READ_SCRIPT = `
${ps.payload(SAFE_CLASSES)}
$safe = @($Payload)
$ghosts = Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.Present -ne $true -and $safe -contains $_.Class } | ForEach-Object {
  [pscustomobject]@{
    instanceId = [string]$_.InstanceId
    name       = [string]$_.FriendlyName
    class      = [string]$_.Class
    status     = [string]$_.Status
  }
}
@($ghosts) | ConvertTo-Json -Depth 4 -Compress
`;

function friendlyError(err) {
  if (/denied|elevation/i.test(err.message)) {
    return new Error('Removing devices needs administrator rights. Restart as admin, then try again.');
  }
  return err;
}

async function list() {
  const rows = ps.arr(await ps.json(READ_SCRIPT)).map((d) => ({
    instanceId: d.instanceId,
    name: d.name || '(unnamed device)',
    class: d.class,
    classLabel: CLASS_LABEL[d.class] || d.class,
  }));

  // Group by friendly class, interesting/short first is not needed — sort by count.
  const byClass = new Map();
  for (const d of rows) {
    if (!byClass.has(d.classLabel)) byClass.set(d.classLabel, []);
    byClass.get(d.classLabel).push(d);
  }
  const groups = [...byClass.entries()]
    .map(([label, items]) => ({ label, items: items.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));

  return { groups, total: rows.length };
}

async function remove(instanceIds) {
  const ids = (Array.isArray(instanceIds) ? instanceIds : [instanceIds]).filter(Boolean);
  if (!ids.length) throw new Error('Nothing selected to remove.');
  let result;
  try {
    result = await ps.json(`
${ps.payload({ ids, safe: SAFE_CLASSES })}
$safe = @($Payload.safe)
$removed = 0
$failed = New-Object System.Collections.ArrayList
foreach ($id in $Payload.ids) {
  $dev = Get-PnpDevice -InstanceId $id -ErrorAction SilentlyContinue
  if (-not $dev) { continue }
  # Never touch something that is present now, or outside the safe classes.
  if ($dev.Present -eq $true) { [void]$failed.Add([pscustomobject]@{ name = [string]$dev.FriendlyName; error = 'device is present' }); continue }
  if ($safe -notcontains $dev.Class) { [void]$failed.Add([pscustomobject]@{ name = [string]$dev.FriendlyName; error = 'not a removable class' }); continue }
  try {
    Remove-PnpDevice -InstanceId $id -Confirm:$false -ErrorAction Stop
    $removed++
  } catch {
    [void]$failed.Add([pscustomobject]@{ name = [string]$dev.FriendlyName; error = [string]$_.Exception.Message })
  }
}
[pscustomobject]@{ removed = $removed; failed = @($failed) } | ConvertTo-Json -Depth 4 -Compress
`, { timeout: 120000 });
  } catch (err) {
    throw friendlyError(err);
  }
  const failed = ps.arr(result && result.failed);
  // If everything failed on elevation, surface the admin hint.
  if ((!result || result.removed === 0) && failed.some((f) => /denied|elevation/i.test(f.error || ''))) {
    throw new Error('Removing devices needs administrator rights. Restart as admin, then try again.');
  }
  return { removed: (result && result.removed) || 0, failed };
}

module.exports = { list, remove, __scripts: { READ: READ_SCRIPT } };
