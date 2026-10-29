'use strict';

// BOB's small persistent settings file (%APPDATA%\PC Cleanup\settings.json).
// Shared so each feature merges its own keys instead of overwriting the others'.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

function read() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function write(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function get(key) {
  return read()[key];
}

function set(key, value) {
  const s = read();
  s[key] = value;
  write(s);
}

module.exports = { read, write, get, set, SETTINGS_FILE };
