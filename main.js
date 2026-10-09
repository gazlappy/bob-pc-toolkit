'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain, shell, clipboard, dialog } = require('electron');

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

// Kept as "PC Cleanup" (the app's original name) on purpose: app.getPath's
// userData folder — where restore points live — derives from this, so keeping it
// stable across the rename to "BOB" preserves every existing backup and
// quarantined file. It is an internal AppData folder the user never sees.
app.setName('PC Cleanup');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0e1116',
    icon: (() => {
      const p = path.join(__dirname, 'build', 'icon.ico');
      return fs.existsSync(p) ? p : undefined;
    })(),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0e1116', symbolColor: '#8b95a5', height: 44 },
    webPreferences: {
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
  win.once('ready-to-show', () => win.show());
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
  const html = report.buildHtml(report.latest() || (await report.gather()));
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
  const html = report.buildHtml(report.latest() || (await report.gather()));
  const file = path.join(os.tmpdir(), `bob-report-${Date.now()}.html`);
  fs.writeFileSync(file, html, 'utf8');
  await shell.openPath(file);
  return { path: file };
});
handle('tweaks:galleryStatus', () => tweaks.galleryStatus());
handle('tweaks:setGalleryHidden', (hidden) => tweaks.setGalleryHidden(hidden));
handle('tweaks:restartExplorer', () => tweaks.restartExplorer());
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
handle('startup:tasks', () => startup.tasks());
handle('startup:setEnabled', (id, enabled) => startup.setEnabled(id, enabled));
handle('startup:remove', (id) => startup.remove(id));
handle('startup:reveal', (id) => startup.reveal(id));
handle('task:setEnabled', (taskPath, name, enabled) => startup.setTaskEnabled(taskPath, name, enabled));

handle('clean:scan', () => clean.scan(progress('clean:progress')));
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
  createWindow();
  // Pay PowerShell's ~1.4s cold start now, while the window is still painting,
  // rather than on the user's first click.
  ps.warmUp();
});

app.on('will-quit', () => {
  network.stopAll();
  repair.stopAll();
  ps.dispose();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => app.quit());
