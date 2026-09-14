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

/**
 * Builds .reg text that would restore every item given.
 * `items` are { hive, subKey, valueName? } — a valueName means back up just
 * that value, its absence means back up the whole key.
 */
// Inside a .reg value name, backslashes and quotes are escaped. Done here in
// JavaScript rather than in PowerShell, where the layers of quoting needed to
// express these two replacements are almost impossible to read.
function escapeRegName(name) {
  return String(name).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

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

/**
 * Writes a restore point. Returns its manifest.
 * @param {{kind: string, label: string, items: Array}} details
 */
async function create({ kind, label, items }) {
  if (!items.length) throw new Error('There is nothing to back up.');

  const stamp = new Date();
  const id = `${stamp.toISOString().replace(/[:.]/g, '-')}-${kind}`;
  const dir = path.join(root(), id);
  await fs.mkdir(dir, { recursive: true });

  // UTF-16LE with a BOM is what regedit writes and what reg import expects.
  const body = await buildRegText(items);
  const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), body]);
  await fs.writeFile(path.join(dir, 'restore.reg'), withBom);

  const manifest = {
    id,
    kind,
    label,
    createdAt: stamp.toISOString(),
    count: items.length,
    items: items.map((item) => ({
      hive: item.hive,
      subKey: item.subKey,
      valueName: item.valueName || null,
      description: item.description || '',
    })),
  };
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

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
      const text = await fs.readFile(path.join(root(), name, 'manifest.json'), 'utf8');
      const manifest = JSON.parse(text);
      const stat = await fs.stat(path.join(root(), name, 'restore.reg')).catch(() => null);
      manifest.bytes = stat ? stat.size : 0;
      manifests.push(manifest);
    } catch {
      /* half-written or hand-edited — ignore it rather than fail the list */
    }
  }

  manifests.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return manifests;
}

async function restore(id) {
  const file = path.join(root(), id, 'restore.reg');
  try {
    await fs.access(file);
  } catch {
    throw new Error('That backup file is missing.');
  }

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

  return true;
}

async function remove(id) {
  const dir = path.join(root(), id);
  if (!path.resolve(dir).startsWith(path.resolve(root()) + path.sep)) {
    throw new Error('Refusing to delete outside the backup folder.');
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

module.exports = { create, list, restore, remove, reveal, root, buildRegText };
