@echo off
title ForexNexus Alpha - engine (dit venster open laten)
cd /d "%~dp0"
set "FNX_DATA_DIR=%LOCALAPPDATA%\ForexNexus"
set "FNX_HOST=127.0.0.1"
set "PORT=8737"
set "FNX_LOCAL_APP=1"
if not exist "%FNX_DATA_DIR%" mkdir "%FNX_DATA_DIR%"
if not exist "%~dp0runtime\node.exe" (
  echo FOUT: runtime\node.exe niet gevonden. Pak eerst het volledige zip-bestand uit.
  pause
  exit /b 1
)
echo.
echo  ForexNexus Alpha wordt gestart...
echo  De app opent zo in je browser: http://127.0.0.1:8737/
echo  Laat dit venster open (mag geminimaliseerd). Sluiten = engine stoppen.
echo.
start "" /min cmd /c "ping -n 6 127.0.0.1 >nul & start http://127.0.0.1:8737/"
"%~dp0runtime\node.exe" --no-warnings "%~dp0app\src\server\main.js"
echo.
echo  De engine is gestopt. Druk op een toets om dit venster te sluiten.
pause >nul
