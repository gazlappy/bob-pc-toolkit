'use strict';

// BitLocker — the drive-encryption controls a bench tech actually reaches for:
// see each volume's state, recover and save the 48-digit recovery keys this
// machine already holds (own-machine recovery, like the product-key and Wi-Fi
// tools), and suspend protection before a firmware/BIOS update so the box does
// not demand a key on the next reboot. Turning encryption *off* (decrypt) is
// here too, behind a confirm.
//
// Everything BitLocker needs administrator rights, so unelevated the tab reports
// "needs admin" rather than a blank. Enabling BitLocker from scratch is
// deliberately NOT here — getting a protector or key-backup wrong can lock a
// user out for good, so that stays with Windows' own wizard.

const ps = require('./ps');

const STATUS_SCRIPT = `
if (-not (Get-Command Get-BitLockerVolume -ErrorAction SilentlyContinue)) {
  [pscustomobject]@{ supported = $false } | ConvertTo-Json -Compress
} else {
  try {
    $vols = Get-BitLockerVolume -ErrorAction Stop | ForEach-Object {
      $v = $_
      $protectors = @($v.KeyProtector | ForEach-Object {
        [pscustomobject]@{
          id               = [string]$_.KeyProtectorId
          type             = [string]$_.KeyProtectorType
          recoveryPassword = [string]$_.RecoveryPassword
        }
      })
      [pscustomobject]@{
        mount        = [string]$v.MountPoint
        volumeType   = [string]$v.VolumeType
        protection   = [string]$v.ProtectionStatus
        volumeStatus = [string]$v.VolumeStatus
        percent      = [int]$v.EncryptionPercentage
        method       = [string]$v.EncryptionMethod
        lock         = [string]$v.LockStatus
        protectors   = $protectors
      }
    }
    [pscustomobject]@{ supported = $true; adminNeeded = $false; volumes = @($vols) } | ConvertTo-Json -Depth 5 -Compress
  } catch {
    if ($_.Exception.Message -match 'denied|elevation') {
      [pscustomobject]@{ supported = $true; adminNeeded = $true; volumes = @() } | ConvertTo-Json -Compress
    } else {
      [pscustomobject]@{ supported = $true; adminNeeded = $false; error = [string]$_.Exception.Message; volumes = @() } | ConvertTo-Json -Compress
    }
  }
}
`;

function friendlyError(err) {
  if (/denied|elevation/i.test(err.message)) {
    return new Error('BitLocker needs administrator rights. Restart as admin, then try again.');
  }
  return err;
}

function cleanMount(mount) {
  const m = String(mount || '').replace(/[^A-Za-z]/g, '').slice(0, 1);
  if (!m) throw new Error('No drive given.');
  return `${m.toUpperCase()}:`;
}

async function status() {
  const raw = (await ps.json(STATUS_SCRIPT)) || {};
  if (!raw.supported) return { supported: false, adminNeeded: false, volumes: [] };
  if (raw.adminNeeded) return { supported: true, adminNeeded: true, volumes: [] };

  const volumes = ps.arr(raw.volumes).map((v) => {
    const protectors = ps.arr(v.protectors);
    const recoveryKeys = protectors
      .filter((p) => /RecoveryPassword/i.test(p.type) && p.recoveryPassword)
      .map((p) => ({ id: p.id, key: p.recoveryPassword }));
    return {
      mount: v.mount,
      volumeType: v.volumeType,
      isOs: /operatingsystem/i.test(v.volumeType || ''),
      protection: v.protection, // On / Off
      protectionOn: /^on$/i.test(v.protection || ''),
      volumeStatus: v.volumeStatus,
      percent: Number(v.percent) || 0,
      method: v.method && v.method !== 'None' ? v.method : '',
      lock: v.lock,
      locked: /^locked$/i.test(v.lock || ''),
      protectorTypes: [...new Set(protectors.map((p) => p.type).filter(Boolean))],
      recoveryKeys,
    };
  });
  return { supported: true, adminNeeded: false, volumes };
}

async function suspend(mount) {
  const m = cleanMount(mount);
  try {
    // RebootCount 0 = stay suspended until Resume is run (the safe choice before
    // a BIOS/firmware update, which may reboot more than once).
    await ps.mutate(`
${ps.payload({ m })}
  Suspend-BitLocker -MountPoint $Payload.m -RebootCount 0 -ErrorAction Stop | Out-Null
`);
  } catch (err) {
    throw friendlyError(err);
  }
  return { mount: m, action: 'suspend' };
}

async function resume(mount) {
  const m = cleanMount(mount);
  try {
    await ps.mutate(`
${ps.payload({ m })}
  Resume-BitLocker -MountPoint $Payload.m -ErrorAction Stop | Out-Null
`);
  } catch (err) {
    throw friendlyError(err);
  }
  return { mount: m, action: 'resume' };
}

async function decrypt(mount) {
  const m = cleanMount(mount);
  try {
    // Starts background decryption; the data is kept, only the encryption is
    // removed. Progress shows up in status as DecryptionInProgress.
    await ps.mutate(`
${ps.payload({ m })}
  Disable-BitLocker -MountPoint $Payload.m -ErrorAction Stop | Out-Null
`);
  } catch (err) {
    throw friendlyError(err);
  }
  return { mount: m, action: 'decrypt' };
}

module.exports = { status, suspend, resume, decrypt, __scripts: { STATUS: STATUS_SCRIPT } };
