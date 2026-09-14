'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, shell } = require('electron');

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

// Set before anything reads app.getPath('userData'), so restore points land in
// "PC Cleanup" rather than the default "Electron" folder when run from source.
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

app.on('will-quit', () => ps.dispose());

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => app.quit());
