'use strict';

// Live resource monitor: one snapshot of CPU / memory / disk / network and the
// processes using them, meant to be polled a few times a second by the
// renderer. Read-only. Everything comes from the pre-formatted performance
// counters, which give a usable value from a single read (no two-sample delta
// to manage here).

const os = require('os');
const ps = require('./ps');

const SNAPSHOT_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'

$os = Get-CimInstance Win32_OperatingSystem
$cpu = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime
$disk = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'"
$net = Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface |
  Where-Object { $_.Name -notmatch 'Loopback|isatap|Teredo|Pseudo' }
$netBytes = ($net | Measure-Object -Property BytesTotalPerSec -Sum).Sum

$procs = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process |
  Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' } |
  ForEach-Object {
    [pscustomobject]@{
      name = [string]$_.Name
      pid  = [int]$_.IDProcess
      cpu  = [double]$_.PercentProcessorTime
      mem  = [double]$_.WorkingSetPrivate
    }
  })

[pscustomobject]@{
  cpu         = [double]$cpu
  memTotal    = [double]$os.TotalVisibleMemorySize * 1024
  memFree     = [double]$os.FreePhysicalMemory * 1024
  diskPct     = [double]$disk.PercentDiskTime
  diskBytes   = [double]$disk.DiskBytesPerSec
  netBytes    = [double]$netBytes
  processes   = $procs
} | ConvertTo-Json -Depth 4 -Compress
`;

const CORES = os.cpus().length || 1;

async function snapshot() {
  const data = await ps.json(SNAPSHOT_SCRIPT, { timeout: 15000 });
  if (!data) throw new Error('Could not read the performance counters.');

  // Per-process CPU from the perf class is summed across every core, so it can
  // read up to 100 × cores; normalise to a 0-100% share of the whole machine.
  // Duplicate process names come back as "chrome", "chrome#1", …; strip the
  // suffix and aggregate so one row means one program.
  const byName = new Map();
  for (const p of ps.arr(data.processes)) {
    const name = String(p.name).replace(/#\d+$/, '');
    const entry = byName.get(name) || { name, cpu: 0, mem: 0, count: 0 };
    entry.cpu += p.cpu / CORES;
    entry.mem += p.mem;
    entry.count += 1;
    byName.set(name, entry);
  }
  const processes = [...byName.values()];

  const topCpu = [...processes].sort((a, b) => b.cpu - a.cpu).slice(0, 8);
  const topMem = [...processes].sort((a, b) => b.mem - a.mem).slice(0, 8);

  const memTotal = data.memTotal || 0;
  const memUsed = Math.max(0, memTotal - (data.memFree || 0));

  return {
    cpu: Math.min(100, Math.round(data.cpu || 0)),
    cores: CORES,
    mem: { total: memTotal, used: memUsed, pct: memTotal ? Math.round((memUsed / memTotal) * 100) : 0 },
    disk: { pct: Math.min(100, Math.round(data.diskPct || 0)), bytesPerSec: data.diskBytes || 0 },
    net: { bytesPerSec: data.netBytes || 0 },
    topCpu,
    topMem,
    processCount: processes.length,
  };
}

module.exports = { snapshot };
