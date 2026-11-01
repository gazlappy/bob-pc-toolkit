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

// What the Settings tab can change. Anything stored that fails its check falls
// back to the default, so a damaged file can never feed a bad value to a feature.
const isBool = (v) => typeof v === 'boolean';
const PREFS = {
  theme: { def: 'dark', ok: (v) => ['system', 'dark', 'light', 'black', 'slate', 'workshop'].includes(v) },
  startView: { def: 'home', ok: (v) => v === 'home' || v === 'last' },
  lastView: { def: 'overview', ok: (v) => typeof v === 'string' && /^[a-z]{2,20}$/.test(v) },
  autoCheckUpdates: { def: true, ok: isBool },
  reportName: { def: '', ok: (v) => typeof v === 'string' && v.length <= 80 },
  tempKeepDays: { def: 1, ok: (v) => [1, 3, 7].includes(v) },
  cleanAllProfiles: { def: true, ok: isBool },
  pretickRecommended: { def: true, ok: isBool },
  fanWatchdogTemp: { def: 83, ok: (v) => [75, 80, 83, 87].includes(v) },
};

function prefs() {
  const stored = get('prefs') || {};
  const out = {};
  for (const [key, spec] of Object.entries(PREFS)) out[key] = spec.ok(stored[key]) ? stored[key] : spec.def;
  return out;
}

function setPref(key, value) {
  const spec = PREFS[key];
  if (!spec) throw new Error('Unknown setting.');
  const v = typeof value === 'string' ? value.trim() : value;
  if (!spec.ok(v)) throw new Error('That value is not allowed for this setting.');
  set('prefs', { ...(get('prefs') || {}), [key]: v });
  return prefs();
}

// Only the choices on the Settings tab: the update source, nvflash location and
// the Tune-up undo list are kept.
function resetPrefs() {
  set('prefs', {});
  return prefs();
}

module.exports = { read, write, get, set, prefs, setPref, resetPrefs, SETTINGS_FILE };
