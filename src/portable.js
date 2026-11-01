'use strict';

// Tech USB mode: BOB keeps its settings in a BOB-data folder next to BOB.exe, so
// a customer's PC is left with nothing of BOB's on it. Requires nothing from the
// rest of BOB, because main.js has to call apply() before any other module works
// out where its data lives.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKER = 'usb-mode.on';
const RECENT_MS = 10 * 60 * 1000;

function exeDir() {
  return process.env.PORTABLE_EXECUTABLE_DIR || null;
}

function dataDir() {
  const dir = exeDir();
  return dir ? path.join(dir, 'BOB-data') : null;
}

function active() {
  const dir = dataDir();
  if (!dir) return false;
  try {
    return fs.statSync(path.join(dir, MARKER)).isFile();
  } catch {
    return false;
  }
}

function apply(app) {
  if (!active()) return false;
  const dir = dataDir();
  app.setPath('userData', dir);
  app.setPath('sessionData', path.join(dir, 'session'));
  app.setPath('crashDumps', path.join(dir, 'crashes'));
  return true;
}

// Restore points and the Tune-up undo list describe one PC. On a stick that goes
// from PC to PC they have to stay apart, or one PC's registry could be put back
// onto another.
function machineDir() {
  return path.join(dataDir(), 'machines', os.hostname().replace(/[^\w.-]/g, '_'));
}

function folderSize(target) {
  let bytes = 0;
  const pending = [target];
  while (pending.length) {
    const dir = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(full);
      else {
        try {
          bytes += fs.lstatSync(full).size;
        } catch {
          /* gone */
        }
      }
    }
  }
  return bytes;
}

/**
 * Copies a force-killed BOB left behind. BOB.exe unpacks itself to the temp folder
 * each time it opens, and only tidies up on a clean exit. Temp is shared with every
 * other NSIS installer, so a folder only counts if BOB is really inside it.
 */
function leftoverCopies() {
  const temp = os.tmpdir();
  const running = path.resolve(process.execPath).toLowerCase();
  let names = [];
  try {
    names = fs.readdirSync(temp);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!/^ns[a-z0-9]{1,8}\.tmp$/i.test(name)) continue;
    const dir = path.join(temp, name);
    const exe = path.join(dir, '7z-out', 'BOB.exe');
    if (running.startsWith(`${dir.toLowerCase()}\\`)) continue;
    if (fs.existsSync(exe) && fs.existsSync(path.join(dir, '7z-out', 'resources', 'app.asar'))) out.push(dir);
  }
  return out;
}

// Renaming fails if anything inside is open, which is how a copy that is still
// running gets left alone.
function removeLeftovers(dirs = leftoverCopies()) {
  let removed = 0;
  let bytes = 0;
  for (const dir of dirs) {
    const size = folderSize(dir);
    const aside = `${dir}.remove`;
    try {
      fs.renameSync(dir, aside);
      fs.rmSync(aside, { recursive: true, force: true, maxRetries: 2 });
      removed += 1;
      bytes += size;
    } catch {
      /* still in use */
    }
  }
  return { removed, bytes };
}

function tempFiles() {
  const temp = os.tmpdir();
  let names = [];
  try {
    names = fs.readdirSync(temp);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^bob-(update(-\d+\.ps1|\.log)|report-\d+\.html|battery-\d+\.xml)$/.test(n))
    .map((n) => path.join(temp, n));
}

// A file this new may belong to an update that is about to run.
function removeTempFiles() {
  for (const file of tempFiles()) {
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > RECENT_MS) fs.rmSync(file, { force: true });
    } catch {
      /* in use */
    }
  }
}

function localFolders(app) {
  const roaming = app.getPath('appData');
  return [path.join(roaming, 'pc-cleanup'), path.join(roaming, 'PC Cleanup')];
}

function status(app) {
  const copies = leftoverCopies();
  const folders = active() ? localFolders(app).filter((f) => fs.existsSync(f)) : [];
  const quarantine = path.join(process.env.LOCALAPPDATA || '', 'PC Cleanup', 'quarantine');
  return {
    available: Boolean(exeDir()),
    active: active(),
    location: exeDir(),
    leftovers: { count: copies.length, bytes: copies.reduce((sum, dir) => sum + folderSize(dir), 0) },
    local: { folders, bytes: folders.reduce((sum, f) => sum + folderSize(f), 0) },
    quarantineBytes: folderSize(quarantine),
  };
}

function enable(settingsFile) {
  const dir = dataDir();
  if (!dir) throw new Error('This only works when running BOB.exe.');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'settings.json');
    if (!fs.existsSync(target)) {
      let current = {};
      try {
        current = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      } catch {
        /* nothing to carry over */
      }
      // Choices come along; this PC's undo list stays with this PC.
      const { prefs, updateSource } = current;
      fs.writeFileSync(target, JSON.stringify({ prefs, updateSource }, null, 2));
    }
    fs.writeFileSync(path.join(dir, MARKER), 'BOB keeps its settings in this folder while this file exists.\r\n');
  } catch (error) {
    throw new Error(`BOB could not write next to BOB.exe (${error.code || error.message}). Is the drive read-only?`);
  }
  return true;
}

function disable() {
  const dir = dataDir();
  if (dir) fs.rmSync(path.join(dir, MARKER), { force: true });
  return true;
}

// Only ever while running from the stick, so it can't remove what BOB is using.
function removeLocal(app) {
  if (!active()) throw new Error('This only works in Tech USB mode.');
  let bytes = 0;
  for (const folder of localFolders(app)) {
    if (!fs.existsSync(folder)) continue;
    bytes += folderSize(folder);
    fs.rmSync(folder, { recursive: true, force: true, maxRetries: 2 });
  }
  return { bytes };
}

module.exports = { apply, active, dataDir, machineDir, status, enable, disable, removeLeftovers, removeTempFiles, removeLocal, leftoverCopies };
