'use strict';

// Before a reinstall kit: gets everything a wipe would lose onto another drive,
// in one folder. Files go through robocopy, which ships with every Windows, and
// are then compared against the originals, so the tech can tell the customer it
// is safe to wipe rather than hope. Nothing on this PC is changed.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ps = require('./ps');
const keys = require('./keys');
const wifi = require('./wifi');
const programs = require('./programs');
const apps = require('./apps');
const driverexport = require('./driverexport');

const FOLDERS = ['Documents', 'Desktop', 'Pictures', 'Downloads', 'Music', 'Videos'];
const SKIP_PROFILES = new Set(['public', 'default', 'default user', 'all users', 'defaultapppool', 'wdagutilityaccount']);

const BOOKMARKS = [
  { browser: 'Chrome', root: ['AppData', 'Local', 'Google', 'Chrome', 'User Data'] },
  { browser: 'Edge', root: ['AppData', 'Local', 'Microsoft', 'Edge', 'User Data'] },
  { browser: 'Brave', root: ['AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'User Data'] },
];

function usersRoot() {
  return path.dirname(os.homedir());
}

function exists(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function listDirs(target) {
  try {
    return fs.readdirSync(target, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * A profile's folders can live in OneDrive instead. Windows records where only
 * for the signed-in user, so everyone else's are looked for in both places.
 */
function foldersFor(profile) {
  const out = [];
  const seen = new Set();
  const add = (name, source) => {
    const key = source.toLowerCase();
    if (!exists(source) || seen.has(key)) return;
    seen.add(key);
    out.push({ name, source, cloud: /[\\/]onedrive[^\\/]*[\\/]/i.test(source) });
  };
  if (profile.current) {
    const { app } = require('electron');
    const known = { Documents: 'documents', Desktop: 'desktop', Pictures: 'pictures', Downloads: 'downloads', Music: 'music', Videos: 'videos' };
    for (const name of FOLDERS) add(name, app.getPath(known[name]));
  }
  for (const name of FOLDERS) add(name, path.join(profile.path, name));
  for (const dir of listDirs(profile.path).filter((d) => /^onedrive/i.test(d))) {
    for (const name of FOLDERS) add(name, path.join(profile.path, dir, name));
  }
  return out;
}

let planned = new Map();

function plan() {
  const current = path.basename(os.homedir()).toLowerCase();
  const root = usersRoot();
  const profiles = listDirs(root)
    .filter((name) => !SKIP_PROFILES.has(name.toLowerCase()) && exists(path.join(root, name, 'AppData')))
    .map((name) => ({ name, path: path.join(root, name), current: name.toLowerCase() === current }))
    .sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name));

  planned = new Map();
  const items = [];
  for (const profile of profiles) {
    for (const folder of foldersFor(profile)) {
      const id = `${profile.name}|${folder.source}`;
      planned.set(id, { ...folder, user: profile.name });
      items.push({ id, user: profile.name, name: folder.name, source: folder.source, cloud: folder.cloud });
    }
  }
  return { computer: os.hostname(), users: profiles.map((p) => ({ name: p.name, current: p.current })), folders: items };
}

// Counts sizes the way robocopy will copy: no following junctions.
async function measure(id) {
  const folder = planned.get(id);
  if (!folder) throw new Error('That folder is not in the plan.');
  let bytes = 0;
  let count = 0;
  const pending = [folder.source];
  while (pending.length) {
    const dir = pending.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isFile()) {
        try {
          bytes += (await fs.promises.lstat(full)).size;
          count += 1;
        } catch {
          /* gone or locked: robocopy will report it */
        }
      }
    }
  }
  return { bytes, count };
}

const VOLUME_SCRIPT = (root) => `
${ps.payload({ root })}
$d = Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='" + $Payload.root + "'")
[pscustomobject]@{ type = [int]$d.DriveType; fs = [string]$d.FileSystem; free = [double]$d.FreeSpace; size = [double]$d.Size; label = [string]$d.VolumeName } | ConvertTo-Json -Compress
`;

/**
 * Checks a chosen drive before anything is copied. A kit saved on the drive
 * Windows is on would be wiped by the very reinstall it exists for.
 */
async function checkDestination(destination) {
  const root = path.parse(path.resolve(destination)).root.replace(/[\\/]+$/, '');
  const unc = root.startsWith('\\');
  const info = unc ? null : await ps.json(VOLUME_SCRIPT(root), { timeout: 20000 }).catch(() => null);
  const windowsDrive = (process.env.SystemDrive || 'C:').toLowerCase();
  return {
    destination,
    drive: root,
    onWindowsDrive: root.toLowerCase() === windowsDrive,
    free: info ? info.free : null,
    size: info ? info.size : null,
    label: info ? info.label : '',
    fileSystem: info ? info.fs : '',
    fat32: Boolean(info && /^fat(32)?$/i.test(info.fs)),
  };
}

let stopping = false;
let currentCopy = null;

// /FFT and /DST stop a USB drive's coarser clock making every file look changed.
const COPY_ARGS = ['/E', '/COPY:DAT', '/DCOPY:T', '/XJ', '/FFT', '/DST', '/R:1', '/W:1', '/NP', '/NDL', '/NJH', '/NJS', '/FP', '/BYTES'];

/** Copies one folder, reporting bytes as files land. robocopy exit codes of 8+ mean some failed. */
function robocopy(source, target, onBytes, listOnly = false) {
  return new Promise((resolve, reject) => {
    const args = [source, target, ...COPY_ARGS, ...(listOnly ? ['/L'] : [])];
    const child = spawn('robocopy.exe', args, { windowsHide: true });
    if (!listOnly) currentCopy = child;
    const errors = [];
    const files = [];
    let tail = '';
    child.stdout.on('data', (chunk) => {
      const lines = (tail + chunk.toString('latin1')).split(/\r?\n/);
      tail = lines.pop();
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        const file = /(\d+)\s+([A-Za-z]:\\.+|\\\\.+)$/.exec(line);
        if (/\b(ERROR|FOUT|FEHLER|ERREUR)\b\s+\d+/.test(line) && errors.length < 200) errors.push(line);
        else if (file) {
          files.push(file[2]);
          if (onBytes) onBytes(Number(file[1]), file[2]);
        }
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (!listOnly) currentCopy = null;
      resolve({ code: code === null ? 16 : code, errors, files });
    });
  });
}

function safeName(name) {
  return String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'item';
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}

function copyBookmarks(kitDir, users, log) {
  let copied = 0;
  const copy = (source, target, label) => {
    try {
      if (!fs.statSync(source).isFile()) return;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      copied += 1;
    } catch (error) {
      if (error.code !== 'ENOENT') log.push(`${label}: ${error.message}. Close the browser and run this again.`);
    }
  };
  for (const user of users) {
    const home = path.join(usersRoot(), user);
    for (const { browser, root } of BOOKMARKS) {
      const data = path.join(home, ...root);
      for (const profile of listDirs(data).filter((d) => d === 'Default' || /^Profile \d+$/.test(d))) {
        copy(path.join(data, profile, 'Bookmarks'), path.join(kitDir, 'Bookmarks', safeName(user), `${browser} ${profile}`, 'Bookmarks'), `${browser} bookmarks for ${user}`);
      }
    }
    const firefox = path.join(home, 'AppData', 'Roaming', 'Mozilla', 'Firefox', 'Profiles');
    for (const profile of listDirs(firefox)) {
      copy(path.join(firefox, profile, 'places.sqlite'), path.join(kitDir, 'Bookmarks', safeName(user), `Firefox ${profile}`, 'places.sqlite'), `Firefox bookmarks for ${user}`);
    }
  }
  return copied;
}

function keysText(data) {
  const lines = [`Product keys from ${os.hostname()}, saved ${new Date().toLocaleString()}`, ''];
  const w = data.windows || {};
  lines.push(`Windows edition: ${w.edition || 'unknown'}`, `Activation: ${w.status || 'unknown'}${w.channel ? ` (${w.channel})` : ''}`);
  if (w.oemKey) lines.push(`Key in the firmware (${w.oemChannel || 'OEM'}): ${w.oemKey}`);
  if (w.retailKey) lines.push(`Installed key: ${w.retailKey}`);
  if (w.digitalLicence) lines.push('Digital licence: there is no key to save. It reactivates by itself on the same hardware.');
  for (const o of data.office || []) lines.push('', `${o.name}: ${o.status}. Only the last five characters can be read: ${o.partialKey || 'none'}`);
  return lines.join('\r\n');
}

function wifiText(data) {
  const lines = [`Saved Wi-Fi networks from ${os.hostname()}, saved ${new Date().toLocaleString()}`, ''];
  for (const p of data.profiles) lines.push(`${p.name}: ${p.open ? '(open network)' : p.key || '(key could not be read)'}`);
  if (!data.profiles.length) lines.push('None.');
  return lines.join('\r\n');
}

function programsText(rows) {
  const sorted = rows.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return ['Name\tVersion\tPublisher', ...sorted.map((p) => `${p.name}\t${p.version || ''}\t${p.publisher || ''}`)].join('\r\n');
}

const STEP_LABEL = {
  bookmarks: 'Browser bookmarks',
  drivers: 'Drivers',
  keys: 'Product keys',
  wifi: 'Wi-Fi keys',
  programs: 'List of installed programs',
};

/**
 * Builds the kit. `job` holds ids from plan() and step names, plus the destination
 * main.js got from the folder dialog, so the renderer never supplies a path.
 */
async function build(job, onProgress) {
  stopping = false;
  const destination = job.destination;
  const chosen = (job.folders || []).map((id) => [id, planned.get(id)]).filter(([, f]) => f);
  const steps = (job.steps || []).filter((s) => STEP_LABEL[s]);
  const kitDir = path.join(destination, safeName(`BOB kit ${os.hostname()} ${stamp()}`));
  const lowerKit = kitDir.toLowerCase();
  for (const [, f] of chosen) {
    if (lowerKit.startsWith(`${f.source.toLowerCase()}\\`)) throw new Error(`The kit cannot go inside a folder it is copying (${f.source}). Choose another drive.`);
  }
  fs.mkdirSync(kitDir, { recursive: true });

  const totalBytes = job.bytes > 0 ? job.bytes : 0;
  let doneBytes = 0;
  const results = [];

  for (const [, folder] of chosen) {
    if (stopping) break;
    const label = `${folder.user}, ${folder.name}`;
    const target = path.join(kitDir, 'Files', safeName(folder.user), safeName(folder.cloud ? `${folder.name} (OneDrive)` : folder.name));
    onProgress({ label: `Copying ${label}`, doneBytes, totalBytes });
    const copy = await robocopy(folder.source, target, (bytes, file) => {
      doneBytes += bytes;
      onProgress({ label: `Copying ${label}`, file: path.basename(file), doneBytes, totalBytes });
    });
    let missing = [];
    if (!stopping) {
      onProgress({ label: `Checking ${label}`, doneBytes, totalBytes });
      missing = (await robocopy(folder.source, target, null, true)).files;
    }
    results.push({
      kind: 'folder',
      label,
      source: folder.source,
      ok: copy.code < 8 && !copy.errors.length && !missing.length && !stopping,
      failed: copy.errors,
      missing,
      copied: Math.max(0, new Set(copy.files).size - missing.length),
    });
  }

  const step = async (id, work) => {
    if (stopping || !steps.includes(id)) return;
    onProgress({ label: `Saving ${STEP_LABEL[id].toLowerCase()}`, doneBytes, totalBytes });
    try {
      results.push({ kind: 'step', label: STEP_LABEL[id], ok: true, ...(await work()) });
    } catch (error) {
      results.push({ kind: 'step', label: STEP_LABEL[id], ok: false, note: error.message });
    }
  };

  await step('bookmarks', () => {
    const log = [];
    const users = [...new Set([...planned.values()].map((f) => f.user))];
    const count = copyBookmarks(kitDir, users, log);
    if (log.length) return { ok: false, note: log.join(' ') };
    return { note: count ? `${count} browser profile${count === 1 ? '' : 's'}` : 'No browser bookmarks found' };
  });
  await step('keys', async () => {
    fs.writeFileSync(path.join(kitDir, 'Product keys.txt'), keysText(await keys.read()));
    return { note: 'Product keys.txt' };
  });
  await step('wifi', async () => {
    const data = await wifi.list();
    if (!data.supported) return { note: 'This PC has no Wi-Fi' };
    if (data.adminNeeded) return { ok: false, note: 'Reading the keys needs administrator rights' };
    fs.writeFileSync(path.join(kitDir, 'Wi-Fi keys.txt'), wifiText(data));
    return { note: `${data.profiles.length} network${data.profiles.length === 1 ? '' : 's'} in Wi-Fi keys.txt` };
  });
  await step('programs', async () => {
    const rows = await programs.list();
    fs.writeFileSync(path.join(kitDir, 'Installed programs.txt'), programsText(Array.isArray(rows) ? rows : rows.programs || []));
    if (await apps.available()) await apps.exportList(path.join(kitDir, 'winget-apps.json')).catch(() => {});
    return { note: 'Installed programs.txt' };
  });
  await step('drivers', async () => {
    const out = await driverexport.exportAll(path.join(kitDir, 'Drivers'));
    return { note: `${out.exported} drivers` };
  });

  const report = {
    kitDir,
    stopped: stopping,
    results,
    ok: !stopping && results.every((r) => r.ok),
  };
  fs.writeFileSync(path.join(kitDir, 'READ ME.txt'), readme(report));
  return report;
}

function readme(report) {
  const lines = [
    `BOB reinstall kit for ${os.hostname()}, made ${new Date().toLocaleString()}`,
    report.stopped ? 'STOPPED BEFORE IT FINISHED. This kit is not complete.' : (report.ok ? 'Everything copied and checked against the originals.' : 'SOME ITEMS FAILED. See below before wiping this PC.'),
    '',
  ];
  for (const r of report.results) {
    lines.push(`${r.ok ? 'OK    ' : 'FAILED'}  ${r.label}${r.note ? `: ${r.note}` : ''}${r.kind === 'folder' ? ` (${r.copied} file${r.copied === 1 ? '' : 's'})` : ''}`);
    for (const e of r.failed || []) lines.push(`        ${e}`);
    for (const m of (r.missing || []).slice(0, 200)) lines.push(`        Differs from the original: ${m}`);
  }
  lines.push(
    '',
    'To put things back:',
    '  Files: copy each folder under Files back to the user\'s profile.',
    '  Bookmarks: copy the Bookmarks file into the browser\'s profile folder with the browser closed.',
    '  Drivers: Device Manager, Update driver, Browse my computer, then choose the Drivers folder.',
    '  Programs: winget import -i winget-apps.json',
    '',
    'NOT in this kit: saved browser passwords, program settings in AppData, and anything stored outside the folders listed.',
    'Product keys.txt and Wi-Fi keys.txt are plain text. Delete them when the job is done.',
  );
  return lines.join('\r\n');
}

function stop() {
  stopping = true;
  if (currentCopy) currentCopy.kill();
  return true;
}

module.exports = { plan, measure, checkDestination, build, stop, __internals: { foldersFor, safeName, keysText, wifiText, robocopy } };
