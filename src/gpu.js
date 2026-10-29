'use strict';

// Graphics card workshop — live temperature, fan, power, load, memory and clocks
// for the graphics card, plus the two controls a bench tech actually reaches for:
// the board power limit and a manual fan speed.
//
// NVIDIA cards are read through nvidia-smi, which ships with every NVIDIA driver,
// so nothing extra has to be installed. nvidia-smi can set the power limit (needs
// admin) but cannot set the fan on Windows, so fan control goes through the
// driver's own NVAPI (nvapi64.dll) cooler calls — the same ones fan-curve tools
// use. AMD and Intel have no built-in equivalent, so those cards get the basic
// identity read-out and a plain note rather than made-up numbers.
//
// A manual fan is the one setting here that can cook a card, so it is fenced in:
// a floor on the speed, a watchdog that hands the fan back to the driver if the
// card gets hot, and every manual fan is returned to automatic when BOB closes.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const ps = require('./ps');

// Lowest manual fan speed BOB will set, whatever the driver allows. Many cards
// accept 0% (fan-stop), which is fine at idle under the driver's control but a
// trap when pinned by hand.
const MIN_MANUAL_FAN = 30;
// Hand the fan back to the driver if a manually-fanned card reaches this.
// (let, so a test can lower it rather than heating a real card.)
let WATCHDOG_TEMP = 83;
const WATCHDOG_MS = 3000;

// Ordered so the cheap, always-present fields come first; THROTTLE is dropped and
// the query retried if a driver no longer recognises it (newer drivers renamed
// it clocks_event_reasons).
const BASE_FIELDS = [
  'index', 'name', 'uuid', 'pci.bus_id', 'driver_version',
  'temperature.gpu', 'fan.speed',
  'power.draw', 'power.limit', 'power.default_limit', 'power.min_limit', 'power.max_limit',
  'utilization.gpu', 'utilization.memory', 'memory.used', 'memory.total',
  'clocks.gr', 'clocks.mem', 'clocks.max.gr', 'clocks.max.mem', 'pstate',
  'pcie.link.gen.current', 'pcie.link.width.current', 'pcie.link.gen.max', 'pcie.link.width.max',
];
const THROTTLE_FIELDS = ['clocks_throttle_reasons.active', 'clocks_event_reasons.active'];

// clocks_throttle_reasons bit meanings, in the order nvidia-smi documents them.
const THROTTLE_BITS = [
  [0x1, 'Idle'],
  [0x2, 'App clock limit'],
  [0x4, 'Power limit'],
  [0x8, 'Hardware slowdown'],
  [0x10, 'Sync boost'],
  [0x20, 'Thermal (software)'],
  [0x40, 'Thermal (hardware)'],
  [0x80, 'Power brake'],
  [0x100, 'Display clock'],
];

const VENDORS = { '10DE': 'NVIDIA', '1002': 'AMD', '8086': 'Intel', '1414': 'Microsoft', '15AD': 'VMware', '80EE': 'VirtualBox' };

/* nvidia-smi --------------------------------------------------------------- */

let smiExe;
function smiPath() {
  if (smiExe !== undefined) return smiExe;
  const candidates = [
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'),
  ];
  smiExe = candidates.find((p) => fs.existsSync(p)) || null;
  return smiExe;
}

function smi(args, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const exe = smiPath();
    if (!exe) return reject(new Error('nvidia-smi not found'));
    execFile(exe, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = String(stdout || '');
      if (err) return reject(new Error((out || String(stderr || '') || err.message).trim()));
      resolve(out);
    });
  });
}

// Field list that this driver accepts, worked out on first use.
let fields = null;

async function queryRaw() {
  const tryFields = async (list) =>
    smi([`--query-gpu=${list.join(',')}`, '--format=csv,noheader,nounits']);
  if (fields) return { text: await tryFields(fields), list: fields };
  for (const extra of [...THROTTLE_FIELDS.map((f) => [f]), []]) {
    const list = [...BASE_FIELDS, ...extra];
    try {
      const text = await tryFields(list);
      fields = list;
      return { text, list };
    } catch (err) {
      if (!/not a valid field|invalid field/i.test(err.message)) throw err;
    }
  }
  throw new Error('nvidia-smi rejected the query');
}

function num(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || /n\/a|not supported|unknown|\[/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function str(v) {
  const s = String(v == null ? '' : v).trim();
  return !s || /^\[?n\/a\]?$|not supported/i.test(s) ? '' : s;
}

function decodeThrottle(hex) {
  const s = str(hex);
  if (!s) return { mask: null, reasons: [] };
  const mask = parseInt(s, 16);
  if (!Number.isFinite(mask)) return { mask: null, reasons: [] };
  return { mask, reasons: THROTTLE_BITS.filter(([bit]) => mask & bit).map(([, label]) => label) };
}

// "00000000:01:00.0" -> 1 (the PCI bus, which is how NVAPI identifies a card).
function busFromId(busId) {
  const m = /^[0-9a-f]+:([0-9a-f]{2}):/i.exec(String(busId || ''));
  return m ? parseInt(m[1], 16) : null;
}

function parseSmi(text, list) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const cells = line.split(/,\s*/);
      const row = {};
      list.forEach((f, i) => { row[f] = cells[i]; });
      const throttleKey = list.find((f) => THROTTLE_FIELDS.includes(f));
      const throttle = decodeThrottle(throttleKey ? row[throttleKey] : '');
      return {
        index: num(row.index),
        name: str(row.name),
        uuid: str(row.uuid),
        busId: str(row['pci.bus_id']),
        bus: busFromId(row['pci.bus_id']),
        driver: str(row.driver_version),
        temp: num(row['temperature.gpu']),
        fanPct: num(row['fan.speed']),
        power: {
          draw: num(row['power.draw']),
          limit: num(row['power.limit']),
          def: num(row['power.default_limit']),
          min: num(row['power.min_limit']),
          max: num(row['power.max_limit']),
        },
        util: { gpu: num(row['utilization.gpu']), mem: num(row['utilization.memory']) },
        mem: { used: num(row['memory.used']), total: num(row['memory.total']) }, // MiB
        clocks: {
          core: num(row['clocks.gr']),
          mem: num(row['clocks.mem']),
          coreMax: num(row['clocks.max.gr']),
          memMax: num(row['clocks.max.mem']),
        },
        pstate: str(row.pstate),
        pcie: {
          gen: num(row['pcie.link.gen.current']),
          width: num(row['pcie.link.width.current']),
          genMax: num(row['pcie.link.gen.max']),
          widthMax: num(row['pcie.link.width.max']),
        },
        throttle,
      };
    });
}

async function nvidiaCards() {
  if (!smiPath()) return { available: false, cards: [] };
  try {
    const { text, list } = await queryRaw();
    return { available: true, cards: parseSmi(text, list) };
  } catch (err) {
    return { available: false, error: err.message, cards: [] };
  }
}

/* NVAPI fan control -------------------------------------------------------- */

// C# shim over nvapi64.dll. Methods return flat int arrays so PowerShell can hand
// them straight to ConvertTo-Json. Function ids are NVAPI's QueryInterface ids.
// Cooler entry layout (12 ints): type, controller, defaultMin, defaultMax,
// currentMin, currentMax, currentLevel, defaultPolicy, currentPolicy, target,
// controlType, active. Policy 1 = manual; anything else is driver-controlled.
const NVAPI_TYPE = `
if (-not ('BobNvFan' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BobNvFan {
  [DllImport("nvapi64.dll", EntryPoint = "nvapi_QueryInterface", CallingConvention = CallingConvention.Cdecl)]
  static extern IntPtr QI(uint id);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int InitFn();
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int EnumFn([Out] IntPtr[] h, out int n);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int BusFn(IntPtr h, out int bus);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int CoolFn(IntPtr h, int idx, IntPtr buf);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int RestoreFn(IntPtr h, IntPtr idxs, int count);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int TachFn(IntPtr h, out uint rpm);
  const int MaxCoolers = 20;
  const int SettingsSize = 8 + MaxCoolers * 48;
  const int LevelsSize = 4 + MaxCoolers * 8;
  static bool ready;
  static T F<T>(uint id) where T : class {
    IntPtr p = QI(id);
    if (p == IntPtr.Zero) throw new Exception("NVAPI function missing");
    return Marshal.GetDelegateForFunctionPointer(p, typeof(T)) as T;
  }
  static IntPtr Handle(int bus) {
    if (!ready) { int r = F<InitFn>(0x0150E828)(); if (r != 0) throw new Exception("NVAPI init failed (" + r + ")"); ready = true; }
    var hs = new IntPtr[64]; int n;
    int rc = F<EnumFn>(0xE5AC921F)(hs, out n);
    if (rc != 0) throw new Exception("NVAPI could not list GPUs (" + rc + ")");
    var busFn = F<BusFn>(0x1BE0B8E5);
    for (int i = 0; i < n; i++) { int b; if (busFn(hs[i], out b) == 0 && b == bus) return hs[i]; }
    if (n == 1 && bus < 0) return hs[0];
    throw new Exception("NVAPI has no GPU on bus " + bus);
  }
  static IntPtr Zeroed(int size) {
    IntPtr buf = Marshal.AllocHGlobal(size);
    for (int i = 0; i < size; i++) Marshal.WriteByte(buf, i, 0);
    return buf;
  }
  public static int[] Coolers(int bus) {
    IntPtr h = Handle(bus);
    IntPtr buf = Zeroed(SettingsSize);
    try {
      Marshal.WriteInt32(buf, 0, SettingsSize | 0x20000);
      int rc = F<CoolFn>(0xDA141340)(h, 0, buf);
      if (rc != 0) return new int[] { rc, 0 };
      int count = Math.Min(Marshal.ReadInt32(buf, 4), MaxCoolers);
      var outp = new int[2 + count * 12];
      outp[0] = 0; outp[1] = count;
      for (int c = 0; c < count; c++)
        for (int k = 0; k < 12; k++) outp[2 + c * 12 + k] = Marshal.ReadInt32(buf, 8 + c * 48 + k * 4);
      return outp;
    } finally { Marshal.FreeHGlobal(buf); }
  }
  public static int SetLevel(int bus, int level) {
    IntPtr h = Handle(bus);
    IntPtr buf = Zeroed(LevelsSize);
    try {
      Marshal.WriteInt32(buf, 0, LevelsSize | 0x10000);
      Marshal.WriteInt32(buf, 4, level);
      Marshal.WriteInt32(buf, 8, 1);
      return F<CoolFn>(0x891FA0AE)(h, 0, buf);
    } finally { Marshal.FreeHGlobal(buf); }
  }
  // Fan RPM from the tachometer, or -1 where the card does not report one.
  public static int Tach(int bus) {
    try { uint rpm; return F<TachFn>(0x5F608315)(Handle(bus), out rpm) == 0 ? (int)rpm : -1; }
    catch { return -1; }
  }
  public static int Restore(int bus) {
    return F<RestoreFn>(0x8F6ED0FB)(Handle(bus), IntPtr.Zero, 0);
  }
}
'@
}
`;

// A .NET method that throws reaches PowerShell wrapped in "Exception calling
// ... with N argument(s)"; report the shim's own message instead.
const NVAPI_CATCH = `$e = $_.Exception; if ($e.InnerException) { $e = $e.InnerException }
  ConvertTo-Json -Compress -InputObject @{ ok = $false; error = [string]$e.Message }`;

const NVAPI_ERRORS = {
  '-1': 'the driver reported a general error',
  '-5': 'the driver rejected the value',
  '-9': 'this driver uses a newer fan interface BOB does not support yet',
  '-104': 'this card does not allow software fan control',
};

function nvapiError(rc) {
  return new Error(`Fan control failed: ${NVAPI_ERRORS[String(rc)] || `NVIDIA driver code ${rc}`}.`);
}

function cleanBus(bus) {
  const b = Number(bus);
  if (!Number.isInteger(b) || b < 0 || b > 255) throw new Error('No graphics card given.');
  return b;
}

async function readCoolers(bus) {
  const out = await ps.json(`
${NVAPI_TYPE}
try {
  ConvertTo-Json -Compress -InputObject @{ ok = $true; data = @([BobNvFan]::Coolers(${cleanBus(bus)})); rpm = [BobNvFan]::Tach(${cleanBus(bus)}) }
} catch {
  ${NVAPI_CATCH}
}
`);
  if (!out || !out.ok) return { supported: false, reason: (out && out.error) || 'NVAPI unavailable', coolers: [] };
  const d = ps.arr(out.data).map(Number);
  if (d[0] !== 0) return { supported: false, reason: nvapiError(d[0]).message, coolers: [] };
  const coolers = [];
  for (let c = 0; c < d[1]; c++) {
    const f = d.slice(2 + c * 12, 2 + c * 12 + 12);
    coolers.push({
      defaultMin: f[2], defaultMax: f[3], min: f[4], max: f[5], level: f[6],
      defaultPolicy: f[7], policy: f[8], manual: f[8] === 1,
    });
  }
  const rpm = Number(out.rpm);
  return {
    supported: coolers.length > 0,
    reason: coolers.length ? '' : 'no controllable fans',
    coolers,
    rpm: Number.isFinite(rpm) && rpm >= 0 ? rpm : null,
  };
}

async function nvapiCall(expr) {
  const out = await ps.json(`
${NVAPI_TYPE}
try {
  ConvertTo-Json -Compress -InputObject @{ ok = $true; rc = [int](${expr}) }
} catch {
  ${NVAPI_CATCH}
}
`);
  if (!out || !out.ok) throw new Error(`Fan control failed: ${(out && out.error) || 'NVAPI unavailable'}.`);
  if (out.rc !== 0) throw nvapiError(out.rc);
}

/* Manual-fan safety -------------------------------------------------------- */

// bus -> level, for every card BOB has put on a manual fan.
const manual = new Map();
let watchdog = null;
let onAlert = null;

function setAlertHandler(fn) {
  onAlert = fn;
}

function syncWatchdog() {
  if (manual.size && !watchdog) watchdog = setInterval(watch, WATCHDOG_MS);
  if (!manual.size && watchdog) {
    clearInterval(watchdog);
    watchdog = null;
  }
}

async function watch() {
  if (!manual.size) return syncWatchdog();
  const { cards } = await nvidiaCards();
  for (const card of cards) {
    if (!manual.has(card.bus) || card.temp == null || card.temp < WATCHDOG_TEMP) continue;
    try {
      await fanAuto(card.bus);
      if (onAlert) {
        onAlert({
          bus: card.bus,
          name: card.name,
          temp: card.temp,
          message: `${card.name} reached ${card.temp}°C on a manual fan, so BOB handed the fan back to automatic.`,
        });
      }
    } catch {
      /* try again on the next tick */
    }
  }
}

/* Public API --------------------------------------------------------------- */

// Every real display adapter (PCI only; virtual/remote displays are skipped).
const ADAPTERS_SCRIPT = `
$classKey = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'
$vram = @{}
Get-ChildItem -Path $classKey -ErrorAction SilentlyContinue | ForEach-Object {
  $p = Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue
  if ($p -and $p.MatchingDeviceId -and $p.'HardwareInformation.qwMemorySize') {
    $vram[[string]$p.MatchingDeviceId.ToUpper()] = [uint64]$p.'HardwareInformation.qwMemorySize'
  }
}
$list = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Where-Object { $_.PNPDeviceID -like 'PCI\\*' } | ForEach-Object {
  $pnp = [string]$_.PNPDeviceID
  $bytes = $null
  foreach ($k in $vram.Keys) { if ($pnp.ToUpper().StartsWith($k)) { $bytes = $vram[$k]; break } }
  if (-not $bytes -and $_.AdapterRAM) { $bytes = [uint64][uint32]$_.AdapterRAM }
  [pscustomobject]@{
    name    = [string]$_.Name
    pnp     = $pnp
    driver  = [string]$_.DriverVersion
    date    = if ($_.DriverDate) { $_.DriverDate.ToString('yyyy-MM-dd') } else { '' }
    vram    = $bytes
    mode    = [string]$_.VideoModeDescription
    refresh = [int]$_.CurrentRefreshRate
    status  = [string]$_.Status
  }
}
ConvertTo-Json -Compress -Depth 3 -InputObject @($list)
`;

function vendorOf(pnp) {
  const m = /VEN_([0-9A-F]{4})/i.exec(pnp || '');
  return m ? VENDORS[m[1].toUpperCase()] || `Vendor ${m[1].toUpperCase()}` : '';
}

async function adapters() {
  const raw = ps.arr(await ps.json(ADAPTERS_SCRIPT));
  return raw.map((a) => ({
    name: a.name,
    pnp: a.pnp,
    vendor: vendorOf(a.pnp),
    driver: a.driver,
    driverDate: a.date,
    vram: Number(a.vram) || null,
    mode: a.mode,
    refresh: a.refresh || null,
    status: a.status,
  }));
}

function attachFan(card, fan) {
  const first = fan.coolers[0];
  const floor = first ? Math.max(MIN_MANUAL_FAN, first.min || 0) : MIN_MANUAL_FAN;
  const isManual = Boolean(first && first.manual);
  // NVAPI's level is where the fan has got to, not where it was asked to go —
  // straight after a change it is still ramping. Report the requested speed
  // when BOB set it.
  const target = !isManual ? null : manual.has(card.bus) ? manual.get(card.bus) : first.level;
  return {
    ...card,
    fan: {
      supported: fan.supported,
      reason: fan.reason,
      manual: isManual,
      setByBob: manual.has(card.bus),
      target,
      level: first ? first.level : null,
      rpm: fan.rpm == null ? null : fan.rpm,
      defaultMin: first ? first.defaultMin : null,
      min: floor,
      max: first ? Math.min(100, first.max || 100) : 100,
      count: fan.coolers.length,
    },
  };
}

// Full read for the tab: every adapter, with live NVIDIA data where available.
async function status() {
  const [list, nv] = await Promise.all([adapters(), nvidiaCards()]);
  const cards = [];
  for (const card of nv.cards) {
    const withFan = attachFan(card, await readCoolers(card.bus));
    cards.push({ ...withFan, vbios: await vbios(card) });
  }
  const others = list.filter((a) => a.vendor !== 'NVIDIA' || !nv.available);
  return {
    nvidia: { available: nv.available, error: nv.error || '', smi: Boolean(smiPath()) },
    nvflash: findNvflash(),
    cards,
    others,
    limits: { minManualFan: MIN_MANUAL_FAN, watchdogTemp: WATCHDOG_TEMP },
  };
}

// The light poll the tab runs every couple of seconds.
async function sample() {
  const nv = await nvidiaCards();
  const cards = [];
  for (const card of nv.cards) cards.push(attachFan(card, await readCoolers(card.bus)));
  return { available: nv.available, cards, at: Date.now() };
}

async function cardByIndex(index) {
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0) throw new Error('No graphics card given.');
  const { cards, available, error } = await nvidiaCards();
  if (!available) throw new Error(error || 'No NVIDIA card found.');
  const card = cards.find((c) => c.index === i);
  if (!card) throw new Error('That graphics card is no longer there.');
  return card;
}

function powerError(err) {
  if (/insufficient permissions|access denied|requires root|administrator/i.test(err.message)) {
    return new Error('Changing the power limit needs administrator rights.');
  }
  if (/not supported/i.test(err.message)) {
    return new Error('This card does not allow its power limit to be changed.');
  }
  return new Error(`Could not set the power limit: ${err.message.split(/\r?\n/)[0]}`);
}

async function setPowerLimit(index, watts) {
  const card = await cardByIndex(index);
  const { min, max } = card.power;
  if (min == null || max == null) throw new Error('This card does not report an adjustable power limit.');
  const w = Math.round(Number(watts));
  if (!Number.isFinite(w)) throw new Error('Enter a power limit in watts.');
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  if (w < lo || w > hi) throw new Error(`The power limit must be between ${lo} W and ${hi} W for this card.`);
  try {
    await smi(['-i', String(card.index), '-pl', String(w)]);
  } catch (err) {
    throw powerError(err);
  }
  return { index: card.index, limit: w };
}

async function resetPowerLimit(index) {
  const card = await cardByIndex(index);
  if (card.power.def == null) throw new Error('This card does not report a default power limit.');
  const w = Math.min(Math.floor(card.power.max), Math.max(Math.ceil(card.power.min), Math.round(card.power.def)));
  return setPowerLimit(index, w);
}

async function setFan(bus, level) {
  const b = cleanBus(bus);
  const fan = await readCoolers(b);
  if (!fan.supported) throw new Error(`Fan control is not available on this card (${fan.reason}).`);
  const first = fan.coolers[0];
  const floor = Math.max(MIN_MANUAL_FAN, first.min || 0);
  const ceil = Math.min(100, first.max || 100);
  const l = Math.round(Number(level));
  if (!Number.isFinite(l)) throw new Error('Enter a fan speed.');
  if (l < floor || l > ceil) throw new Error(`Manual fan speed must be between ${floor}% and ${ceil}%.`);
  await nvapiCall(`[BobNvFan]::SetLevel(${b}, ${l})`);
  manual.set(b, l);
  syncWatchdog();
  return { bus: b, level: l };
}

async function fanAuto(bus) {
  const b = cleanBus(bus);
  await nvapiCall(`[BobNvFan]::Restore(${b})`);
  manual.delete(b);
  syncWatchdog();
  return { bus: b, auto: true };
}

/* VBIOS -------------------------------------------------------------------- */

// The card's firmware is where every default lives: the power limits, the fan
// floor, the clock ceiling and the temperature targets. Windows-side changes are
// overrides on top of it and fall back to it on another PC or a driver reinstall.
// Whether those defaults can be changed at the source depends on the generation:
// from Pascal on, NVIDIA cards only run an NVIDIA-signed VBIOS.

const UNSIGNED_ARCHS = /^(tesla|fermi|kepler|maxwell)$/i;
const SIGNED_ARCHS = /^(pascal|volta|turing|ampere|ada|ada lovelace|hopper|blackwell)$/i;

// Older drivers leave product_architecture out; fall back on the model name.
function archFromName(name) {
  const n = String(name || '');
  if (/\bRTX\s*50\d0/i.test(n)) return 'Blackwell';
  if (/\bRTX\s*40\d0/i.test(n)) return 'Ada Lovelace';
  if (/\bRTX\s*30\d0|\bA\d{3,4}\b/i.test(n)) return 'Ampere';
  if (/\bRTX\s*20\d0|\bGTX\s*16\d0|TITAN RTX/i.test(n)) return 'Turing';
  if (/\bGTX\s*10\d0|\bGT\s*10\d0|TITAN X[p ]/i.test(n)) return 'Pascal';
  if (/\bGTX\s*(9\d0|750)|TITAN X$/i.test(n)) return 'Maxwell';
  if (/\bGTX\s*(6\d0|7[0-4]\d|7[6-9]\d)|TITAN( Black| Z)?$/i.test(n)) return 'Kepler';
  return '';
}

function editability(arch) {
  if (UNSIGNED_ARCHS.test(arch)) {
    return {
      locked: false,
      note: `${arch} cards accept an unsigned VBIOS, so the built-in power limits and fan curve can be raised permanently by editing the VBIOS and flashing it with nvflash. That is a firmware change that travels with the card — back it up first; a bad flash can leave the card unusable.`,
    };
  }
  if (SIGNED_ARCHS.test(arch)) {
    return {
      locked: true,
      note: `${arch} cards only run a VBIOS signed by NVIDIA, so its limits cannot be changed by editing it. The most that can be done is flashing another vendor's signed VBIOS for the same board.`,
    };
  }
  return { locked: null, note: 'BOB could not tell which generation this card is, so it cannot say whether its VBIOS can be changed.' };
}

function xmlSection(xml, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? m[1] : '';
}

function xmlValue(xml, tag) {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return m ? str(m[1]) : '';
}

// "96 C" / "195.14 W" / "1443 MHz" -> number
function xmlNum(xml, tag) {
  const v = xmlValue(xml, tag);
  const m = /-?\d+(\.\d+)?/.exec(v);
  return m ? Number(m[0]) : null;
}

async function vbios(card) {
  let xml = '';
  try {
    xml = await smi(['-q', '-x', '-i', String(card.index)], 15000);
  } catch {
    /* fall through with what the CSV query already gave */
  }
  const power = xmlSection(xml, 'gpu_power_readings') || xmlSection(xml, 'power_readings');
  const temps = xmlSection(xml, 'temperature');
  const maxClocks = xmlSection(xml, 'max_clocks');
  const arch = xmlValue(xml, 'product_architecture') || archFromName(card.name);
  return {
    version: xmlValue(xml, 'vbios_version'),
    architecture: arch,
    brand: xmlValue(xml, 'product_brand'),
    partNumber: xmlValue(xml, 'gpu_part_number'),
    boardId: xmlValue(xml, 'board_id'),
    inforom: xmlValue(xmlSection(xml, 'inforom_version'), 'img_version'),
    power: {
      def: xmlNum(power, 'default_power_limit') ?? card.power.def,
      min: xmlNum(power, 'min_power_limit') ?? card.power.min,
      max: xmlNum(power, 'max_power_limit') ?? card.power.max,
    },
    clocks: {
      core: xmlNum(maxClocks, 'graphics_clock') ?? card.clocks.coreMax,
      mem: xmlNum(maxClocks, 'mem_clock') ?? card.clocks.memMax,
      video: xmlNum(maxClocks, 'video_clock'),
    },
    temps: {
      target: xmlNum(temps, 'gpu_target_temperature'),
      slowdown: xmlNum(temps, 'gpu_temp_slow_threshold'),
      shutdown: xmlNum(temps, 'gpu_temp_max_threshold'),
      maxOperating: xmlNum(temps, 'gpu_temp_max_gpu_threshold'),
    },
    ...editability(arch),
  };
}

// nvflash is NVIDIA's flashing tool. BOB cannot ship it, so it uses a copy the
// tech provides: one saved via "Locate nvflash", or one sitting beside BOB.exe.
const NVFLASH_NAME = /^nvflash(64)?\.exe$/i;

function nvflashCandidates() {
  const dirs = [];
  if (process.env.PORTABLE_EXECUTABLE_DIR) dirs.push(process.env.PORTABLE_EXECUTABLE_DIR);
  dirs.push(path.join(__dirname, '..'));
  const out = [];
  let saved = null;
  try {
    saved = settings().get('nvflashPath');
  } catch {
    /* no Electron (headless test) — just look beside BOB */
  }
  if (saved) out.push(saved);
  for (const d of dirs) {
    for (const sub of ['', 'tools', 'nvflash']) {
      for (const name of ['nvflash64.exe', 'nvflash.exe']) out.push(path.join(d, sub, name));
    }
  }
  return out;
}

function findNvflash() {
  return nvflashCandidates().find((p) => {
    try {
      return NVFLASH_NAME.test(path.basename(p)) && fs.statSync(p).isFile();
    } catch {
      return false;
    }
  }) || null;
}

// Loaded lazily: settings.js needs Electron's app, and gpu.js is also driven
// headless from plain Node in tests.
function settings() {
  return require('./settings');
}

function setNvflashPath(p) {
  const file = String(p || '');
  if (!NVFLASH_NAME.test(path.basename(file))) throw new Error('Choose nvflash64.exe (or nvflash.exe).');
  if (!fs.existsSync(file)) throw new Error('That file no longer exists.');
  settings().set('nvflashPath', file);
  return { path: file };
}

function runNvflash(exe, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`;
      if (err) return reject(Object.assign(new Error(out.trim() || err.message), { output: out }));
      resolve(out);
    });
  });
}

// With more than one NVIDIA card, nvflash must be told which one; its own
// numbering is matched to ours by PCI bus ("B:01" in its --list output).
async function nvflashIndexFor(exe, card, cardCount) {
  if (cardCount <= 1) return null;
  const list = await runNvflash(exe, ['--list'], 30000);
  if (card.bus == null) throw new Error('BOB could not tell which PCI slot this card is in.');
  const bus = card.bus.toString(16).padStart(2, '0');
  for (const line of list.split(/\r?\n/)) {
    const m = /^\s*<(\d+)>.*\bB:([0-9a-f]{2})\b/i.exec(line);
    if (m && m[2].toLowerCase() === bus) return Number(m[1]);
  }
  throw new Error('nvflash did not list this card, so BOB will not guess which one to read.');
}

function looksLikeRom(buf) {
  if (buf.length < 32 * 1024) return false;
  if (buf[0] === 0x55 && buf[1] === 0xaa) return true;
  // Newer NVIDIA images carry an "NVGI" header in front of the PCI ROM.
  if (buf.slice(0, 4).toString('latin1') === 'NVGI') return true;
  return buf.indexOf(Buffer.from([0x55, 0xaa])) !== -1 && buf.indexOf(Buffer.from('PCIR', 'latin1')) !== -1;
}

async function backupVbios(index, dest) {
  const card = await cardByIndex(index);
  const exe = findNvflash();
  if (!exe) throw new Error('nvflash was not found. Put nvflash64.exe next to BOB.exe, or use "Locate nvflash".');
  if (!dest) throw new Error('No file chosen.');

  const { cards } = await nvidiaCards();
  const nvIndex = await nvflashIndexFor(exe, card, cards.length);
  const tmp = path.join(require('os').tmpdir(), `bob-vbios-${Date.now()}.rom`);
  const args = [...(nvIndex == null ? [] : [`--index=${nvIndex}`]), '--save', tmp];
  try {
    await runNvflash(exe, args);
  } catch (err) {
    if (/administrator|elevat|privilege|access is denied/i.test(err.message)) {
      throw new Error('Reading the VBIOS needs administrator rights.');
    }
    throw new Error(`nvflash could not read the VBIOS: ${err.message.split(/\r?\n/).filter(Boolean).pop()}`);
  }
  let buf;
  try {
    buf = fs.readFileSync(tmp);
  } catch {
    throw new Error('nvflash finished but wrote no file.');
  }
  try {
    if (!looksLikeRom(buf)) throw new Error('The file nvflash wrote does not look like a VBIOS image, so it was not saved.');
    fs.writeFileSync(dest, buf);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
  const sha256 = require('crypto').createHash('sha256').update(buf).digest('hex');
  return { path: dest, size: buf.length, sha256 };
}

function hasManual() {
  return manual.size > 0;
}

// Called on quit: never leave a card on a fixed fan speed with nobody watching.
async function restoreAll() {
  for (const bus of [...manual.keys()]) {
    try {
      await fanAuto(bus);
    } catch {
      manual.delete(bus);
    }
  }
  syncWatchdog();
}

module.exports = {
  status,
  sample,
  setPowerLimit,
  resetPowerLimit,
  setFan,
  fanAuto,
  hasManual,
  restoreAll,
  setAlertHandler,
  backupVbios,
  findNvflash,
  setNvflashPath,
  __internals: {
    archFromName, editability, looksLikeRom,
    parseSmi, decodeThrottle, busFromId, vendorOf, MIN_MANUAL_FAN,
    setWatchdogTemp: (t) => { WATCHDOG_TEMP = t; },
  },
};
