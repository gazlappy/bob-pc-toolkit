// Writes dist/version.json describing the built BOB.exe, for the self-updater.
// Workflow per release:
//   1. bump "version" in package.json
//   2. npm run dist           (builds dist/BOB.exe)
//   3. npm run manifest       (writes dist/version.json with its SHA-256)
//   4. copy dist/BOB.exe + dist/version.json to your update source
//      (the web folder or shared/synced folder each BOB is pointed at)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const pkg = require('../package.json');
const dist = path.join(__dirname, '..', 'dist');
const exePath = path.join(dist, 'BOB.exe');

if (!fs.existsSync(exePath)) {
  console.error('dist/BOB.exe not found — run "npm run dist" first.');
  process.exit(1);
}

const buf = fs.readFileSync(exePath);
const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

const manifest = {
  version: pkg.version,
  exe: 'BOB.exe',
  sha256,
  size: buf.length,
  date: new Date().toISOString().slice(0, 10),
  notes: process.argv.slice(2).join(' ') || `BOB ${pkg.version}`,
};

fs.writeFileSync(path.join(dist, 'version.json'), JSON.stringify(manifest, null, 2));
console.log(`wrote dist/version.json  v${manifest.version}  sha256 ${sha256.slice(0, 16)}…  (${(buf.length / 1048576).toFixed(0)} MB)`);
