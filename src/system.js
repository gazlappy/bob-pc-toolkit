'use strict';

// System and hardware information — the first thing a technician looks up on
// any machine. Everything here is read-only: CIM/WMI queries and nothing else,
// so it needs no elevation and can change nothing.
//
// Each section is gathered defensively. A machine might have no battery, a
// storage driver that will not answer reliability counters without admin, or a
// locked-down WMI class; any one of those returns null for its own section
// rather than emptying the whole report.

const os = require('os');
const ps = require('./ps');

const INFO_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'

function Safe($block) { try { & $block } catch { $null } }

$os   = Get-CimInstance Win32_OperatingSystem
$cs   = Get-CimInstance Win32_ComputerSystem
$bios = Get-CimInstance Win32_BIOS
$board = Get-CimInstance Win32_BaseBoard
$cpus = @(Get-CimInstance Win32_Processor)

# --- memory modules -------------------------------------------------------
$memArray = Get-CimInstance Win32_PhysicalMemoryArray
$modules = @(Get-CimInstance Win32_PhysicalMemory | ForEach-Object {
  [pscustomobject]@{
    slot         = [string]$_.DeviceLocator
    capacity     = [double]$_.Capacity
    speed        = [int]$_.Speed
    manufacturer = ([string]$_.Manufacturer).Trim()
    partNumber   = ([string]$_.PartNumber).Trim()
  }
})

# --- graphics -------------------------------------------------------------
$gpus = @(Get-CimInstance Win32_VideoController | Where-Object { $_.Name } | ForEach-Object {
  [pscustomobject]@{
    name          = [string]$_.Name
    driverVersion = [string]$_.DriverVersion
    driverDate    = Safe { $_.DriverDate.ToString('yyyy-MM-dd') }
    vram          = [double]$_.AdapterRAM
    resolution    = if ($_.CurrentHorizontalResolution) { "$($_.CurrentHorizontalResolution) x $($_.CurrentVerticalResolution)" } else { $null }
  }
})

# --- physical disks, with health -----------------------------------------
# The modern Storage namespace gives health, media type and bus in one place;
# reliability counters (temperature, power-on hours, SSD wear) are an associated
# instance and may be withheld without admin, so each is fetched defensively.
$healthText = @{ 0 = 'Healthy'; 1 = 'Warning'; 2 = 'Unhealthy' }
$mediaText  = @{ 0 = 'Unspecified'; 3 = 'HDD'; 4 = 'SSD'; 5 = 'SCM' }
$busText    = @{ 1='SCSI'; 2='ATAPI'; 3='ATA'; 4='1394'; 5='SSA'; 6='Fibre'; 7='USB'; 8='RAID'; 9='iSCSI'; 10='SAS'; 11='SATA'; 12='SD'; 13='MMC'; 17='NVMe' }

# Assign in the parent scope — a value returned from Safe, never assigned inside
# its scriptblock, which would write to the block's own scope and be lost.
$phys = Safe { @(Get-CimInstance -Namespace 'root/Microsoft/Windows/Storage' MSFT_PhysicalDisk) }

if ($phys -and $phys.Count -gt 0) {
  $disks = @($phys | ForEach-Object {
    $p = $_
    $rc = Safe { Get-CimAssociatedInstance -InputObject $p -ResultClassName MSFT_StorageReliabilityCounter }
    [pscustomobject]@{
      name         = [string]$p.FriendlyName
      serial       = ([string]$p.SerialNumber).Trim()
      size         = [double]$p.Size
      media        = $mediaText[[int]$p.MediaType]
      bus          = $busText[[int]$p.BusType]
      # SpindleSpeed is a uint32: 0xFFFFFFFF means "not applicable" (an SSD) and
      # 0 means "unknown". [int] would overflow on the sentinel, so it is read as
      # a wide type and both non-values become null. A real RPM is kept.
      spindleSpeed = [int64]$p.SpindleSpeed
      health       = $healthText[[int]$p.HealthStatus]
      # Only surfaced when the drive actually reports it (SSD life remaining).
      wear         = if ($rc -and $rc.Wear -ne $null) { [int]$rc.Wear } else { $null }
      temperature  = if ($rc -and $rc.Temperature) { [int]$rc.Temperature } else { $null }
      powerOnHours = if ($rc -and $rc.PowerOnHours) { [int]$rc.PowerOnHours } else { $null }
      readErrors   = if ($rc -and $rc.ReadErrorsTotal -ne $null) { [double]$rc.ReadErrorsTotal } else { $null }
      writeErrors  = if ($rc -and $rc.WriteErrorsTotal -ne $null) { [double]$rc.WriteErrorsTotal } else { $null }
    }
  })
} else {
  # Fall back to the classic class if the Storage namespace was unavailable.
  $disks = @(Get-CimInstance Win32_DiskDrive | ForEach-Object {
    [pscustomobject]@{
      name = [string]$_.Model; serial = ([string]$_.SerialNumber).Trim(); size = [double]$_.Size
      media = $null; bus = [string]$_.InterfaceType; spindleSpeed = $null
      health = if ($_.Status -eq 'OK') { 'Healthy' } else { [string]$_.Status }
      wear = $null; temperature = $null; powerOnHours = $null; readErrors = $null; writeErrors = $null
    }
  })
}

# --- Windows activation ---------------------------------------------------
# LicenseStatus 1 = licensed. PartialProductKey filters out the dozens of
# inactive add-on SKUs, leaving the actual Windows licence.
$activation = Safe {
  $lic = Get-CimInstance SoftwareLicensingProduct -Filter "ApplicationId='55c92734-d682-4d71-983e-d6ec3f16059f' AND PartialProductKey IS NOT NULL" |
    Select-Object -First 1
  if ($lic) {
    [pscustomobject]@{
      status      = switch ([int]$lic.LicenseStatus) { 1 {'Activated'} 0 {'Unlicensed'} 2 {'Grace period'} 3 {'Out-of-box grace'} 5 {'Notification'} default {'Unknown'} }
      description = [string]$lic.Description
      partialKey  = [string]$lic.PartialProductKey
    }
  }
}

$battery = Safe {
  $b = Get-CimInstance Win32_Battery | Where-Object { $_.EstimatedChargeRemaining -ne $null } | Select-Object -First 1
  if ($b) { [pscustomobject]@{ percent = [int]$b.EstimatedChargeRemaining; status = [int]$b.BatteryStatus } }
}

[pscustomobject]@{
  os = [pscustomobject]@{
    caption      = [string]$os.Caption
    version      = [string]$os.Version
    build        = [string]$os.BuildNumber
    architecture = [string]$os.OSArchitecture
    installedOn  = Safe { $os.InstallDate.ToString('yyyy-MM-dd') }
    lastBoot     = Safe { $os.LastBootUpTime.ToString('o') }
    computerName = [string]$env:COMPUTERNAME
  }
  machine = [pscustomobject]@{
    manufacturer = ([string]$cs.Manufacturer).Trim()
    model        = ([string]$cs.Model).Trim()
    systemType   = [string]$cs.SystemType
    board        = (([string]$board.Manufacturer).Trim() + ' ' + ([string]$board.Product).Trim()).Trim()
    biosVersion  = [string]$bios.SMBIOSBIOSVersion
    biosDate     = Safe { $bios.ReleaseDate.ToString('yyyy-MM-dd') }
  }
  cpu = [pscustomobject]@{
    name         = ([string]$cpus[0].Name).Trim()
    cores        = ($cpus | Measure-Object -Property NumberOfCores -Sum).Sum
    threads      = ($cpus | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum
    maxClockMhz  = [int]$cpus[0].MaxClockSpeed
    sockets      = $cpus.Count
  }
  memory = [pscustomobject]@{
    total       = [double]$cs.TotalPhysicalMemory
    slotsUsed   = $modules.Count
    slotsTotal  = if ($memArray) { [int]$memArray.MemoryDevices } else { $null }
    modules     = $modules
  }
  gpus       = $gpus
  disks      = $disks
  activation = $activation
  battery    = $battery
} | ConvertTo-Json -Depth 6 -Compress
`;

async function info() {
  const data = await ps.json(INFO_SCRIPT, { timeout: 60000 });
  if (!data) throw new Error('Could not read system information.');

  // Uptime is friendlier computed here than formatted in PowerShell.
  let uptimeMs = null;
  if (data.os && data.os.lastBoot) {
    const boot = Date.parse(data.os.lastBoot);
    if (!Number.isNaN(boot)) uptimeMs = Date.now() - boot;
  }

  return {
    os: data.os || {},
    machine: data.machine || {},
    cpu: data.cpu || {},
    memory: { ...(data.memory || {}), modules: ps.arr(data.memory && data.memory.modules) },
    gpus: ps.arr(data.gpus),
    disks: ps.arr(data.disks).map((disk) => ({
      ...disk,
      // 0xFFFFFFFF ("not applicable") and 0 ("unknown") aren't real speeds.
      spindleSpeed: disk.spindleSpeed && disk.spindleSpeed < 0xffffffff ? disk.spindleSpeed : null,
    })),
    activation: data.activation || null,
    battery: data.battery && typeof data.battery.percent === 'number' ? data.battery : null,
    uptimeMs,
    hostname: os.hostname(),
  };
}

module.exports = { info };
