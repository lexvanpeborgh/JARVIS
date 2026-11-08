@echo off
echo ForexNexus-engine stoppen...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*app\src\server\main.js*' -and $_.ExecutablePath -like '*%~dp0*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host 'Gestopt.' }"
timeout /t 2 >nul
