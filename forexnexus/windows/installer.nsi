; ForexNexus Alpha — Windows-installer (NSIS). Installatie per gebruiker, geen beheerdersrechten.
Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"

!define APPNAME "ForexNexus Alpha"
!define APPKEY "ForexNexusAlpha"
!ifndef VERSION
  !define VERSION "1.1.0"
!endif
!ifndef STAGE
  !define STAGE "stage"
!endif

Name "${APPNAME}"
OutFile "ForexNexus-Alpha-Setup.exe"
InstallDir "$LOCALAPPDATA\Programs\ForexNexus"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "${APPNAME} ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "FileDescription" "${APPNAME} installatie"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Privégebruik"

!define MUI_ICON "${STAGE}\forexnexus.ico"
!define MUI_UNICON "${STAGE}\forexnexus.ico"
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "ForexNexus Alpha nu starten"
!define MUI_FINISHPAGE_RUN_FUNCTION StartApp
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Dutch"

!define PS '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"'
!define PSARGS '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\start.ps1"'
!define STOPCMD `-NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $$_.ExecutablePath -like '$INSTDIR\*' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"`

Function StartApp
  Exec '${PS} ${PSARGS}'
FunctionEnd

Section "ForexNexus Alpha (vereist)" SecMain
  SectionIn RO
  nsExec::Exec '${PS} ${STOPCMD}'
  SetOutPath "$INSTDIR"
  RMDir /r "$INSTDIR\app"
  File /r "${STAGE}\*.*"
  WriteUninstaller "$INSTDIR\Verwijderen.exe"
  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" ${PS} '${PSARGS}' "$INSTDIR\forexnexus.ico" 0 SW_SHOWMINIMIZED
  CreateShortcut "$SMPROGRAMS\${APPNAME}\ForexNexus stoppen.lnk" "$INSTDIR\ForexNexus-stoppen.cmd" "" "$INSTDIR\forexnexus.ico" 0 SW_SHOWMINIMIZED
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME} verwijderen.lnk" "$INSTDIR\Verwijderen.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPKEY}" "Publisher" "ForexNexus"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPKEY}" "DisplayIcon" "$INSTDIR\forexnexus.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPKEY}" "UninstallString" '"$INSTDIR\Verwijderen.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPKEY}" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPKEY}" "EstimatedSize" $0
SectionEnd

Section "Snelkoppeling op het bureaublad" SecDesktop
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" ${PS} '${PSARGS}' "$INSTDIR\forexnexus.ico" 0 SW_SHOWMINIMIZED
SectionEnd

Section /o "Automatisch starten bij aanmelden (bewaking zolang de pc aanstaat)" SecAutostart
  CreateShortcut "$SMSTARTUP\${APPNAME}.lnk" ${PS} '${PSARGS}' "$INSTDIR\forexnexus.ico" 0 SW_SHOWMINIMIZED
SectionEnd

Section "Uninstall"
  nsExec::Exec '${PS} ${STOPCMD}'
  Delete "$DESKTOP\${APPNAME}.lnk"
  Delete "$SMSTARTUP\${APPNAME}.lnk"
  RMDir /r "$SMPROGRAMS\${APPNAME}"
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\runtime"
  Delete "$INSTDIR\*.*"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPKEY}"
  MessageBox MB_YESNO|MB_ICONQUESTION "Ook je ForexNexus-gegevens verwijderen (instellingen, versleutelde sleutels, paperhistorie)?$\r$\nKies Nee om ze te bewaren." /SD IDNO IDNO keep
    RMDir /r "$LOCALAPPDATA\ForexNexus"
  keep:
SectionEnd
