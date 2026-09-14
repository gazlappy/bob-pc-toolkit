@echo off
cd /d "%~dp0"
powershell -NoProfile -Command "Start-Process -FilePath '%~dp0node_moduleslectron\distlectron.exe' -ArgumentList '%~dp0' -Verb RunAs"
