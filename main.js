'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain, shell, clipboard, dialog, nativeTheme, powerSaveBlocker } = require('electron');

// Before anything else: every module below works out where its data lives from this.
const portable = require('./src/portable');
portable.apply(app);

const ps = require('./src/ps');
const sys = require('./src/sys');
const startup = require('./src/startup');
const clean = require('./src/clean');
const files = require('./src/files');
const registry = require('./src/registry');
const backup = require('./src/backup');
const treemap = require('./src/treemap');
const duplicates = require('./src/duplicates');
const programs = require('./src/programs');
const system = require('./src/system');
const keys = require('./src/keys');
const network = require('./src/network');
const repair = require('./src/repair');
const speedtest = require('./src/speedtest');
const events = require('./src/events');
const devices = require('./src/devices');
const monitor = require('./src/monitor');
const autoruns = require('./src/autoruns');
const security = require('./src/security');
const battery = require('./src/battery');
const connections = require('./src/connections');
const driverexport = require('./src/driverexport');
const accounts = require('./src/accounts');
const quickcmd = require('./src/quickcmd');
const partition = require('./src/partition');
const wifi = require('./src/wifi');
const ghostdevices = require('./src/ghostdevices');
const report = require('./src/report');
const tweaks = require('./src/tweaks');
const bitlocker = require('./src/bitlocker');
const update = require('./src/update');
const gpu = require('./src/gpu');
const tuneup = require('./src/tuneup');
const settings = require('./src/settings');
const malware = require('./src/malware');
const apps = require('./src/apps');
const kit = require('./src/kit');
const stress = require('./src/stress');
const running = require('./src/running');
const progressReport = require('./src/progress');

// Kept as "PC Cleanup" (the app's original name) on purpose: app.getPath's
// userData folder — where restore points live — derives from this, so keeping it
// stable across the rename to "BOB" preserves every existing backup and
// quarantined file. It is an internal AppData folder the user never sees.
app.setName('PC Cleanup');

let win = null;

// One BOB at a time: launching it again brings the running one to the front
// instead of starting a second copy alongside it.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => revealWindow());

function revealWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Window frame colours for each theme (the page's own colours are in style.css).
const THEME_FRAME = {
  dark: { color: '#0e1116', symbolColor: '#8b95a5' },
  light: { color: '#f4f6f9', symbolColor: '#4f5b6b' },
  black: { color: '#000000', symbolColor: '#98a2b1' },
  slate: { color: '#1f242b', symbolColor: '#a8b2bf' },
  workshop: { color: '#14110d', symbolColor: '#aea391' },
  neon: { color: '#0b0716', symbolColor: '#b4a7d6' },
};

function resolvedTheme() {
  const theme = settings.prefs().theme;
  if (theme === 'system') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  return theme;
}

function applyWindowTheme() {
  if (!win || win.isDestroyed()) return;
  const name = resolvedTheme();
  const frame = THEME_FRAME[name];
  win.setBackgroundColor(frame.color);
  win.setTitleBarOverlay({ ...frame, height: 44 });
  win.webContents.send('theme:changed', name);
}

// "Match Windows" follows the Windows setting while BOB is open.
nativeTheme.on('updated', () => {
  if (settings.prefs().theme === 'system') applyWindowTheme();
});

function createWindow() {
  const startTheme = resolvedTheme();
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: THEME_FRAME[startTheme].color,
    icon: (() => {
      const p = path.join(__dirname, 'build', 'icon.ico');
      return fs.existsSync(p) ? p : undefined;
    })(),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...THEME_FRAME[startTheme], height: 44 },
    webPreferences: {
      additionalArguments: [`--bob-theme=${startTheme}`],
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // The Hardware test bench needs the camera and microphone; grant media to our
  // own local page (and nothing else).
  const allowMedia = (permission) => permission === 'media';
  win.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => cb(allowMedia(permission)));
  win.webContents.session.setPermissionCheckHandler((_wc, permission) => allowMedia(permission));

  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  // Shown on ready-to-show to avoid a blank flash, with two backstops: a timer in
  // case that event never comes, and a second show if the first was swallowed —
  // a BOB relaunched by the self-updater was left running with a hidden window,
  // which then blocked every later launch until it was killed.
  let shown = false;
  const reveal = () => {
    if (shown || !win || win.isDestroyed()) return;
    shown = true;
    win.show();
    setTimeout(() => {
      if (win && !win.isDestroyed() && !win.isVisible()) revealWindow();
    }, 500);
  };
  win.once('ready-to-show', reveal);
  setTimeout(reveal, 4000);
  win.on('closed', () => {
    win = null;
  });

  // Anything that wants a new window opens in the real browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Every handler answers with { ok, data } or { ok, error } so the renderer has
// one shape to deal with and a thrown error never becomes an unhandled reject.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) };
    }
  });
}

function progress(channel) {
  return (payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
}

handle('sys:overview', () => sys.overview());
handle('sys:elevate', () => sys.elevate());
handle('system:info', () => system.info());
handle('keys:read', () => keys.read());

handle('net:info', () => network.info());
handle('net:actions', () => network.actionList());
handle('net:runAction', (id) => network.runAction(id));
handle('net:start', (kind, host) => network.startLive(kind, host, (event) => {
  if (win && !win.isDestroyed()) win.webContents.send('net:line', event);
}));
handle('net:stop', (id) => network.stopLive(id));
handle('net:speedtest', () => speedtest.run(progress('net:speed')));

handle('repair:list', () => repair.list());
handle('repair:start', (id) => repair.start(id, (event) => {
  if (win && !win.isDestroyed()) win.webContents.send('repair:line', event);
}));
handle('repair:stop', (id) => repair.stop(id));

handle('events:read', () => events.read());
handle('devices:list', () => devices.list());
handle('monitor:sample', () => monitor.snapshot());
handle('autoruns:read', () => autoruns.read());
handle('autoruns:extensions', () => autoruns.extensions());
handle('autoruns:setEnabled', (id, enabled) => autoruns.setEnabled(id, enabled));
handle('autoruns:reveal', (id) => autoruns.reveal(id));
handle('security:read', () => security.read());
handle('battery:read', () => battery.read());
handle('connections:read', () => connections.read());
handle('drivers:list', () => driverexport.list());
handle('drivers:export', async () => {
  const win = BrowserWindow.getAllWindows()[0];
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose where to save the driver backup',
    defaultPath: driverexport.suggestedDestination(),
    buttonLabel: 'Save drivers here',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const outcome = await driverexport.exportAll(result.filePaths[0]);
  return { canceled: false, ...outcome };
});
handle('drivers:reveal', (target) => {
  if (target) shell.openPath(target);
  return true;
});
handle('accounts:list', () => accounts.list());
handle('accounts:create', (opts) => accounts.create(opts || {}));
handle('accounts:setPassword', (name, password) => accounts.setPassword(name, password));
handle('accounts:setEnabled', (name, enabled) => accounts.setEnabled(name, enabled));
handle('accounts:setAdmin', (name, isAdmin) => accounts.setAdmin(name, isAdmin));
handle('accounts:remove', (name) => accounts.remove(name));
handle('quickcmd:list', () => quickcmd.list());
handle('quickcmd:run', (id) => quickcmd.run(id));
handle('partition:read', () => partition.read());
handle('partition:setLetter', (disk, part, letter) => partition.setLetter(disk, part, letter));
handle('partition:setLabel', (disk, part, label) => partition.setLabel(disk, part, label));
handle('wifi:list', () => wifi.list());
handle('ghost:list', () => ghostdevices.list());
handle('ghost:remove', (ids) => ghostdevices.remove(ids));
handle('report:gather', () => report.gather());
handle('report:save', async () => {
  const html = report.buildHtml(report.latest() || (await report.gather()), { preparedBy: settings.prefs().reportName });
  const win = BrowserWindow.getAllWindows()[0];
  const stamp = new Date().toISOString().slice(0, 10);
  const result = await dialog.showSaveDialog(win, {
    title: 'Save PC health report',
    defaultPath: path.join(os.homedir(), 'Desktop', `PC Health Report ${stamp}.html`),
    filters: [{ name: 'Web page', extensions: ['html'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  fs.writeFileSync(result.filePath, html, 'utf8');
  return { canceled: false, path: result.filePath };
});
handle('report:open', async () => {
  const html = report.buildHtml(report.latest() || (await report.gather()), { preparedBy: settings.prefs().reportName });
  const file = path.join(os.tmpdir(), `bob-report-${Date.now()}.html`);
  fs.writeFileSync(file, html, 'utf8');
  await shell.openPath(file);
  return { path: file };
});
handle('tweaks:galleryStatus', () => tweaks.galleryStatus());
handle('tweaks:setGalleryHidden', (hidden) => tweaks.setGalleryHidden(hidden));
handle('tweaks:restartExplorer', () => tweaks.restartExplorer());
handle('gpu:status', () => gpu.status());
handle('gpu:sample', () => gpu.sample());
handle('gpu:setPowerLimit', (index, watts) => gpu.setPowerLimit(index, watts));
handle('gpu:resetPowerLimit', (index) => gpu.resetPowerLimit(index));
handle('gpu:setFan', (bus, level) => gpu.setFan(bus, level));
handle('gpu:fanAuto', (bus) => gpu.fanAuto(bus));
gpu.setAlertHandler(progress('gpu:alert'));
handle('gpu:backupVbios', async (index, suggestedName) => {
  const win = BrowserWindow.getAllWindows()[0];
  const safe = String(suggestedName || 'VBIOS').replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').trim() || 'VBIOS';
  const result = await dialog.showSaveDialog(win, {
    title: 'Save a backup of the VBIOS',
    defaultPath: path.join(os.homedir(), 'Desktop', `${safe}.rom`),
    filters: [{ name: 'VBIOS image', extensions: ['rom'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  return gpu.backupVbios(index, result.filePath);
});
handle('gpu:locateNvflash', async () => {
  const win = BrowserWindow.getAllWindows()[0];
  const result = await dialog.showOpenDialog(win, {
    title: 'Locate nvflash',
    properties: ['openFile'],
    filters: [{ name: 'nvflash', extensions: ['exe'] }],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  return gpu.setNvflashPath(result.filePaths[0]);
});
handle('bitlocker:status', () => bitlocker.status());
handle('bitlocker:suspend', (mount) => bitlocker.suspend(mount));
handle('bitlocker:resume', (mount) => bitlocker.resume(mount));
handle('bitlocker:decrypt', (mount) => bitlocker.decrypt(mount));
handle('update:config', () => update.getConfig());
handle('update:setSource', (source) => update.setSource(source));
handle('update:check', () => update.check());
handle('update:apply', () => update.apply(progress('update:progress')));
handle('bitlocker:saveKeys', async () => {
  const s = await bitlocker.status();
  if (s.adminNeeded) throw new Error('BitLocker needs administrator rights. Restart as admin, then try again.');
  const withKeys = s.volumes.filter((v) => v.recoveryKeys && v.recoveryKeys.length);
  if (!withKeys.length) throw new Error('No recovery keys found on this machine.');
  const stamp = new Date().toLocaleString('en-GB');
  const lines = [`BOB — BitLocker recovery keys`, `${os.hostname()} · ${stamp}`, ''];
  for (const v of withKeys) {
    lines.push(`Drive ${v.mount}${v.isOs ? ' (System)' : ''} — ${v.volumeStatus}${v.method ? `, ${v.method}` : ''}`);
    for (const k of v.recoveryKeys) {
      lines.push(`  Identifier : ${k.id}`);
      lines.push(`  Recovery key: ${k.key}`);
    }
    lines.push('');
  }
  lines.push('Keep this somewhere safe — anyone with a recovery key can unlock the drive.');
  const win = BrowserWindow.getAllWindows()[0];
  const result = await dialog.showSaveDialog(win, {
    title: 'Save BitLocker recovery keys',
    defaultPath: path.join(os.homedir(), 'Desktop', `BitLocker recovery keys ${new Date().toISOString().slice(0, 10)}.txt`),
    filters: [{ name: 'Text file', extensions: ['txt'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  fs.writeFileSync(result.filePath, lines.join('\r\n'), 'utf8');
  return { canceled: false, path: result.filePath, count: withKeys.length };
});
handle('sys:copy', (text) => {
  clipboard.writeText(String(text ?? ''));
  return true;
});

handle('startup:list', () => startup.list());
handle('startup:boot', () => startup.bootReport());
handle('results:get', () => progressReport.get());
handle('results:newBefore', () => progressReport.newBefore());
handle('results:saveAfter', () => progressReport.saveAfter());
handle('running:list', () => running.list());
handle('running:end', (key) => running.end(key));
handle('running:reveal', (key) => running.reveal(key));
handle('startup:tasks', () => startup.tasks());
handle('startup:setEnabled', (id, enabled) => startup.setEnabled(id, enabled));
handle('startup:remove', (id) => startup.remove(id));
handle('startup:reveal', (id) => startup.reveal(id));
handle('task:setEnabled', (taskPath, name, enabled) => startup.setTaskEnabled(taskPath, name, enabled));

handle('clean:scan', () => clean.scan(progress('clean:progress')));
// Links shown in BOB (driver downloads and the like) open only if they go to a
// known vendor site over https, or to Windows Update's own settings pages.
const LINK_HOSTS = /(^|\.)(nvidia\.com|amd\.com|intel\.com|asus\.com|msi\.com|gigabyte\.com|asrock\.com|dell\.com|hp\.com|lenovo\.com|acer\.com|microsoft\.com|google\.com)$/i;
handle('sys:openLink', async (url) => {
  const u = String(url || '');
  if (/^(ms-settings:windowsupdate(-optionalupdates)?|windowsdefender:)$/i.test(u)) return shell.openExternal(u);
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    throw new Error('That link is not valid.');
  }
  if (parsed.protocol !== 'https:' || !LINK_HOSTS.test(parsed.hostname)) throw new Error('BOB only opens links to known driver and support sites.');
  return shell.openExternal(parsed.href);
});
function settingsView() {
  return { prefs: settings.prefs(), theme: resolvedTheme(), systemTheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light', nvflash: gpu.findNvflash(), version: update.getConfig().current };
}
gpu.setWatchdogTemp(settings.prefs().fanWatchdogTemp);
handle('usb:status', () => portable.status(app));
handle('usb:enable', () => portable.enable(settings.SETTINGS_FILE));
handle('usb:disable', () => portable.disable());
handle('usb:removeLeftovers', () => portable.removeLeftovers());
handle('usb:removeLocal', () => portable.removeLocal(app));
handle('stress:drives', () => stress.drives());
handle('stress:disk', (letter) => stress.disk(letter, progress('stress:disk')));
handle('stress:load', async (options) => {
  const awake = powerSaveBlocker.start('prevent-display-sleep');
  try {
    return await stress.load(options, progress('stress:progress'));
  } finally {
    powerSaveBlocker.stop(awake);
  }
});
handle('stress:stop', () => stress.stop('you'));
handle('stress:verdict', (parts) => stress.verdict(parts));
let kitDestination = null;
let lastKit = null;
handle('kit:plan', () => kit.plan());
handle('kit:measure', (id) => kit.measure(id));
handle('kit:choose', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose where to save the kit',
    buttonLabel: 'Save the kit here',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const check = await kit.checkDestination(result.filePaths[0]);
  kitDestination = check.onWindowsDrive ? null : check.destination;
  return check;
});
handle('kit:build', async (job) => {
  if (!kitDestination) throw new Error('Choose where to save the kit first.');
  const report = await kit.build({ ...job, destination: kitDestination }, progress('kit:progress'));
  lastKit = report.kitDir;
  return report;
});
handle('kit:stop', () => kit.stop());
handle('kit:reveal', () => {
  if (lastKit) shell.openPath(lastKit);
  return true;
});
handle('apps:upgrades', () => apps.upgrades());
handle('apps:catalogue', () => apps.catalogue());
handle('apps:upgrade', (items) => apps.upgrade(items, progress('apps:progress')));
handle('apps:install', (ids) => apps.install(ids, progress('apps:progress')));
handle('apps:browse', (options) => apps.browse(options));
handle('apps:details', (id) => apps.details(id));
handle('apps:stop', () => apps.stop());
handle('apps:repair', () => apps.repairWinget());
handle('malware:read', () => malware.read());
handle('malware:scan', (kind) => malware.scan(kind, progress('malware:progress')));
handle('malware:stop', () => malware.stopScan());
handle('settings:get', () => settingsView());
handle('settings:set', (key, value) => {
  settings.setPref(key, value);
  if (key === 'fanWatchdogTemp') gpu.setWatchdogTemp(settings.prefs().fanWatchdogTemp);
  if (key === 'theme') applyWindowTheme();
  return settingsView();
});
handle('settings:reset', () => {
  settings.resetPrefs();
  gpu.setWatchdogTemp(settings.prefs().fanWatchdogTemp);
  applyWindowTheme();
  return settingsView();
});
handle('gpu:forgetNvflash', () => gpu.forgetNvflash());
handle('tuneup:scan', () => tuneup.scan(progress('tuneup:progress')));
handle('tuneup:apply', (ids) => tuneup.apply(Array.isArray(ids) ? ids : [], progress('tuneup:progress')));
handle('tuneup:undo', (key) => tuneup.undo(key));
handle('tuneup:undoAll', () => tuneup.undoAll());
handle('tuneup:changes', () => tuneup.changes());
handle('clean:run', (ids) => clean.clean(Array.isArray(ids) ? ids : [], progress('clean:progress')));

handle('files:roots', () => files.availableRoots());
handle('files:scan', (options) => files.scan(options || {}, progress('files:progress')));
handle('files:trash', (paths) => files.trash(Array.isArray(paths) ? paths : []));
handle('files:reveal', (target) => files.reveal(target));

handle('map:scan', (options) => treemap.scan(options || {}, progress('map:progress')));
handle('map:node', (target) => ({ node: treemap.node(target), trail: treemap.trail(target) }));

handle('dupes:scan', (options) => duplicates.scan(options || {}, progress('dupes:progress')));
handle('dupes:trash', (paths) => duplicates.trash(Array.isArray(paths) ? paths : []));

handle('programs:list', () => programs.list());
handle('programs:measure', (id) => programs.measure(id));
handle('programs:uninstall', (id) => programs.uninstall(id));
handle('programs:reveal', (id) => programs.reveal(id));
handle('programs:forcePlan', (id) => programs.forcePlan(id));
handle('programs:forceRemove', (id) => programs.forceRemove(id));

handle('registry:scan', () => registry.scan(progress('registry:progress')));
handle('registry:clean', (ids) => registry.clean(Array.isArray(ids) ? ids : []));

handle('backup:list', () => backup.list());
handle('backup:restore', (id) => backup.restore(id));
handle('backup:remove', (id) => backup.remove(id));
handle('backup:reveal', (id) => backup.reveal(id));

app.whenReady().then(() => {
  if (!gotLock) return;
  createWindow();
  // Pay PowerShell's ~1.4s cold start now, while the window is still painting,
  // rather than on the user's first click.
  ps.warmUp();
  // The Before readings have to exist before anyone changes anything on this PC.
  setTimeout(() => progressReport.ensureBefore().catch(() => {}), 8000);
});

// A card left on a fixed fan speed with BOB gone has nobody watching its
// temperature, so hand every manual fan back to the driver before quitting.
let gpuReleased = false;
app.on('will-quit', (event) => {
  if (!gpuReleased && gpu.hasManual()) {
    event.preventDefault();
    gpuReleased = true;
    gpu.restoreAll().finally(() => app.quit());
    return;
  }
  network.stopAll();
  repair.stopAll();
  malware.stopScan();
  apps.kill();
  kit.stop();
  stress.stop('you');
  if (portable.active()) portable.removeTempFiles();
  ps.dispose();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => app.quit());
