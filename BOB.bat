@echo off
setlocal
rem Strip the trailing backslash so a path with spaces quotes cleanly.
set "APPDIR=%~dp0"
set "APPDIR=%APPDIR:~0,-1%"
start "" "%APPDIR%\node_modules\electron\dist\electron.exe" "%APPDIR%"
