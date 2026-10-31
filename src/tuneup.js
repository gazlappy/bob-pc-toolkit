'use strict';

// Tune-up: one scan of how the PC is set up and what it is running, turned into
// a list of suggestions a tech can tick and apply ("Do it for me").
//
// Rules:
//   - The renderer only sends suggestion ids. Apply re-scans and acts on what it
//     finds now, so a stale list can never push an outdated change.
//   - Every change records how to put it back (the previous registry value,
//     power plan, startup state…) in BOB's settings, and the tab lists them with
//     Undo. The one exception, clearing junk files, is labelled as permanent.
//   - Startup suggestions come from a list of apps known to be fine to stop
//     (browser pre-launch, game launchers, chat apps). Drivers, security
//     software, and sync tools are never suggested.
//   - Things BOB cannot change (a spinning hard disk, too little RAM) are shown
//     as advice without a tick box.

const ps = require('./ps');
const startup = require('./startup');
const clean = require('./clean');
const gpu = require('./gpu');

const GB = 1024 ** 3;
const HIGH_PERF = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c';
const ULTIMATE = 'e9a42b02-d5df-448d-aa00-03f14749eb61';
const BALANCED = '381b4222-f694-41f0-9685-ff5bb260df2e';
const POWER_SAVER = 'a1841308-3541-4fab-bc81-f71556f20b4a';
const LAPTOP_CHASSIS = new Set([8, 9, 10, 11, 12, 14, 18, 21, 30, 31, 32]);

// Startup entries that are safe to stop: each still opens normally when the
// user runs it, it just stops loading (and staying resident) at every sign-in.
const STARTUP_KNOWN = [
  { name: 'Chrome background launch', test: (e) => /^GoogleChromeAutoLaunch_/i.test(e.valueName), why: 'Chrome opens hidden at every sign-in so it starts faster later — at the cost of slowing sign-in and holding memory all day.' },
  { name: 'Edge pre-launch', test: (e) => /^MicrosoftEdgeAutoLaunch_/i.test(e.valueName), why: 'Edge loads hidden at every sign-in so it starts faster later — at the cost of slowing sign-in and holding memory all day.' },
  { name: 'Spotify', exe: /\\spotify\.exe/i },
  { name: 'Discord', exe: /discord\.exe|\\discord\\update\.exe/i },
  { name: 'Steam', exe: /\\steam\.exe/i },
  { name: 'Epic Games Launcher', exe: /epicgameslauncher\.exe/i },
  { name: 'EA app', exe: /eadesktop\.exe|\\origin\.exe/i },
  { name: 'Battle.net', exe: /battle\.net(launcher)?\.exe/i },
  { name: 'Ubisoft Connect', exe: /\\upc\.exe|ubisoftconnect\.exe/i },
  { name: 'GOG Galaxy', exe: /galaxyclient\.exe/i },
  { name: 'Microsoft Teams', exe: /\\teams\.exe|ms-teams\.exe/i },
  { name: 'Skype', exe: /\\skype(app)?\.exe/i },
  { name: 'Zoom', exe: /\\zoom\.exe/i },
  { name: 'Slack', exe: /\\slack\.exe/i },
  { name: 'Webex', exe: /ciscocollabhost\.exe|webex.*\.exe|ptoneclk\.exe/i },
  { name: 'Telegram', exe: /\\telegram\.exe/i },
  { name: 'Viber', exe: /\\viber\.exe/i },
  { name: 'WhatsApp', exe: /\\whatsapp\.exe/i },
  { name: 'Adobe Creative Cloud', exe: /creative cloud\.exe|ccxprocess\.exe|adobe desktop service\.exe|adobegcinvoker/i },
  { name: 'iTunes helper', exe: /ituneshelper\.exe/i },
  { name: 'Java update checker', exe: /\\jusched\.exe/i },
  { name: 'CCleaner monitoring', exe: /ccleaner(64)?\.exe/i },
  { name: 'uTorrent / BitTorrent', exe: /\\(utorrent|bittorrent)\.exe/i },
  { name: 'qBittorrent', exe: /qbittorrent\.exe/i },
  { name: 'Docker Desktop', exe: /docker desktop\.exe/i, why: 'Docker Desktop starts its virtual machine at sign-in, which takes a large slice of memory.' },
  { name: 'Opera browser assistant', exe: /browser_assistant\.exe|opera_autoupdate\.exe/i },
  { name: 'Notion', exe: /\\notion\.exe/i },
  { name: 'Postman', exe: /\\postman\.exe/i },
  { name: 'Evernote', exe: /\\evernote\.exe/i },
  { name: 'OneNote quick launcher', exe: /onenotem\.exe/i },
  { name: 'GitHub Desktop', exe: /githubdesktop\.exe/i },
  { name: 'Unity Hub', exe: /unity hub\.exe/i },
];

/* Facts ----------------------------------------------------------------------- */

const FACTS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$admin = ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$guidRe = '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\\s*\\(([^)]*)\\)'
$active = ''; $activeName = ''
$a = (powercfg /getactivescheme) -join ' '
if ($a -match $guidRe) { $active = $matches[1].ToLower(); $activeName = $matches[2] }
$schemes = @(foreach ($l in (powercfg /list)) { if ($l -match $guidRe) { [pscustomobject]@{ guid = $matches[1].ToLower(); name = $matches[2] } } })
$drive = $env:SystemDrive.TrimEnd(':')
$media = ''
try {
  $disk = Get-Partition -DriveLetter $drive -ErrorAction Stop | Get-Disk -ErrorAction Stop
  $pd = Get-PhysicalDisk -ErrorAction Stop | Where-Object { $_.DeviceId -eq [string]$disk.Number } | Select-Object -First 1
  $media = [string]$pd.MediaType
} catch {}
$vol = Get-Volume -DriveLetter $drive
function RegVal($p, $n) { try { (Get-ItemProperty -LiteralPath $p -Name $n -ErrorAction Stop).$n } catch { $null } }
$hib = 0
try { $f = ([IO.DirectoryInfo]($env:SystemDrive + '\\')).GetFiles('hiberfil.sys'); if ($f.Count) { $hib = [double]$f[0].Length } } catch {}
$trim = $null
if ($admin) {
  $t = (fsutil behavior query DisableDeleteNotify) | Where-Object { $_ -match 'NTFS' } | Select-Object -First 1
  if ($t -match '=\\s*(\\d)') { $trim = [int]$matches[1] }
}
$av = @(Get-CimInstance -Namespace root\\SecurityCenter2 -ClassName AntiVirusProduct | Where-Object { ($_.productState -band 0x1000) -ne 0 } | ForEach-Object { [string]$_.displayName } | Sort-Object -Unique)
$skip = @('Idle', 'System', 'Registry', 'Memory Compression', 'Secure System')
$mem = @(Get-Process | Where-Object { $skip -notcontains $_.ProcessName } | Group-Object ProcessName | ForEach-Object {
  [pscustomobject]@{ name = $_.Name; bytes = [double](($_.Group | Measure-Object WorkingSet64 -Sum).Sum); count = $_.Count }
} | Sort-Object bytes -Descending | Select-Object -First 5)
[pscustomobject]@{
  admin = $admin
  build = [int]$os.BuildNumber
  ramTotal = [double]$cs.TotalPhysicalMemory
  ramFree = [double]$os.FreePhysicalMemory * 1024
  bootTime = $os.LastBootUpTime.ToString('o')
  cpu = ([string]$cpu.Name).Trim()
  threads = [int]$cpu.NumberOfLogicalProcessors
  batteries = @(Get-CimInstance Win32_Battery).Count
  chassis = @((Get-CimInstance Win32_SystemEnclosure).ChassisTypes)
  activeScheme = $active; activeSchemeName = $activeName; schemes = $schemes
  systemDrive = $env:SystemDrive; media = $media
  free = [double]$vol.SizeRemaining; size = [double]$vol.Size
  backgroundOff = RegVal 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications' 'GlobalUserDisabled'
  gameDvr = RegVal 'HKCU:\\System\\GameConfigStore' 'GameDVR_Enabled'
  transparency = RegVal 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize' 'EnableTransparency'
  hiberBytes = $hib
  autoPagefile = [bool]$cs.AutomaticManagedPagefile
  trimDisabled = $trim
  antivirus = $av
  topMemory = $mem
} | ConvertTo-Json -Depth 4 -Compress
`;

// Monitors: list each active display's current mode and what it can do, and
// switch modes. Set() asks Windows to test a mode (CDS_TEST) before applying it
// with CDS_UPDATEREGISTRY, and returns Windows' DISP_CHANGE code (0 = done).
const DISPLAY_TYPE = `
if (-not ('BobDisplay' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class BobDisplayMode {
  public string Device { get; set; } public string Monitor { get; set; } public string Adapter { get; set; } public bool Primary { get; set; }
  public int Width { get; set; } public int Height { get; set; } public int Hz { get; set; } public int BestHz { get; set; }
  public int MaxWidth { get; set; } public int MaxHeight { get; set; } public int MaxHz { get; set; }
}
public static class BobDisplay {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion; public short dmDriverVersion; public short dmSize; public short dmDriverExtra; public int dmFields;
    public int dmPositionX; public int dmPositionY; public int dmDisplayOrientation; public int dmDisplayFixedOutput;
    public short dmColor; public short dmDuplex; public short dmYResolution; public short dmTTOption; public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels; public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight; public int dmDisplayFlags; public int dmDisplayFrequency;
    public int dmICMMethod; public int dmICMIntent; public int dmMediaType; public int dmDitherType; public int dmReserved1; public int dmReserved2; public int dmPanningWidth; public int dmPanningHeight;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DISPLAY_DEVICE {
    public int cb; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString; public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplayDevices(string dev, int i, ref DISPLAY_DEVICE dd, int flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettings(string dev, int mode, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int ChangeDisplaySettingsEx(string dev, ref DEVMODE dm, IntPtr hwnd, int flags, IntPtr lParam);
  static DEVMODE Blank() { var d = new DEVMODE(); d.dmSize = (short)Marshal.SizeOf(d); return d; }
  public static BobDisplayMode[] List() {
    var list = new List<BobDisplayMode>();
    for (int i = 0; ; i++) {
      var dd = new DISPLAY_DEVICE(); dd.cb = Marshal.SizeOf(dd);
      if (!EnumDisplayDevices(null, i, ref dd, 0)) break;
      if ((dd.StateFlags & 1) == 0) continue;
      var cur = Blank();
      if (!EnumDisplaySettings(dd.DeviceName, -1, ref cur)) continue;
      var mon = new DISPLAY_DEVICE(); mon.cb = Marshal.SizeOf(mon);
      EnumDisplayDevices(dd.DeviceName, 0, ref mon, 0);
      var m = new BobDisplayMode { Device = dd.DeviceName, Monitor = mon.DeviceString, Adapter = dd.DeviceString, Primary = (dd.StateFlags & 4) != 0,
        Width = cur.dmPelsWidth, Height = cur.dmPelsHeight, Hz = cur.dmDisplayFrequency };
      for (int k = 0; ; k++) {
        var dm = Blank();
        if (!EnumDisplaySettings(dd.DeviceName, k, ref dm)) break;
        if ((dm.dmDisplayFlags & 2) != 0 || dm.dmBitsPerPel != cur.dmBitsPerPel) continue;
        if (dm.dmPelsWidth == cur.dmPelsWidth && dm.dmPelsHeight == cur.dmPelsHeight && dm.dmDisplayFrequency > m.BestHz) m.BestHz = dm.dmDisplayFrequency;
        if ((long)dm.dmPelsWidth * dm.dmPelsHeight > (long)m.MaxWidth * m.MaxHeight) { m.MaxWidth = dm.dmPelsWidth; m.MaxHeight = dm.dmPelsHeight; m.MaxHz = 0; }
        if (dm.dmPelsWidth == m.MaxWidth && dm.dmPelsHeight == m.MaxHeight && dm.dmDisplayFrequency > m.MaxHz) m.MaxHz = dm.dmDisplayFrequency;
      }
      list.Add(m);
    }
    return list.ToArray();
  }
  public static int Set(string device, int w, int h, int hz) {
    var dm = Blank();
    if (!EnumDisplaySettings(device, -1, ref dm)) return -100;
    dm.dmPelsWidth = w; dm.dmPelsHeight = h; dm.dmDisplayFrequency = hz;
    dm.dmFields = 0x80000 | 0x100000 | 0x400000;
    int test = ChangeDisplaySettingsEx(device, ref dm, IntPtr.Zero, 2, IntPtr.Zero);
    if (test != 0) return test;
    return ChangeDisplaySettingsEx(device, ref dm, IntPtr.Zero, 1, IntPtr.Zero);
  }
}
'@
}
`;

const HW_FACTS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
${DISPLAY_TYPE}
function RegVal($p, $n) { try { (Get-ItemProperty -LiteralPath $p -Name $n -ErrorAction Stop).$n } catch { $null } }
$ram = @(Get-CimInstance Win32_PhysicalMemory | ForEach-Object {
  [pscustomobject]@{ bytes = [double]$_.Capacity; speed = [int]$_.Speed; configured = [int]$_.ConfiguredClockSpeed; maker = ([string]$_.Manufacturer).Trim(); part = ([string]$_.PartNumber).Trim(); slot = [string]$_.DeviceLocator }
})
$slots = [int](Get-CimInstance Win32_PhysicalMemoryArray | Measure-Object MemoryDevices -Sum).Sum
# powercfg prints min, max, increment, AC, DC as hex; position is locale-proof, the labels are not.
$hex = @((powercfg /query SCHEME_CURRENT SUB_PROCESSOR PROCTHROTTLEMAX) | ForEach-Object { [regex]::Matches($_, '0x[0-9a-fA-F]{8}') | ForEach-Object { $_.Value } })
$procMax = $null
if ($hex.Count -ge 4) { $procMax = [Convert]::ToInt32($hex[3], 16) }
$disks = @(Get-PhysicalDisk | ForEach-Object { [pscustomobject]@{ name = [string]$_.FriendlyName; media = [string]$_.MediaType; health = [string]$_.HealthStatus } })
$sysmain = Get-Service SysMain
$gpus = @(Get-CimInstance Win32_VideoController | Where-Object { $_.PNPDeviceID -like 'PCI\\*' } | ForEach-Object {
  [pscustomobject]@{ name = [string]$_.Name; date = $(if ($_.DriverDate) { $_.DriverDate.ToString('o') } else { '' }); version = [string]$_.DriverVersion }
})
[pscustomobject]@{
  ram = $ram; slots = $slots; procMax = $procMax; disks = $disks
  defragState = [string](Get-ScheduledTask -TaskPath '\\Microsoft\\Windows\\Defrag\\' -TaskName 'ScheduledDefrag').State
  sysmainStart = [string]$sysmain.StartType; sysmainStatus = [string]$sysmain.Status
  gameMode = RegVal 'HKCU:\\Software\\Microsoft\\GameBar' 'AutoGameModeEnabled'
  storageSense = RegVal 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\StorageSense\\Parameters\\StoragePolicy' '01'
  minAnimate = RegVal 'HKCU:\\Control Panel\\Desktop\\WindowMetrics' 'MinAnimate'
  hwSch = RegVal 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers' 'HwSchMode'
  gpus = $gpus
  displays = @([BobDisplay]::List())
  rebootPending = [bool]((Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending') -or (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired'))
  osName = [string](Get-CimInstance Win32_OperatingSystem).Caption
} | ConvertTo-Json -Depth 4 -Compress
`;

async function facts() {
  const [base, hw, drv, cards] = await Promise.all([
    ps.json(FACTS_SCRIPT),
    ps.json(HW_FACTS_SCRIPT),
    ps.json(DRIVER_FACTS_SCRIPT).catch(() => null),
    gpu.sample().then((s) => s.cards).catch(() => []),
  ]);
  const f = { ...(base || {}), ...(hw || {}), ...(drv || {}), nvidiaCards: cards };
  f.drivers = ps.arr(f.drivers);
  f.missing = ps.arr(f.missing);
  f.ram = ps.arr(f.ram);
  f.disks = ps.arr(f.disks);
  f.gpus = ps.arr(f.gpus);
  f.displays = ps.arr(f.displays);
  const chassis = ps.arr(f.chassis).map(Number);
  return {
    ...f,
    laptop: Number(f.batteries) > 0 || chassis.some((c) => LAPTOP_CHASSIS.has(c)),
    schemes: ps.arr(f.schemes),
    antivirus: ps.arr(f.antivirus),
    topMemory: ps.arr(f.topMemory),
    lowSpec: Number(f.ramTotal) < 8 * GB || Number(f.threads) <= 2,
  };
}

/* Suggestions ------------------------------------------------------------------ */

// 16 GB, 8 GB, 9.6 GB, 600 MB — no "8.0 GB" next to "16 GB".
const fmtGB = (b) => {
  const v = b / GB;
  if (v < 1) return `${Math.max(1, Math.round(b / 1048576))} MB`;
  return `${v >= 10 || Math.abs(v - Math.round(v)) < 0.05 ? Math.round(v) : v.toFixed(1)} GB`;
};
// Windows reports DDR4-2666 as 2667 and DDR4-2933 as 2934; say what the box says.
const mhz = (v) => (Math.abs(v - 2666) <= 1 ? 2666 : Math.abs(v - 2933) <= 1 ? 2933 : v);

function suggestion(s) {
  return {
    category: 'Windows settings',
    impact: 'Low',
    recommended: false,
    needsAdmin: false,
    restart: false,
    permanent: false,
    actionable: true,
    ...s,
  };
}

function powerSuggestions(f) {
  const out = [];
  if (!f.activeScheme) return out;
  const has = (g) => f.schemes.some((s) => s.guid === g);
  if (!f.laptop && f.activeScheme !== HIGH_PERF && f.activeScheme !== ULTIMATE) {
    out.push(suggestion({
      id: 'power-high',
      category: 'Power',
      title: 'Switch to the High performance power plan',
      detail: `This desktop is on "${f.activeSchemeName || 'Balanced'}", which lets the processor slow down to save power. High performance keeps it ready, so the PC feels quicker to respond.${has(HIGH_PERF) ? '' : ' Windows has hidden the plan on this PC, so BOB recreates it.'}`,
      impact: 'Medium',
      recommended: true,
      action: { kind: 'power', target: HIGH_PERF },
    }));
  }
  if (f.laptop && f.activeScheme === POWER_SAVER) {
    out.push(suggestion({
      id: 'power-balanced',
      category: 'Power',
      title: 'Switch from Power saver to Balanced',
      detail: 'Power saver holds the processor back all the time, even when plugged in. Balanced speeds up when needed and still saves battery.',
      impact: 'High',
      recommended: true,
      action: { kind: 'power', target: BALANCED },
    }));
  }
  return out;
}

function startupSuggestions(entries) {
  const out = [];
  for (const e of entries) {
    if (!e.enabled || !e.approvable) continue;
    const known = STARTUP_KNOWN.find((k) => (k.test ? k.test(e) : k.exe.test(e.command || '')));
    if (!known) continue;
    out.push(suggestion({
      id: `startup:${e.id}`,
      category: 'Startup',
      title: `Stop ${known.name} starting with Windows`,
      detail: known.why || `${known.name} loads at every sign-in and keeps running in the background. It still opens normally whenever you start it.`,
      impact: 'Medium',
      recommended: true,
      needsAdmin: e.scope === 'machine',
      action: { kind: 'startup', entryId: e.id, label: known.name },
    }));
  }
  return out;
}

function settingSuggestions(f) {
  const out = [];
  if (f.build < 22000 && Number(f.backgroundOff) !== 1) {
    out.push(suggestion({
      id: 'background-apps',
      title: 'Stop Store apps running in the background',
      detail: 'Windows lets apps like Mail, Weather and Xbox keep running when closed. Turning that off saves memory and processor time; those apps then only update while open.',
      impact: f.laptop || f.lowSpec ? 'Medium' : 'Low',
      recommended: f.laptop || f.lowSpec,
      action: {
        kind: 'registry',
        values: [
          { path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications', name: 'GlobalUserDisabled', type: 'DWord', value: 1 },
          { path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Search', name: 'BackgroundAppGlobalToggle', type: 'DWord', value: 0 },
        ],
      },
    }));
  }
  if (Number(f.gameDvr) !== 0) {
    out.push(suggestion({
      id: 'game-dvr',
      title: 'Turn off Xbox Game Bar recording',
      detail: 'Game DVR hooks into every game so it can record clips. If nobody here uses it, turning it off removes that overhead (the Game Bar itself still opens with Win+G).',
      action: {
        kind: 'registry',
        values: [
          { path: 'HKCU:\\System\\GameConfigStore', name: 'GameDVR_Enabled', type: 'DWord', value: 0 },
          { path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR', name: 'AppCaptureEnabled', type: 'DWord', value: 0 },
        ],
      },
    }));
  }
  if (f.lowSpec && Number(f.transparency) !== 0) {
    out.push(suggestion({
      id: 'transparency',
      title: 'Turn off transparency effects',
      detail: 'The see-through taskbar and Start menu cost graphics work on a modest PC like this one. Turning them off makes the desktop a little snappier.',
      recommended: true,
      action: {
        kind: 'registry',
        values: [{ path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', name: 'EnableTransparency', type: 'DWord', value: 0 }],
      },
    }));
  }
  return out;
}

function storageSuggestions(f, junk) {
  const out = [];
  if (f.trimDisabled === 1 && /ssd/i.test(f.media)) {
    out.push(suggestion({
      id: 'trim',
      category: 'Storage',
      title: 'Turn TRIM back on for the SSD',
      detail: 'TRIM is switched off, so the SSD cannot tidy up deleted space and gets slower over time. Windows normally has it on.',
      impact: 'High',
      recommended: true,
      needsAdmin: true,
      action: { kind: 'trim' },
    }));
  }
  if (junk && junk.bytes >= 500 * 1024 * 1024) {
    const tight = f.size && f.free / f.size < 0.15;
    out.push(suggestion({
      id: 'junk',
      category: 'Storage',
      title: `Clear ${fmtGB(junk.bytes)} of junk files`,
      detail: `The safe items from the Cleanup tab: ${junk.labels.join(', ')}. Recently used files and anything open are left alone.`,
      impact: tight ? 'High' : 'Medium',
      recommended: tight || junk.bytes >= 2 * GB,
      permanent: true,
      action: { kind: 'cleanup', ids: junk.ids },
    }));
  }
  if (!f.laptop && f.hiberBytes >= 2 * GB) {
    out.push(suggestion({
      id: 'hibernate',
      category: 'Storage',
      title: `Turn off hibernation (frees ${fmtGB(f.hiberBytes)})`,
      detail: `hiberfil.sys reserves ${fmtGB(f.hiberBytes)} on ${f.systemDrive} for a feature desktops rarely use. Turning it off also turns off Fast Startup, so a cold boot may take a few seconds longer.`,
      needsAdmin: true,
      action: { kind: 'hibernate' },
    }));
  }
  return out;
}

// A RAM stick's rated (XMP/EXPO) speed is not visible to Windows — SMBIOS only
// holds the JEDEC default — but gaming memory spells it out in the part number:
// KF3200C16D4, CMK16GX4M2B3200C16, F4-3600C18D, BL8G32C16U4B, PVS416G320C6.
const SPEEDS = [2133, 2400, 2666, 2933, 3000, 3200, 3333, 3466, 3600, 3733, 3866, 4000, 4133, 4266, 4400, 4800, 5200, 5600, 6000, 6200, 6400, 6800, 7200, 7600, 8000];
function ratedSpeed(part) {
  const p = String(part || '').toUpperCase().replace(/\s+/g, '');
  let m;
  if ((m = /^HX4(\d{2})C/.exec(p)) || (m = /^KF4(\d{2})C/.exec(p)) || (m = /^KF5(\d{2})C/.exec(p))) return Number(m[1]) * 100 + (m[1] === '26' ? 66 : 0);
  if ((m = /^BL\w*?G(\d{2})C\d{2}/.exec(p))) return Number(m[1]) * 100 + (m[1] === '26' ? 66 : 0);
  if ((m = /^PV\w*?G(\d{3})C\d/.exec(p))) return Number(m[1]) * 10 + (m[1] === '266' ? 6 : 0);
  for (const s of SPEEDS) if (new RegExp(`(^|[^0-9])${s}([^0-9]|$)`).test(p)) return s;
  return null;
}

function nvidiaArch(name) {
  return gpu.__internals.archFromName(name);
}

function hardwareSuggestions(f) {
  const out = [];
  const hw = (s) => out.push(suggestion({ category: 'Hardware', ...s }));
  const info = (s) => hw({ actionable: false, ...s });

  // Memory.
  const sticks = f.ram.filter((r) => r.bytes > 0);
  if (sticks.length) {
    const running = mhz(Math.min(...sticks.map((r) => r.configured || r.speed || 0)));
    const describe = (r) => `${fmtGB(r.bytes)} ${r.maker && !/^unknown|^0+$/i.test(r.maker) ? `${r.maker} ` : ''}${r.part || ''}`.trim();
    const parts = new Set(sticks.map((r) => `${r.part}|${r.bytes}`));
    const rated = sticks.map((r) => ratedSpeed(r.part)).filter(Boolean);
    const bestRated = rated.length ? Math.max(...rated) : null;
    if (sticks.length > 1 && parts.size > 1) {
      const sizes = new Set(sticks.map((r) => r.bytes));
      info({
        id: 'hw-ram-mismatch',
        impact: 'Medium',
        title: 'The memory sticks don’t match',
        detail: `Installed: ${sticks.map((r) => `${describe(r)}${ratedSpeed(r.part) ? ` (rated ${ratedSpeed(r.part)} MHz)` : ''}`).join(' + ')}. Mixed sticks all run at the slowest one’s speed — ${running} MHz here${sizes.size > 1 ? ', and with different sizes only part of the memory runs dual-channel' : ''}. Two (or four) identical sticks would be faster.`,
      });
    } else if (bestRated && running && bestRated - running >= 200) {
      info({
        id: 'hw-ram-xmp',
        impact: 'High',
        title: `Memory is rated ${bestRated} MHz but running at ${running} MHz`,
        detail: 'The memory’s speed profile is switched off in the BIOS. Turning on XMP (Intel) or EXPO/DOCP (AMD) in the BIOS lets it run at full speed — free performance, especially for games.',
      });
    }
    if (sticks.length === 1 && (f.slots || 0) >= 2) {
      info({
        id: 'hw-ram-single',
        impact: 'Medium',
        title: 'Memory is running in single-channel',
        detail: `There is one ${fmtGB(sticks[0].bytes)} stick in a board with ${f.slots} slots. Adding a matching second stick doubles memory bandwidth — a big gain for built-in graphics and a noticeable one for games.`,
      });
    }
  }
  if (f.ramTotal && f.ramTotal < 8 * GB) {
    info({ id: 'advice-ram', impact: 'High', title: 'Add more memory', detail: `This PC has ${fmtGB(f.ramTotal)} of RAM. 8 GB is the practical minimum for Windows 10/11 with a modern browser; below that Windows constantly swaps to disk.` });
  }

  // Processor capped by the power plan.
  if (f.procMax != null && f.procMax < 100) {
    hw({
      id: 'hw-proc-max',
      title: `Let the processor run at full speed (capped at ${f.procMax}%)`,
      detail: `The power plan's "Maximum processor state" is set to ${f.procMax}%, which stops the processor reaching its full clock speed when plugged in.`,
      impact: 'High',
      recommended: true,
      action: { kind: 'proc-max', value: 100, previous: f.procMax },
    });
  }

  // Graphics.
  for (const c of f.nvidiaCards || []) {
    const p = c.power || {};
    if (p.limit != null && p.def != null && p.limit < p.def * 0.97) {
      hw({
        id: `hw-gpu-power-${c.index}`,
        title: `Give the ${c.name} its full power back (${Math.round(p.limit)} W of ${Math.round(p.def)} W)`,
        detail: 'The graphics card’s power limit is set below its default, which caps how fast it can run. If it was lowered on purpose — to calm a faulty or overheating card — leave it.',
        impact: 'High',
        needsAdmin: true,
        action: { kind: 'gpu-power', index: c.index, previous: Math.round(p.limit) },
      });
    }
    if (c.pcie && c.pcie.width && c.pcie.widthMax && c.pcie.width < c.pcie.widthMax) {
      info({ id: `hw-gpu-pcie-${c.index}`, impact: 'Medium', title: `${c.name} is connected at x${c.pcie.width}, not x${c.pcie.widthMax}`, detail: 'The card is running with fewer PCIe lanes than it supports. Check it is in the top full-length slot and fully seated, and that no M.2 drive is sharing its lanes.' });
    }
    const reasons = (c.throttle && c.throttle.reasons) || [];
    if (reasons.some((r) => /thermal/i.test(r))) {
      info({ id: `hw-gpu-thermal-${c.index}`, impact: 'High', title: `${c.name} is slowing down from heat`, detail: 'The card is thermal-throttling right now. Clean the dust out of its fans and heatsink and check the case airflow; on an older card, new thermal paste helps.' });
    } else if (c.temp != null && c.temp >= 65 && (c.util ? c.util.gpu : 0) < 15) {
      info({ id: `hw-gpu-hot-${c.index}`, impact: 'Medium', title: `${c.name} is ${c.temp}°C while idle`, detail: 'A graphics card normally idles around 30–50°C. Check its fans spin and clean out dust before it starts throttling under load.' });
    }
  }
  // Hardware-accelerated GPU scheduling: Windows 10 2004+ on NVIDIA Pascal or
  // newer, or AMD RX 5000 or newer.
  const hagsCapable = f.build >= 19041 && f.gpus.some((g) => /pascal|volta|turing|ampere|ada|hopper|blackwell/i.test(nvidiaArch(g.name)) || /radeon.*rx\s*[5-9]\d{3}/i.test(g.name));
  if (hagsCapable && Number(f.hwSch) !== 2) {
    hw({
      id: 'hw-hags',
      title: 'Turn on hardware-accelerated GPU scheduling',
      detail: 'Lets the graphics card manage its own memory queue, which can smooth frame times and lower input lag in games. Results vary by game — it is easy to undo if anything feels worse.',
      needsAdmin: true,
      restart: true,
      action: { kind: 'registry', values: [{ path: 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers', name: 'HwSchMode', type: 'DWord', value: 2 }] },
    });
  }

  // Drives.
  for (const d of f.disks) {
    if (d.health && !/^healthy$/i.test(d.health)) {
      info({ id: `hw-disk-${d.name}`, impact: 'High', title: `Back up now — ${d.name} reports “${d.health}”`, detail: 'Windows says this drive is failing or degraded. Copy anything important off it and plan to replace it; the Disks tab shows its SMART details.' });
    }
  }
  if (/hdd/i.test(f.media)) {
    info({ id: 'advice-ssd', impact: 'High', title: 'Replace the hard disk with an SSD', detail: `Windows is on a spinning hard disk (${f.systemDrive}). Moving it to an SSD is the biggest single speed-up an older PC can get — often 3–5× faster to start and open programs.` });
  }
  return out;
}

function displaySuggestions(f) {
  const out = [];
  f.displays.forEach((d, i) => {
    const ref = `${d.Primary ? 'the main display' : `display ${i + 1}`}${d.Monitor && !/generic/i.test(d.Monitor) ? ` (${d.Monitor})` : ''}`;
    if (d.BestHz && d.Hz && d.BestHz - d.Hz >= 5) {
      out.push(suggestion({
        id: `display-hz-${d.Device}`,
        category: 'Display',
        title: `Run ${ref} at ${d.BestHz} Hz (now ${d.Hz} Hz)`,
        detail: `The screen can refresh ${d.BestHz} times a second at ${d.Width}×${d.Height} but Windows is only using ${d.Hz}. Higher refresh makes everything — mouse, scrolling, games — visibly smoother. If the screen goes blank, it switches back by itself after 15 seconds.`,
        impact: 'High',
        recommended: true,
        verifyDisplay: true,
        action: { kind: 'display', device: d.Device, width: d.Width, height: d.Height, hz: d.BestHz, previous: { width: d.Width, height: d.Height, hz: d.Hz } },
      }));
    }
    if (d.MaxWidth && d.MaxWidth * d.MaxHeight > d.Width * d.Height * 1.05) {
      out.push(suggestion({
        id: `display-res-${d.Device}`,
        category: 'Display',
        title: `Use the full resolution on ${ref}: ${d.MaxWidth}×${d.MaxHeight} (now ${d.Width}×${d.Height})`,
        detail: 'Below its native resolution a flat screen looks soft and blurry. If text looks too small afterwards, raise Scale in Display settings instead of lowering the resolution.',
        impact: 'Medium',
        verifyDisplay: true,
        action: { kind: 'display', device: d.Device, width: d.MaxWidth, height: d.MaxHeight, hz: d.MaxHz, previous: { width: d.Width, height: d.Height, hz: d.Hz } },
      }));
    }
  });
  return out;
}

function moreSettingSuggestions(f) {
  const out = [];
  if (Number(f.storageSense) !== 1) {
    out.push(suggestion({
      id: 'storage-sense',
      title: 'Turn on Storage Sense',
      detail: 'Windows’ own automatic cleanup: it clears temporary files when space runs low and empties Recycle Bin items older than 30 days.',
      action: { kind: 'registry', values: [{ path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\StorageSense\\Parameters\\StoragePolicy', name: '01', type: 'DWord', value: 1 }] },
    }));
  }
  if (f.gameMode != null && Number(f.gameMode) === 0) {
    out.push(suggestion({
      id: 'game-mode',
      title: 'Turn Game Mode back on',
      detail: 'Game Mode gives a running game priority and holds back Windows Update installs and notifications while you play. It is on by default and has been switched off here.',
      recommended: true,
      action: { kind: 'registry', values: [{ path: 'HKCU:\\Software\\Microsoft\\GameBar', name: 'AutoGameModeEnabled', type: 'DWord', value: 1 }] },
    }));
  }
  if (f.lowSpec && String(f.minAnimate) !== '0') {
    out.push(suggestion({
      id: 'animations',
      title: 'Turn off window and taskbar animations',
      detail: 'Windows animates every window and taskbar change. On a modest PC like this, switching that off makes it feel more responsive. Takes effect after signing out.',
      recommended: true,
      restart: true,
      action: {
        kind: 'registry',
        values: [
          { path: 'HKCU:\\Control Panel\\Desktop\\WindowMetrics', name: 'MinAnimate', type: 'String', value: '0' },
          { path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced', name: 'TaskbarAnimations', type: 'DWord', value: 0 },
        ],
      },
    }));
  }
  if (/hdd/i.test(f.media) && /disabled/i.test(f.sysmainStart || '')) {
    out.push(suggestion({
      id: 'sysmain',
      title: 'Turn SysMain (Superfetch) back on',
      detail: 'SysMain preloads the programs you use into memory. It has been disabled here, and on a hard disk that makes programs noticeably slower to open.',
      impact: 'Medium',
      recommended: true,
      needsAdmin: true,
      action: { kind: 'service', name: 'SysMain', startType: 'Automatic', previous: f.sysmainStart, wasRunning: /running/i.test(f.sysmainStatus || '') },
    }));
  }
  if (/disabled/i.test(f.defragState || '')) {
    out.push(suggestion({
      id: 'scheduled-optimise',
      category: 'Storage',
      title: 'Turn scheduled drive optimisation back on',
      detail: 'Windows normally defragments hard disks and re-TRIMs SSDs once a week. That schedule is switched off, so the drives slowly get slower.',
      impact: 'Medium',
      recommended: true,
      needsAdmin: true,
      action: { kind: 'task', path: '\\Microsoft\\Windows\\Defrag\\', name: 'ScheduledDefrag' },
    }));
  }
  return out;
}

/* Drivers ------------------------------------------------------------------------ */

// Third-party network, Wi-Fi, Bluetooth and audio drivers, plus Intel ME, with
// the PC's maker/model so the advice can link to the right download page.
// Microsoft's own drivers are left out: their dates are deliberately old.
const DRIVER_FACTS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$cs = Get-CimInstance Win32_ComputerSystem
$bb = Get-CimInstance Win32_BaseBoard
$bios = Get-CimInstance Win32_BIOS
$drivers = @(Get-CimInstance Win32_PnPSignedDriver | Where-Object {
  $_.DeviceName -and $_.DriverProviderName -and $_.DriverDate -and $_.DriverProviderName -notmatch '^Microsoft' -and
  (@('NET', 'MEDIA', 'BLUETOOTH') -contains [string]$_.DeviceClass -or ([string]$_.DeviceClass -eq 'SYSTEM' -and $_.DeviceName -match 'Management Engine'))
} | ForEach-Object {
  [pscustomobject]@{ name = ([string]$_.DeviceName).Trim(); cls = [string]$_.DeviceClass; provider = [string]$_.DriverProviderName; date = $_.DriverDate.ToString('o'); version = [string]$_.DriverVersion }
})
$missing = @(Get-CimInstance Win32_PnPEntity | Where-Object { $_.ConfigManagerErrorCode -eq 28 -and $_.Present -ne $false } | ForEach-Object { $(if ($_.Name) { [string]$_.Name } else { 'Unknown device' }) })
[pscustomobject]@{
  sysMaker = ([string]$cs.Manufacturer).Trim(); sysModel = ([string]$cs.Model).Trim()
  boardMaker = ([string]$bb.Manufacturer).Trim(); boardModel = ([string]$bb.Product).Trim()
  serial = ([string]$bios.SerialNumber).Trim(); biosVersion = ([string]$bios.SMBIOSBIOSVersion).Trim()
  biosDate = $(if ($bios.ReleaseDate) { $bios.ReleaseDate.ToString('o') } else { '' })
  drivers = $drivers; missing = $missing
} | ConvertTo-Json -Depth 4 -Compress
`;

// Virtual and software devices whose drivers come with an app, not the hardware.
const DRIVER_SKIP = /virtual|streaming|host-only|emulat|xvdd|vmware|virtualbox|hyper-v|wan miniport|tap-windows|wireguard|vpn|oculus|meta |nvidia high definition|amd high definition|nvidia virtual/i;

const OPTIONAL_UPDATES = { label: 'Windows Update — optional driver updates', url: 'ms-settings:windowsupdate-optionalupdates' };
const INTEL_DSA = { label: 'Intel Driver & Support Assistant', url: 'https://www.intel.com/content/www/us/en/support/detect.html' };

function gpuLinks(name) {
  if (/nvidia/i.test(name)) {
    return [
      { label: 'NVIDIA driver downloads', url: 'https://www.nvidia.com/en-us/drivers/' },
      { label: 'NVIDIA app (keeps it updated)', url: 'https://www.nvidia.com/en-us/software/nvidia-app/' },
    ];
  }
  if (/amd|radeon/i.test(name)) return [{ label: 'AMD driver downloads', url: 'https://www.amd.com/en/support/download/drivers.html' }];
  if (/intel/i.test(name)) return [INTEL_DSA];
  return [];
}

const webSearch = (q) => ({ label: `Search: ${q}`, url: `https://www.google.com/search?q=${encodeURIComponent(q)}` });
const GENERIC_MAKER = /^$|system manufacturer|system product|to be filled|default string|o\.?e\.?m|not applicable/i;

// The page a tech actually wants: the PC maker's driver page for a branded PC,
// the motherboard maker's page for this exact board on a custom build.
function makerLinks(f) {
  const sys = f.sysMaker || '';
  const model = f.sysModel || '';
  const tag = f.serial && !GENERIC_MAKER.test(f.serial) ? f.serial : '';
  if (/dell/i.test(sys)) return [{ label: `Dell drivers${tag ? ` — service tag ${tag}` : ''}`, url: 'https://www.dell.com/support/home/en-us?app=drivers' }];
  if (/hewlett|^hp\b/i.test(sys)) return [{ label: `HP drivers${tag ? ` — serial ${tag}` : ''}`, url: 'https://support.hp.com/drivers' }];
  if (/lenovo/i.test(sys)) return [{ label: `Lenovo support${tag ? ` — serial ${tag}` : ''}`, url: 'https://pcsupport.lenovo.com/' }];
  if (/acer/i.test(sys)) return [{ label: `Acer drivers${tag ? ` — serial ${tag}` : ''}`, url: 'https://www.acer.com/us-en/support/drivers-and-manuals' }];
  if (/microsoft/i.test(sys) && /surface/i.test(model)) return [{ label: 'Surface drivers and firmware', url: 'https://support.microsoft.com/en-us/surface/download-drivers-and-firmware-for-surface-09bb2e09-2a4b-cb69-0951-078a7739e120' }];
  if (/asus/i.test(sys) && model && !GENERIC_MAKER.test(model)) return [{ label: `ASUS ${model} drivers & BIOS`, url: `https://www.asus.com/supportonly/${encodeURIComponent(model)}/HelpDesk_Download/` }];
  if (/micro-star|^msi\b/i.test(sys) && model && !GENERIC_MAKER.test(model)) return [{ label: `MSI ${model} drivers & BIOS`, url: `https://www.msi.com/search/${encodeURIComponent(model.replace(/\s*\(MS-\w+\)\s*$/i, ''))}` }];

  // Custom build (or a builder like PC Specialist): go by the motherboard.
  const board = (f.boardModel || '').replace(/\s*\(MS-\w+\)\s*$/i, '');
  const bm = f.boardMaker || '';
  if (!board || GENERIC_MAKER.test(board)) return GENERIC_MAKER.test(sys) || !model ? [] : [webSearch(`${sys} ${model} drivers`)];
  if (/asus/i.test(bm)) return [{ label: `ASUS ${board} drivers & BIOS`, url: `https://www.asus.com/supportonly/${encodeURIComponent(board)}/HelpDesk_Download/` }];
  if (/micro-star|^msi\b/i.test(bm)) return [{ label: `MSI ${board} drivers & BIOS`, url: `https://www.msi.com/search/${encodeURIComponent(board)}` }];
  if (/gigabyte/i.test(bm)) return [{ label: 'Gigabyte support', url: 'https://www.gigabyte.com/Support' }, webSearch(`Gigabyte ${board} drivers`)];
  if (/asrock/i.test(bm)) return [{ label: 'ASRock support', url: 'https://www.asrock.com/support/index.asp?cat=Download' }, webSearch(`ASRock ${board} drivers`)];
  return [webSearch(`${bm} ${board} drivers`)];
}

function makerName(f) {
  const links = makerLinks(f);
  const m = links.length && /^(Dell|HP|Lenovo|Acer|Surface|ASUS|MSI|Gigabyte|ASRock)/.exec(links[0].label);
  return m ? (m[1] === 'Surface' ? 'Microsoft' : m[1]) : 'the PC or motherboard maker';
}

const monthYear = (iso) => new Date(iso).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
const monthsSince = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / (30.44 * 86400000)) : null;
};
const ageText = (months) => (months >= 24 ? `${Math.floor(months / 12)} years` : `${months} months`);

function driverKind(d) {
  if (d.cls === 'NET') return /wireless|wi-?fi|wlan|802\.11/i.test(d.name) ? 'Wi-Fi' : 'network';
  if (d.cls === 'MEDIA') return 'audio';
  if (d.cls === 'BLUETOOTH') return 'Bluetooth';
  return 'system';
}

function driverSuggestions(f) {
  const out = [];
  const info = (s) => out.push(suggestion({ category: 'Drivers', actionable: false, ...s }));

  for (const g of f.gpus) {
    const months = monthsSince(g.date);
    if (months == null || months < 12 || /microsoft basic/i.test(g.name)) continue;
    info({
      id: `driver-gpu-${g.name}`,
      impact: 'Medium',
      title: `${g.name} driver is ${ageText(months)} old`,
      detail: `Installed: ${g.version}, from ${monthYear(g.date)}. New graphics drivers regularly fix bugs and add game optimisations.`,
      links: gpuLinks(g.name),
    });
  }

  const old = (f.drivers || [])
    .filter((d) => !DRIVER_SKIP.test(d.name) && !DRIVER_SKIP.test(d.provider))
    .map((d) => ({ ...d, months: monthsSince(d.date) }))
    // Dates before 2000 are placeholders some vendors use, not real ages.
    .filter((d) => d.months != null && d.months >= 36 && new Date(d.date).getFullYear() >= 2000)
    .sort((a, b) => b.months - a.months);
  const seen = new Set();
  const unique = old.filter((d) => (seen.has(d.name) ? false : (seen.add(d.name), true)));
  if (unique.length) {
    const links = [...makerLinks(f)];
    if (unique.some((d) => /intel/i.test(d.provider))) links.push(INTEL_DSA);
    links.push(OPTIONAL_UPDATES);
    info({
      id: 'driver-old',
      impact: 'Medium',
      title: `${unique.length} device driver${unique.length === 1 ? ' is' : 's are'} over 3 years old`,
      detail: `${unique.map((d) => `${d.name} (${driverKind(d)}, ${monthYear(d.date)})`).join('; ')}. Newer versions usually fix connection drops, crackling audio and sleep problems — get them from ${makerName(f)}${unique.some((d) => /intel/i.test(d.provider)) ? ' or Intel' : ''}, or Windows Update's optional updates.`,
      links,
    });
  }

  const missing = f.missing || [];
  if (missing.length) {
    info({
      id: 'driver-missing',
      impact: 'High',
      title: `${missing.length} device${missing.length === 1 ? ' has' : 's have'} no driver`,
      detail: `${missing.slice(0, 6).join('; ')}${missing.length > 6 ? `; and ${missing.length - 6} more` : ''}. Without a driver the device does not work at all — the Devices tab lists them under “needs attention”.`,
      links: [...makerLinks(f), OPTIONAL_UPDATES],
    });
  }

  const biosMonths = monthsSince(f.biosDate);
  if (biosMonths != null && biosMonths >= 48) {
    info({
      id: 'driver-bios',
      title: `The BIOS is ${ageText(biosMonths)} old (version ${f.biosVersion}, ${monthYear(f.biosDate)})`,
      detail: 'BIOS updates fix stability, security (processor microcode) and compatibility problems. Only update with a reason, and follow the maker’s instructions exactly — a BIOS update that fails part-way can stop the PC starting.',
      links: makerLinks(f),
    });
  }
  return out;
}

function adviceItems(f, entries) {
  const out = [];
  const info = (s) => out.push(suggestion({ actionable: false, category: 'Advice', ...s }));
  // Windows 10's last version (22H2) left free support on 14 October 2025.
  if (f.build && f.build < 22000 && Date.now() >= Date.UTC(2025, 9, 14)) {
    info({ id: 'advice-win10', impact: 'High', title: 'Windows 10 no longer gets free security updates', detail: 'Support ended on 14 October 2025. Upgrade to Windows 11 if this PC qualifies (PC Health Check will say), or enrol it in Extended Security Updates so it keeps getting fixes.' });
  }
  if (f.rebootPending) {
    info({ id: 'advice-reboot', impact: 'Medium', title: 'Windows is waiting for a restart', detail: 'Updates have been installed but need a restart to finish. Until then some files stay locked and Windows keeps extra work running in the background.' });
  }
  const used = f.ramTotal ? 1 - f.ramFree / f.ramTotal : 0;
  if (used >= 0.85) {
    const top = f.topMemory.slice(0, 3).map((m) => `${m.name} ${fmtGB(m.bytes)}`).join(', ');
    info({ id: 'advice-ram-now', impact: 'Medium', title: `Memory is ${Math.round(used * 100)}% full right now`, detail: `Biggest users: ${top}. Closing some of these will speed things up immediately.` });
  }
  if (f.size && f.free / f.size < 0.1) {
    info({ id: 'advice-space', impact: 'High', title: `Only ${fmtGB(f.free)} free on ${f.systemDrive}`, detail: 'Windows slows down and updates fail when the system drive is nearly full. Clear junk (above) and move large files elsewhere — the Large files tab shows what is taking the space.' });
  }
  const days = f.bootTime ? (Date.now() - Date.parse(f.bootTime)) / 86400000 : 0;
  if (days >= 7) {
    info({ id: 'advice-restart', impact: 'Medium', title: `Restart — it has been running ${Math.floor(days)} days`, detail: 'Shutting down with Fast Startup on does not fully restart Windows. A real restart clears memory leaks and finishes pending updates.' });
  }
  if (f.antivirus.length > 1) {
    info({ id: 'advice-av', impact: 'High', title: `${f.antivirus.length} antivirus products are active`, detail: `${f.antivirus.join(' and ')} are both scanning every file. Two real-time scanners slow the PC down and can conflict — keep one.` });
  }
  if (f.autoPagefile === false) {
    info({ id: 'advice-pagefile', title: 'The page file is set by hand', detail: 'Letting Windows manage the page file size is best for almost every PC (System → Advanced system settings → Performance → Virtual memory).' });
  }
  const enabled = entries.filter((e) => e.enabled).length;
  if (enabled > 12) {
    info({ id: 'advice-startup', impact: 'Medium', title: `${enabled} programs start with Windows`, detail: 'Beyond the ones suggested above, review the rest in the Startup tab — every one slows sign-in a little.' });
  }
  return out;
}

async function junkSummary() {
  const result = await clean.scan().catch(() => null);
  if (!result) return null;
  const safe = result.targets.filter((t) => t.bytes > 0 && !t.blocked && !t.warn && !t.optional);
  return {
    bytes: safe.reduce((s, t) => s + t.bytes, 0),
    ids: safe.map((t) => t.id),
    labels: safe.map((t) => t.label),
  };
}

async function build(onProgress) {
  if (onProgress) onProgress({ label: 'Reading this PC’s setup' });
  const [f, startupList, junk] = await Promise.all([
    facts(),
    startup.list().catch(() => ({ entries: [] })),
    junkSummary(),
  ]);
  if (onProgress) onProgress({ label: 'Working out suggestions' });
  const entries = startupList.entries || [];
  const list = [
    ...powerSuggestions(f),
    ...hardwareSuggestions(f),
    ...displaySuggestions(f),
    ...driverSuggestions(f),
    ...startupSuggestions(entries),
    ...settingSuggestions(f),
    ...moreSettingSuggestions(f),
    ...storageSuggestions(f, junk),
    ...adviceItems(f, entries),
  ].map((s) => ({ ...s, blocked: s.needsAdmin && !f.admin }));
  return { facts: f, list };
}

// What the renderer sees: everything but the action payload.
function publicView(s) {
  const { action, ...rest } = s;
  return rest;
}

async function scan(onProgress) {
  const { facts: f, list } = await build(onProgress);
  return {
    admin: f.admin,
    summary: {
      cpu: f.cpu,
      ram: f.ramTotal,
      ramUsedPct: f.ramTotal ? Math.round((1 - f.ramFree / f.ramTotal) * 100) : null,
      drive: f.systemDrive,
      media: f.media,
      free: f.free,
      size: f.size,
      laptop: f.laptop,
      powerPlan: f.activeSchemeName,
      uptimeDays: f.bootTime ? Math.floor((Date.now() - Date.parse(f.bootTime)) / 86400000) : null,
    },
    suggestions: list.map(publicView),
    changes: changesLog().map(publicChange),
  };
}

/* Changes and undo ------------------------------------------------------------- */

// Loaded lazily: settings.js needs Electron's app; headless tests fall back to
// an in-memory log.
let memoryLog = [];
function settings() {
  try {
    return require('./settings');
  } catch {
    return null;
  }
}
function changesLog() {
  const s = settings();
  if (!s) return memoryLog;
  try {
    return s.get('tuneupChanges') || [];
  } catch {
    return memoryLog;
  }
}
function saveLog(log) {
  const s = settings();
  try {
    if (s) return s.set('tuneupChanges', log);
  } catch {
    /* fall through */
  }
  memoryLog = log;
}
function publicChange(c) {
  return { key: c.key, title: c.title, appliedAt: c.appliedAt, restart: Boolean(c.restart) };
}

async function setRegistry(values) {
  const out = await ps.json(`
${ps.payload({ values })}
try {
  $prev = @()
  foreach ($c in $Payload.values) {
    $existed = $false; $old = $null; $kind = $null
    if (Test-Path -LiteralPath $c.path) {
      $key = Get-Item -LiteralPath $c.path
      if ($key.GetValueNames() -contains $c.name) { $existed = $true; $old = $key.GetValue($c.name); $kind = $key.GetValueKind($c.name).ToString() }
    } else {
      New-Item -Path $c.path -Force | Out-Null
    }
    New-ItemProperty -LiteralPath $c.path -Name $c.name -Value $c.value -PropertyType $c.type -Force -ErrorAction Stop | Out-Null
    $prev += [pscustomobject]@{ path = $c.path; name = $c.name; existed = $existed; value = $old; type = $kind }
  }
  ConvertTo-Json -Compress -Depth 4 -InputObject @{ ok = $true; prev = @($prev) }
} catch {
  ConvertTo-Json -Compress -InputObject @{ ok = $false; error = [string]$_.Exception.Message }
}
`);
  if (!out || !out.ok) throw new Error((out && out.error) || 'Could not change the setting.');
  return ps.arr(out.prev);
}

async function restoreRegistry(prev) {
  await ps.mutate(`
${ps.payload({ prev })}
foreach ($p in $Payload.prev) {
  if ($p.existed) {
    if (-not (Test-Path -LiteralPath $p.path)) { New-Item -Path $p.path -Force | Out-Null }
    New-ItemProperty -LiteralPath $p.path -Name $p.name -Value $p.value -PropertyType $p.type -Force | Out-Null
  } elseif (Test-Path -LiteralPath $p.path) {
    Remove-ItemProperty -LiteralPath $p.path -Name $p.name -ErrorAction SilentlyContinue
  }
}
`);
}

function runExe(file, args) {
  return ps.mutate(`
${ps.payload({ file, args })}
$out = & $Payload.file @($Payload.args) 2>&1
if ($LASTEXITCODE -ne 0) { throw (($out | Out-String).Trim()) }
`);
}

async function setPowerPlan(target, f) {
  let guid = target;
  if (!f.schemes.some((s) => s.guid === target)) {
    // Hidden on this PC: recreate it from the built-in template.
    const out = await ps.json(`
${ps.payload({ target })}
$o = (powercfg /duplicatescheme $Payload.target) -join ' '
if ($o -match '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})') { ConvertTo-Json -Compress -InputObject $matches[1].ToLower() } else { ConvertTo-Json -Compress -InputObject '' }
`);
    if (!out) throw new Error('Windows would not create the power plan on this PC.');
    guid = out;
  }
  await runExe('powercfg', ['/setactive', guid]);
  return guid;
}

async function applyOne(s, f) {
  const a = s.action;
  switch (a.kind) {
    case 'power': {
      const previous = f.activeScheme;
      await setPowerPlan(a.target, f);
      return { undo: { kind: 'power', previous } };
    }
    case 'startup': {
      await startup.list();
      await startup.setEnabled(a.entryId, false);
      return { undo: { kind: 'startup', entryId: a.entryId } };
    }
    case 'registry': {
      const prev = await setRegistry(a.values);
      return { undo: { kind: 'registry', prev } };
    }
    case 'trim': {
      await runExe('fsutil', ['behavior', 'set', 'DisableDeleteNotify', 'NTFS', '0']);
      return { undo: { kind: 'trim', previous: 1 } };
    }
    case 'hibernate': {
      await runExe('powercfg', ['/hibernate', 'off']);
      return { undo: { kind: 'hibernate' } };
    }
    case 'cleanup': {
      const report = await clean.clean(a.ids);
      return { undo: null, detail: `Freed ${fmtGB(report.bytes)}${report.skipped ? `, ${report.skipped} files in use skipped` : ''}.` };
    }
    case 'proc-max': {
      await setProcMax(a.value);
      return { undo: { kind: 'proc-max', previous: a.previous } };
    }
    case 'gpu-power': {
      await gpu.resetPowerLimit(a.index);
      return { undo: { kind: 'gpu-power', index: a.index, previous: a.previous } };
    }
    case 'display': {
      await setDisplay(a.device, a.width, a.height, a.hz);
      return { undo: { kind: 'display', device: a.device, ...a.previous } };
    }
    case 'service': {
      await ps.mutate(`
${ps.payload({ name: a.name, startType: a.startType })}
Set-Service -Name $Payload.name -StartupType $Payload.startType -ErrorAction Stop
Start-Service -Name $Payload.name -ErrorAction SilentlyContinue
`);
      return { undo: { kind: 'service', name: a.name, startType: a.previous, wasRunning: a.wasRunning } };
    }
    case 'task': {
      await ps.mutate(`${ps.payload({ path: a.path, name: a.name })}\nEnable-ScheduledTask -TaskPath $Payload.path -TaskName $Payload.name -ErrorAction Stop | Out-Null`);
      return { undo: { kind: 'task', path: a.path, name: a.name } };
    }
    default:
      throw new Error('Unknown change.');
  }
}

async function setProcMax(value) {
  await runExe('powercfg', ['/setacvalueindex', 'SCHEME_CURRENT', 'SUB_PROCESSOR', 'PROCTHROTTLEMAX', String(value)]);
  await runExe('powercfg', ['/setactive', 'SCHEME_CURRENT']);
}

const DISP_CHANGE = { 1: 'Windows needs a restart to apply it', '-1': 'the display driver refused it', '-2': 'the screen does not support that mode', '-3': 'Windows could not save it', '-100': 'that display is no longer connected' };

async function setDisplay(device, width, height, hz) {
  const out = await ps.json(`
${DISPLAY_TYPE}
${ps.payload({ device, width, height, hz })}
ConvertTo-Json -Compress -InputObject ([BobDisplay]::Set($Payload.device, [int]$Payload.width, [int]$Payload.height, [int]$Payload.hz))
`);
  if (out !== 0) throw new Error(`Display not changed: ${DISP_CHANGE[String(out)] || `Windows code ${out}`}.`);
}

async function revert(u) {
  switch (u.kind) {
    case 'power':
      if (u.previous) await runExe('powercfg', ['/setactive', u.previous]);
      return;
    case 'startup':
      await startup.list();
      await startup.setEnabled(u.entryId, true);
      return;
    case 'registry':
      await restoreRegistry(u.prev);
      return;
    case 'trim':
      await runExe('fsutil', ['behavior', 'set', 'DisableDeleteNotify', 'NTFS', String(u.previous)]);
      return;
    case 'hibernate':
      await runExe('powercfg', ['/hibernate', 'on']);
      return;
    case 'proc-max':
      await setProcMax(u.previous);
      return;
    case 'gpu-power':
      await gpu.setPowerLimit(u.index, u.previous);
      return;
    case 'display':
      await setDisplay(u.device, u.width, u.height, u.hz);
      return;
    case 'service':
      await ps.mutate(`
${ps.payload(u)}
if (-not $Payload.wasRunning) { Stop-Service -Name $Payload.name -Force -ErrorAction SilentlyContinue }
Set-Service -Name $Payload.name -StartupType $Payload.startType -ErrorAction Stop
`);
      return;
    case 'task':
      await ps.mutate(`${ps.payload(u)}\nDisable-ScheduledTask -TaskPath $Payload.path -TaskName $Payload.name -ErrorAction Stop | Out-Null`);
      return;
    default:
      throw new Error('BOB does not know how to undo that change.');
  }
}

async function apply(ids, onProgress) {
  const wanted = new Set(Array.isArray(ids) ? ids : []);
  const { facts: f, list } = await build();
  const chosen = list.filter((s) => wanted.has(s.id) && s.actionable);
  const results = [];
  let log = changesLog();

  for (let i = 0; i < chosen.length; i += 1) {
    const s = chosen[i];
    if (onProgress) onProgress({ label: s.title, index: i, total: chosen.length });
    if (s.needsAdmin && !f.admin) {
      results.push({ id: s.id, title: s.title, ok: false, error: 'Needs administrator rights.' });
      continue;
    }
    try {
      const r = await applyOne(s, f);
      let key = null;
      if (r.undo) {
        key = `${s.id}@${Date.now()}`;
        log = [...log, { key, suggestionId: s.id, title: s.title, appliedAt: new Date().toISOString(), restart: s.restart, undo: r.undo }];
        saveLog(log);
      }
      // verifyDisplay: the renderer asks "can you see this?" and undoes it by
      // key if nobody answers — a mode the screen cannot show leaves it blank.
      results.push({ id: s.id, title: s.title, ok: true, detail: r.detail || '', key, verifyDisplay: Boolean(s.verifyDisplay) });
    } catch (err) {
      results.push({ id: s.id, title: s.title, ok: false, error: String(err.message || err).split(/\r?\n/)[0] });
    }
  }
  // Wanted but no longer suggested (already done elsewhere, or the PC changed).
  for (const id of wanted) {
    if (!chosen.some((s) => s.id === id)) results.push({ id, title: id, ok: false, error: 'No longer needed — nothing was changed.' });
  }
  if (onProgress) onProgress({ label: 'Done', index: chosen.length, total: chosen.length });
  return { results, changes: changesLog().map(publicChange) };
}

async function undo(key) {
  const log = changesLog();
  const entry = log.find((c) => c.key === key);
  if (!entry) throw new Error('That change is no longer in the list.');
  await revert(entry.undo);
  saveLog(log.filter((c) => c.key !== key));
  return { title: entry.title, changes: changesLog().map(publicChange) };
}

async function undoAll() {
  const done = [];
  const failed = [];
  for (const entry of [...changesLog()].reverse()) {
    try {
      await revert(entry.undo);
      saveLog(changesLog().filter((c) => c.key !== entry.key));
      done.push(entry.title);
    } catch (err) {
      failed.push({ title: entry.title, error: err.message });
    }
  }
  return { done, failed, changes: changesLog().map(publicChange) };
}

function changes() {
  return changesLog().map(publicChange);
}

module.exports = { scan, apply, undo, undoAll, changes, _internals: { facts, build, applyOne, revert, STARTUP_KNOWN, setRegistry, restoreRegistry, ratedSpeed, hardwareSuggestions, displaySuggestions, driverSuggestions, makerLinks, moreSettingSuggestions, setDisplay, setProcMax } };
