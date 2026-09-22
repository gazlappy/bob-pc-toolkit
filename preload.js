'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Unwraps the { ok, data | error } envelope from main so callers can just await
// a value and catch a normal Error.
async function call(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result || result.ok !== true) {
    throw new Error((result && result.error) || 'Something went wrong.');
  }
  return result.data;
}

contextBridge.exposeInMainWorld('pc', {
  overview: () => call('sys:overview'),
  elevate: () => call('sys:elevate'),
  system: () => call('system:info'),
  keys: () => call('keys:read'),
  copyText: (text) => call('sys:copy', text),

  net: {
    info: () => call('net:info'),
    actions: () => call('net:actions'),
    runAction: (id) => call('net:runAction', id),
    start: (kind, host) => call('net:start', kind, host),
    stop: (id) => call('net:stop', id),
    speedtest: () => call('net:speedtest'),
    onSpeed: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('net:speed', listener);
      return () => ipcRenderer.removeListener('net:speed', listener);
    },
    onLine: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('net:line', listener);
      return () => ipcRenderer.removeListener('net:line', listener);
    },
  },

  events: () => call('events:read'),
  devices: () => call('devices:list'),
  monitor: () => call('monitor:sample'),

  autoruns: {
    read: () => call('autoruns:read'),
    extensions: () => call('autoruns:extensions'),
    setEnabled: (id, enabled) => call('autoruns:setEnabled', id, enabled),
    reveal: (id) => call('autoruns:reveal', id),
  },

  security: () => call('security:read'),
  battery: () => call('battery:read'),

  repair: {
    list: () => call('repair:list'),
    start: (id) => call('repair:start', id),
    stop: (id) => call('repair:stop', id),
    onLine: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('repair:line', listener);
      return () => ipcRenderer.removeListener('repair:line', listener);
    },
  },

  startup: {
    list: () => call('startup:list'),
    tasks: () => call('startup:tasks'),
    setEnabled: (id, enabled) => call('startup:setEnabled', id, enabled),
    remove: (id) => call('startup:remove', id),
    reveal: (id) => call('startup:reveal', id),
    setTaskEnabled: (taskPath, name, enabled) => call('task:setEnabled', taskPath, name, enabled),
  },

  map: {
    scan: (options) => call('map:scan', options),
    node: (target) => call('map:node', target),
    onProgress: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('map:progress', listener);
      return () => ipcRenderer.removeListener('map:progress', listener);
    },
  },

  dupes: {
    scan: (options) => call('dupes:scan', options),
    trash: (paths) => call('dupes:trash', paths),
    onProgress: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('dupes:progress', listener);
      return () => ipcRenderer.removeListener('dupes:progress', listener);
    },
  },

  programs: {
    list: () => call('programs:list'),
    measure: (id) => call('programs:measure', id),
    uninstall: (id) => call('programs:uninstall', id),
    reveal: (id) => call('programs:reveal', id),
    forcePlan: (id) => call('programs:forcePlan', id),
    forceRemove: (id) => call('programs:forceRemove', id),
  },

  registry: {
    scan: () => call('registry:scan'),
    clean: (ids) => call('registry:clean', ids),
    onProgress: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('registry:progress', listener);
      return () => ipcRenderer.removeListener('registry:progress', listener);
    },
  },

  backups: {
    list: () => call('backup:list'),
    restore: (id) => call('backup:restore', id),
    remove: (id) => call('backup:remove', id),
    reveal: (id) => call('backup:reveal', id),
  },

  clean: {
    scan: () => call('clean:scan'),
    run: (ids) => call('clean:run', ids),
    onProgress: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('clean:progress', listener);
      return () => ipcRenderer.removeListener('clean:progress', listener);
    },
  },

  files: {
    roots: () => call('files:roots'),
    scan: (options) => call('files:scan', options),
    onProgress: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('files:progress', listener);
      return () => ipcRenderer.removeListener('files:progress', listener);
    },
    trash: (paths) => call('files:trash', paths),
    reveal: (target) => call('files:reveal', target),
  },
});
