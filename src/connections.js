'use strict';

// Connections — who this PC is actually talking to, and what it is listening
// for. The security companion to Autoruns: malware that has installed itself
// still has to phone home, and this is where that shows up. Read-only.
//
// It pairs every TCP/UDP endpoint with its owning process (name + on-disk path),
// checks that path's Authenticode signature, and flags the combination that
// matters — an unsigned program, or one running from a user-writable folder,
// holding a connection open to a public IP. Loopback and LAN chatter is folded
// down so the genuinely outbound traffic stands out.

const ps = require('./ps');

const signCache = new Map();

const READ_SCRIPT = `
$out = [ordered]@{}
$out.procMap = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{ pid = [int]$_.ProcessId; name = [string]$_.Name; path = [string]$_.ExecutablePath }
})
try {
  $out.tcp = @(Get-NetTCPConnection -ErrorAction Stop | Where-Object { $_.State -eq 'Established' -or $_.State -eq 'Listen' } | ForEach-Object {
    [pscustomobject]@{
      localAddr = [string]$_.LocalAddress; localPort = [int]$_.LocalPort
      remoteAddr = [string]$_.RemoteAddress; remotePort = [int]$_.RemotePort
      state = [string]$_.State; pid = [int]$_.OwningProcess
    }
  })
} catch { $out.tcp = @() }
try {
  $out.udp = @(Get-NetUDPEndpoint -ErrorAction Stop | ForEach-Object {
    [pscustomobject]@{ localAddr = [string]$_.LocalAddress; localPort = [int]$_.LocalPort; pid = [int]$_.OwningProcess }
  })
} catch { $out.udp = @() }
@($out) | ConvertTo-Json -Depth 4 -Compress
`;

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
    // Get-AuthenticodeSignature fetches cert chains over the network for
    // legitimately-signed binaries, so checking them one at a time is slow.
    // Spread them across a small runspace pool to overlap the waits.
    const rows = ps.arr(
      await ps
        .json(`
${ps.payload(need)}
$paths = @($Payload)
$pool = [runspacefactory]::CreateRunspacePool(1, 8)
$pool.Open()
$work = {
  param($f)
  $status = 'Unknown'; $signer = ''
  if (Test-Path -LiteralPath $f -PathType Leaf) {
    try {
      $s = Get-AuthenticodeSignature -LiteralPath $f -ErrorAction Stop
      $status = [string]$s.Status
      if ($s.SignerCertificate) { $signer = [string]$s.SignerCertificate.Subject }
    } catch { $status = 'Error' }
  } else { $status = 'Missing' }
  [pscustomobject]@{ path = $f; status = $status; signer = $signer }
}
$jobs = foreach ($p in $paths) {
  $inst = [powershell]::Create()
  $inst.RunspacePool = $pool
  [void]$inst.AddScript($work).AddArgument($p)
  [pscustomobject]@{ inst = $inst; handle = $inst.BeginInvoke() }
}
$results = foreach ($j in $jobs) {
  try { $j.inst.EndInvoke($j.handle) } catch {} finally { $j.inst.Dispose() }
}
$pool.Close(); $pool.Dispose()
@($results) | ConvertTo-Json -Depth 3 -Compress
`)
        .catch(() => [])
    );
    for (const row of rows) {
      signCache.set(String(row.path).toLowerCase(), { status: row.status, publisher: publisherFrom(row.signer) });
    }
    for (const p of need) if (!signCache.has(p.toLowerCase())) signCache.set(p.toLowerCase(), { status: 'Unknown', publisher: '' });
  }
  const out = {};
  for (const p of paths) if (p) out[p.toLowerCase()] = signCache.get(p.toLowerCase()) || { status: 'Unknown', publisher: '' };
  return out;
}

const USER_WRITABLE = /\\(temp|tmp|appdata|downloads|\$recycle\.bin)\\/i;
const WINDIR = (process.env.WINDIR || 'C:\\Windows').toLowerCase();
const isSystemExe = (exe) => Boolean(exe) && exe.toLowerCase().startsWith(WINDIR);

// Classifies a remote address so LAN and loopback chatter can be folded away
// and only genuinely-public traffic is highlighted.
function scopeOf(addr) {
  if (!addr) return 'local';
  const a = addr.toLowerCase();
  if (a === '127.0.0.1' || a === '::1' || a === '0.0.0.0' || a === '::' || a === '*') return 'local';
  if (a.startsWith('169.254.') || a.startsWith('fe80')) return 'local';
  if (a.startsWith('10.') || a.startsWith('192.168.')) return 'private';
  const m172 = a.match(/^172\.(\d+)\./);
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return 'private';
  if (a.startsWith('fc') || a.startsWith('fd')) return 'private';
  return 'public';
}

function assess(exe, sign, remotePublic) {
  const status = sign ? sign.status : 'Unknown';
  const publisher = sign ? sign.publisher : '';
  const reasons = [];
  // A valid Authenticode signature clears a program regardless of where it
  // lives — plenty of legitimate apps (Slack, Spotify, this one) install
  // per-user in AppData. Location only matters for something unsigned.
  if (exe && status !== 'Valid') {
    if (status === 'Missing') reasons.push('the program file is missing');
    else {
      reasons.push('unsigned program');
      if (USER_WRITABLE.test(exe)) reasons.push('running from a user-writable folder');
    }
  }
  // Only escalate to a flag when there is an actual public connection involved.
  const flagged = remotePublic && reasons.length > 0;
  return { publisher, signed: status === 'Valid', signStatus: status, flagged, flagReason: flagged ? reasons.join(' · ') : '' };
}

async function read() {
  const raw = (await ps.json(READ_SCRIPT)) || {};
  const procMap = new Map();
  for (const p of ps.arr(raw.procMap)) procMap.set(p.pid, { name: p.name || '', path: p.path || '' });

  const tcp = ps.arr(raw.tcp);
  const udp = ps.arr(raw.udp);

  const procOf = (pid) => procMap.get(pid) || { name: pid === 0 ? 'System Idle' : pid === 4 ? 'System' : `PID ${pid}`, path: '' };

  // Sign only the programs that actually own a networked endpoint, and skip the
  // ones under %WINDIR% (svchost, System) — they are catalog-signed system
  // binaries, and signing every one of them is what made this slow.
  const needPids = new Set();
  for (const c of tcp) {
    if (c.state === 'Listen') needPids.add(c.pid);
    else if (c.state === 'Established' && scopeOf(c.remoteAddr) !== 'local') needPids.add(c.pid);
  }
  for (const u of udp) needPids.add(u.pid);
  const toSign = [
    ...new Set(
      [...needPids]
        .map((pid) => procOf(pid).path)
        .filter((p) => p && !isSystemExe(p))
    ),
  ];
  const signs = await signBatch(toSign);
  const signOf = (exe) => {
    if (!exe) return { status: 'Unknown', publisher: '' };
    if (isSystemExe(exe)) return { status: 'Valid', publisher: 'Windows' };
    return signs[exe.toLowerCase()] || { status: 'Unknown', publisher: '' };
  };

  // --- Outbound (established, non-local remote) ---
  const outMap = new Map(); // key: pid|remoteAddr|remotePort
  for (const c of tcp) {
    if (c.state !== 'Established') continue;
    const scope = scopeOf(c.remoteAddr);
    if (scope === 'local') continue;
    const proc = procOf(c.pid);
    const key = `${c.pid}|${c.remoteAddr}|${c.remotePort}`;
    if (outMap.has(key)) {
      outMap.get(key).count += 1;
      continue;
    }
    const info = assess(proc.path, signOf(proc.path), scope === 'public');
    outMap.set(key, {
      id: `out::${key}`,
      process: proc.name,
      pid: c.pid,
      exe: proc.path,
      remoteAddr: c.remoteAddr,
      remotePort: c.remotePort,
      scope,
      count: 1,
      ...info,
    });
  }
  const outbound = [...outMap.values()].sort((a, b) => Number(b.flagged) - Number(a.flagged) || a.process.localeCompare(b.process));

  // --- Listening (TCP Listen + UDP endpoints) ---
  const listenMap = new Map(); // key: proto|localPort|pid
  const addListen = (proto, addr, port, pid) => {
    const key = `${proto}|${port}|${pid}`;
    if (listenMap.has(key)) return;
    const proc = procOf(pid);
    const bound = addr === '0.0.0.0' || addr === '::' || addr === '*' ? 'all' : scopeOf(addr) === 'local' ? 'loopback' : 'lan';
    const info = assess(proc.path, signOf(proc.path), bound === 'all');
    listenMap.set(key, {
      id: `listen::${key}`,
      proto,
      process: proc.name,
      pid,
      exe: proc.path,
      localAddr: addr,
      localPort: port,
      bound,
      ...info,
    });
  };
  for (const c of tcp) if (c.state === 'Listen') addListen('TCP', c.localAddr, c.localPort, c.pid);
  for (const u of udp) addListen('UDP', u.localAddr, u.localPort, u.pid);
  const listening = [...listenMap.values()].sort(
    (a, b) => Number(b.flagged) - Number(a.flagged) || a.localPort - b.localPort
  );

  const flagged = outbound.filter((x) => x.flagged).length + listening.filter((x) => x.flagged).length;
  const publicOut = outbound.filter((x) => x.scope === 'public').length;

  return {
    outbound,
    listening,
    summary: { outbound: outbound.length, listening: listening.length, flagged, publicOut },
  };
}

module.exports = { read, __scripts: { READ: READ_SCRIPT }, __internals: { scopeOf, assess } };
