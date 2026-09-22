'use strict';

// Network toolkit: see the adapters at a glance, run the everyday fixes
// (flush DNS, renew the lease, reset the stack), and ping / trace a host with
// the output streaming in live rather than hidden in a console window.
//
// The live tools are spawned directly (ping.exe / tracert.exe), not through the
// PowerShell host, because the host is request/response and these need their
// lines forwarded as they arrive. Each run gets an id so the renderer can stop
// it; the host is only used for the one-shot read and the fix actions.

const { spawn } = require('child_process');
const ps = require('./ps');

const INFO_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'

$adapters = @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled = True' | ForEach-Object {
  $cfg = $_
  $adapter = Get-CimInstance Win32_NetworkAdapter -Filter "Index = $($cfg.Index)"
  [pscustomobject]@{
    name        = [string]$cfg.Description
    connection  = [string]$adapter.NetConnectionID
    mac         = [string]$cfg.MACAddress
    dhcp        = [bool]$cfg.DHCPEnabled
    ipv4        = @($cfg.IPAddress | Where-Object { $_ -match '^\\d+\\.\\d+\\.\\d+\\.\\d+$' })
    ipv6        = @($cfg.IPAddress | Where-Object { $_ -match ':' })
    subnet      = [string](@($cfg.IPSubnet | Where-Object { $_ -match '^\\d+\\.' }) | Select-Object -First 1)
    gateway     = [string](@($cfg.DefaultIPGateway) | Select-Object -First 1)
    dns         = @($cfg.DNSServerSearchOrder)
    dhcpServer  = [string]$cfg.DHCPServer
    speed       = [double]$adapter.Speed
  }
})

[pscustomobject]@{
  hostName = [string]$env:COMPUTERNAME
  adapters = $adapters
} | ConvertTo-Json -Depth 5 -Compress
`;

async function info() {
  const data = await ps.json(INFO_SCRIPT, { timeout: 30000 });
  if (!data) throw new Error('Could not read the network configuration.');
  return {
    hostName: data.hostName || '',
    adapters: ps.arr(data.adapters).map((a) => ({
      name: a.name,
      connection: a.connection || null,
      mac: a.mac || null,
      dhcp: Boolean(a.dhcp),
      ipv4: ps.arr(a.ipv4),
      ipv6: ps.arr(a.ipv6),
      subnet: a.subnet || null,
      gateway: a.gateway || null,
      dns: ps.arr(a.dns),
      dhcpServer: a.dhcpServer || null,
      speedMbps: a.speed ? Math.round(a.speed / 1e6) : null,
    })),
  };
}

// --- fix actions ----------------------------------------------------------

const ACTIONS = {
  flushDns: {
    label: 'Flush DNS cache',
    needsAdmin: false,
    run: 'ipconfig /flushdns | Out-Null',
    done: 'DNS resolver cache cleared.',
  },
  renew: {
    label: 'Release & renew IP',
    needsAdmin: false,
    run: 'ipconfig /release | Out-Null; ipconfig /renew | Out-Null',
    done: 'IP address released and renewed.',
  },
  resetWinsock: {
    label: 'Reset Winsock',
    needsAdmin: true,
    run: 'netsh winsock reset | Out-Null',
    done: 'Winsock catalog reset. Restart the PC to finish.',
  },
  resetStack: {
    label: 'Reset TCP/IP stack',
    needsAdmin: true,
    run: 'netsh int ip reset | Out-Null',
    done: 'TCP/IP stack reset. Restart the PC to finish.',
  },
};

function actionList() {
  return Object.entries(ACTIONS).map(([id, a]) => ({ id, label: a.label, needsAdmin: a.needsAdmin }));
}

async function runAction(id) {
  const action = ACTIONS[id];
  if (!action) throw new Error('Unknown action.');
  await ps.mutate(action.run, { timeout: 60000 });
  return { message: action.done };
}

// --- live ping / traceroute ----------------------------------------------

// Only a plausible host or IP may reach the command line. Even though args are
// passed as an array (no shell), this refuses anything that could be read as a
// flag or is obviously not a host.
function cleanHost(input) {
  const host = String(input || '').trim();
  if (!host || host.length > 255) return null;
  if (host.startsWith('-') || host.startsWith('/')) return null;
  if (!/^[A-Za-z0-9._:\-]+$/.test(host)) return null;
  return host;
}

const running = new Map();
let nextId = 1;

/**
 * Spawns `ping`/`tracert` for `host` and streams its output.
 * `onEvent` receives { id, line } for each line and { id, done, code } at exit.
 * Returns the run id, or throws if the host is invalid.
 */
function startLive(kind, host, onEvent) {
  const clean = cleanHost(host);
  if (!clean) throw new Error('Enter a valid host name or IP address.');

  const id = nextId++;
  const exe = kind === 'trace' ? 'tracert.exe' : 'ping.exe';
  // ping -t runs until stopped; tracert runs to completion. -d on tracert skips
  // reverse-DNS so it is not painfully slow.
  const args = kind === 'trace' ? ['-d', '-h', '20', clean] : ['-t', clean];

  const child = spawn(exe, args, { windowsHide: true });
  running.set(id, child);

  let buffer = '';
  const emitLines = (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) {
      if (line.trim()) onEvent({ id, line: line.trimEnd() });
    }
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', emitLines);
  child.stderr.on('data', emitLines);
  child.on('error', (error) => {
    onEvent({ id, line: `Could not start ${exe}: ${error.message}` });
  });
  child.on('close', (code) => {
    if (buffer.trim()) onEvent({ id, line: buffer.trimEnd() });
    running.delete(id);
    onEvent({ id, done: true, code });
  });

  return id;
}

function stopLive(id) {
  const child = running.get(id);
  if (child) {
    child.kill();
    running.delete(id);
  }
  return true;
}

function stopAll() {
  for (const child of running.values()) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  running.clear();
}

module.exports = { info, actionList, runAction, startLive, stopLive, stopAll, __internals: { cleanHost } };
