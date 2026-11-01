'use strict';

// Stress test: finds the faults that only appear under load. The processor and
// memory threads check their own answers, the disk test checks what it reads
// back, and Windows' own hardware error log is read afterwards. The page runs the
// graphics load, because only it can reach the card through WebGL.
//
// Heat is the risk, so it stops by itself at STOP_GPU_C or STOP_BOARD_C. Windows
// shows no processor temperature on most PCs without a kernel driver, which BOB
// does not install, so the test also watches for the speed drop that overheating
// causes.

const { fork, spawn } = require('child_process');
const os = require('os');
const path = require('path');
const ps = require('./ps');
const gpu = require('./gpu');

const STOP_GPU_C = 90;
const STOP_BOARD_C = 95;
const BLIND_MS = 30000;
const MINUTES = [1, 5, 15, 30, 60];
const MEMORY_BLOCK = 2 * 1024 * 1024 * 1024;
const MEMORY_RESERVE = 2 * 1024 * 1024 * 1024;
const DISK_TEST_BYTES = 1024 * 1024 * 1024;

const SAMPLE_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$p = Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation -Filter "Name='_Total'"
$z = @(Get-CimInstance -Namespace root/wmi MSAcpi_ThermalZoneTemperature | ForEach-Object { [math]::Round(($_.CurrentTemperature / 10) - 273.15, 1) })
[pscustomobject]@{
  load = [double]$p.PercentProcessorTime
  performance = [double]$p.PercentProcessorPerformance
  baseMhz = [double]$p.ProcessorFrequency
  board = $(if ($z.Count) { ($z | Measure-Object -Maximum).Maximum } else { $null })
} | ConvertTo-Json -Compress
`;

const DRIVES_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$phys = @(Get-PhysicalDisk)
@(Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -in 2,3 -and $_.Size } | ForEach-Object {
  $letter = $_.DeviceID.Substring(0,1)
  $n = (Get-Partition -DriveLetter $letter).DiskNumber
  $d = $phys | Where-Object { [string]$_.DeviceId -eq [string]$n } | Select-Object -First 1
  [pscustomobject]@{
    letter = $letter
    label = [string]$_.VolumeName
    free = [double]$_.FreeSpace
    size = [double]$_.Size
    media = [string]$d.MediaType
    bus = [string]$d.BusType
    model = [string]$d.FriendlyName
  }
}) | ConvertTo-Json -Compress
`;

const EVENTS_SCRIPT = (since) => `
${ps.payload({ since })}
$ErrorActionPreference = 'SilentlyContinue'
$from = [datetime]::Parse($Payload.since).ToLocalTime()
$whea = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-WHEA-Logger'; StartTime = $from })
$disk = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'disk','Ntfs','storahci','stornvme'; Level = 1,2,3; StartTime = $from })
$display = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Display','nvlddmkm','amdkmdag','igfx'; StartTime = $from })
[pscustomobject]@{ whea = $whea.Count; disk = $disk.Count; display = $display.Count } | ConvertTo-Json -Compress
`;

let run = null;

function drives() {
  return ps.json(DRIVES_SCRIPT, { timeout: 30000 }).then((rows) => ps.arr(rows).map((d) => ({
    ...d,
    enoughSpace: d.free > DISK_TEST_BYTES * 2,
  })));
}

function planMemoryBlocks() {
  const spare = os.freemem() - MEMORY_RESERVE;
  const total = Math.max(0, Math.floor(spare * 0.8));
  const blocks = [];
  let left = total;
  while (left >= 256 * 1024 * 1024 && blocks.length < 8) {
    const size = Math.min(left, MEMORY_BLOCK);
    blocks.push(size - (size % 4));
    left -= size;
  }
  return blocks;
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Runs the processor and memory load for the chosen time, resolving with what happened. */
async function load(options, onProgress) {
  if (run) throw new Error('A stress test is already running.');
  const minutes = MINUTES.includes(options.minutes) ? options.minutes : 5;
  const started = Date.now();
  const raw = {
    since: new Date(started).toISOString(),
    minutes,
    wanted: { cpu: Boolean(options.cpu), memory: Boolean(options.memory), gpu: Boolean(options.gpu) },
    cpu: { threads: options.cpu ? os.cpus().length : 0, rounds: 0, errors: 0, crashed: 0 },
    memory: { bytes: 0, passes: 0, errors: 0, failedBlocks: 0, crashed: 0 },
    samples: [],
    gpuSensor: false,
    gpuMaxTemp: null,
    boardMaxTemp: null,
    stoppedBy: null,
  };

  // Read before the load starts, so a card with no sensor is told apart from a
  // sensor that has stopped answering.
  const before = options.gpu ? await gpu.sample().catch(() => null) : null;
  raw.gpuSensor = Boolean(before && before.cards && before.cards[0] && typeof before.cards[0].temp === 'number');

  const child = fork(path.join(__dirname, 'stress-host.js'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  child.on('message', (m) => {
    if (m.kind === 'cpu') {
      raw.cpu.rounds += m.rounds || 0;
      raw.cpu.errors += m.errors || 0;
      raw.cpu.crashed += m.crashed || 0;
    } else {
      raw.memory.bytes += m.allocated || 0;
      raw.memory.failedBlocks += m.failed ? 1 : 0;
      raw.memory.passes += m.passes || 0;
      raw.memory.errors += m.errors || 0;
      raw.memory.crashed += m.crashed || 0;
    }
  });
  child.on('error', () => { raw.cpu.crashed += raw.cpu.threads ? 1 : 0; });
  child.send({ threads: raw.cpu.threads, blocks: options.memory ? planMemoryBlocks() : [] });

  return new Promise((resolve) => {
    let finished = false;
    let cpuBusy = false;
    let gpuBusy = false;
    let gpuLastRead = Date.now();
    const latest = { cpuLoad: null, cpuPerformance: null, cpuMhz: null, baseMhz: null, boardTemp: null, gpuName: null, gpuTemp: null, gpuLoad: null, gpuPower: null, gpuFan: null };

    const finish = (stoppedBy) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      raw.stoppedBy = stoppedBy;
      raw.seconds = Math.round((Date.now() - started) / 1000);
      child.kill();
      run = null;
      resolve(raw);
    };
    run = { stop: (why) => finish(why || 'you') };

    // Read separately so a slow answer from one never holds up the other.
    const readCpu = async () => {
      if (cpuBusy) return;
      cpuBusy = true;
      const cpu = await ps.json(SAMPLE_SCRIPT, { timeout: 15000 }).catch(() => null);
      cpuBusy = false;
      if (!cpu || finished) return;
      Object.assign(latest, {
        cpuLoad: cpu.load,
        cpuPerformance: cpu.performance,
        cpuMhz: cpu.baseMhz ? Math.round((cpu.baseMhz * cpu.performance) / 100) : null,
        baseMhz: cpu.baseMhz,
        boardTemp: cpu.board,
      });
      if (cpu.board !== null) raw.boardMaxTemp = Math.max(raw.boardMaxTemp || 0, cpu.board);
      if (cpu.board >= STOP_BOARD_C) finish('board-heat');
    };
    const readGpu = async () => {
      if (gpuBusy || !options.gpu) return;
      gpuBusy = true;
      const cards = await gpu.sample().catch(() => null);
      gpuBusy = false;
      if (finished) return;
      const card = cards && cards.cards && cards.cards[0];
      if (card && typeof card.temp === 'number') {
        gpuLastRead = Date.now();
        Object.assign(latest, {
          gpuName: card.name,
          gpuTemp: card.temp,
          gpuLoad: card.util ? card.util.gpu : null,
          gpuPower: card.power ? card.power.draw : null,
          gpuFan: card.fanPct,
        });
        raw.gpuMaxTemp = Math.max(raw.gpuMaxTemp || 0, card.temp);
        if (card.temp >= STOP_GPU_C) finish('gpu-heat');
      } else if (raw.gpuSensor && Date.now() - gpuLastRead > BLIND_MS) {
        finish('gpu-blind');
      }
    };

    const tick = () => {
      const elapsed = (Date.now() - started) / 1000;
      if (elapsed >= minutes * 60) {
        finish(null);
        return;
      }
      readCpu();
      readGpu();
      const sample = {
        ...latest,
        elapsed: Math.round(elapsed),
        left: Math.max(0, Math.round(minutes * 60 - elapsed)),
        cpuErrors: raw.cpu.errors,
        memoryErrors: raw.memory.errors,
        memoryBytes: raw.memory.bytes,
        memoryPasses: raw.memory.passes,
      };
      raw.samples.push(sample);
      onProgress(sample);
    };
    const timer = setInterval(tick, 2000);
    tick();
  });
}

function stop(why) {
  stopDisk();
  if (run) run.stop(why);
  return true;
}

// --- Disk ---------------------------------------------------------------------

// Bypasses Windows' file cache, which would otherwise report memory speed. The
// file is delete-on-close, so it goes even if BOB is killed halfway through.
const DISK_TYPE = `
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class BobDisk {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern IntPtr CreateFileW(string n, uint a, uint s, IntPtr sa, uint d, uint f, IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr h, IntPtr b, uint n, out uint r, IntPtr o);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(IntPtr h, IntPtr b, uint n, out uint w, IntPtr o);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFilePointerEx(IntPtr h, long p, IntPtr np, uint m);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr VirtualAlloc(IntPtr a, UIntPtr s, uint t, uint p);
  [DllImport("msvcrt.dll", CallingConvention=CallingConvention.Cdecl)] static extern int memcmp(IntPtr a, IntPtr b, UIntPtr n);
  const int BLOCK = 1048576;
  static void Say(string phase, double done, double rate) {
    Console.WriteLine("{\\"phase\\":\\"" + phase + "\\",\\"done\\":" + done.ToString("0.000", System.Globalization.CultureInfo.InvariantCulture) + ",\\"rate\\":" + rate.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) + "}");
  }
  static double Rate(long bytes, Stopwatch w) { return bytes / 1048576.0 / Math.Max(w.Elapsed.TotalSeconds, 0.001); }
  public static string Run(string path, long size) {
    IntPtr h = CreateFileW(path, 0xC0000000, 0, IntPtr.Zero, 1, 0xA4000000, IntPtr.Zero);
    if (h == new IntPtr(-1)) throw new Exception("Could not create the test file (error " + Marshal.GetLastWin32Error() + ").");
    IntPtr io = VirtualAlloc(IntPtr.Zero, new UIntPtr(BLOCK), 0x3000, 4);
    IntPtr pattern = VirtualAlloc(IntPtr.Zero, new UIntPtr(BLOCK), 0x3000, 4);
    byte[] seed = new byte[BLOCK];
    new Random(20240611).NextBytes(seed);
    Marshal.Copy(seed, 0, pattern, BLOCK);
    long blocks = size / BLOCK;
    uint n;
    long errors = 0;
    try {
      Stopwatch w = Stopwatch.StartNew();
      double next = 0;
      Marshal.Copy(seed, 0, io, BLOCK);
      for (long i = 0; i < blocks; i++) {
        Marshal.WriteInt64(io, i);
        if (!WriteFile(h, io, BLOCK, out n, IntPtr.Zero) || n != BLOCK) throw new Exception("Writing failed at " + i + " MB (error " + Marshal.GetLastWin32Error() + ").");
        if (w.Elapsed.TotalSeconds > next) { Say("write", (double)i / blocks, Rate(i * BLOCK, w)); next = w.Elapsed.TotalSeconds + 0.5; }
      }
      w.Stop();
      double write = Rate(blocks * BLOCK, w);

      if (!SetFilePointerEx(h, 0, IntPtr.Zero, 0)) throw new Exception("Seek failed.");
      w = Stopwatch.StartNew();
      next = 0;
      for (long i = 0; i < blocks; i++) {
        if (!ReadFile(h, io, BLOCK, out n, IntPtr.Zero) || n != BLOCK) { errors++; continue; }
        if (Marshal.ReadInt64(io) != i || memcmp(new IntPtr(io.ToInt64() + 8), new IntPtr(pattern.ToInt64() + 8), new UIntPtr(BLOCK - 8)) != 0) errors++;
        if (w.Elapsed.TotalSeconds > next) { Say("read", (double)i / blocks, Rate(i * BLOCK, w)); next = w.Elapsed.TotalSeconds + 0.5; }
      }
      w.Stop();
      double read = Rate(blocks * BLOCK, w);

      Random r = new Random(7);
      long ops = 0;
      long spots = size / 4096;
      w = Stopwatch.StartNew();
      next = 0;
      while (w.Elapsed.TotalSeconds < 8) {
        long at = (long)(r.NextDouble() * spots) * 4096;
        SetFilePointerEx(h, at, IntPtr.Zero, 0);
        if (!ReadFile(h, io, 4096, out n, IntPtr.Zero) || n != 4096) errors++;
        ops++;
        if (w.Elapsed.TotalSeconds > next) { Say("random", w.Elapsed.TotalSeconds / 8, ops / Math.Max(w.Elapsed.TotalSeconds, 0.001)); next = w.Elapsed.TotalSeconds + 0.5; }
      }
      double iops = ops / w.Elapsed.TotalSeconds;
      return "{\\"write\\":" + write.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) + ",\\"read\\":" + read.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) + ",\\"iops\\":" + iops.ToString("0", System.Globalization.CultureInfo.InvariantCulture) + ",\\"errors\\":" + errors + "}";
    } finally {
      CloseHandle(h);
    }
  }
}
`;

let diskChild = null;

function diskScript(file, size) {
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
${DISK_TYPE}
'@
try {
  Write-Output ('RESULT ' + [BobDisk]::Run('${file.replace(/'/g, "''")}', ${size}))
} catch {
  Write-Output ('FAILED ' + $_.Exception.InnerException.Message)
}
`;
}

/** Tests one drive by letter. Only a letter from drives() is accepted. */
async function disk(letter, onProgress, sizeOverride) {
  const list = await drives();
  const drive = list.find((d) => d.letter === letter);
  if (!drive) throw new Error('That drive is not available.');
  const size = sizeOverride || DISK_TEST_BYTES;
  if (drive.free < size * 2) throw new Error(`${letter}: needs ${Math.round((size * 2) / 1073741824)} GB free for this test.`);
  const file = `${letter}:\\BOB-disktest-${process.pid}.tmp`;
  const script = diskScript(file, size);
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
    diskChild = child;
    let tail = '';
    let result = null;
    let failure = null;
    let errText = '';
    child.stdout.on('data', (chunk) => {
      const lines = (tail + chunk.toString('utf8')).split(/\r?\n/);
      tail = lines.pop();
      for (const line of lines) {
        if (line.startsWith('RESULT ')) result = JSON.parse(line.slice(7));
        else if (line.startsWith('FAILED ')) failure = line.slice(7);
        else if (line.startsWith('{')) {
          try {
            onProgress({ letter, ...JSON.parse(line) });
          } catch {
            /* half a line */
          }
        }
      }
    });
    child.stderr.on('data', (chunk) => { errText += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', () => {
      diskChild = null;
      if (result) resolve({ letter, media: drive.media, bus: drive.bus, model: drive.model, ...result });
      else if (failure) reject(new Error(failure));
      else reject(new Error(errText.trim() ? 'The disk test could not run.' : 'The disk test was stopped.'));
    });
  });
}

function stopDisk() {
  if (diskChild) diskChild.kill();
}

// --- Verdict ------------------------------------------------------------------

function diskVerdict(d) {
  const isSsd = /ssd/i.test(d.media);
  const isHdd = /hdd/i.test(d.media);
  const nvme = /nvme/i.test(d.bus);
  const usb = /usb/i.test(d.bus);
  const speeds = `Write ${Math.round(d.write)} MB/s, read ${Math.round(d.read)} MB/s, ${Number(d.iops).toLocaleString()} small reads a second.`;
  if (d.errors > 0) return { level: 'fail', detail: `${d.errors} read${d.errors === 1 ? '' : 's'} came back wrong or failed. Back up this drive and replace it. ${speeds}` };
  let slow = false;
  if (!usb && isSsd && nvme) slow = d.read < 500 || d.write < 150;
  else if (!usb && isSsd) slow = d.read < 200 || d.write < 80;
  else if (!usb && isHdd) slow = d.read < 40 || d.write < 30;
  if (slow) return { level: 'warn', detail: `No errors, but slow for this kind of drive. ${speeds}` };
  return { level: 'pass', detail: `No errors. ${speeds}` };
}

async function verdict({ raw, diskResult, diskError, gl }) {
  const lines = [];
  const add = (name, level, detail) => lines.push({ name, level, detail });
  const events = raw
    ? await ps.json(EVENTS_SCRIPT(raw.since), { timeout: 30000 }).catch(() => null)
    : null;
  const early = Boolean(raw && raw.stoppedBy === 'you');
  const ranFor = raw ? raw.samples.slice(Math.floor(raw.samples.length / 2)) : [];

  if (raw && raw.wanted.cpu) {
    const perf = median(ranFor.map((s) => s.cpuPerformance).filter((v) => v !== null));
    const load2 = median(ranFor.map((s) => s.cpuLoad).filter((v) => v !== null));
    const base = (raw.samples.find((s) => s.baseMhz) || {}).baseMhz || null;
    const speedText = perf !== null && base ? ` Ran at ${((base * perf) / 100000).toFixed(2)} GHz (rated ${(base / 1000).toFixed(2)} GHz).` : '';
    if (raw.cpu.errors > 0) add('Processor', 'fail', `${raw.cpu.errors} wrong answer${raw.cpu.errors === 1 ? '' : 's'} on known sums. An unstable overclock, too little voltage, or a failing processor.${speedText}`);
    else if (raw.cpu.crashed > 0) add('Processor', 'fail', `${raw.cpu.crashed} test thread${raw.cpu.crashed === 1 ? '' : 's'} crashed.${speedText}`);
    else if (perf !== null && perf < 85) add('Processor', 'warn', `No errors, but it slowed to ${Math.round(perf)}% of its rated speed under load. That usually means overheating, so check the cooler and thermal paste.${speedText}`);
    else add('Processor', 'pass', `No errors across ${raw.cpu.threads} threads, ${raw.cpu.rounds.toLocaleString()} rounds.${speedText}${load2 !== null && load2 < 80 ? ` Load only reached ${Math.round(load2)}%.` : ''}`);
  }

  if (raw && raw.wanted.memory) {
    const gb = (raw.memory.bytes / 1073741824).toFixed(1);
    if (raw.memory.errors > 0) add('Memory', 'fail', `${raw.memory.errors.toLocaleString()} errors in ${gb} GB. Test one stick at a time to find the bad one.`);
    else if (!raw.memory.bytes) add('Memory', 'warn', 'Not tested: there was too little free memory to use. Close some programs and run it again.');
    else if (!raw.memory.passes) add('Memory', 'warn', `${gb} GB was allocated but no pass finished in the time. Run a longer test.`);
    else add('Memory', 'pass', `No errors in ${gb} GB, ${raw.memory.passes} passes. Windows' Memory Diagnostic in the Toolbox tests more of it, because it runs before Windows loads.`);
  }

  if (raw && raw.wanted.gpu) {
    const name = gl && gl.renderer ? gl.renderer : 'Graphics card';
    const load3 = median(ranFor.map((s) => s.gpuLoad).filter((v) => v !== null && v !== undefined));
    const heat = raw.gpuMaxTemp !== null ? ` Peak ${raw.gpuMaxTemp} °C.` : ' BOB can only read temperatures on NVIDIA cards, so feel this one for heat or watch it in another tool.';
    const loadText = load3 !== null ? ` Load ${Math.round(load3)}%.` : '';
    if (raw.stoppedBy === 'gpu-blind') add('Graphics', 'fail', `BOB lost the card's temperature reading for 30 seconds, so it stopped the test to be safe. The driver may have crashed.${heat}`);
    else if (raw.stoppedBy === 'gpu-heat') add('Graphics', 'fail', `Reached ${raw.gpuMaxTemp} °C, so BOB stopped the test. Check the fans and clean the cooler.`);
    else if (!gl || gl.skipped) add('Graphics', 'skip', (gl && gl.skipped) || 'Did not run.');
    else if (gl.lost) add('Graphics', 'fail', `The graphics driver crashed under load after ${gl.seconds} seconds. A failing card, not enough power, or a bad driver.${heat}`);
    else if (events && events.display > 0) add('Graphics', 'fail', `Windows logged ${events.display} display driver reset${events.display === 1 ? '' : 's'} during the test.${heat}`);
    else if (gl.imageErrors > 0) add('Graphics', 'warn', `The same picture came out different ${gl.imageErrors} time${gl.imageErrors === 1 ? '' : 's'} out of ${gl.imageChecks}, which can mean graphics memory trouble.${heat}${loadText}`);
    else if (raw.gpuMaxTemp !== null && raw.gpuMaxTemp >= 85) add('Graphics', 'warn', `No errors, but hot.${heat} Check the fans and clean the cooler.${loadText}`);
    else if (load3 !== null && load3 < 60) add('Graphics', 'warn', `No errors, but the card only reached ${Math.round(load3)}% load, so this was a light test.${heat}`);
    else add('Graphics', 'pass', `No errors, ${gl.imageChecks} picture checks matched.${heat}${loadText}`);
  }

  if (diskError) add(diskError.letter ? `Disk ${diskError.letter}:` : 'Disk', 'fail', diskError.message);
  if (diskResult) {
    const v = diskVerdict(diskResult);
    add(`Disk ${diskResult.letter}:`, v.level, v.detail);
    if (events && events.disk > 0 && v.level !== 'fail') add('Disk log', 'warn', `Windows logged ${events.disk} disk or file system warning${events.disk === 1 ? '' : 's'} during the test. Look in the Event log.`);
  }

  if (raw && raw.stoppedBy === 'board-heat') add('Temperature', 'fail', `The motherboard sensor reached ${raw.boardMaxTemp} °C, so BOB stopped the test. Check the cooling.`);
  if (events && events.whea > 0) add('Hardware errors', 'fail', `Windows logged ${events.whea} hardware error${events.whea === 1 ? '' : 's'} (WHEA) during the test, even if nothing above failed. Often processor, memory or an overclock.`);
  if (events === null && raw) add('Hardware errors', 'skip', 'Could not read the Windows error log.');
  else if (raw && !(events.whea > 0)) add('Hardware errors', 'pass', 'Windows logged none during the test.');

  const worst = lines.some((l) => l.level === 'fail') ? 'fail' : lines.some((l) => l.level === 'warn') ? 'warn' : 'pass';
  return { lines, overall: worst, early, stoppedBy: raw ? raw.stoppedBy : null, seconds: raw ? raw.seconds : 0, minutes: raw ? raw.minutes : 0 };
}

module.exports = { drives, load, disk, stop, verdict, stopDisk, STOP_GPU_C, __internals: { planMemoryBlocks, diskVerdict } };
