'use strict';

const path = require('path');
const { app } = require('electron');
const ps = require('./ps');

async function overview() {
  const data = await ps.json(`
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
$admin = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)

$disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{
    drive = $_.DeviceID
    label = $_.VolumeName
    size  = [double]$_.Size
    free  = [double]$_.FreeSpace
  }
})

[pscustomobject]@{
  admin = $admin
  user  = $identity.Name
  os    = (Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).Caption
  disks = $disks
} | ConvertTo-Json -Depth 4 -Compress
`);

  return {
    admin: Boolean(data && data.admin),
    user: (data && data.user) || '',
    os: (data && data.os) || 'Windows',
    disks: ps.arr(data && data.disks),
  };
}

// Relaunches the app through the UAC prompt.
//
// In development process.execPath is electron.exe, which needs the app
// directory passed back to it. In a portable build process.execPath is the copy
// unpacked into a temp folder, so the launcher's PORTABLE_EXECUTABLE_FILE is
// used instead — elevating the throwaway copy would leave the user staring at
// an app that vanishes on the next run.
async function elevate() {
  const args = app.isPackaged ? [] : [path.resolve(app.getAppPath())];
  const exe = (app.isPackaged && process.env.PORTABLE_EXECUTABLE_FILE) || process.execPath;
  await ps.mutate(`
${ps.payload({ exe, args })}
  # Each argument is quoted: the app path (e.g. "D:\\Projects\\PC Cleanup")
  # contains a space, and Start-Process -ArgumentList does not quote array
  # elements itself, so an unquoted path arrives split and Electron cannot find
  # the app.
  $launchArgs = @($Payload.args | ForEach-Object { '"' + $_ + '"' })
  if ($launchArgs.Count -gt 0) {
    Start-Process -FilePath $Payload.exe -ArgumentList $launchArgs -Verb RunAs | Out-Null
  } else {
    Start-Process -FilePath $Payload.exe -Verb RunAs | Out-Null
  }
`);
  setTimeout(() => app.quit(), 600);
  return true;
}

module.exports = { overview, elevate };
