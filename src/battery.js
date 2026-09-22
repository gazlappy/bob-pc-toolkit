'use strict';

// Battery health — the reading a tech wants when a laptop "doesn't last like it
// used to": how much of the battery's original design capacity is left (wear),
// the cycle count, and what it is doing right now. Read-only.
//
// The numbers come straight from the firmware's own WMI classes (root\wmi
// BatteryStaticData / BatteryFullChargedCapacity / BatteryCycleCount /
// BatteryStatus) plus Win32_Battery for the live charge and runtime estimate.
// Some firmwares leave design/full/cycle blank there, so when they come back
// zero we fall back to `powercfg /batteryreport`, which reads the same values a
// different way. On a desktop there is no battery and the tab says so.

const os = require('os');
const path = require('path');
const ps = require('./ps');

const READ_SCRIPT = `
$out = [ordered]@{}
$w32 = @(Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue)
if ($w32.Count -eq 0) {
  $out.present = $false
} else {
  $b = $w32[0]
  $out.present = $true
  $out.name = [string]$b.Name
  $out.deviceId = [string]$b.DeviceID
  $out.chemistry = [int]$b.Chemistry
  $out.chargePct = [int]$b.EstimatedChargeRemaining
  $out.runtimeMin = [int]$b.EstimatedRunTime
  $out.batteryStatusCode = [int]$b.BatteryStatus

  $static = Get-CimInstance -Namespace root\\wmi -ClassName BatteryStaticData -ErrorAction SilentlyContinue | Select-Object -First 1
  $full   = Get-CimInstance -Namespace root\\wmi -ClassName BatteryFullChargedCapacity -ErrorAction SilentlyContinue | Select-Object -First 1
  $cyc    = Get-CimInstance -Namespace root\\wmi -ClassName BatteryCycleCount -ErrorAction SilentlyContinue | Select-Object -First 1
  $st     = Get-CimInstance -Namespace root\\wmi -ClassName BatteryStatus -ErrorAction SilentlyContinue | Select-Object -First 1

  $out.designCapacity = if ($static) { [int]$static.DesignedCapacity } else { 0 }
  $out.fullCapacity   = if ($full) { [int]$full.FullChargedCapacity } else { 0 }
  $out.cycleCount     = if ($cyc) { [int]$cyc.CycleCount } else { 0 }
  $out.manufacturer   = if ($static) { [string]$static.ManufactureName } else { '' }
  $out.serial         = if ($static) { [string]$static.SerialNumber } else { '' }
  if ($st) {
    $out.remaining   = [int]$st.RemainingCapacity
    $out.voltage     = [int]$st.Voltage
    $out.charging    = [bool]$st.Charging
    $out.discharging = [bool]$st.Discharging
    $out.acOnline    = [bool]$st.PowerOnline
  }
}
@($out) | ConvertTo-Json -Depth 4 -Compress
`;

// Fallback that reads the same capacity/cycle figures out of a battery report,
// used only when the WMI classes leave them blank.
function powercfgScript(reportPath) {
  return `
$rp = '${reportPath.replace(/\\/g, '\\\\')}'
try {
  powercfg /batteryreport /xml /output $rp | Out-Null
  [xml]$xml = Get-Content -LiteralPath $rp -Raw
  $bat = $xml.SelectNodes("//*[local-name()='Battery']") | Select-Object -First 1
  $get = { param($n) ($bat.ChildNodes | Where-Object { $_.LocalName -eq $n } | Select-Object -First 1).InnerText }
  [pscustomobject]@{
    design = [int](& $get 'DesignCapacity')
    full   = [int](& $get 'FullChargeCapacity')
    cycles = [int](& $get 'CycleCount')
  } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{ design = 0; full = 0; cycles = 0 } | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $rp -Force -ErrorAction SilentlyContinue
}
`;
}

const CHEMISTRY = {
  1: 'Other',
  2: 'Unknown',
  3: 'Lead acid',
  4: 'Nickel cadmium',
  5: 'Nickel metal hydride',
  6: 'Lithium-ion',
  7: 'Zinc air',
  8: 'Lithium polymer',
};

// Shapes the raw firmware numbers into the figures the tab shows and a health
// verdict. Exposed so the populated path can be exercised without a battery.
function build(raw) {
  if (!raw || !raw.present) {
    return { present: false };
  }

  const design = Number(raw.designCapacity) || 0;
  const full = Number(raw.fullCapacity) || 0;
  const cycleCount = Number(raw.cycleCount) || 0;

  const wearPct = design > 0 && full > 0 ? Math.max(0, Math.round(((design - full) / design) * 100)) : null;

  // Win32_Battery reports a large sentinel (~71,582,788) for runtime while on AC.
  const rawRuntime = Number(raw.runtimeMin) || 0;
  const runtimeMin = raw.acOnline || rawRuntime <= 0 || rawRuntime > 100000 ? null : rawRuntime;

  const state = raw.charging ? 'Charging' : raw.acOnline ? 'Plugged in' : 'On battery';

  let health = 'unknown';
  if (wearPct !== null) health = wearPct < 20 ? 'good' : wearPct < 40 ? 'warn' : 'bad';

  return {
    present: true,
    name: raw.name || 'Battery',
    manufacturer: raw.manufacturer || '',
    serial: raw.serial || '',
    chemistry: CHEMISTRY[raw.chemistry] || '',
    chargePct: Number(raw.chargePct) || 0,
    state,
    acOnline: Boolean(raw.acOnline),
    charging: Boolean(raw.charging),
    runtimeMin,
    designCapacity: design,
    fullCapacity: full,
    remaining: Number(raw.remaining) || 0,
    voltageMv: Number(raw.voltage) || 0,
    wearPct,
    cycleCount,
    health,
  };
}

async function read() {
  const raw = await ps.json(READ_SCRIPT);
  if (!raw || !raw.present) return { present: false };

  // Fill in capacity/cycle from a battery report if the firmware left them blank.
  if (!raw.designCapacity || !raw.fullCapacity || !raw.cycleCount) {
    const reportPath = path.join(os.tmpdir(), `pc-cleanup-battery-${Date.now()}.xml`);
    const fallback = await ps.json(powercfgScript(reportPath)).catch(() => null);
    if (fallback) {
      if (!raw.designCapacity && fallback.design) raw.designCapacity = fallback.design;
      if (!raw.fullCapacity && fallback.full) raw.fullCapacity = fallback.full;
      if (!raw.cycleCount && fallback.cycles) raw.cycleCount = fallback.cycles;
    }
  }

  return build(raw);
}

module.exports = { read, build, __scripts: { READ: READ_SCRIPT }, __powercfgScript: powercfgScript };
