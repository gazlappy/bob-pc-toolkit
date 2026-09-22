'use strict';

// Registry backups.
//
// Nothing in this app deletes a registry key or value without first writing a
// .reg file that puts it back. Backups live under the app's own data folder and
// survive restarts, so a mistake made today is still recoverable next week.
//
// Two shapes of backup are produced:
//   * whole keys  — exported with reg.exe, which captures subkeys and every
//                   value type faithfully;
//   * single values — reconstructed by hand as hex(N) entries, so removing one
//                   value out of a huge shared key does not mean exporting the
//                   entire key alongside it.

const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { app, shell } = require('electron');
const ps = require('./ps');

const LONG_HIVE = { HKLM: 'HKEY_LOCAL_MACHINE', HKCU: 'HKEY_CURRENT_USER', HKCR: 'HKEY_CLASSES_ROOT' };

function root() {
  return path.join(app.getPath('userData'), 'backups');
}

function psPath(item) {
  return `${item.hive}:\\${item.subKey}`;
}

function regPath(item) {
  return `${item.hive}\\${item.subKey}`;
}

function longPath(item) {
  return `${LONG_HIVE[item.hive] || item.hive}\\${item.subKey}`;
}

// Inside a .reg value name, backslashes and quotes are escaped. Done here in
// JavaScript rather than in PowerShell, where the layers of quoting needed to
// express these two replacements are almost impossible to read.
function escapeRegName(name) {
  return String(name).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Builds .reg text that would restore every item given.
 * `items` are { hive, subKey, valueName? } — a valueName means back up just
 * that value, its absence means back up the whole key.
 */
async function buildRegText(items) {
  const request = items.map((item) => ({
    psPath: psPath(item),
    regPath: regPath(item),
    longPath: longPath(item),
    valueName: item.valueName || null,
    regName: item.valueName ? escapeRegName(item.valueName) : null,
  }));

  const encoded = await ps.run(
    `
${ps.payload(request)}

# .reg accepts hex(N) for every value type, which sidesteps the quoting rules
# that the friendlier "name"="value" forms would require.
$kindToCode = @{ 'String' = 1; 'ExpandString' = 2; 'Binary' = 3; 'DWord' = 4; 'MultiString' = 7; 'QWord' = 11 }

function Get-ValueBytes($key, $name, $kind) {
  $value = $key.GetValue($name, $null, 'DoNotExpandEnvironmentNames')
  switch ($kind) {
    'String'       { return [System.Text.Encoding]::Unicode.GetBytes([string]$value + [char]0) }
    'ExpandString' { return [System.Text.Encoding]::Unicode.GetBytes([string]$value + [char]0) }
    'MultiString'  {
      $text = ''
      foreach ($part in @($value)) { $text += [string]$part + [char]0 }
      return [System.Text.Encoding]::Unicode.GetBytes($text + [char]0)
    }
    'DWord'        { return [System.BitConverter]::GetBytes([uint32]$value) }
    'QWord'        { return [System.BitConverter]::GetBytes([uint64]$value) }
    default        { return [byte[]]$value }
  }
}

$out = New-Object System.Collections.ArrayList
[void]$out.Add('Windows Registry Editor Version 5.00')
[void]$out.Add('')

foreach ($item in @($Payload)) {
  if ($item.valueName) {
    $key = Get-Item -LiteralPath $item.psPath -ErrorAction SilentlyContinue
    if (-not $key) { continue }
    if (-not ($key.GetValueNames() -contains $item.valueName)) { continue }

    $kind = [string]$key.GetValueKind($item.valueName)
    $code = $kindToCode[$kind]
    if (-not $code) { $code = 3 }
    $bytes = Get-ValueBytes $key $item.valueName $kind
    $pairs = @($bytes | ForEach-Object { '{0:x2}' -f $_ })

    [void]$out.Add('[' + $item.longPath + ']')

    # Wrapped in regedit's style: 25 bytes a line, continued with a backslash.
    $prefix = '"' + $item.regName + '"=hex(' + ('{0:x}' -f $code) + '):'
    if ($pairs.Count -eq 0) {
      [void]$out.Add($prefix)
    } else {
      for ($i = 0; $i -lt $pairs.Count; $i += 25) {
        $slice = $pairs[$i..([Math]::Min($i + 24, $pairs.Count - 1))]
        $line = ($slice -join ',')
        $more = ($i + 25) -lt $pairs.Count
        if ($i -eq 0) { $line = $prefix + $line } else { $line = '  ' + $line }
        if ($more) { $line = $line + ',\\' }
        [void]$out.Add($line)
      }
    }
    [void]$out.Add('')
  } else {
    $temp = [System.IO.Path]::GetTempFileName()
    Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
    & reg.exe export $item.regPath $temp /y | Out-Null
    if (Test-Path -LiteralPath $temp) {
      # Drop the per-file header; the combined file carries its own.
      foreach ($line in (Get-Content -LiteralPath $temp -Encoding Unicode)) {
        if ($line -match '^Windows Registry Editor') { continue }
        [void]$out.Add($line)
      }
      [void]$out.Add('')
      Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
    }
  }
}

[Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes(($out -join "\`r\`n")))
`,
    { timeout: 120000 }
  );

  const trimmed = encoded.trim();
  if (!trimmed) throw new Error('Could not read the registry values to back up.');
  return Buffer.from(trimmed, 'base64');
}

// --- quarantine -------------------------------------------------------------
//
// Files and folders taken out of place by a forced program removal are parked
// here rather than deleted. Parking is always a rename on the same volume,
// which matters twice over: it is atomic (a folder with a file still in use
// either moves whole or not at all, never half), and it has no size limit.
// The Recycle Bin has neither property — Windows recycles "if possible,
// otherwise deletes", so a folder too big for the bin would be gone for good.

function localQuarantineRoot() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'PC Cleanup', 'quarantine');
}

function driveOf(target) {
  const match = path.resolve(target).match(/^([a-zA-Z]):/);
  return match ? match[1].toUpperCase() : null;
}

/** Where something from `source` is parked for restore point `backupId`. */
function quarantineDir(source, backupId) {
  const local = localQuarantineRoot();
  const drive = driveOf(source);
  if (!drive) throw new Error('Only paths on a lettered drive can be quarantined.');
  if (drive === driveOf(local)) return path.join(local, backupId);
  return path.join(`${drive}:\\`, 'PC Cleanup Quarantine', backupId);
}

/**
 * True only for a path strictly inside a restore point's quarantine folder.
 * Discarding deletes these for good, and manifests are plain files on disk,
 * so a hand-edited or damaged one must not be able to point that at anything
 * else.
 */
function isQuarantinePath(target) {
  const resolved = path.resolve(target);
  const roots = [localQuarantineRoot()];
  const drive = driveOf(resolved);
  if (drive) roots.push(path.join(`${drive}:\\`, 'PC Cleanup Quarantine'));
  return roots.some((quarantine) => {
    const relative = path.relative(quarantine, resolved);
    return (
      relative !== '' &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      relative.split(path.sep).length >= 2
    );
  });
}

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes a restore point. Returns its manifest.
 *
 * `items` are registry keys or values to capture. `moved` lists files or
 * folders parked in quarantine; a forced program removal writes those in two
 * steps (see setMoved), so a crash part way through still leaves a record of
 * where everything went.
 *
 * @param {{kind: string, label: string, items?: Array, moved?: Array}} details
 */
async function create({ kind, label, items = [], moved = [] }) {
  if (!items.length && !moved.length) throw new Error('There is nothing to back up.');

  const stamp = new Date();
  const id = `${stamp.toISOString().replace(/[:.]/g, '-')}-${kind}`;
  const dir = path.join(root(), id);
  await fs.mkdir(dir, { recursive: true });

  if (items.length) {
    // UTF-16LE with a BOM is what regedit writes and what reg import expects.
    const body = await buildRegText(items);
    const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), body]);
    await fs.writeFile(path.join(dir, 'restore.reg'), withBom);
  }

  const manifest = {
    id,
    kind,
    label,
    createdAt: stamp.toISOString(),
    count: items.length + moved.length,
    status: 'done',
    items: items.map((item) => ({
      hive: item.hive,
      subKey: item.subKey,
      valueName: item.valueName || null,
      description: item.description || '',
    })),
    moved: moved.map(normaliseMove),
  };
  await writeManifest(manifest);

  return manifest;
}

function normaliseMove(entry) {
  return {
    from: entry.from,
    to: entry.to,
    type: entry.type === 'folder' ? 'folder' : 'file',
    bytes: Number(entry.bytes) || 0,
    description: entry.description || '',
  };
}

async function readManifest(id) {
  const text = await fs.readFile(path.join(root(), id, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(text);
  manifest.moved = Array.isArray(manifest.moved) ? manifest.moved : [];
  manifest.items = Array.isArray(manifest.items) ? manifest.items : [];
  return manifest;
}

async function writeManifest(manifest) {
  await fs.writeFile(path.join(root(), manifest.id, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

/** Records what a restore point has parked in quarantine, and whether it finished. */
async function setMoved(id, moved, status) {
  const manifest = await readManifest(id);
  manifest.moved = moved.map(normaliseMove);
  manifest.count = manifest.items.length + manifest.moved.length;
  manifest.status = status;
  await writeManifest(manifest);
  return manifest;
}

async function list() {
  let names;
  try {
    names = await fs.readdir(root());
  } catch {
    return [];
  }

  const manifests = [];
  for (const name of names) {
    try {
      const manifest = await readManifest(name);
      const stat = await fs.stat(path.join(root(), name, 'restore.reg')).catch(() => null);
      manifest.bytes = stat ? stat.size : 0;

      // Only what is still sitting in quarantine counts — anything restored
      // or already discarded is no longer taking up space.
      let quarantined = 0;
      for (const entry of manifest.moved) {
        if (await exists(entry.to)) quarantined += entry.bytes;
      }
      manifest.quarantinedBytes = quarantined;

      manifests.push(manifest);
    } catch {
      /* half-written or hand-edited — ignore it rather than fail the list */
    }
  }

  manifests.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return manifests;
}

async function importRegistry(file) {
  // No 2>&1 here. reg.exe writes "The operation completed successfully." to
  // stderr, and redirecting a native command's stderr in Windows PowerShell
  // wraps each line in an ErrorRecord — which, under the Stop preference the
  // guard sets, turned a successful import into a thrown error.
  await ps.mutate(
    `
${ps.payload({ file })}
  & reg.exe import $Payload.file | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "reg import failed with exit code $LASTEXITCODE." }
`,
    { timeout: 120000 }
  );
}

/**
 * Puts everything in a restore point back.
 *
 * Parked files and folders go back first, and only if nothing has since
 * appeared in their place: if the program was reinstalled, restoring an old
 * copy over it — or re-importing old registry values over new ones — would
 * break the working install, so the whole restore is refused instead.
 */
async function restore(id) {
  const manifest = await readManifest(id);
  const file = path.join(root(), id, 'restore.reg');
  const hasRegistry = await exists(file);

  const toMoveBack = [];
  for (const entry of manifest.moved) {
    if (!(await exists(entry.to))) continue; // never moved, or already put back
    if (await exists(entry.from)) {
      throw new Error(
        `${entry.from} already exists — it looks like this was reinstalled. Nothing has been changed.`
      );
    }
    toMoveBack.push(entry);
  }

  if (!hasRegistry && !toMoveBack.length && manifest.moved.length) {
    throw new Error('Everything in this restore point has already been put back or discarded.');
  }
  if (!hasRegistry && !manifest.moved.length) throw new Error('That backup file is missing.');

  // Folders before files: a shortcut going back into a folder needs the folder
  // there first.
  toMoveBack.sort((a, b) => (a.type === b.type ? 0 : a.type === 'folder' ? -1 : 1));
  for (const entry of toMoveBack) {
    await fs.mkdir(path.dirname(entry.from), { recursive: true });
    await fs.rename(entry.to, entry.from);
  }

  if (hasRegistry) await importRegistry(file);

  await removeEmptyQuarantine(manifest);
  return true;
}

/**
 * Tidies up a restore point's quarantine folders once they are empty.
 *
 * Deepest first: a restore point parks shortcuts in `<id>\shortcuts\`, and
 * `<id>` can only be removed once `shortcuts` has gone from inside it.
 */
async function removeEmptyQuarantine(manifest) {
  const dirs = new Set();
  for (const entry of manifest.moved) {
    // Walk up from the parked item to the restore point's own folder, never
    // past it to the quarantine root shared by every restore point.
    for (let dir = path.dirname(entry.to); isQuarantinePath(path.join(dir, 'x')); dir = path.dirname(dir)) {
      dirs.add(dir);
    }
  }
  const deepestFirst = [...dirs].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  for (const dir of deepestFirst) {
    try {
      await fs.rmdir(dir); // only succeeds when empty — never recursive here
    } catch {
      /* not empty, or already gone */
    }
  }
}

/** Removes empty quarantine folders for entries that were planned but never parked. */
async function cleanQuarantineDirs(moved) {
  await removeEmptyQuarantine({ moved });
}

/**
 * Deletes a restore point. Anything it parked in quarantine is deleted for
 * good at this point — this is the step that actually frees the space.
 */
async function remove(id) {
  const dir = path.join(root(), id);
  if (!path.resolve(dir).startsWith(path.resolve(root()) + path.sep)) {
    throw new Error('Refusing to delete outside the backup folder.');
  }

  let manifest = null;
  try {
    manifest = await readManifest(id);
  } catch {
    /* no manifest — just the backup folder to remove */
  }

  if (manifest) {
    for (const entry of manifest.moved) {
      if (!isQuarantinePath(entry.to)) {
        throw new Error(`Refusing to delete ${entry.to}: it is not inside a quarantine folder.`);
      }
    }
    for (const entry of manifest.moved) {
      await fs.rm(entry.to, { recursive: true, force: true, maxRetries: 2 });
    }
    await removeEmptyQuarantine(manifest);
  }

  await fs.rm(dir, { recursive: true, force: true });
  return true;
}

async function reveal(id) {
  const dir = id ? path.join(root(), id) : root();
  await fs.mkdir(root(), { recursive: true });
  shell.openPath(dir);
  return true;
}

module.exports = {
  create,
  setMoved,
  list,
  restore,
  remove,
  reveal,
  root,
  buildRegText,
  quarantineDir,
  isQuarantinePath,
  cleanQuarantineDirs,
};
