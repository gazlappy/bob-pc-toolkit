'use strict';

// Quick commands — the tools a bench tech opens twenty times a day, as buttons.
// Two kinds: 'launch' opens one of Windows' own consoles, control panels or
// Settings pages, and 'action' runs a short maintenance command and reports
// what happened.
//
// The renderer only ever sends a tool id; the actual command is resolved here
// from this fixed table, so nothing the UI sends can turn into an arbitrary
// command line.

const ps = require('./ps');

const TOOLS = [
  // Consoles
  { id: 'devmgmt', label: 'Device Manager', file: 'devmgmt.msc', desc: 'Devices and drivers' },
  { id: 'diskmgmt', label: 'Disk Management', file: 'diskmgmt.msc', desc: 'Partitions and volumes' },
  { id: 'services', label: 'Services', file: 'services.msc', desc: 'Windows services' },
  { id: 'eventvwr', label: 'Event Viewer', file: 'eventvwr.msc', desc: 'System and application logs' },
  { id: 'taskschd', label: 'Task Scheduler', file: 'taskschd.msc', desc: 'Scheduled tasks' },
  { id: 'compmgmt', label: 'Computer Management', file: 'compmgmt.msc', desc: 'The lot in one console' },
  { id: 'gpedit', label: 'Group Policy Editor', file: 'gpedit.msc', desc: 'Local policy (Pro)' },
  { id: 'wf', label: 'Firewall (Advanced)', file: 'wf.msc', desc: 'Inbound/outbound rules' },
  { id: 'certmgr', label: 'Certificates', file: 'certmgr.msc', desc: 'Current-user certificates' },
  { id: 'printmgmt', label: 'Print Management', file: 'printmanagement.msc', desc: 'Printers and drivers (Pro)' },
  { id: 'perfmon-rel', label: 'Reliability Monitor', file: 'perfmon', args: '/rel', desc: 'Stability timeline' },
  { id: 'resmon', label: 'Resource Monitor', file: 'resmon', desc: 'Live CPU/disk/net detail' },

  // System tools
  { id: 'taskmgr', label: 'Task Manager', file: 'taskmgr', desc: 'Processes and startup' },
  { id: 'msinfo32', label: 'System Information', file: 'msinfo32', desc: 'Full spec sheet' },
  { id: 'winver', label: 'Windows Version', file: 'winver', desc: 'Build and edition' },
  { id: 'dxdiag', label: 'DirectX Diagnostic', file: 'dxdiag', desc: 'Graphics and sound' },
  { id: 'msconfig', label: 'System Configuration', file: 'msconfig', desc: 'Boot and services' },
  { id: 'regedit', label: 'Registry Editor', file: 'regedit', desc: 'Edit the registry' },
  { id: 'cmd', label: 'Command Prompt', file: 'cmd', desc: 'A console window' },
  { id: 'powershell', label: 'PowerShell', file: 'powershell', desc: 'A PowerShell window' },
  { id: 'dfrgui', label: 'Optimise Drives', file: 'dfrgui', desc: 'Defrag / TRIM' },
  { id: 'cleanmgr', label: 'Disk Cleanup', file: 'cleanmgr', desc: "Windows' own cleaner" },
  { id: 'rstrui', label: 'System Restore', file: 'rstrui', desc: 'Roll back to a point' },
  { id: 'mdsched', label: 'Memory Diagnostic', file: 'mdsched', desc: 'Test the RAM' },
  { id: 'mstsc', label: 'Remote Desktop', file: 'mstsc', desc: 'Connect to another PC' },
  { id: 'quickassist', label: 'Quick Assist', file: 'quickassist', desc: 'Remote help' },
  { id: 'snip', label: 'Snipping Tool', file: 'snippingtool', desc: 'Screenshot a region' },
  { id: 'sysdm', label: 'System Properties', file: 'control', args: 'sysdm.cpl', desc: 'Name, restore, remote' },
  { id: 'netplwiz', label: 'User Accounts', file: 'netplwiz', desc: 'Classic user accounts' },
  { id: 'credmgr', label: 'Credential Manager', file: 'control', args: '/name Microsoft.CredentialManager', desc: 'Saved logins' },

  // Control panels
  { id: 'appwiz', label: 'Programs & Features', file: 'control', args: 'appwiz.cpl', desc: 'Uninstall programs' },
  { id: 'optionalfeatures', label: 'Windows Features', file: 'optionalfeatures', desc: 'Turn features on/off' },
  { id: 'ncpa', label: 'Network Connections', file: 'control', args: 'ncpa.cpl', desc: 'Adapters' },
  { id: 'inetcpl', label: 'Internet Options', file: 'control', args: 'inetcpl.cpl', desc: 'Proxy, security zones' },
  { id: 'powercfg', label: 'Power Options', file: 'control', args: 'powercfg.cpl', desc: 'Power plans' },
  { id: 'mmsys', label: 'Sound', file: 'control', args: 'mmsys.cpl', desc: 'Playback and recording' },
  { id: 'timedate', label: 'Date and Time', file: 'control', args: 'timedate.cpl', desc: 'Clock and time zone' },
  { id: 'intl', label: 'Region', file: 'control', args: 'intl.cpl', desc: 'Locale and formats' },
  { id: 'main', label: 'Mouse', file: 'control', args: 'main.cpl', desc: 'Pointer and buttons' },
  { id: 'printers', label: 'Devices and Printers', file: 'control', args: 'printers', desc: 'Installed printers' },
  { id: 'mblctr', label: 'Mobility Center', file: 'mblctr', desc: 'Laptop quick settings' },
  { id: 'fonts', label: 'Fonts', file: 'control', args: 'fonts', desc: 'Installed fonts' },

  // Settings
  { id: 'set-update', label: 'Windows Update', file: 'ms-settings:windowsupdate', desc: 'Check for updates' },
  { id: 'set-defender', label: 'Windows Security', file: 'ms-settings:windowsdefender', desc: 'Antivirus and firewall' },
  { id: 'set-apps', label: 'Apps & Features', file: 'ms-settings:appsfeatures', desc: 'Installed apps' },
  { id: 'set-storage', label: 'Storage', file: 'ms-settings:storagesense', desc: "What's using the disk" },
  { id: 'set-about', label: 'About / Activation', file: 'ms-settings:about', desc: 'Spec and activation' },
  { id: 'set-recovery', label: 'Recovery', file: 'ms-settings:recovery', desc: 'Reset and advanced start' },
  { id: 'set-bluetooth', label: 'Bluetooth & Devices', file: 'ms-settings:bluetooth', desc: 'Paired devices' },
  { id: 'set-display', label: 'Display', file: 'ms-settings:display', desc: 'Resolution and scaling' },

  // Quick actions
  { id: 'flushdns', label: 'Flush DNS cache', kind: 'action', desc: 'Clear the resolver cache', ok: 'DNS cache flushed.' },
  { id: 'registerdns', label: 'Re-register DNS', kind: 'action', desc: 'ipconfig /registerdns', ok: 'DNS registration refreshed.' },
  { id: 'gpupdate', label: 'Update Group Policy', kind: 'action', desc: 'gpupdate /force', ok: 'Group Policy refreshed.' },
  { id: 'restorepoint', label: 'Create restore point', kind: 'action', desc: 'A System Restore checkpoint', ok: 'Restore point created.' },
  { id: 'highperf', label: 'High Performance plan', kind: 'action', desc: 'Switch power plan', ok: 'High Performance power plan active.' },
  { id: 'wsreset', label: 'Reset Store cache', kind: 'action', desc: 'wsreset', ok: 'Store cache reset started.' },
  { id: 'spooler', label: 'Restart Print Spooler', kind: 'action', desc: 'Fixes stuck print queues', ok: 'Print Spooler restarted.' },
  { id: 'iconcache', label: 'Rebuild icon cache', kind: 'action', confirm: true, confirmBody: 'The taskbar and desktop will reload while the icon cache is rebuilt. Any open File Explorer windows will close.', desc: 'Fixes broken/blank icons', ok: 'Icon cache rebuilt.' },
  { id: 'emptybin', label: 'Empty Recycle Bin', kind: 'action', confirm: true, danger: true, confirmBody: 'This permanently deletes everything in the Recycle Bin on every drive. It cannot be undone.', desc: 'On every drive', ok: 'Recycle Bin emptied.' },
  { id: 'explorer', label: 'Restart Explorer', kind: 'action', confirm: true, confirmBody: 'The taskbar and desktop will briefly disappear and reload. Any open File Explorer windows will close.', desc: 'Taskbar and desktop reload', ok: 'Explorer restarted.' },
  { id: 'reboot-uefi', label: 'Restart to UEFI / BIOS', kind: 'action', confirm: true, danger: true, confirmBody: 'This restarts the PC NOW and boots straight into the UEFI/BIOS firmware settings. Save any open work first.', desc: 'Reboot into firmware', ok: 'Restarting to firmware…' },
  { id: 'reboot-recovery', label: 'Restart to Recovery', kind: 'action', confirm: true, danger: true, confirmBody: 'This restarts the PC NOW into the Advanced Startup / recovery options. Save any open work first.', desc: 'Reboot into WinRE', ok: 'Restarting to recovery…' },
];

// Grouped by what a tech is trying to do, not by how Windows implements it. The
// order here is the order on screen, most-used first.
const GROUPS = [
  { name: 'Quick fixes', ids: ['flushdns', 'registerdns', 'spooler', 'iconcache', 'wsreset', 'gpupdate', 'highperf', 'restorepoint', 'emptybin'] },
  { name: 'Restart', ids: ['explorer', 'reboot-uefi', 'reboot-recovery'] },
  { name: 'Diagnose', ids: ['taskmgr', 'resmon', 'eventvwr', 'perfmon-rel', 'msinfo32', 'dxdiag', 'mdsched', 'winver', 'set-about'] },
  { name: 'System', ids: ['compmgmt', 'services', 'taskschd', 'msconfig', 'regedit', 'gpedit', 'sysdm', 'rstrui', 'set-update', 'set-recovery', 'cmd', 'powershell', 'snip', 'timedate', 'intl'] },
  { name: 'Hardware', ids: ['devmgmt', 'printers', 'printmgmt', 'set-display', 'mmsys', 'main', 'set-bluetooth', 'powercfg', 'mblctr'] },
  { name: 'Disks', ids: ['diskmgmt', 'dfrgui', 'cleanmgr', 'set-storage'] },
  { name: 'Network', ids: ['ncpa', 'wf', 'inetcpl', 'mstsc', 'quickassist'] },
  { name: 'Security & accounts', ids: ['set-defender', 'netplwiz', 'credmgr', 'certmgr'] },
  { name: 'Programs', ids: ['appwiz', 'set-apps', 'optionalfeatures', 'fonts'] },
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
      case 'registerdns':
        return 'ipconfig /registerdns | Out-Null';
      case 'gpupdate':
        return 'gpupdate /force | Out-Null';
      case 'restorepoint':
        return "Checkpoint-Computer -Description 'Manual - BOB' -RestorePointType 'MODIFY_SETTINGS'";
      case 'highperf':
        return 'powercfg /setactive SCHEME_MIN';
      case 'wsreset':
        return 'Start-Process wsreset.exe';
      case 'spooler':
        return 'Restart-Service -Name Spooler -Force';
      case 'iconcache':
        return "Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue; Remove-Item -Path (Join-Path $env:LOCALAPPDATA 'IconCache.db') -Force -ErrorAction SilentlyContinue; Remove-Item -Path (Join-Path $env:LOCALAPPDATA 'Microsoft\\Windows\\Explorer\\iconcache*') -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 400; if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }";
      case 'emptybin':
        return 'Clear-RecycleBin -Force -ErrorAction SilentlyContinue';
      case 'explorer':
        return 'Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 600; if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }';
      case 'reboot-uefi':
        return 'shutdown /r /fw /t 0';
      case 'reboot-recovery':
        return 'shutdown /r /o /t 0';
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
  const tools = [];
  for (const group of GROUPS) {
    for (const id of group.ids) {
      const t = BY_ID.get(id);
      if (!t) continue;
      tools.push({
        id: t.id,
        group: group.name,
        label: t.label,
        desc: t.desc || '',
        kind: t.kind || 'launch',
        confirm: Boolean(t.confirm),
        danger: Boolean(t.danger),
        confirmBody: t.confirmBody || '',
      });
    }
  }
  return { tools };
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

module.exports = { list, run, TOOLS, GROUPS, __resolve: resolve };
