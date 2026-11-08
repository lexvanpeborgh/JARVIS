# ForexNexus Alpha — Windows-starter. Start de engine (indien nodig) en opent het app-venster.
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Data = Join-Path $env:LOCALAPPDATA 'ForexNexus'
$Port = 8737
$Url = "http://127.0.0.1:$Port/"
New-Item -ItemType Directory -Force -Path $Data | Out-Null

function Test-Engine { try { Invoke-WebRequest -UseBasicParsing "$($Url)api/health" -TimeoutSec 2 | Out-Null; $true } catch { $false } }

if (-not (Test-Engine)) {
  $env:FNX_DATA_DIR = $Data; $env:FNX_HOST = '127.0.0.1'; $env:PORT = "$Port"
  $log = Join-Path $Data 'engine.log'
  Start-Process -FilePath (Join-Path $Here 'runtime\node.exe') `
    -ArgumentList '--no-warnings', "`"$(Join-Path $Here 'app\src\server\main.js')`"" `
    -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError (Join-Path $Data 'engine-fouten.log')
  for ($i = 0; $i -lt 40 -and -not (Test-Engine); $i++) { Start-Sleep -Milliseconds 500 }
  if (-not (Test-Engine)) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show("De ForexNexus-engine startte niet. Zie $Data\engine-fouten.log", 'ForexNexus Alpha') | Out-Null
    exit 1
  }
}

# Eerste keer: toon het eenmalige wachtwoord
$pw = Join-Path $Data 'INITIAL_PASSWORD.txt'; $shown = Join-Path $Data '.wachtwoord-getoond'
if ((Test-Path $pw) -and -not (Test-Path $shown)) {
  Start-Process notepad.exe -ArgumentList "`"$pw`""
  New-Item -ItemType File -Path $shown | Out-Null
}

# App-venster (Edge in app-modus), anders de standaardbrowser
try { Start-Process msedge -ArgumentList "--app=$Url", '--window-size=1400,900' } catch { Start-Process $Url }
