'use strict';

// App updates and new PC setup, through Windows' own package manager, winget.
// BOB never picks a download itself: winget fetches each installer from the
// source it lists and checks its hash. The renderer only ever sends package ids,
// and those must be in the last listing or the fixed catalogue below.

const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ps = require('./ps');

const WINGET_FLAGS = ['--accept-source-agreements', '--disable-interactivity'];
const LIST_TIMEOUT = 180000;
const PACKAGE_TIMEOUT = 45 * 60 * 1000;

const CATALOGUE = [
  { group: 'Web browsers', id: 'Google.Chrome', name: 'Google Chrome', pick: true },
  { group: 'Web browsers', id: 'Mozilla.Firefox', name: 'Firefox' },
  { group: 'Web browsers', id: 'Brave.Brave', name: 'Brave' },
  { group: 'Web browsers', id: 'Opera.Opera', name: 'Opera' },
  { group: 'Web browsers', id: 'Vivaldi.Vivaldi', name: 'Vivaldi' },
  { group: 'Web browsers', id: 'Microsoft.Edge', name: 'Microsoft Edge' },
  { group: 'Web browsers', id: 'LibreWolf.LibreWolf', name: 'LibreWolf' },
  { group: 'Web browsers', id: 'Waterfox.Waterfox', name: 'Waterfox' },
  { group: 'Web browsers', id: 'TorProject.TorBrowser', name: 'Tor Browser' },
  { group: 'Messaging', id: 'Zoom.Zoom', name: 'Zoom' },
  { group: 'Messaging', id: 'Discord.Discord', name: 'Discord' },
  { group: 'Messaging', id: 'Microsoft.Teams', name: 'Microsoft Teams' },
  { group: 'Messaging', id: 'Mozilla.Thunderbird', name: 'Thunderbird' },
  { group: 'Messaging', id: 'Telegram.TelegramDesktop', name: 'Telegram' },
  { group: 'Messaging', id: 'OpenWhisperSystems.Signal', name: 'Signal' },
  { group: 'Messaging', id: 'SlackTechnologies.Slack', name: 'Slack' },
  { group: 'Messaging', id: 'TeamSpeakSystems.TeamSpeakClient', name: 'TeamSpeak' },
  { group: 'Messaging', id: 'Element.Element', name: 'Element' },
  { group: 'Media', id: 'VideoLAN.VLC', name: 'VLC media player', pick: true },
  { group: 'Media', id: 'Audacity.Audacity', name: 'Audacity' },
  { group: 'Media', id: 'Apple.iTunes', name: 'iTunes' },
  { group: 'Media', id: 'HandBrake.HandBrake', name: 'HandBrake' },
  { group: 'Media', id: 'clsid2.mpc-hc', name: 'MPC-HC' },
  { group: 'Media', id: 'AIMP.AIMP', name: 'AIMP' },
  { group: 'Media', id: 'PeterPawlowski.foobar2000', name: 'foobar2000' },
  { group: 'Media', id: 'CodecGuide.K-LiteCodecPack.Standard', name: 'K-Lite Codec Pack' },
  { group: 'Media', id: 'OBSProject.OBSStudio', name: 'OBS Studio' },
  { group: 'Media', id: 'KDE.Kdenlive', name: 'Kdenlive' },
  { group: 'Media', id: 'Meltytech.Shotcut', name: 'Shotcut' },
  { group: 'Media', id: 'Daum.PotPlayer', name: 'PotPlayer' },
  { group: 'Media', id: 'Winamp.Winamp', name: 'Winamp' },
  { group: 'Media', id: 'Plex.Plex', name: 'Plex' },
  { group: 'Media', id: 'XBMCFoundation.Kodi', name: 'Kodi' },
  { group: 'Media', id: 'MoritzBunkus.MKVToolNix', name: 'MKVToolNix' },
  { group: 'Media', id: 'Gyan.FFmpeg', name: 'FFmpeg' },
  { group: 'Media', id: 'yt-dlp.yt-dlp', name: 'yt-dlp' },
  { group: 'Imaging', id: 'dotPDN.PaintDotNet', name: 'Paint.NET' },
  { group: 'Imaging', id: 'GIMP.GIMP', name: 'GIMP' },
  { group: 'Imaging', id: 'IrfanSkiljan.IrfanView', name: 'IrfanView' },
  { group: 'Imaging', id: 'Inkscape.Inkscape', name: 'Inkscape' },
  { group: 'Imaging', id: 'Greenshot.Greenshot', name: 'Greenshot' },
  { group: 'Imaging', id: 'ShareX.ShareX', name: 'ShareX' },
  { group: 'Imaging', id: 'BlenderFoundation.Blender', name: 'Blender' },
  { group: 'Imaging', id: 'KDE.Krita', name: 'Krita' },
  { group: 'Imaging', id: 'XnSoft.XnViewMP', name: 'XnView MP' },
  { group: 'Imaging', id: 'darktable.darktable', name: 'darktable' },
  { group: 'Imaging', id: 'Flameshot.Flameshot', name: 'Flameshot' },
  { group: 'Documents', id: 'Adobe.Acrobat.Reader.64-bit', name: 'Adobe Acrobat Reader', pick: true },
  { group: 'Documents', id: 'TheDocumentFoundation.LibreOffice', name: 'LibreOffice' },
  { group: 'Documents', id: 'ONLYOFFICE.DesktopEditors', name: 'ONLYOFFICE' },
  { group: 'Documents', id: 'Foxit.FoxitReader', name: 'Foxit PDF Reader' },
  { group: 'Documents', id: 'SumatraPDF.SumatraPDF', name: 'SumatraPDF' },
  { group: 'Documents', id: 'Apache.OpenOffice', name: 'OpenOffice' },
  { group: 'Documents', id: 'calibre.calibre', name: 'calibre' },
  { group: 'Documents', id: 'Microsoft.Office', name: 'Microsoft 365 (Office)' },
  { group: 'Documents', id: 'geeksoftwareGmbH.PDF24Creator', name: 'PDF24 Creator' },
  { group: 'Documents', id: 'PDFsam.PDFsam', name: 'PDFsam Basic' },
  { group: 'Documents', id: 'Notion.Notion', name: 'Notion' },
  { group: 'Documents', id: 'Obsidian.Obsidian', name: 'Obsidian' },
  { group: 'Documents', id: 'Evernote.Evernote', name: 'Evernote' },
  { group: 'Documents', id: 'Joplin.Joplin', name: 'Joplin' },
  { group: 'Security', id: 'Malwarebytes.Malwarebytes', name: 'Malwarebytes' },
  { group: 'Security', id: 'Bitwarden.Bitwarden', name: 'Bitwarden' },
  { group: 'Security', id: 'KeePassXCTeam.KeePassXC', name: 'KeePassXC' },
  { group: 'Security', id: 'Malwarebytes.AdwCleaner', name: 'AdwCleaner' },
  { group: 'Security', id: 'DominikReichl.KeePass', name: 'KeePass' },
  { group: 'Security', id: 'AgileBits.1Password', name: '1Password' },
  { group: 'Security', id: 'IDRIX.VeraCrypt', name: 'VeraCrypt' },
  { group: 'Security', id: 'Cryptomator.Cryptomator', name: 'Cryptomator' },
  { group: 'Security', id: 'Proton.ProtonVPN', name: 'Proton VPN' },
  { group: 'Security', id: 'Sandboxie.Plus', name: 'Sandboxie Plus' },
  { group: 'Runtimes', id: 'Microsoft.VCRedist.2015+.x64', name: 'Visual C++ Runtime (64-bit)', pick: true },
  { group: 'Runtimes', id: 'Microsoft.VCRedist.2015+.x86', name: 'Visual C++ Runtime (32-bit)' },
  { group: 'Runtimes', id: 'Microsoft.DotNet.DesktopRuntime.8', name: '.NET Desktop Runtime 8' },
  { group: 'Runtimes', id: 'Microsoft.DirectX', name: 'DirectX Runtime' },
  { group: 'Runtimes', id: 'Oracle.JavaRuntimeEnvironment', name: 'Java Runtime (Oracle)' },
  { group: 'Runtimes', id: 'EclipseAdoptium.Temurin.21.JRE', name: 'Java Runtime (Temurin 21)' },
  { group: 'Runtimes', id: 'Microsoft.VCRedist.2013.x64', name: 'Visual C++ 2013 (64-bit)' },
  { group: 'Runtimes', id: 'Microsoft.VCRedist.2013.x86', name: 'Visual C++ 2013 (32-bit)' },
  { group: 'Runtimes', id: 'Microsoft.VCRedist.2012.x64', name: 'Visual C++ 2012 (64-bit)' },
  { group: 'Runtimes', id: 'Microsoft.VCRedist.2012.x86', name: 'Visual C++ 2012 (32-bit)' },
  { group: 'Runtimes', id: 'Microsoft.VCRedist.2010.x64', name: 'Visual C++ 2010 (64-bit)' },
  { group: 'Runtimes', id: 'Microsoft.VCRedist.2010.x86', name: 'Visual C++ 2010 (32-bit)' },
  { group: 'Runtimes', id: 'Microsoft.DotNet.DesktopRuntime.9', name: '.NET Desktop Runtime 9' },
  { group: 'Runtimes', id: 'Microsoft.DotNet.DesktopRuntime.6', name: '.NET Desktop Runtime 6' },
  { group: 'Runtimes', id: 'Microsoft.EdgeWebView2Runtime', name: 'WebView2 Runtime' },
  { group: 'Runtimes', id: 'Microsoft.XNARedist', name: 'XNA Framework' },
  { group: 'Cloud and sharing', id: 'Google.GoogleDrive', name: 'Google Drive' },
  { group: 'Cloud and sharing', id: 'Dropbox.Dropbox', name: 'Dropbox' },
  { group: 'Cloud and sharing', id: 'Microsoft.OneDrive', name: 'OneDrive' },
  { group: 'Cloud and sharing', id: 'qBittorrent.qBittorrent', name: 'qBittorrent' },
  { group: 'Cloud and sharing', id: 'Mega.MEGASync', name: 'MEGA' },
  { group: 'Cloud and sharing', id: 'Nextcloud.NextcloudDesktop', name: 'Nextcloud' },
  { group: 'Cloud and sharing', id: 'LocalSend.LocalSend', name: 'LocalSend' },
  { group: 'Cloud and sharing', id: 'Transmission.Transmission', name: 'Transmission' },
  { group: 'Compression', id: '7zip.7zip', name: '7-Zip', pick: true },
  { group: 'Compression', id: 'RARLab.WinRAR', name: 'WinRAR' },
  { group: 'Compression', id: 'Giorgiotani.Peazip', name: 'PeaZip' },
  { group: 'Compression', id: 'Bandisoft.Bandizip', name: 'Bandizip' },
  { group: 'Compression', id: 'M2Team.NanaZip', name: 'NanaZip' },
  { group: 'Utilities', id: 'TeamViewer.TeamViewer', name: 'TeamViewer' },
  { group: 'Utilities', id: 'AnyDesk.AnyDesk', name: 'AnyDesk' },
  { group: 'Utilities', id: 'voidtools.Everything', name: 'Everything' },
  { group: 'Utilities', id: 'Microsoft.PowerToys', name: 'PowerToys' },
  { group: 'Utilities', id: 'Rufus.Rufus', name: 'Rufus' },
  { group: 'Utilities', id: 'WinDirStat.WinDirStat', name: 'WinDirStat' },
  { group: 'Utilities', id: 'AntibodySoftware.WizTree', name: 'WizTree' },
  { group: 'Utilities', id: 'Notepad++.Notepad++', name: 'Notepad++' },
  { group: 'Utilities', id: 'RevoUninstaller.RevoUninstaller', name: 'Revo Uninstaller' },
  { group: 'Utilities', id: 'BleachBit.BleachBit', name: 'BleachBit' },
  { group: 'Utilities', id: 'Microsoft.WindowsTerminal', name: 'Windows Terminal' },
  { group: 'Utilities', id: 'AutoHotkey.AutoHotkey', name: 'AutoHotkey' },
  { group: 'Utilities', id: 'Ditto.Ditto', name: 'Ditto' },
  { group: 'Utilities', id: 'CodeSector.TeraCopy', name: 'TeraCopy' },
  { group: 'Utilities', id: 'Balena.Etcher', name: 'balenaEtcher' },
  { group: 'Utilities', id: 'Ventoy.Ventoy', name: 'Ventoy' },
  { group: 'Utilities', id: 'Klocman.BulkCrapUninstaller', name: 'Bulk Crap Uninstaller' },
  { group: 'Utilities', id: 'Microsoft.RemoteDesktopClient', name: 'Remote Desktop' },
  { group: 'Utilities', id: 'TigerVNC.TigerVNC', name: 'TigerVNC' },
  { group: 'Utilities', id: 'Oracle.VirtualBox', name: 'VirtualBox' },
  { group: 'Utilities', id: 'Logitech.OptionsPlus', name: 'Logi Options+' },
  { group: 'Games', id: 'Valve.Steam', name: 'Steam' },
  { group: 'Games', id: 'EpicGames.EpicGamesLauncher', name: 'Epic Games Launcher' },
  { group: 'Games', id: 'GOG.Galaxy', name: 'GOG Galaxy' },
  { group: 'Games', id: 'Ubisoft.Connect', name: 'Ubisoft Connect' },
  { group: 'Games', id: 'ElectronicArts.EADesktop', name: 'EA app' },
  { group: 'Games', id: 'Blizzard.BattleNet', name: 'Battle.net' },
  { group: 'Games', id: 'Amazon.Games', name: 'Amazon Games' },
  { group: 'Games', id: 'Playnite.Playnite', name: 'Playnite' },
  { group: 'Developer tools', id: 'Git.Git', name: 'Git' },
  { group: 'Developer tools', id: 'Python.Python.3.13', name: 'Python 3.13' },
  { group: 'Developer tools', id: 'OpenJS.NodeJS.LTS', name: 'Node.js LTS' },
  { group: 'Developer tools', id: 'Microsoft.VisualStudioCode', name: 'Visual Studio Code' },
  { group: 'Developer tools', id: 'WinSCP.WinSCP', name: 'WinSCP' },
  { group: 'Developer tools', id: 'PuTTY.PuTTY', name: 'PuTTY' },
  { group: 'Developer tools', id: 'WinMerge.WinMerge', name: 'WinMerge' },
  { group: 'Developer tools', id: 'Microsoft.VisualStudio.2022.Community', name: 'Visual Studio 2022 Community' },
  { group: 'Developer tools', id: 'SublimeHQ.SublimeText.4', name: 'Sublime Text' },
  { group: 'Developer tools', id: 'GitHub.GitHubDesktop', name: 'GitHub Desktop' },
  { group: 'Developer tools', id: 'Docker.DockerDesktop', name: 'Docker Desktop' },
  { group: 'Developer tools', id: 'Postman.Postman', name: 'Postman' },
  { group: 'Developer tools', id: 'Microsoft.PowerShell', name: 'PowerShell 7' },
  { group: 'Developer tools', id: 'DBBrowserForSQLite.DBBrowserForSQLite', name: 'DB Browser for SQLite' },
  { group: 'Developer tools', id: 'HeidiSQL.HeidiSQL', name: 'HeidiSQL' },
  { group: 'Developer tools', id: 'WiresharkFoundation.Wireshark', name: 'Wireshark' },
  { group: 'Developer tools', id: 'Insecure.Nmap', name: 'Nmap' },
  { group: 'Tech tools', id: 'CrystalDewWorld.CrystalDiskInfo', name: 'CrystalDiskInfo' },
  { group: 'Tech tools', id: 'CrystalDewWorld.CrystalDiskMark', name: 'CrystalDiskMark' },
  { group: 'Tech tools', id: 'CPUID.CPU-Z', name: 'CPU-Z' },
  { group: 'Tech tools', id: 'CPUID.HWMonitor', name: 'HWMonitor' },
  { group: 'Tech tools', id: 'REALiX.HWiNFO', name: 'HWiNFO' },
  { group: 'Tech tools', id: 'TechPowerUp.GPU-Z', name: 'GPU-Z' },
  { group: 'Tech tools', id: 'Piriform.Speccy', name: 'Speccy' },
  { group: 'Tech tools', id: 'Microsoft.Sysinternals.Suite', name: 'Sysinternals Suite' },
  { group: 'Tech tools', id: 'Piriform.Recuva', name: 'Recuva' },
  { group: 'Tech tools', id: 'Piriform.Defraggler', name: 'Defraggler' },
  { group: 'Tech tools', id: 'FinalWire.AIDA64.Extreme', name: 'AIDA64 Extreme' },
  { group: 'Tech tools', id: 'Guru3D.Afterburner', name: 'MSI Afterburner' },
  { group: 'Tech tools', id: 'Wagnardsoft.DisplayDriverUninstaller', name: 'Display Driver Uninstaller' },
  { group: 'Tech tools', id: 'OCBase.OCCT.Personal', name: 'OCCT' },
  { group: 'Tech tools', id: 'Maxon.CinebenchR23', name: 'Cinebench R23' },
  { group: 'Tech tools', id: 'CGSecurity.TestDisk', name: 'TestDisk and PhotoRec' },
  { group: 'Tech tools', id: 'angryziber.AngryIPScanner', name: 'Angry IP Scanner' },
  { group: 'Tech tools', id: 'Famatech.AdvancedIPScanner', name: 'Advanced IP Scanner' },
  { group: 'Tech tools', id: 'Ookla.Speedtest.Desktop', name: 'Speedtest by Ookla' },
  { group: 'Tech tools', id: 'MiniTool.PartitionWizard.Free', name: 'MiniTool Partition Wizard' },
  { group: 'Tech tools', id: 'Microsoft.Sysinternals.Autoruns', name: 'Autoruns' },
  { group: 'Tech tools', id: 'Microsoft.Sysinternals.ProcessExplorer', name: 'Process Explorer' },
  { group: 'Hardware makers', id: 'Intel.IntelDriverAndSupportAssistant', name: 'Intel Driver & Support Assistant' },
  { group: 'Hardware makers', id: 'Dell.CommandUpdate', name: 'Dell Command Update' },
  { group: 'Hardware makers', id: 'Lenovo.SystemUpdate', name: 'Lenovo System Update' },
  { group: 'Hardware makers', id: 'HP.ImageAssistant', name: 'HP Image Assistant' },
  { group: 'Hardware makers', id: 'Asus.ArmouryCrate', name: 'ASUS Armoury Crate' },
  { group: 'Hardware makers', id: 'Logitech.GHUB', name: 'Logitech G HUB' },
  { group: 'Hardware makers', id: 'Corsair.iCUE.5', name: 'Corsair iCUE' },
];

function winget(args, timeout = LIST_TIMEOUT) {
  return new Promise((resolve, reject) => {
    execFile('winget', args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error && (error.code === 'ENOENT' || error.killed)) {
        reject(error);
        return;
      }
      resolve(stdout || '');
    });
  });
}

// A Chinese or Japanese character fills two columns of winget's table.
function isWide(ch) {
  const c = ch.codePointAt(0);
  return (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
    || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60)
    || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd);
}

function splitColumns(line, starts) {
  const cols = starts.map(() => '');
  let cell = 0;
  let col = 0;
  for (const ch of line) {
    while (col + 1 < starts.length && cell >= starts[col + 1]) col += 1;
    if (cell >= starts[0]) cols[col] += ch;
    cell += isWide(ch) ? 2 : 1;
  }
  return cols.map((c) => c.trim());
}

/**
 * Reads winget's tables, which have no JSON form. Column positions come from the
 * header row above each line of dashes; the header's words are translated on
 * other Windows languages, so only their positions and order are used.
 */
function parseTables(text) {
  const lines = text.split(/\r?\n/).map((line) => {
    const cut = line.lastIndexOf('\r');
    return cut === -1 ? line : line.slice(cut + 1);
  });
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    if (!/^-{10,}\s*$/.test(lines[i])) continue;
    const header = lines[i - 1].replace(/^[\s\\|/-]+(?=\S)/, '');
    const starts = [...header.matchAll(/\S+/g)].map((m) => m.index);
    if (starts.length < 3) continue;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (!line.trim()) break;
      const cols = splitColumns(line, starts);
      if (!cols[1] || (/\s/.test(cols[1]) && !/^(ARP|MSIX)\\/i.test(cols[1]))) continue;
      rows.push(cols);
    }
  }
  return rows;
}

function parseUpgrades(text) {
  const seen = new Set();
  const out = [];
  for (const cols of parseTables(text)) {
    if (cols.length < 4 || seen.has(cols[1]) || !cols[3]) continue;
    seen.add(cols[1]);
    out.push({ name: cols[0], id: cols[1], version: cols[2], available: cols[3] });
  }
  return out;
}

let offered = new Set();

async function available() {
  try {
    const version = await winget(['--version'], 15000);
    return version.trim() || null;
  } catch {
    return null;
  }
}

async function upgrades() {
  const version = await available();
  if (!version) return { available: false, packages: [] };
  const packages = parseUpgrades(await winget(['upgrade', ...WINGET_FLAGS]));
  offered = new Set(packages.map((p) => p.id));
  return { available: true, version, packages };
}

let lastStatus = new Map();
let installedIds = new Set();
let outdatedIds = new Set();

/** The list, with each program marked missing, up to date or out of date on this PC. */
async function catalogue() {
  const version = await available();
  if (!version) return { available: false, apps: [] };
  const rows = parseTables(await winget(['list', ...WINGET_FLAGS]));
  const outdated = parseUpgrades(await winget(['upgrade', ...WINGET_FLAGS]));
  // Some packages list under a longer id, such as Google.Chrome.EXE.
  const matches = (candidate, id) => {
    const c = candidate.toLowerCase();
    const i = id.toLowerCase();
    return c === i || c.startsWith(`${i}.`);
  };
  // Programs winget did not install itself, and can't tie to a package, only have
  // their name to go on. It can't update those, so they count as installed.
  const byName = (name) => new RegExp(`(^|\\W)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\W)`, 'i');
  installedIds = new Set(rows.map((c) => c[1].toLowerCase()));
  outdatedIds = new Set(outdated.map((u) => u.id.toLowerCase()));
  lastStatus = new Map();
  const apps = CATALOGUE.map((app) => {
    const row = rows.find((c) => matches(c[1], app.id)) || rows.find((c) => /^(ARP|MSIX)\\/i.test(c[1]) && byName(app.name).test(c[0]));
    const update = outdated.find((u) => matches(u.id, app.id));
    const status = !row ? 'missing' : update ? 'outdated' : 'current';
    const installedId = update ? update.id : row ? row[1] : null;
    lastStatus.set(app.id, { status, installedId });
    return {
      ...app,
      pick: Boolean(app.pick),
      status,
      version: row ? row[2] : null,
      available: update ? update.available : null,
    };
  });
  return { available: true, version, apps };
}

// A fresh Windows often has winget on disk but not yet registered for this user.
async function repairWinget() {
  await ps.run(`Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe -ErrorAction Stop`, { timeout: 120000 }).catch(() => {});
  return { available: Boolean(await available()) };
}

// HRESULTs winget returns. Node reports them as unsigned numbers.
const NOT_NEEDED = new Set([0x8a15002b, 0x8a150061]);
const FRIENDLY = new Map([
  [0x8a150014, 'winget could not find this package.'],
  [0x8a15010e, 'It needs the program closed first. Close it and try again.'],
  [0x8a150101, 'The program is running. Close it and try again.'],
  [0x8a150102, 'Another installer is running. Wait for it to finish and try again.'],
  [0x8a150109, 'Windows needs to restart before this can install.'],
  [0x8a150107, 'The PC is short of disk space.'],
  [0x8a150108, 'The PC is short of memory.'],
  [0x8a150105, 'It needs an internet connection.'],
]);

let stopping = false;
const children = new Set();
const downloads = new Set();

// winget normally downloads through Delivery Optimization, which took 90 to 180
// seconds for a file a plain download fetched in 2. Its other downloader writes
// straight to disk too, which gives something to measure, since winget reports no
// progress when BOB is reading its output. The setting is only held for the batch.
function wingetSettingsFile() {
  return path.join(process.env.LOCALAPPDATA || '', 'Packages', 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe', 'LocalState', 'settings.json');
}

let restoreDownloader = null;

function useFastDownloader() {
  const file = wingetSettingsFile();
  try {
    if (!fs.existsSync(path.dirname(file))) return;
    const original = fs.existsSync(file) ? fs.readFileSync(file) : null;
    const current = original ? JSON.parse(original.toString('utf8').replace(/^\s*\/\/.*$/gm, '')) : {};
    if (current.network && current.network.downloader) return;
    fs.writeFileSync(file, JSON.stringify({ ...current, network: { ...current.network, downloader: 'wininet' } }, null, 2));
    restoreDownloader = () => {
      restoreDownloader = null;
      if (original) fs.writeFileSync(file, original);
      else fs.rmSync(file, { force: true });
    };
  } catch {
    /* a settings file BOB can't read is left alone: slower, but it still works */
  }
}

function putDownloaderBack() {
  if (!restoreDownloader) return;
  try {
    restoreDownloader();
  } catch {
    restoreDownloader = null;
  }
}

function wingetCache() {
  return path.join(os.tmpdir(), 'WinGet');
}

// winget builds each download at %TEMP%\WinGet\<id>.<version>\<hash>.
function downloadedSoFar(id, since) {
  const prefix = `${id.toLowerCase()}.`;
  let bytes = 0;
  let folders = [];
  try {
    folders = fs.readdirSync(wingetCache()).filter((name) => name.toLowerCase().startsWith(prefix));
  } catch {
    return 0;
  }
  for (const folder of folders) {
    const dir = path.join(wingetCache(), folder);
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const stat = fs.statSync(path.join(dir, name));
        if (stat.isFile() && stat.mtimeMs >= since) bytes = Math.max(bytes, stat.size);
      } catch {
        /* just renamed */
      }
    }
  }
  return bytes;
}

async function downloadSize(url) {
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000) });
    return Number(response.headers.get('content-length')) || 0;
  } catch {
    return 0;
  }
}

const DOWNLOADS_AT_ONCE = 3;
const QUIET_AFTER_MS = 60000;
const WRITE_SCALE = 3;

function runProcess(args, onLine, group) {
  return new Promise((resolve) => {
    const child = spawn('winget', args, { windowsHide: true });
    children.add(child);
    if (group) group.add(child);
    const timer = setTimeout(() => child.kill(), PACKAGE_TIMEOUT);
    let last = '';
    const relay = (chunk) => {
      for (const part of chunk.toString('utf8').split(/[\r\n]+/)) {
        const line = part.trim();
        if (line.length < 3 || /^[\\|/-]+$/.test(line) || /^[█▒\s\d.%A-Za-z/]*(MB|KB|GB)\s*\/|^[█▒]/.test(line)) continue;
        last = line;
        onLine(line, child);
      }
    };
    child.stdout.on('data', relay);
    child.stderr.on('data', relay);
    const end = (code, message) => {
      clearTimeout(timer);
      children.delete(child);
      if (group) group.delete(child);
      resolve({ code, last: message || last });
    };
    child.on('error', (error) => end(-1, error.message));
    child.on('close', (code) => end(code === null ? -1 : code >>> 0));
    if (onLine.started) onLine.started(child);
  });
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => hash.update(d)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Fetches a program's installer without installing it, then leaves it where winget
 * looks first. winget still checks the file's hash against its manifest, and if it
 * picks a different installer it just downloads that itself, so a wasted download is
 * the worst this can do.
 */
async function downloadAhead(item, onStep) {
  const id = item.installedId || item.id;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bob-winget-'));
  const started = Date.now() - 2000;
  let size = 0;
  let watcher = null;
  try {
    onStep({ phase: 'download', got: 0, size: 0 });
    await runProcess(['download', '--id', id, '--exact', '--source', 'winget', '--accept-package-agreements', ...WINGET_FLAGS, '--download-directory', dir], (line) => {
      const url = /https?:\/\/\S+/.exec(line);
      if (!url || watcher) return;
      downloadSize(url[0]).then((bytes) => { size = bytes; });
      watcher = setInterval(() => onStep({ phase: 'download', got: downloadedSoFar(id, started), size }), 500);
    }, downloads);
    clearInterval(watcher);
    if (stopping) return null;
    const names = fs.readdirSync(dir);
    const manifest = names.find((n) => n.endsWith('.yaml'));
    const installer = names.find((n) => !n.endsWith('.yaml'));
    if (!manifest || !installer) return null;
    const version = /^PackageVersion:\s*["']?([^"'\s]+)/m.exec(fs.readFileSync(path.join(dir, manifest), 'utf8'));
    if (!version) return null;
    const source = path.join(dir, installer);
    const bytes = fs.statSync(source).size;
    const seed = path.join(wingetCache(), `${id}.${version[1]}`, await sha256(source));
    fs.mkdirSync(path.dirname(seed), { recursive: true });
    fs.renameSync(source, seed);
    return { seed, bytes };
  } catch {
    return null;
  } finally {
    clearInterval(watcher);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const WRITES_SCRIPT = (root) => `
$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WriteTransferCount
$ids = @{ ${Number(root)} = $true }
do {
  $added = $false
  foreach ($p in $all) { if ($ids[[int]$p.ParentProcessId] -and -not $ids[[int]$p.ProcessId]) { $ids[[int]$p.ProcessId] = $true; $added = $true } }
} while ($added)
[pscustomobject]@{
  tree = [double](($all | Where-Object { $ids[[int]$_.ProcessId] } | Measure-Object WriteTransferCount -Sum).Sum)
  msi = @($all | Where-Object { $_.Name -eq 'msiexec.exe' -and -not $ids[[int]$_.ProcessId] } | ForEach-Object { [pscustomobject]@{ id = [int]$_.ProcessId; w = [double]$_.WriteTransferCount } })
} | ConvertTo-Json -Compress
`;

/**
 * Installers don't report a percentage, but Windows counts what every process
 * writes. MSI installers do their work in a Windows service outside winget's own
 * process tree, so those are counted from what they had written when this began.
 */
function watchWrites(pid, onWrites) {
  const baseline = new Map();
  let first = true;
  let busy = false;
  let written = 0;
  let changed = Date.now();
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    const data = await ps.json(WRITES_SCRIPT(pid), { timeout: 10000 }).catch(() => null);
    busy = false;
    if (!data) return;
    let total = data.tree || 0;
    for (const m of ps.arr(data.msi)) {
      if (first) baseline.set(m.id, m.w);
      total += m.w - (baseline.get(m.id) || 0);
    }
    first = false;
    if (total > written) {
      written = total;
      changed = Date.now();
    }
    onWrites(written, Date.now() - changed);
  }, 1500);
  return () => clearInterval(timer);
}

// A bar that follows what the installer really writes. How much it will write isn't
// known, so this slows as it climbs and never reaches the end until the installer
// finishes. It stands still when the installer does.
function writeFraction(written, installerBytes) {
  const scale = Math.max(installerBytes, 1048576) * WRITE_SCALE;
  return Math.min(0.95, 1 - Math.exp(-written / scale));
}

function installOne(args, installerBytes, onStep) {
  let phase = 'install';
  let size = 0;
  let downloaded = 0;
  let watcher = null;
  let stopWrites = null;
  const started = Date.now() - 2000;
  const id = args[args.indexOf('--id') + 1];
  const relay = (line) => {
    const url = /https?:\/\/\S+/.exec(line);
    if (url && phase === 'install' && !watcher) {
      phase = 'download';
      downloadSize(url[0]).then((bytes) => { size = bytes; });
      watcher = setInterval(() => {
        downloaded = downloadedSoFar(id, started);
        onStep({ phase, got: downloaded, size });
      }, 500);
      return;
    }
    if (phase === 'download') {
      phase = 'install';
      clearInterval(watcher);
    }
  };
  relay.started = (child) => {
    onStep({ phase: 'install', written: 0, fraction: 0, quietMs: 0 });
    stopWrites = watchWrites(child.pid, (written, quietMs) => {
      if (phase !== 'install') return;
      onStep({ phase, written, fraction: writeFraction(written, installerBytes || size || downloaded), quietMs });
    });
  };
  return runProcess(args, relay).finally(() => {
    clearInterval(watcher);
    if (stopWrites) stopWrites();
  });
}

let batchRunning = false;

/**
 * Downloads run side by side while installs take turns, since Windows Installer
 * only allows one at a time and two installers can trip over each other.
 */
async function runBatch(items, argsFor, onProgress) {
  if (batchRunning) throw new Error('winget is already busy with another list.');
  batchRunning = true;
  stopping = false;
  useFastDownloader();
  const total = items.length;
  const results = [];
  const ready = [];
  const seeds = [];
  let wake = null;
  const emit = (item, step) => onProgress({ id: item.id, name: item.name, total, done: results.length, ...step });
  const finish = (item, result) => {
    results.push(result);
    emit(item, { finished: result });
  };

  const queue = items.slice();
  const fetcher = async () => {
    while (queue.length) {
      const item = queue.shift();
      if (stopping) {
        ready.push({ item, skipped: true });
      } else {
        const fetched = await downloadAhead(item, (step) => emit(item, step));
        if (fetched) seeds.push(fetched.seed);
        if (!stopping) emit(item, { phase: 'queued' });
        ready.push({ item, bytes: fetched ? fetched.bytes : 0 });
      }
      if (wake) wake();
    }
  };

  try {
    const fetchers = Promise.all(Array.from({ length: Math.min(DOWNLOADS_AT_ONCE, total) }, fetcher));
    while (results.length < total) {
      if (!ready.length) await new Promise((resolve) => { wake = resolve; });
      wake = null;
      const next = ready.shift();
      if (!next) continue;
      const { item } = next;
      if (next.skipped || stopping) {
        finish(item, { ...item, status: 'skipped', message: 'Stopped before this one started.' });
        continue;
      }
      const { code, last } = await installOne(argsFor(item), next.bytes, (step) => emit(item, step));
      if (code === 0) finish(item, { ...item, status: 'done', message: '' });
      else if (NOT_NEEDED.has(code)) finish(item, { ...item, status: 'current', message: code === 0x8a150061 ? 'Already installed.' : 'Already up to date.' });
      else finish(item, { ...item, status: 'failed', message: FRIENDLY.get(code) || last || `winget stopped with code ${code.toString(16)}.` });
    }
    await fetchers;
  } finally {
    batchRunning = false;
    putDownloaderBack();
    // winget clears up what it used. Anything left was never picked up.
    for (const seed of seeds) {
      try {
        fs.rmSync(seed, { force: true });
        fs.rmdirSync(path.dirname(seed));
      } catch {
        /* folder still in use */
      }
    }
  }
  return { results };
}

const QUIET = ['--exact', '--silent', '--accept-package-agreements', ...WINGET_FLAGS];

function upgrade(items, onProgress) {
  const chosen = (Array.isArray(items) ? items : []).filter((p) => p && offered.has(p.id)).map((p) => ({ id: p.id, name: String(p.name || p.id) }));
  if (!chosen.length) throw new Error('Nothing to update. Check for updates again.');
  return runBatch(chosen, (item) => ['upgrade', '--id', item.id, ...QUIET], onProgress);
}

// --- Browsing everything in winget --------------------------------------------

const BROWSE_PAGE = 50;
const BROWSE_TAGS = new Set(['browser', 'chat', 'video', 'music', 'image', 'pdf', 'office', 'game', 'security', 'backup', 'network', 'utility', 'developer-tools', 'editor', 'disk', 'remote-desktop']);
const browseCache = new Map();
const browseSeen = new Map();

function exactStatus(id) {
  const lower = id.toLowerCase();
  if (outdatedIds.has(lower)) return 'outdated';
  return installedIds.has(lower) ? 'current' : 'missing';
}

async function browseRows(query, tag) {
  const key = `${tag}|${query.toLowerCase()}`;
  if (browseCache.has(key)) return browseCache.get(key);
  const args = ['search', '--source', 'winget', ...WINGET_FLAGS];
  // Passed as a named value, so a search can't be read as one of winget's options.
  if (query || !tag) args.push('--query', query || '.');
  if (tag) args.push('--tag', tag);
  const rows = parseTables(await winget(args))
    .filter((c) => c[1] && c[0])
    .map((c) => ({ name: c[0], id: c[1], version: c[2] || '' }));
  if (!query) rows.sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }));
  if (browseCache.size > 40) browseCache.clear();
  browseCache.set(key, rows);
  return rows;
}

/** One page of winget's catalogue. Only what has been shown can then be installed. */
async function browse(options) {
  const version = await available();
  if (!version) return { available: false, rows: [], total: 0, page: 0, pages: 0 };
  const query = String((options && options.query) || '').trim().slice(0, 80);
  const tag = BROWSE_TAGS.has(options && options.tag) ? options.tag : '';
  const rows = await browseRows(query, tag);
  const pages = Math.max(1, Math.ceil(rows.length / BROWSE_PAGE));
  const page = Math.min(pages - 1, Math.max(0, Number(options && options.page) || 0));
  const shown = rows.slice(page * BROWSE_PAGE, (page + 1) * BROWSE_PAGE).map((row) => {
    const onList = CATALOGUE.some((app) => app.id === row.id);
    if (!onList) browseSeen.set(row.id, row.name);
    return { ...row, onList, status: exactStatus(row.id) };
  });
  return { available: true, rows: shown, total: rows.length, page, pages };
}

/** What winget knows about a package, for checking it before installing. */
async function details(id) {
  if (!browseSeen.has(id) && !CATALOGUE.some((app) => app.id === id)) throw new Error('Search for that program again.');
  const text = await winget(['show', '--id', id, '--exact', '--source', 'winget', ...WINGET_FLAGS]);
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd());
  const start = lines.findIndex((l) => /\[.+\]$/.test(l.trim()));
  const from = start === -1 ? 0 : start + 1;
  const end = lines.findIndex((l, i) => i > from && /^(Tags|Installer|Release Notes|Documentation|Purchase Url):/.test(l));
  const kept = lines.slice(from, end === -1 ? from + 20 : end).filter((l) => l.trim() && !/^(Author|Moniker|Copyright|Copyright Url|Publisher Support Url|Privacy Url|License Url):/.test(l));
  return { text: kept.join('\n').slice(0, 1600) };
}

// Installs what's missing, updates what's old and leaves what's current alone.
function planInstall(ids) {
  const wanted = Array.isArray(ids) ? ids : [];
  const listed = CATALOGUE.filter((app) => wanted.includes(app.id))
    .map(({ id, name }) => ({ id, name, ...(lastStatus.get(id) || { status: 'missing', installedId: null }) }));
  const browsed = wanted.filter((id) => browseSeen.has(id) && !listed.some((item) => item.id === id))
    .map((id) => {
      const status = exactStatus(id);
      return { id, name: browseSeen.get(id), status, installedId: status === 'outdated' ? id : null };
    });
  return [...listed, ...browsed].filter((item) => item.status !== 'current');
}

function installArgs(item) {
  return item.status === 'outdated'
    ? ['upgrade', '--id', item.installedId, ...QUIET]
    : ['install', '--id', item.id, '--source', 'winget', '--no-upgrade', ...QUIET];
}

function install(ids, onProgress) {
  const chosen = planInstall(ids);
  if (!chosen.length) throw new Error('Tick at least one program that needs installing or updating.');
  return runBatch(chosen, installArgs, onProgress);
}

// Lets the current install finish: killing winget would leave its installer running
// with nothing watching it. Downloads have nothing to protect, so those stop now.
function stop() {
  stopping = true;
  for (const child of downloads) child.kill();
  return children.size > 0;
}

function kill() {
  stopping = true;
  for (const child of children) child.kill();
  putDownloaderBack();
}

async function exportList(file) {
  await winget(['export', '-o', file, '--include-versions', ...WINGET_FLAGS]);
}

module.exports = { upgrades, catalogue, browse, details, upgrade, install, stop, kill, exportList, available, repairWinget, CATALOGUE, __internals: { splitColumns, BROWSE_TAGS, parseTables, parseUpgrades, planInstall, installArgs, runBatch, writeFraction } };
