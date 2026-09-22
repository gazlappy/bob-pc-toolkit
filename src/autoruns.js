'use strict';

// Persistence auditor — the deep autostart surfaces that the Startup tab does
// not touch and that Task Manager hides entirely. This is where malware hides
// to survive a reboot, so every entry is checked against its Authenticode
// signature and flagged when it looks wrong: unsigned, running from a
// user-writable folder, a missing file, or a known logon hook holding a
// non-default value.
//
// The tool reads before it writes. Only two categories are safely reversible
// from here — services (StartupType) and scheduled tasks (Enable/Disable) —
// and those are the only ones with a toggle. The registry hooks (Winlogon,
// AppInit_DLLs, IFEO), WMI subscriptions and browser add-ons are shown
// read-only with a "why" and a Reveal button; editing them by hand is a
// footgun (emptying Userinit breaks login), so we surface them rather than
// one-click-remove them.

const { shell } = require('electron');
const ps = require('./ps');

// Resolved from the last read so an action only ever gets an id from the UI
// and we look the real target up ourselves.
let cache = new Map();
const signCache = new Map();

const READ_SCRIPT = `
$out = [ordered]@{}

function New-Row($cat, $name, $location, $command, $file, $note) {
  [pscustomobject]@{
    category = $cat; name = $name; location = $location
    command = [string]$command; file = [string]$file; note = [string]$note
  }
}

# ---- Logon hooks (Winlogon, AppInit, Explorer load/run, policy Run) ----
$logon = New-Object System.Collections.ArrayList
try {
  $wl = 'HKLM:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'
  if (Test-Path $wl) {
    $k = Get-ItemProperty -Path $wl
    foreach ($pair in @(
      @{ n='Userinit'; d='C:\\Windows\\system32\\userinit.exe,' },
      @{ n='Shell';    d='explorer.exe' },
      @{ n='Taskman';  d='' },
      @{ n='VmApplet'; d='SystemPropertiesPerformance.exe /pagefile' },
      @{ n='AppSetup'; d='' }
    )) {
      $v = [string]$k.($pair.n)
      $isDefault = ($v.Trim().TrimEnd(',').ToLower() -eq $pair.d.Trim().TrimEnd(',').ToLower())
      if ($v -and -not $isDefault) {
        [void]$logon.Add((New-Row 'logon' ("Winlogon " + $pair.n) 'HKLM Winlogon' $v $v 'non-default logon hook'))
      }
    }
  }
  $wlu = 'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'
  if (Test-Path $wlu) {
    $ku = Get-ItemProperty -Path $wlu
    foreach ($n in 'Shell','Userinit') {
      $v = [string]$ku.$n
      if ($v) { [void]$logon.Add((New-Row 'logon' ("Winlogon " + $n + " (you)") 'HKCU Winlogon' $v $v 'per-user logon hook (unusual)')) }
    }
  }
  foreach ($base in 'HKLM:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Windows','HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows NT\\CurrentVersion\\Windows') {
    if (Test-Path $base) {
      $k = Get-ItemProperty -Path $base
      $dlls = [string]$k.AppInit_DLLs
      if ($dlls.Trim()) {
        $loadFlag = [int]($k.LoadAppInit_DLLs)
        $note = if ($loadFlag -eq 1) { 'AppInit DLL injection is ON' } else { 'AppInit DLLs listed (loading off)' }
        [void]$logon.Add((New-Row 'logon' 'AppInit_DLLs' $base $dlls $dlls $note))
      }
    }
  }
  $winCfg = 'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Windows'
  if (Test-Path $winCfg) {
    $k = Get-ItemProperty -Path $winCfg
    foreach ($n in 'load','run') {
      $v = [string]$k.$n
      if ($v.Trim()) { [void]$logon.Add((New-Row 'logon' ("Windows " + $n + " (you)") $winCfg $v $v 'legacy win.ini autostart')) }
    }
  }
  foreach ($pol in 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer\\Run','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer\\Run') {
    if (Test-Path $pol) {
      $k = Get-Item $pol
      foreach ($vn in $k.GetValueNames()) {
        if ([string]::IsNullOrWhiteSpace($vn)) { continue }
        $v = [string]$k.GetValue($vn)
        [void]$logon.Add((New-Row 'logon' ("Policy Run: " + $vn) $pol $v $v 'policy-enforced autostart'))
      }
    }
  }
} catch {}
$out.logon = @($logon)

# ---- Image File Execution Options debuggers (classic hijack) ----
$ifeo = New-Object System.Collections.ArrayList
try {
  foreach ($root in 'HKLM:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options','HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options') {
    if (-not (Test-Path $root)) { continue }
    Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
      $dbg = (Get-ItemProperty -Path $_.PSPath -Name Debugger -ErrorAction SilentlyContinue).Debugger
      if ($dbg) {
        [void]$ifeo.Add((New-Row 'ifeo' ($_.PSChildName + ' -> Debugger') 'Image File Execution Options' $dbg $dbg 'a debugger hijacks this program'))
      }
    }
  }
} catch {}
$out.ifeo = @($ifeo)

# ---- Auto-start services ----
$services = New-Object System.Collections.ArrayList
try {
  Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object { $_.StartMode -eq 'Auto' } | ForEach-Object {
    [void]$services.Add([pscustomobject]@{
      category = 'service'
      name = [string]$_.Name
      displayName = [string]$_.DisplayName
      state = [string]$_.State
      command = [string]$_.PathName
      startName = [string]$_.StartName
    })
  }
} catch {}
$out.services = @($services)

# ---- Scheduled tasks with an executable action ----
$tasks = New-Object System.Collections.ArrayList
try {
  Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object {
    $action = @($_.Actions) | Where-Object { $_.Execute } | Select-Object -First 1
    if (-not $action) { return }
    [void]$tasks.Add([pscustomobject]@{
      category = 'task'
      name = [string]$_.TaskName
      taskPath = [string]$_.TaskPath
      state = [string]$_.State
      author = [string]$_.Author
      command = [string]$action.Execute
      arguments = [string]$action.Arguments
    })
  }
} catch {}
$out.tasks = @($tasks)

# ---- WMI permanent event subscriptions (fileless persistence) ----
$wmi = New-Object System.Collections.ArrayList
try {
  Get-CimInstance -Namespace root\\subscription -ClassName __FilterToConsumerBinding -ErrorAction SilentlyContinue | ForEach-Object {
    $consumerRef = [string]$_.Consumer
    # Skip the benign built-in NTEventLog binding; surface only the consumer
    # types malware actually uses to run code.
    if ($consumerRef -notmatch 'CommandLineEventConsumer|ActiveScriptEventConsumer') { return }
    $cmd = ''
    try {
      $c = Get-CimInstance -Namespace root\\subscription -ClassName CommandLineEventConsumer -ErrorAction SilentlyContinue | Where-Object { $consumerRef -match [regex]::Escape($_.Name) } | Select-Object -First 1
      if ($c) { $cmd = [string]$c.CommandLineTemplate }
      if (-not $cmd) {
        $s = Get-CimInstance -Namespace root\\subscription -ClassName ActiveScriptEventConsumer -ErrorAction SilentlyContinue | Where-Object { $consumerRef -match [regex]::Escape($_.Name) } | Select-Object -First 1
        if ($s) { $cmd = [string]$s.ScriptFileName; if (-not $cmd) { $cmd = 'inline script' } }
      }
    } catch {}
    [void]$wmi.Add((New-Row 'wmi' $consumerRef 'root\\subscription' $cmd '' 'WMI event subscription'))
  }
} catch {}
$out.wmi = @($wmi)

@($out) | ConvertTo-Json -Depth 5 -Compress
`;

const EXT_SCRIPT = `
$rows = New-Object System.Collections.ArrayList

function Read-ChromiumExts($root, $browser) {
  if (-not (Test-Path $root)) { return }
  Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile*' } | ForEach-Object {
    $prof = $_.Name
    $extRoot = Join-Path $_.FullName 'Extensions'
    if (-not (Test-Path $extRoot)) { return }
    Get-ChildItem $extRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      $id = $_.Name
      $ver = Get-ChildItem $_.FullName -Directory -ErrorAction SilentlyContinue | Select-Object -Last 1
      if (-not $ver) { return }
      $manifest = Join-Path $ver.FullName 'manifest.json'
      $name = $id
      if (Test-Path $manifest) {
        try {
          $m = Get-Content $manifest -Raw -ErrorAction Stop | ConvertFrom-Json
          if ($m.name -and -not ($m.name -like '__MSG_*')) { $name = [string]$m.name }
          elseif ($m.name -like '__MSG_*') {
            $msgKey = ($m.name -replace '__MSG_','').Trim('_')
            $locale = if ($m.default_locale) { $m.default_locale } else { 'en' }
            $msgFile = Join-Path $ver.FullName ('_locales\\' + $locale + '\\messages.json')
            if (Test-Path $msgFile) {
              try { $msgs = Get-Content $msgFile -Raw | ConvertFrom-Json; if ($msgs.$msgKey.message) { $name = [string]$msgs.$msgKey.message } } catch {}
            }
          }
        } catch {}
      }
      [void]$rows.Add([pscustomobject]@{ browser = $browser; profile = $prof; id = $id; name = $name; path = $ver.FullName })
    }
  }
}

try { Read-ChromiumExts (Join-Path $env:LOCALAPPDATA 'Google\\Chrome\\User Data') 'Chrome' } catch {}
try { Read-ChromiumExts (Join-Path $env:LOCALAPPDATA 'Microsoft\\Edge\\User Data') 'Edge' } catch {}
try { Read-ChromiumExts (Join-Path $env:LOCALAPPDATA 'BraveSoftware\\Brave-Browser\\User Data') 'Brave' } catch {}

try {
  $ffProfiles = Join-Path $env:APPDATA 'Mozilla\\Firefox\\Profiles'
  if (Test-Path $ffProfiles) {
    Get-ChildItem $ffProfiles -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      $dbFile = Join-Path $_.FullName 'extensions.json'
      if (Test-Path $dbFile) {
        try {
          $db = Get-Content $dbFile -Raw | ConvertFrom-Json
          foreach ($a in @($db.addons)) {
            if ($a.type -ne 'extension') { continue }
            $nm = if ($a.defaultLocale.name) { [string]$a.defaultLocale.name } else { [string]$a.id }
            [void]$rows.Add([pscustomobject]@{ browser = 'Firefox'; profile = $_.Name; id = [string]$a.id; name = $nm; path = [string]$a.path })
          }
        } catch {}
      }
    }
  }
} catch {}

@($rows) | ConvertTo-Json -Depth 4 -Compress
`;

function expandEnvironment(value) {
  return String(value || '').replace(/%([^%]+)%/g, (match, name) => {
    const found = process.env[name] ?? process.env[name.toUpperCase()];
    return found === undefined ? match : found;
  });
}

// Pulls the executable out of a service PathName / task command such as:
//   "C:\Program Files\App\svc.exe" -k netsvcs
function executableFrom(command) {
  const text = expandEnvironment(command).trim();
  if (!text) return '';
  if (text.startsWith('"')) {
    const close = text.indexOf('"', 1);
    return close === -1 ? text.slice(1) : text.slice(1, close);
  }
  const match = text.match(/^(.*?\.(?:exe|com|bat|cmd|scr|dll|sys|vbs|js|ps1))(?:\s|$)/i);
  if (match) return match[1];
  const space = text.indexOf(' ');
  return space === -1 ? text : text.slice(0, space);
}

function publisherFrom(signer) {
  if (!signer) return '';
  const org = signer.match(/(?:^|,)\s*O=("[^"]+"|[^,]+)/);
  if (org) return org[1].replace(/^"|"$/g, '').trim();
  const cn = signer.match(/CN=("[^"]+"|[^,]+)/);
  return cn ? cn[1].replace(/^"|"$/g, '').trim() : '';
}

async function signBatch(paths) {
  const need = paths.filter((p) => p && !signCache.has(p.toLowerCase()));
  if (need.length) {
    const rows = ps.arr(
      await ps
        .json(`
${ps.payload(need)}
@(@($Payload) | ForEach-Object {
  $p = $_
  $status = 'Unknown'; $signer = ''
  if (Test-Path -LiteralPath $p -PathType Leaf) {
    try {
      $s = Get-AuthenticodeSignature -LiteralPath $p -ErrorAction Stop
      $status = [string]$s.Status
      if ($s.SignerCertificate) { $signer = [string]$s.SignerCertificate.Subject }
    } catch { $status = 'Error' }
  } else { $status = 'Missing' }
  [pscustomobject]@{ path = $p; status = $status; signer = $signer }
}) | ConvertTo-Json -Depth 3 -Compress
`)
        .catch(() => [])
    );
    for (const row of rows) {
      signCache.set(String(row.path).toLowerCase(), {
        status: row.status,
        publisher: publisherFrom(row.signer),
      });
    }
    for (const p of need) {
      if (!signCache.has(p.toLowerCase())) signCache.set(p.toLowerCase(), { status: 'Unknown', publisher: '' });
    }
  }
  const out = {};
  for (const p of paths) {
    if (p) out[p.toLowerCase()] = signCache.get(p.toLowerCase()) || { status: 'Unknown', publisher: '' };
  }
  return out;
}

const WINDIR = (process.env.WINDIR || 'C:\\Windows').toLowerCase();
const USER_WRITABLE = /\\(temp|tmp|appdata|downloads|\$recycle\.bin)\\/i;

function isMicrosoft(publisher) {
  return /microsoft/i.test(publisher || '');
}

function assess(exe, sign, { alwaysFlag = false, note = '' } = {}) {
  const path = (exe || '').toLowerCase();
  const status = sign ? sign.status : 'Unknown';
  const publisher = sign ? sign.publisher : '';
  const reasons = [];
  if (alwaysFlag) reasons.push(note || 'unusual persistence location');
  // A bare command name with no directory (sc.exe, powershell.exe,
  // SystemPropertiesPerformance.exe) is a system binary resolved off PATH, so
  // the file-based checks below (which need a real path) do not apply to it.
  const hasPath = /[\\/]/.test(exe);
  if (exe && hasPath && status === 'Missing') reasons.push('the file is missing');
  else if (exe && hasPath) {
    const inWindows = path.startsWith(WINDIR);
    if (status !== 'Valid' && !inWindows) reasons.push('not signed / signature not valid');
    if (USER_WRITABLE.test(exe)) reasons.push('runs from a user-writable folder');
  }
  return {
    publisher,
    signed: status === 'Valid',
    signStatus: status,
    flagged: reasons.length > 0,
    flagReason: reasons.join(' \u00b7 '),
  };
}

async function read() {
  const raw = (await ps.json(READ_SCRIPT).catch(() => null)) || {};
  const logon = ps.arr(raw.logon);
  const ifeo = ps.arr(raw.ifeo);
  const services = ps.arr(raw.services);
  const tasks = ps.arr(raw.tasks);
  const wmi = ps.arr(raw.wmi);

  const exeOf = (row) => executableFrom(row.file || row.command);
  const allExes = [
    ...logon.map(exeOf),
    ...ifeo.map(exeOf),
    ...services.map((s) => executableFrom(s.command)),
    ...tasks.map((t) => executableFrom(t.command)),
  ].filter(Boolean);
  const signs = await signBatch([...new Set(allExes)]);
  const signOf = (exe) => signs[(exe || '').toLowerCase()];

  cache = new Map();
  let flaggedCount = 0;
  const push = (entry) => {
    entry.executable = entry.executable || '';
    cache.set(entry.id, entry);
    if (entry.flagged) flaggedCount += 1;
    return entry;
  };

  const logonEntries = logon.map((row, i) => {
    const exe = exeOf(row);
    const info = assess(exe, signOf(exe), { alwaysFlag: true, note: row.note });
    return push({
      id: `logon::${i}`,
      category: 'logon',
      name: row.name,
      location: row.location,
      command: expandEnvironment(row.command),
      executable: exe,
      note: row.note,
      actionable: false,
      ...info,
    });
  });

  const ifeoEntries = ifeo.map((row, i) => {
    const exe = exeOf(row);
    const info = assess(exe, signOf(exe), { alwaysFlag: true, note: row.note });
    return push({
      id: `ifeo::${i}`,
      category: 'ifeo',
      name: row.name,
      location: row.location,
      command: expandEnvironment(row.command),
      executable: exe,
      note: row.note,
      actionable: false,
      ...info,
    });
  });

  const serviceEntries = services.map((svc) => {
    const exe = executableFrom(svc.command);
    const info = assess(exe, signOf(exe));
    const trusted = info.signed && isMicrosoft(info.publisher);
    return push({
      id: `service::${svc.name}`,
      category: 'service',
      name: svc.displayName || svc.name,
      serviceName: svc.name,
      location: svc.startName ? `Service \u00b7 ${svc.startName}` : 'Service',
      command: expandEnvironment(svc.command),
      executable: exe,
      state: svc.state,
      enabled: true,
      actionable: true,
      actionKind: 'service',
      builtIn: trusted,
      ...info,
    });
  });

  const taskEntries = tasks.map((task) => {
    const exe = executableFrom(task.command);
    const info = assess(exe, signOf(exe));
    const builtIn = String(task.taskPath || '').toLowerCase().startsWith('\\microsoft\\');
    return push({
      id: `task::${task.taskPath}${task.name}`,
      category: 'task',
      name: task.name,
      taskPath: task.taskPath,
      location: `Task \u00b7 ${task.taskPath}`,
      command: expandEnvironment([task.command, task.arguments].filter(Boolean).join(' ')),
      executable: exe,
      state: task.state,
      enabled: String(task.state).toLowerCase() !== 'disabled',
      actionable: true,
      actionKind: 'task',
      builtIn,
      ...info,
    });
  });

  const wmiEntries = wmi.map((row, i) =>
    push({
      id: `wmi::${i}`,
      category: 'wmi',
      name: row.name,
      location: row.location,
      command: row.command,
      executable: '',
      note: row.note,
      actionable: false,
      flagged: true,
      flagReason: 'WMI event subscriptions are a common fileless persistence trick — verify it',
      publisher: '',
      signed: false,
      signStatus: 'n/a',
    })
  );

  const groups = [
    { id: 'logon', label: 'Logon hooks', hint: 'Winlogon, AppInit_DLLs and legacy load/run points', entries: logonEntries },
    { id: 'ifeo', label: 'Debugger hijacks', hint: 'Image File Execution Options debuggers', entries: ifeoEntries },
    { id: 'wmi', label: 'WMI subscriptions', hint: 'Permanent event consumers (fileless persistence)', entries: wmiEntries },
    { id: 'service', label: 'Auto-start services', hint: 'Services set to start automatically', entries: serviceEntries },
    { id: 'task', label: 'Scheduled tasks', hint: 'Tasks that launch a program', entries: taskEntries },
  ].filter((g) => g.entries.length);

  return {
    groups,
    summary: {
      total: cache.size,
      flagged: flaggedCount,
      services: serviceEntries.length,
      tasks: taskEntries.length,
    },
  };
}

// Browser add-ons are a separate, slower call: the audit paints first and this
// fills in after, like the Startup tab does with scheduled tasks.
async function extensions() {
  const rows = ps.arr(await ps.json(EXT_SCRIPT).catch(() => []));
  return {
    extensions: rows.map((row, i) => ({
      id: `ext::${i}`,
      browser: row.browser,
      profile: row.profile,
      name: row.name || row.id,
      extId: row.id,
      path: row.path,
    })),
  };
}

function requireEntry(id) {
  const entry = cache.get(id);
  if (!entry) throw new Error('That item is no longer in the list. Refresh and try again.');
  return entry;
}

async function setEnabled(id, enabled) {
  const entry = requireEntry(id);
  if (entry.actionKind === 'service') {
    await ps
      .mutate(`
${ps.payload({ name: entry.serviceName, enabled: Boolean(enabled) })}
  $svc = Get-Service -Name $Payload.name -ErrorAction Stop
  if ($Payload.enabled) {
    Set-Service -Name $Payload.name -StartupType Automatic
  } else {
    Set-Service -Name $Payload.name -StartupType Disabled
    if ($svc.Status -eq 'Running') { Stop-Service -Name $Payload.name -Force -ErrorAction SilentlyContinue }
  }
`)
      .catch((err) => {
        if (/access is denied/i.test(err.message)) {
          throw new Error('Changing a service needs administrator rights. Run as admin from the banner, then try again.');
        }
        throw err;
      });
  } else if (entry.actionKind === 'task') {
    await ps
      .mutate(`
${ps.payload({ taskPath: entry.taskPath, name: entry.name, enabled: Boolean(enabled) })}
  if ($Payload.enabled) {
    Enable-ScheduledTask -TaskPath $Payload.taskPath -TaskName $Payload.name | Out-Null
  } else {
    Disable-ScheduledTask -TaskPath $Payload.taskPath -TaskName $Payload.name | Out-Null
  }
`)
      .catch((err) => {
        if (/access is denied/i.test(err.message)) {
          throw new Error('Changing this task needs administrator rights. Run as admin from the banner, then try again.');
        }
        throw err;
      });
  } else {
    throw new Error('This item cannot be toggled here — use Reveal to inspect it.');
  }
  entry.enabled = Boolean(enabled);
  if (entry.actionKind === 'service') entry.state = enabled ? entry.state : 'Stopped';
  return entry;
}

async function reveal(id) {
  const entry = requireEntry(id);
  const target = entry.executable || entry.path;
  if (!target) throw new Error('There is no file to show for this item.');
  shell.showItemInFolder(target);
  return true;
}

module.exports = {
  read,
  extensions,
  setEnabled,
  reveal,
  __scripts: { READ: READ_SCRIPT, EXT: EXT_SCRIPT },
};
