@echo off
rem Maakt snelkoppelingen op het bureaublad en in het Startmenu.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s = New-Object -ComObject WScript.Shell;" ^
  "foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {" ^
  "  $l = $s.CreateShortcut((Join-Path $dir 'ForexNexus Alpha.lnk'));" ^
  "  $l.TargetPath = '%~dp0ForexNexus.cmd'; $l.WorkingDirectory = '%~dp0'; $l.IconLocation = '%~dp0forexnexus.ico'; $l.WindowStyle = 7; $l.Save() }"
echo Klaar. Start ForexNexus Alpha via het bureaublad of het Startmenu.
pause
