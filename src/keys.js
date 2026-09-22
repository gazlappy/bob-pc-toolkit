'use strict';

// Recover this machine's *own* product keys — the everyday "I'm reinstalling
// this PC, what's its licence?" task. Read-only: it reads keys already stored
// on the machine, and changes nothing.
//
// Two sources for Windows, because neither is complete on its own:
//   * the BIOS/UEFI-embedded OEM key (OA3xOriginalProductKey) — the genuine key
//     on a machine that shipped with Windows, read straight from firmware;
//   * the DigitalProductId in the registry, Base24-decoded — the key of a
//     retail/boxed install. On a modern digital-licence install this decodes to
//     a generic placeholder, so it is only shown when it verifiably matches the
//     licence's own last-five (from SoftwareLicensingProduct), which proves it
//     is the real, activated key rather than a default.

const ps = require('./ps');

const READ_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'

$slsvc = Get-CimInstance SoftwareLicensingService
$nt = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'

# The activated Windows licence: channel and the last five of its key.
$win = Get-CimInstance SoftwareLicensingProduct -Filter "ApplicationId='55c92734-d682-4d71-983e-d6ec3f16059f' AND PartialProductKey IS NOT NULL" |
  Select-Object -First 1

# Every activated Office licence, if any (Office uses its own ApplicationId).
$office = @(Get-CimInstance SoftwareLicensingProduct -Filter "PartialProductKey IS NOT NULL" |
  Where-Object { $_.ApplicationId -ne '55c92734-d682-4d71-983e-d6ec3f16059f' -and $_.Name -match 'Office|Microsoft 365|Word|Excel|Outlook|Visio|Project' } |
  ForEach-Object {
    [pscustomobject]@{
      name        = [string]$_.Name
      description = [string]$_.Description
      partialKey  = [string]$_.PartialProductKey
      status      = [int]$_.LicenseStatus
    }
  })

# DigitalProductId is a REG_BINARY; hand it back as base64 to decode in JS.
$dpid = $nt.DigitalProductId
$dpidB64 = if ($dpid) { [Convert]::ToBase64String([byte[]]$dpid) } else { $null }

[pscustomobject]@{
  oemKey        = [string]$slsvc.OA3xOriginalProductKey
  oemKeyChannel = [string]$slsvc.OA3xOriginalProductKeyDescription
  edition       = [string]$nt.ProductName
  editionId     = [string]$nt.EditionID
  digitalId     = [string]$nt.DigitalProductId4  # contains the licence channel text
  dpidBase64    = $dpidB64
  winPartial    = if ($win) { [string]$win.PartialProductKey } else { $null }
  winChannel    = if ($win) { [string]$win.Description } else { $null }
  winStatus     = if ($win) { [int]$win.LicenseStatus } else { $null }
  office        = $office
} | ConvertTo-Json -Depth 4 -Compress
`;

const KEY_CHARS = 'BCDFGHJKMPQRTVWXY2346789';

/**
 * Candidate decodings of a Windows DigitalProductId (REG_BINARY).
 *
 * The bytes at offset 52..66 hold the key as a little-endian big integer in
 * base 24, which the loop reads out as 25 characters. Pre-Windows-8 keys are
 * exactly that. Windows 8+ "N" editions instead encode 24 meaningful characters
 * and hide the position of an inserted 'N', and the published formulas for that
 * splice disagree with each other.
 *
 * Rather than trust one formula, every plausible reading is returned and the
 * caller keeps only the one whose last five characters match the licence's own
 * partial key. A wrong key can therefore never be shown — at worst none is.
 */
function decodeCandidates(buffer) {
  if (!buffer || buffer.length < 67) return [];
  const id = Buffer.from(buffer); // a copy — the decode mutates as it divides
  const offset = 52;

  // Byte 66 is part of the 15 the division consumes, and its bit 3 is a flag,
  // not key data — it must be cleared before decoding or every character comes
  // out wrong.
  id[66] &= 0xf7;

  let raw = '';
  let last = 0;
  for (let i = 24; i >= 0; i -= 1) {
    let current = 0;
    for (let j = 14; j >= 0; j -= 1) {
      current = current * 256 + id[offset + j];
      id[offset + j] = Math.floor(current / 24);
      current %= 24;
    }
    last = current;
    raw = KEY_CHARS[current] + raw;
  }

  const format = (chars) => chars.slice(0, 25).match(/.{1,5}/g).join('-');
  const candidates = [raw]; // pre-Win8: the 25 chars as-is

  // Win8+ N-edition splices: drop the placeholder first char, insert 'N' at the
  // recorded position. Both published spellings are offered.
  const body = raw.slice(1);
  candidates.push(body.slice(0, last) + 'N' + body.slice(last));
  candidates.push('N' + body.slice(0, last) + body.slice(last));

  return [...new Set(candidates.map(format))];
}

/** The single decoding whose last five match `partial`, or null if none do. */
function decodeVerified(buffer, partial) {
  if (!partial) return null;
  for (const candidate of decodeCandidates(buffer)) {
    if (candidate.replace(/-/g, '').endsWith(partial)) return candidate;
  }
  return null;
}

const CHANNEL_STATUS = {
  0: 'Unlicensed',
  1: 'Activated',
  2: 'Grace period',
  3: 'Out-of-box grace',
  5: 'Notification',
};

/**
 * Pulls the channel out of a licence name or description. No trailing word
 * boundary: real strings read "OEM_DM channel" and "…ProVL_KMS_Client edition",
 * where the channel word runs straight into an underscore.
 */
function channelOf(description) {
  const text = String(description || '');
  const match = text.match(/(RETAIL|OEM|MAK|KMS|EVALUATION|SUBSCRIPTION)/i);
  if (match) return match[1].toUpperCase();
  // Volume licences are written "…ProVL_…", "…VL edition" or "Volume".
  if (/VOLUME|VL(?=[_\s]|$)/i.test(text)) return 'VOLUME';
  return null;
}

async function read() {
  const data = await ps.json(READ_SCRIPT, { timeout: 30000 });
  if (!data) throw new Error('Could not read licence information.');

  const partial = data.winPartial || null;
  const retailKey = data.dpidBase64
    ? decodeVerified(Buffer.from(data.dpidBase64, 'base64'), partial)
    : null;

  const windows = {
    edition: data.edition || null,
    status: data.winStatus != null ? CHANNEL_STATUS[data.winStatus] || 'Unknown' : null,
    channel: channelOf(data.winChannel),
    partialKey: partial,
    // The genuine key, best source first.
    oemKey: data.oemKey || null,
    oemChannel: channelOf(data.oemKeyChannel) || (data.oemKey ? 'OEM' : null),
    retailKey,
    // A digital licence has no retrievable key: no OEM firmware key, and the
    // DigitalProductId decodes to a placeholder that fails the check above.
    digitalLicence: !data.oemKey && !retailKey,
  };

  const office = ps.arr(data.office).map((item) => ({
    name: item.name,
    edition: (item.description || '').split(',')[0] || item.name,
    channel: channelOf(item.description),
    status: CHANNEL_STATUS[item.status] || 'Unknown',
    partialKey: item.partialKey,
  }));

  return { windows, office };
}

module.exports = { read, __internals: { decodeCandidates, decodeVerified, channelOf } };
