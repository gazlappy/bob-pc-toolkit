@echo off
setlocal
rem Strip the trailing backslash so the app path (which contains a space) is
rem passed to Electron as a single quoted argument through the UAC prompt.
set "APPDIR=%~dp0"
set "APPDIR=%APPDIR:~0,-1%"
powershell -NoProfile -Command "Start-Process -FilePath '%APPDIR%\node_modules\electron\dist\electron.exe' -ArgumentList '\"%APPDIR%\"' -Verb RunAs"
