'use strict';

// Local accounts — the everyday "a customer forgot their password" and "this
// machine needs a clean admin account" jobs, done the supported way: on the
// running machine, as an administrator, through the same Local Users and Groups
// APIs that Computer Management uses. Resetting a password you administer is not
// recovering the old one (Windows keeps only a one-way hash, so there is nothing
// to recover) — it sets a new one you choose.
//
// Every change needs admin. The destructive ones are guarded server-side as
// well as in the UI: you cannot delete or disable the account you are signed in
// with, and the built-in accounts (RID < 1000) cannot be deleted.

const ps = require('./ps');

const CURRENT_USER = (process.env.USERNAME || '').toLowerCase();

const LIST_SCRIPT = `
$adminSids = New-Object System.Collections.Generic.HashSet[string]
try {
  Get-LocalGroupMember -Group 'Administrators' -ErrorAction Stop | ForEach-Object { [void]$adminSids.Add([string]$_.SID) }
} catch {}
$users = Get-LocalUser | ForEach-Object {
  $sid = [string]$_.SID
  $rid = 0
  if ($sid -match '-(\\d+)$') { $rid = [int]$matches[1] }
  [pscustomobject]@{
    name             = [string]$_.Name
    fullName         = [string]$_.FullName
    description      = [string]$_.Description
    enabled          = [bool]$_.Enabled
    passwordRequired = [bool]$_.PasswordRequired
    passwordLastSet  = if ($_.PasswordLastSet) { $_.PasswordLastSet.ToString('yyyy-MM-dd') } else { '' }
    lastLogon        = if ($_.LastLogon) { $_.LastLogon.ToString('yyyy-MM-dd') } else { '' }
    sid              = $sid
    rid              = $rid
    isAdmin          = $adminSids.Contains($sid)
  }
}
@($users) | ConvertTo-Json -Depth 4 -Compress
`;

// Local account names: 1–20 chars, and none of the characters Windows forbids;
// cannot be only dots/spaces or end in a dot.
const INVALID_NAME = /["/\\[\]:;|=,+*?<>@]/;
function validateName(name) {
  const n = String(name || '').trim();
  if (!n) throw new Error('Enter a user name.');
  if (n.length > 20) throw new Error('User names are at most 20 characters.');
  if (INVALID_NAME.test(n)) throw new Error('That name contains a character Windows does not allow.');
  if (/^[. ]+$/.test(n) || n.endsWith('.')) throw new Error('That name is not allowed.');
  return n;
}

function friendlyError(err) {
  if (/denied|elevation/i.test(err.message)) {
    return new Error('This needs administrator rights. Restart as admin from the banner, then try again.');
  }
  if (/password does not meet|policy/i.test(err.message)) {
    return new Error('The password does not meet this machine’s policy (length or complexity).');
  }
  return err;
}

async function list() {
  const rows = ps.arr(await ps.json(LIST_SCRIPT));
  const users = rows
    .map((u) => ({
      ...u,
      isBuiltin: (u.rid || 0) < 1000,
      isCurrent: String(u.name).toLowerCase() === CURRENT_USER,
    }))
    .sort((a, b) => Number(b.isAdmin) - Number(a.isAdmin) || a.name.localeCompare(b.name));
  const admins = users.filter((u) => u.isAdmin && u.enabled).length;
  return { users, summary: { total: users.length, admins, current: process.env.USERNAME || '' } };
}

async function create({ name, password, fullName, admin } = {}) {
  const clean = validateName(name);
  try {
    await ps.mutate(`
${ps.payload({ name: clean, password: password || '', fullName: fullName || '', admin: Boolean(admin) })}
  $name = $Payload.name
  if ($Payload.password) {
    $sec = ConvertTo-SecureString $Payload.password -AsPlainText -Force
    New-LocalUser -Name $name -Password $sec -FullName $Payload.fullName -AccountNeverExpires -ErrorAction Stop | Out-Null
  } else {
    New-LocalUser -Name $name -NoPassword -FullName $Payload.fullName -AccountNeverExpires -ErrorAction Stop | Out-Null
  }
  if ($Payload.admin) { Add-LocalGroupMember -Group 'Administrators' -Member $name -ErrorAction Stop }
`);
  } catch (err) {
    throw friendlyError(err);
  }
  return { name: clean };
}

async function setPassword(name, password) {
  const clean = validateName(name);
  try {
    await ps.mutate(`
${ps.payload({ name: clean, password: password || '', blank: !password })}
  $name = $Payload.name
  if ($Payload.blank) {
    $sec = New-Object System.Security.SecureString
  } else {
    $sec = ConvertTo-SecureString $Payload.password -AsPlainText -Force
  }
  Set-LocalUser -Name $name -Password $sec -ErrorAction Stop
`);
  } catch (err) {
    throw friendlyError(err);
  }
  return { name: clean, blanked: !password };
}

async function setEnabled(name, enabled) {
  const clean = validateName(name);
  try {
    await ps.mutate(`
${ps.payload({ name: clean, enabled: Boolean(enabled) })}
  $name = $Payload.name
  if (-not $Payload.enabled -and ($name -ieq $env:USERNAME)) { throw 'You cannot disable the account you are signed in with.' }
  if ($Payload.enabled) { Enable-LocalUser -Name $name -ErrorAction Stop } else { Disable-LocalUser -Name $name -ErrorAction Stop }
`);
  } catch (err) {
    throw friendlyError(err);
  }
  return { name: clean, enabled: Boolean(enabled) };
}

async function setAdmin(name, isAdmin) {
  const clean = validateName(name);
  try {
    await ps.mutate(`
${ps.payload({ name: clean, admin: Boolean(isAdmin) })}
  $name = $Payload.name
  if (-not $Payload.admin -and ($name -ieq $env:USERNAME)) { throw 'You cannot remove your own account from the Administrators group.' }
  if ($Payload.admin) {
    Add-LocalGroupMember -Group 'Administrators' -Member $name -ErrorAction Stop
  } else {
    Remove-LocalGroupMember -Group 'Administrators' -Member $name -ErrorAction Stop
  }
`);
  } catch (err) {
    throw friendlyError(err);
  }
  return { name: clean, isAdmin: Boolean(isAdmin) };
}

async function remove(name) {
  const clean = validateName(name);
  try {
    await ps.mutate(`
${ps.payload({ name: clean })}
  $name = $Payload.name
  $u = Get-LocalUser -Name $name -ErrorAction Stop
  $sid = [string]$u.SID
  if ($sid -match '-(\\d+)$' -and [int]$matches[1] -lt 1000) { throw 'Built-in accounts cannot be removed.' }
  if ($name -ieq $env:USERNAME) { throw 'You cannot delete the account you are signed in with.' }
  Remove-LocalUser -Name $name -ErrorAction Stop
`);
  } catch (err) {
    throw friendlyError(err);
  }
  return { name: clean };
}

module.exports = { list, create, setPassword, setEnabled, setAdmin, remove, __validateName: validateName, __scripts: { LIST: LIST_SCRIPT } };
