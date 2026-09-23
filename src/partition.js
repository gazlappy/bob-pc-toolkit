'use strict';

// Disks & partitions — the Disk Management view a tech wants at a glance: every
// physical disk, its style and health, and each partition with its letter,
// label, filesystem and how full it is.
//
// Reading is unprivileged and safe. The edits exposed here are the reversible,
// non-destructive ones — change a drive letter, rename a volume — and they are
// refused on the partitions that must not be touched (the one Windows booted
// from, the EFI system partition, recovery). The destructive operations
// (create / format / resize / delete) are deliberately not wired here yet; they
// are being verified against a scratch disk before they go in, because a
// partition editor that can wipe a volume has to be driven, not just written.

const ps = require('./ps');

const SYSTEM_DRIVE_LETTER = String(process.env.SystemDrive || 'C:').replace(/[^A-Za-z]/g, '').toUpperCase();

// GPT type GUIDs that mark a partition as off-limits for edits.
const PROTECTED_GPT = new Set([
  '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}', // EFI System
  '{de94bba4-06d1-4d40-a16a-bfd50179d6ac}', // Windows Recovery
  '{e3c9e316-0b5c-4db8-817d-f92df00215ae}', // Microsoft Reserved (MSR)
]);

const READ_SCRIPT = `
$disks = Get-Disk -ErrorAction SilentlyContinue | Sort-Object Number | ForEach-Object {
  $d = $_
  $parts = Get-Partition -DiskNumber $d.Number -ErrorAction SilentlyContinue | Sort-Object Offset | ForEach-Object {
    $p = $_
    $vol = $null
    if ($p.DriveLetter -and $p.DriveLetter -ne 0) { $vol = Get-Volume -DriveLetter $p.DriveLetter -ErrorAction SilentlyContinue }
    [pscustomobject]@{
      partitionNumber = [int]$p.PartitionNumber
      driveLetter     = if ($p.DriveLetter -and $p.DriveLetter -ne 0) { [string]$p.DriveLetter } else { '' }
      size            = [int64]$p.Size
      offset          = [int64]$p.Offset
      type            = [string]$p.Type
      gptType         = [string]$p.GptType
      isBoot          = [bool]$p.IsBoot
      isSystem        = [bool]$p.IsSystem
      isActive        = [bool]$p.IsActive
      label           = if ($vol) { [string]$vol.FileSystemLabel } else { '' }
      fileSystem      = if ($vol) { [string]$vol.FileSystem } else { '' }
      free            = if ($vol) { [int64]$vol.SizeRemaining } else { 0 }
      health          = if ($vol) { [string]$vol.HealthStatus } else { '' }
    }
  }
  $parts = @($parts)
  $allocated = 0
  foreach ($p in $parts) { $allocated += $p.size }
  [pscustomobject]@{
    number         = [int]$d.Number
    friendlyName   = [string]$d.FriendlyName
    serial         = ([string]$d.SerialNumber).Trim()
    size           = [int64]$d.Size
    partitionStyle = [string]$d.PartitionStyle
    busType        = [string]$d.BusType
    health         = [string]$d.HealthStatus
    isBoot         = [bool]$d.IsBoot
    isSystem       = [bool]$d.IsSystem
    isOffline      = ($d.OperationalStatus -ne 'Online')
    unallocated    = [int64]($d.Size - $allocated)
    partitions     = $parts
  }
}
@($disks) | ConvertTo-Json -Depth 6 -Compress
`;

function isProtectedPartition(p) {
  if (p.isBoot || p.isSystem) return true;
  if (/system|recovery|reserved/i.test(p.type || '')) return true;
  if (p.gptType && PROTECTED_GPT.has(String(p.gptType).toLowerCase())) return true;
  if (p.driveLetter && p.driveLetter.toUpperCase() === SYSTEM_DRIVE_LETTER) return true;
  return false;
}

function friendlyError(err) {
  if (/denied|elevation/i.test(err.message)) {
    return new Error('Changing a partition needs administrator rights. Restart as admin, then try again.');
  }
  return err;
}

async function read() {
  const disks = ps.arr(await ps.json(READ_SCRIPT)).map((d) => {
    const partitions = ps.arr(d.partitions).map((p) => ({
      ...p,
      protected: isProtectedPartition(p),
      used: p.free && p.size ? p.size - p.free : null,
    }));
    return { ...d, partitions };
  });
  return { disks, summary: { disks: disks.length, systemDrive: `${SYSTEM_DRIVE_LETTER}:` } };
}

// Resolves a partition from the current disk layout so an action gets its real
// flags from Windows rather than trusting what the UI passed.
async function resolvePartition(diskNumber, partitionNumber) {
  const { disks } = await read();
  const disk = disks.find((d) => d.number === Number(diskNumber));
  if (!disk) throw new Error('That disk is no longer present. Refresh and try again.');
  const part = disk.partitions.find((p) => p.partitionNumber === Number(partitionNumber));
  if (!part) throw new Error('That partition is no longer present. Refresh and try again.');
  return part;
}

async function setLetter(diskNumber, partitionNumber, letter) {
  const part = await resolvePartition(diskNumber, partitionNumber);
  if (part.protected) throw new Error('This is a protected partition (system, boot, EFI or recovery) — its drive letter cannot be changed here.');
  const newLetter = String(letter || '').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 1);
  if (!newLetter) throw new Error('Choose a drive letter.');
  try {
    await ps.mutate(`
${ps.payload({ disk: Number(diskNumber), part: Number(partitionNumber), letter: newLetter })}
  Set-Partition -DiskNumber $Payload.disk -PartitionNumber $Payload.part -NewDriveLetter $Payload.letter -ErrorAction Stop
`);
  } catch (err) {
    throw friendlyError(err);
  }
  return { driveLetter: newLetter };
}

async function setLabel(diskNumber, partitionNumber, label) {
  const part = await resolvePartition(diskNumber, partitionNumber);
  if (!part.driveLetter) throw new Error('This partition has no drive letter, so it cannot be labelled.');
  const clean = String(label == null ? '' : label).slice(0, 32);
  try {
    await ps.mutate(`
${ps.payload({ letter: part.driveLetter, label: clean })}
  Set-Volume -DriveLetter $Payload.letter -NewFileSystemLabel $Payload.label -ErrorAction Stop
`);
  } catch (err) {
    throw friendlyError(err);
  }
  return { label: clean };
}

module.exports = {
  read,
  setLetter,
  setLabel,
  __internals: { isProtectedPartition, SYSTEM_DRIVE_LETTER },
  __scripts: { READ: READ_SCRIPT },
};
