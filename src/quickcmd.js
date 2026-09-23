'use strict';

// Quick commands — the tools a bench tech opens twenty times a day, as buttons.
// Two kinds: 'launch' opens one of Windows' own consoles or control panels
// (Device Manager, Disk Management, Services…), and 'action' runs a short
// maintenance command and reports what happened.
//
// The renderer only ever sends a tool id; the actual command is resolved here
// from this fixed table, so nothing the UI sends can turn into an arbitrary
// command line.

const ps = require('./ps');

const TOOLS = [
  // Consoles
  { id: 'devmgmt', group: 'Consoles', label: 'Device Manager', file: 'devmgmt.msc', desc: 'Devices and drivers' },
  { id: 'diskmgmt', group: 'Consoles', label: 'Disk Management', file: 'diskmgmt.msc', desc: 'Partitions and volumes' },
  { id: 'services', group: 'Consoles', label: 'Services', file: 'services.msc', desc: 'Windows services' },
  { id: 'eventvwr', group: 'Consoles', label: 'Event Viewer', file: 'eventvwr.msc', desc: 'System and application logs' },
  { id: 'taskschd', group: 'Consoles', label: 'Task Scheduler', file: 'taskschd.msc', desc: 'Scheduled tasks' },
  { id: 'compmgmt', group: 'Consoles', label: 'Computer Management', file: 'compmgmt.msc', desc: 'The lot in one console' },
  { id: 'perfmon-rel', group: 'Consoles', label: 'Reliability Monitor', file: 'perfmon', args: '/rel', desc: 'Stability timeline' },
  { id: 'resmon', group: 'Consoles', label: 'Resource Monitor', file: 'resmon', desc: 'Live CPU/disk/net detail' },

  // System tools
  { id: 'msinfo32', group: 'System tools', label: 'System Information', file: 'msinfo32', desc: 'Full spec sheet' },
  { id: 'dxdiag', group: 'System tools', label: 'DirectX Diagnostic', file: 'dxdiag', desc: 'Graphics and sound' },
  { id: 'msconfig', group: 'System tools', label: 'System Configuration', file: 'msconfig', desc: 'Boot and services' },
  { id: 'regedit', group: 'System tools', label: 'Registry Editor', file: 'regedit', desc: 'Edit the registry' },
  { id: 'sysdm', group: 'System tools', label: 'System Properties', file: 'control', args: 'sysdm.cpl', desc: 'Name, restore, remote' },
  { id: 'netplwiz', group: 'System tools', label: 'User Accounts', file: 'netplwiz', desc: 'Classic user accounts' },

  // Control panels
  { id: 'appwiz', group: 'Control panels', label: 'Programs & Features', file: 'control', args: 'appwiz.cpl', desc: 'Uninstall programs' },
  { id: 'ncpa', group: 'Control panels', label: 'Network Connections', file: 'control', args: 'ncpa.cpl', desc: 'Adapters' },
  { id: 'powercfg', group: 'Control panels', label: 'Power Options', file: 'control', args: 'powercfg.cpl', desc: 'Power plans' },
  { id: 'mmsys', group: 'Control panels', label: 'Sound', file: 'control', args: 'mmsys.cpl', desc: 'Playback and recording' },
  { id: 'optionalfeatures', group: 'Control panels', label: 'Windows Features', file: 'optionalfeatures', desc: 'Turn features on/off' },

  // Quick actions
  { id: 'flushdns', group: 'Quick actions', label: 'Flush DNS cache', kind: 'action', desc: 'Clear the resolver cache', ok: 'DNS cache flushed.' },
  { id: 'gpupdate', group: 'Quick actions', label: 'Update Group Policy', kind: 'action', desc: 'gpupdate /force', ok: 'Group Policy refreshed.' },
  { id: 'wsreset', group: 'Quick actions', label: 'Reset Store cache', kind: 'action', desc: 'wsreset', ok: 'Store cache reset started.' },
  { id: 'spooler', group: 'Quick actions', label: 'Restart Print Spooler', kind: 'action', desc: 'Fixes stuck print queues', ok: 'Print Spooler restarted.' },
  { id: 'explorer', group: 'Quick actions', label: 'Restart Explorer', kind: 'action', confirm: true, desc: 'Taskbar and desktop reload', ok: 'Explorer restarted.' },
];

const BY_ID = new Map(TOOLS.map((t) => [t.id, t]));

// The command a tool runs, resolved server-side. Exposed for testing so the
// mapping can be checked without actually launching anything.
function resolve(id) {
  const tool = BY_ID.get(id);
  if (!tool) return null;
  if (tool.kind === 'action') {
    switch (id) {
      case 'flushdns':
        return 'ipconfig /flushdns | Out-Null';
      case 'gpupdate':
        return 'gpupdate /force | Out-Null';
      case 'wsreset':
        return 'Start-Process wsreset.exe';
      case 'spooler':
        return 'Restart-Service -Name Spooler -Force';
      case 'explorer':
        return 'Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 600; if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }';
      default:
        return null;
    }
  }
  // launch
  const file = tool.file.replace(/'/g, "''");
  const args = tool.args ? ` -ArgumentList '${tool.args.replace(/'/g, "''")}'` : '';
  return `Start-Process -FilePath '${file}'${args}`;
}

function list() {
  return {
    tools: TOOLS.map((t) => ({
      id: t.id,
      group: t.group,
      label: t.label,
      desc: t.desc || '',
      kind: t.kind || 'launch',
      confirm: Boolean(t.confirm),
    })),
  };
}

async function run(id) {
  const tool = BY_ID.get(id);
  if (!tool) throw new Error('Unknown tool.');
  const command = resolve(id);
  if (!command) throw new Error('Unknown tool.');

  if (tool.kind === 'action') {
    try {
      await ps.run(command, { timeout: 120000 });
    } catch (err) {
      if (/access is denied|denied|elevation/i.test(err.message)) {
        throw new Error(`${tool.label} needs administrator rights. Restart as admin, then try again.`);
      }
      throw err;
    }
    return { ran: true, message: tool.ok || `${tool.label} done.` };
  }

  // Launch: fire-and-forget; Start-Process returns immediately.
  await ps.run(command, { timeout: 30000 });
  return { launched: true, message: `Opened ${tool.label}.` };
}

module.exports = { list, run, __resolve: resolve };
