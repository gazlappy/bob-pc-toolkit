'use strict';

// Event & crash viewer: the "why is this PC misbehaving" tool. Read-only — it
// reads the Windows event logs and changes nothing.
//
// Two things a technician wants from the logs:
//   * a stability timeline — the blue screens, unexpected shutdowns and app
//     crashes, which are scattered across specific event IDs;
//   * the recent error/warning feed, filterable and searchable, with a
//     plain-English hint for the IDs that come up again and again.
//
// The Security log is deliberately not read: it needs administrator rights and
// is mostly audit noise for this purpose. System and Application are readable by
// a standard user.

const ps = require('./ps');

// Events that mark a real stability problem, whatever their level. Keyed by
// "provider|id" so the same id under different providers does not collide.
const STABILITY = {
  'Microsoft-Windows-Kernel-Power|41': { kind: 'crash', label: 'Unexpected shutdown or crash' },
  'Microsoft-Windows-WER-SystemErrorReporting|1001': { kind: 'bsod', label: 'Blue screen (BugCheck)' },
  'EventLog|6008': { kind: 'crash', label: 'Previous shutdown was unexpected' },
  'Application Error|1000': { kind: 'appcrash', label: 'Application crashed' },
  'Application Hang|1002': { kind: 'apphang', label: 'Application stopped responding' },
  '.NET Runtime|1026': { kind: 'appcrash', label: '.NET application crash' },
  'Microsoft-Windows-WER-SystemErrorReporting|1018': { kind: 'bsod', label: 'Blue screen (BugCheck)' },
};

const STABILITY_IDS = [...new Set(Object.keys(STABILITY).map((k) => Number(k.split('|')[1])))];

// Plain-English hints for IDs that turn up a lot. Keyed provider-first, with a
// bare-id fallback for the generic ones.
const HINTS = {
  'Microsoft-Windows-Kernel-Power|41':
    'The PC restarted without shutting down cleanly first — a crash, a power cut, or a forced reset (holding the power button).',
  'Microsoft-Windows-WER-SystemErrorReporting|1001':
    'A blue screen. The bugcheck code in the message points at the cause — often a driver.',
  'EventLog|6008': 'The last shutdown was unexpected — the PC lost power or was reset rather than shut down.',
  'Application Error|1000': 'A program crashed. The faulting module in the message is usually the culprit.',
  'Application Hang|1002': 'A program stopped responding and had to be closed.',
  'Microsoft-Windows-DistributedCOM|10016':
    'A DCOM permission warning. Almost always harmless noise — Microsoft advises leaving it alone.',
  'disk|51': 'A disk had trouble reading or writing. Worth checking that drive’s health.',
  'disk|7': 'A bad block was found on a disk. Back up and check that drive.',
  'disk|11': 'A disk controller error. Often a cable or a failing drive.',
  'Ntfs|55': 'File-system corruption was found on a volume. Running chkdsk is the fix.',
  'Microsoft-Windows-DNS-Client|1014': 'A DNS name lookup timed out — usually a brief network blip.',
  'Service Control Manager|7031': 'A service stopped unexpectedly and Windows restarted it.',
  'Service Control Manager|7034': 'A service stopped unexpectedly.',
  'Service Control Manager|7000': 'A service failed to start.',
  'Microsoft-Windows-Kernel-PnP|219': 'A driver failed to load for a device.',
  'Microsoft-Windows-Security-SPP|8233':
    'A volume-licence activation check failed. Harmless unless this PC is meant to be on a volume licence.',
  'Microsoft-Windows-Security-SPP|8198': 'A licence activation check failed. Usually harmless.',
};

const LEVEL = { 1: 'Critical', 2: 'Error', 3: 'Warning', 4: 'Information' };

function hintFor(provider, id) {
  return HINTS[`${provider}|${id}`] || HINTS[`${String(provider).toLowerCase()}|${id}`] || null;
}

const READ_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$since = (Get-Date).AddDays(-14)
$sinceStability = (Get-Date).AddDays(-45)

function Pack($events) {
  @($events | ForEach-Object {
    [pscustomobject]@{
      time     = $_.TimeCreated.ToString('o')
      log      = [string]$_.LogName
      level    = [int]$_.Level
      provider = [string]$_.ProviderName
      id       = [int]$_.Id
      message  = if ($_.Message) { ($_.Message -split "\`r?\`n")[0].Trim() } else { '' }
      full     = [string]$_.Message
    }
  })
}

$errors = Pack (Get-WinEvent -FilterHashtable @{ LogName = 'System','Application'; Level = 1,2,3; StartTime = $since } -MaxEvents 400)
$stability = Pack (Get-WinEvent -FilterHashtable @{ LogName = 'System','Application'; Id = ${STABILITY_IDS.join(',')}; StartTime = $sinceStability } -MaxEvents 120)

[pscustomobject]@{ errors = $errors; stability = $stability } | ConvertTo-Json -Depth 4 -Compress
`;

function shape(row) {
  return {
    time: row.time,
    log: row.log,
    level: LEVEL[row.level] || 'Information',
    levelNum: row.level,
    provider: row.provider,
    id: row.id,
    message: row.message || '(no message text)',
    full: row.full || row.message || '',
    hint: hintFor(row.provider, row.id),
  };
}

async function read() {
  const data = await ps.json(READ_SCRIPT, { timeout: 60000 });
  if (!data) throw new Error('Could not read the event logs.');

  const errors = ps.arr(data.errors).map(shape);

  // The same event fires over and over (a service retrying, an activation check
  // every few hours). Collapse identical ones into a counted group so the feed
  // is readable — 300 rows become a few dozen.
  const map = new Map();
  for (const e of errors) {
    const key = `${e.provider}|${e.id}|${e.level}`;
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
      if (e.time > existing.latest) {
        existing.latest = e.time;
        existing.message = e.message;
        existing.full = e.full;
      }
    } else {
      map.set(key, {
        provider: e.provider,
        id: e.id,
        level: e.level,
        levelNum: e.levelNum,
        log: e.log,
        message: e.message,
        full: e.full,
        hint: e.hint,
        count: 1,
        latest: e.time,
      });
    }
  }
  const groups = [...map.values()].sort((a, b) => b.latest.localeCompare(a.latest));

  // Only classified crash/shutdown events reach the timeline — the generic WER
  // fault reports (kind "other") just duplicate the Application Error entries.
  const stability = ps
    .arr(data.stability)
    .map((row) => {
      const meta = STABILITY[`${row.provider}|${row.id}`];
      if (!meta) return null;
      let detail = '';
      if (meta.kind === 'appcrash' || meta.kind === 'apphang') {
        const m = String(row.full || row.message).match(/^\s*(?:Faulting application name:\s*)?([^\s,]+\.exe)/i);
        detail = m ? m[1] : '';
      } else if (meta.kind === 'bsod') {
        const m = String(row.full || row.message).match(/0x[0-9A-Fa-f]{8}/);
        detail = m ? m[0] : '';
      }
      return { time: row.time, kind: meta.kind, label: meta.label, detail, id: row.id, provider: row.provider, full: row.full };
    })
    .filter(Boolean)
    .sort((a, b) => b.time.localeCompare(a.time));

  const summary = {
    bsod: stability.filter((s) => s.kind === 'bsod').length,
    crash: stability.filter((s) => s.kind === 'crash').length,
    appcrash: stability.filter((s) => s.kind === 'appcrash' || s.kind === 'apphang').length,
    errors: groups.filter((g) => g.levelNum <= 2).reduce((n, g) => n + g.count, 0),
    warnings: groups.filter((g) => g.levelNum === 3).reduce((n, g) => n + g.count, 0),
    days: 14,
  };

  return { groups, stability, summary };
}

module.exports = { read, __internals: { hintFor, STABILITY_IDS } };
