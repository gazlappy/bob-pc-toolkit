'use strict';

// Wi-Fi key recovery — the passwords this machine already has saved, so after a
// reset or reinstall the PC (and the customer's other kit) can get back online
// without hunting for the router sticker. Own-machine recovery, the same idea as
// the product-key tool: it only ever reads the WLAN profiles stored on this PC,
// via Windows' own `netsh wlan`. Windows keeps the key encrypted under the
// SYSTEM account, so `key=clear` only returns it when running as administrator —
// unelevated, the networks list but the passwords stay hidden.

const ps = require('./ps');

const READ_SCRIPT = `
$out = [ordered]@{}
$prof = (netsh wlan show profiles) | Out-String
$out.profilesRaw = $prof
$names = [regex]::Matches($prof, '(?im)^\\s*(?:All User|User) Profile(?:\\s*\\(.*\\))?\\s*:\\s*(.+?)\\s*$') | ForEach-Object { $_.Groups[1].Value.Trim() }
$details = @()
foreach ($n in $names) {
  $d = (netsh wlan show profile name="$n" key=clear) | Out-String
  $details += [pscustomobject]@{ name = $n; raw = $d }
}
$out.details = $details
@($out) | ConvertTo-Json -Depth 4 -Compress
`;

function field(text, label) {
  const m = new RegExp(`${label}\\s*:\\s*(.+)`, 'i').exec(text || '');
  return m ? m[1].trim() : '';
}

async function list() {
  const raw = await ps.json(READ_SCRIPT).catch(() => null);
  const profilesRaw = (raw && raw.profilesRaw) || '';
  if (/there is no wireless interface|no such service|is not running/i.test(profilesRaw)) {
    return { supported: false, profiles: [], adminNeeded: false };
  }

  const details = ps.arr(raw && raw.details);
  const profiles = details.map((d) => {
    const auth = field(d.raw, 'Authentication');
    const key = field(d.raw, 'Key Content');
    const open = /open/i.test(auth) && !key;
    return {
      name: d.name,
      auth: auth || (open ? 'Open' : ''),
      key,
      hasKey: Boolean(key),
      open,
    };
  });

  // If no secured profile revealed a key, we are almost certainly unelevated.
  const securedWithoutKey = profiles.some((p) => !p.open && !p.hasKey);
  const anyKey = profiles.some((p) => p.hasKey);
  return {
    supported: true,
    profiles: profiles.sort((a, b) => a.name.localeCompare(b.name)),
    adminNeeded: securedWithoutKey && !anyKey,
  };
}

module.exports = { list, __scripts: { READ: READ_SCRIPT } };
