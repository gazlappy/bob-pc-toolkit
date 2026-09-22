'use strict';

// Security posture — the one-glance "is this machine set up safely" check a
// bench tech runs before handing a PC back. Read-only: it reads Defender,
// Firewall, SmartScreen, BitLocker, UAC, the pending-reboot flags and the local
// accounts, and grades each. Nothing here changes a setting; fixing them is a
// deliberate, per-setting act the tech does themselves, so the tool's job is to
// surface the state honestly, including "unknown — needs admin" rather than a
// false all-clear.

const ps = require('./ps');

const READ_SCRIPT = `
$out = [ordered]@{}

# ---- Windows Defender ----
try {
  $mp = Get-MpComputerStatus -ErrorAction Stop
  $out.defender = [pscustomobject]@{
    installed     = $true
    realtime      = [bool]$mp.RealTimeProtectionEnabled
    amService     = [bool]$mp.AMServiceEnabled
    antispyware   = [bool]$mp.AntispywareEnabled
    tamper        = [bool]$mp.IsTamperProtected
    sigAgeDays    = [int]$mp.AntivirusSignatureAge
    engineVersion = [string]$mp.AMEngineVersion
    lastQuickScan = [string]$mp.QuickScanEndTime
  }
} catch {
  $out.defender = $null
}

# ---- Third-party AV registered with Security Center ----
try {
  $out.otherAv = @(Get-CimInstance -Namespace root\\SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction Stop | ForEach-Object {
    [pscustomobject]@{ name = [string]$_.displayName; state = [int]$_.productState }
  })
} catch {
  $out.otherAv = @()
}

# ---- Firewall profiles ----
try {
  $out.firewall = @(Get-NetFirewallProfile -ErrorAction Stop | ForEach-Object {
    [pscustomobject]@{ name = [string]$_.Name; enabled = [bool]$_.Enabled }
  })
} catch {
  $out.firewall = @()
}

# ---- Third-party firewall registered with Security Center ----
try {
  $out.otherFirewall = @(Get-CimInstance -Namespace root\\SecurityCenter2 -ClassName FirewallProduct -ErrorAction Stop | ForEach-Object {
    [pscustomobject]@{ name = [string]$_.displayName; state = [int]$_.productState }
  })
} catch {
  $out.otherFirewall = @()
}

# ---- BitLocker (Pro+ has cmdlets; querying status often needs admin) ----
$bl = [ordered]@{ supported = $false; error = ''; volumes = @() }
if (Get-Command Get-BitLockerVolume -ErrorAction SilentlyContinue) {
  $bl.supported = $true
  try {
    $bl.volumes = @(Get-BitLockerVolume -ErrorAction Stop | ForEach-Object {
      [pscustomobject]@{
        mount      = [string]$_.MountPoint
        protection = [string]$_.ProtectionStatus
        status     = [string]$_.VolumeStatus
        percent    = [int]$_.EncryptionPercentage
      }
    })
  } catch {
    $bl.error = [string]$_.Exception.Message
  }
}
$out.bitlocker = $bl

# ---- UAC ----
try {
  $sys = Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -ErrorAction Stop
  $out.uac = [pscustomobject]@{
    enableLUA     = [int]$sys.EnableLUA
    consentAdmin  = [int]$sys.ConsentPromptBehaviorAdmin
  }
} catch {
  $out.uac = $null
}

# ---- SmartScreen ----
try {
  $ex = Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer' -Name SmartScreenEnabled -ErrorAction SilentlyContinue
  $out.smartscreen = [string]$ex.SmartScreenEnabled
} catch {
  $out.smartscreen = ''
}

# ---- Pending reboot ----
$reboot = [ordered]@{}
$reboot.cbs = Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending'
$reboot.windowsUpdate = Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired'
$reboot.fileRename = $false
try {
  $sm = Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager' -Name PendingFileRenameOperations -ErrorAction SilentlyContinue
  if ($sm -and $sm.PendingFileRenameOperations) { $reboot.fileRename = $true }
} catch {}
$reboot.rename = $false
try {
  $active = (Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\ComputerName\\ActiveComputerName' -Name ComputerName).ComputerName
  $pendingName = (Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\ComputerName\\ComputerName' -Name ComputerName).ComputerName
  if ($active -ne $pendingName) { $reboot.rename = $true }
} catch {}
$out.reboot = $reboot

# ---- Local accounts ----
$acc = [ordered]@{ admins = @(); users = @(); error = '' }
try {
  $acc.admins = @(Get-LocalGroupMember -Group 'Administrators' -ErrorAction Stop | ForEach-Object { [string]$_.Name })
} catch {
  try {
    $lines = net localgroup administrators
    $capture = $false
    $names = New-Object System.Collections.ArrayList
    foreach ($l in $lines) {
      if ($l -match '^----') { $capture = $true; continue }
      if ($l -match 'The command completed') { $capture = $false; continue }
      if ($capture -and $l.Trim()) { [void]$names.Add($l.Trim()) }
    }
    $acc.admins = @($names)
  } catch { $acc.error = [string]$_.Exception.Message }
}
try {
  $acc.users = @(Get-LocalUser -ErrorAction Stop | ForEach-Object {
    [pscustomobject]@{
      name             = [string]$_.Name
      enabled          = [bool]$_.Enabled
      passwordRequired = [bool]$_.PasswordRequired
      passwordExpires  = ($_.PasswordExpires -ne $null)
      lastLogon        = if ($_.LastLogon) { [string]$_.LastLogon } else { '' }
    }
  })
} catch {}
$out.accounts = $acc

@($out) | ConvertTo-Json -Depth 5 -Compress
`;

// Turns the productState bitmask from Security Center into on/up-to-date flags.
// Bit layout is undocumented but stable: byte 2 (>>8) is enabled, byte 1 (>>4)
// is signature freshness.
function decodeAvState(state) {
  const enabled = (state & 0x1000) !== 0;
  const upToDate = (state & 0x10) === 0;
  return { enabled, upToDate };
}

function check(id, label, status, value, detail, hint) {
  return { id, label, status, value, detail: detail || '', hint: hint || '' };
}

function build(raw) {
  const sections = [];
  let good = 0;
  let warn = 0;
  let bad = 0;
  const tally = (s) => {
    if (s === 'good') good += 1;
    else if (s === 'warn') warn += 1;
    else if (s === 'bad') bad += 1;
  };
  const section = (label, checks) => {
    for (const c of checks) tally(c.status);
    sections.push({ label, checks });
  };

  // Is any third-party AV actually turned on?
  const otherAv = (raw.otherAv || [])
    .map((a) => ({ name: a.name, ...decodeAvState(a.state) }))
    .filter((a) => !/windows defender/i.test(a.name));
  const activeOtherAv = otherAv.find((a) => a.enabled);

  // --- Protection ---
  const protection = [];
  const d = raw.defender;
  if (d && d.installed) {
    if (d.realtime) {
      const stale = d.sigAgeDays > 7;
      protection.push(
        check(
          'defender-rt',
          'Microsoft Defender',
          stale ? 'warn' : 'good',
          'Real-time on',
          stale
            ? `Definitions are ${d.sigAgeDays} days old`
            : `Definitions ${d.sigAgeDays === 0 ? 'up to date' : `${d.sigAgeDays} day${d.sigAgeDays === 1 ? '' : 's'} old`}`,
          stale ? 'Update definitions from Windows Security.' : ''
        )
      );
    } else if (activeOtherAv) {
      protection.push(
        check('defender-rt', 'Antivirus', 'good', activeOtherAv.name, 'Defender is off because another AV is active', '')
      );
    } else {
      protection.push(
        check('defender-rt', 'Microsoft Defender', 'bad', 'Real-time OFF', 'No active antivirus detected', 'Turn real-time protection back on.')
      );
    }
    if (typeof d.tamper === 'boolean') {
      protection.push(check('tamper', 'Tamper protection', d.tamper ? 'good' : 'warn', d.tamper ? 'On' : 'Off', '', d.tamper ? '' : 'Blocks malware from disabling Defender.'));
    }
  } else if (activeOtherAv) {
    protection.push(check('defender-rt', 'Antivirus', 'good', activeOtherAv.name, 'Third-party antivirus is active', ''));
  } else {
    protection.push(check('defender-rt', 'Antivirus', 'unknown', 'Not reported', 'Defender status could not be read', ''));
  }

  const otherFw = (raw.otherFirewall || [])
    .map((f) => ({ name: f.name, ...decodeAvState(f.state) }))
    .filter((f) => !/windows firewall/i.test(f.name));
  const activeOtherFw = otherFw.find((f) => f.enabled);
  const fw = raw.firewall || [];
  if (fw.length) {
    const off = fw.filter((p) => !p.enabled);
    const detail = fw.map((p) => `${p.name} ${p.enabled ? 'on' : 'off'}`).join(' · ');
    if (off.length && activeOtherFw) {
      // Windows Firewall stands down when a third-party firewall takes over —
      // that is expected, not a hole.
      protection.push(check('firewall', 'Firewall', 'good', activeOtherFw.name, 'Windows Firewall is off because another firewall is active', ''));
    } else {
      const status = off.length === 0 ? 'good' : off.length === fw.length ? 'bad' : 'warn';
      protection.push(
        check(
          'firewall',
          'Firewall',
          status,
          off.length === 0 ? 'On (all profiles)' : `Off: ${off.map((p) => p.name).join(', ')}`,
          detail,
          off.length ? 'Turn the firewall on for every profile.' : ''
        )
      );
    }
  }

  const ss = String(raw.smartscreen || '').toLowerCase();
  const ssOff = ss === 'off';
  protection.push(
    check(
      'smartscreen',
      'SmartScreen',
      ssOff ? 'warn' : 'good',
      ssOff ? 'Off' : ss ? ss.replace(/^\w/, (c) => c.toUpperCase()) : 'On (default)',
      '',
      ssOff ? 'Screens malicious downloads and sites.' : ''
    )
  );
  section('Protection', protection);

  // --- Encryption ---
  const encryption = [];
  const bl = raw.bitlocker || {};
  if (!bl.supported) {
    encryption.push(check('bitlocker', 'Drive encryption', 'info', 'Not available', 'This Windows edition has no BitLocker', ''));
  } else if (bl.error) {
    encryption.push(check('bitlocker', 'BitLocker', 'unknown', 'Needs admin', 'Run as administrator to read encryption status', 'Restart as admin to check BitLocker.'));
  } else {
    const vols = bl.volumes || [];
    const cVol = vols.find((v) => /^C:/i.test(v.mount)) || vols[0];
    if (!cVol) {
      encryption.push(check('bitlocker', 'BitLocker', 'unknown', 'No volumes reported', '', ''));
    } else {
      const on = /^on$/i.test(cVol.protection);
      encryption.push(
        check(
          'bitlocker',
          'BitLocker (C:)',
          on ? 'good' : 'warn',
          on ? 'On' : 'Off',
          vols.map((v) => `${v.mount} ${v.protection}`).join(' · '),
          on ? '' : 'The system drive is not encrypted.'
        )
      );
    }
  }
  section('Encryption', encryption);

  // --- Access control ---
  const access = [];
  const uac = raw.uac;
  if (uac) {
    const on = uac.enableLUA === 1;
    access.push(check('uac', 'User Account Control', on ? 'good' : 'bad', on ? 'On' : 'Off', on ? '' : 'UAC prompts are disabled', on ? '' : 'Turn UAC back on — off is a major risk.'));
  }
  const acc = raw.accounts || {};
  const admins = acc.admins || [];
  if (admins.length) {
    access.push(check('admins', 'Administrator accounts', admins.length > 2 ? 'warn' : 'info', `${admins.length}`, admins.join(', '), admins.length > 2 ? 'More admins than usual — confirm each is expected.' : ''));
  }
  const users = acc.users || [];
  const risky = users.filter((u) => u.enabled && !u.passwordRequired);
  if (risky.length) {
    access.push(check('blank-pw', 'Accounts without a password', 'warn', `${risky.length}`, risky.map((u) => u.name).join(', '), 'An enabled account with no required password can be logged into freely.'));
  }
  const builtinAdmin = users.find((u) => /^Administrator$/i.test(u.name) && u.enabled);
  if (builtinAdmin) {
    access.push(check('builtin-admin', 'Built-in Administrator', 'warn', 'Enabled', 'The hidden Administrator account is active', 'Usually best left disabled.'));
  }
  if (access.length) section('Access control', access);

  // --- Maintenance ---
  const maintenance = [];
  const rb = raw.reboot || {};
  const pending = rb.cbs || rb.windowsUpdate || rb.fileRename || rb.rename;
  const reasons = [];
  if (rb.cbs) reasons.push('servicing');
  if (rb.windowsUpdate) reasons.push('Windows Update');
  if (rb.fileRename) reasons.push('file replace on reboot');
  if (rb.rename) reasons.push('computer rename');
  maintenance.push(
    check(
      'reboot',
      'Pending reboot',
      pending ? 'warn' : 'good',
      pending ? 'Yes' : 'No',
      pending ? reasons.join(', ') : 'Nothing waiting on a restart',
      pending ? 'A restart will settle pending changes.' : ''
    )
  );
  section('Maintenance', maintenance);

  return {
    sections,
    summary: { good, warn, bad, headline: bad ? 'needs attention' : warn ? 'a few things to check' : 'looks healthy' },
  };
}

async function read() {
  const raw = (await ps.json(READ_SCRIPT)) || {};
  return build(raw);
}

module.exports = { read, __scripts: { READ: READ_SCRIPT }, __build: build };
