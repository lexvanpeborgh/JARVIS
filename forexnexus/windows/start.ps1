# ForexNexus Alpha — Windows-starter. Start de engine (indien nodig) en opent het app-venster.
# Lokale modus: alleen bereikbaar vanaf deze pc (127.0.0.1), geen wachtwoord nodig.
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Data = Join-Path $env:LOCALAPPDATA 'ForexNexus'
$Port = 8737
$Url = "http://127.0.0.1:$Port/"
New-Item -ItemType Directory -Force -Path $Data | Out-Null

function Test-Engine { try { Invoke-WebRequest -UseBasicParsing "$($Url)api/health" -TimeoutSec 2 | Out-Null; $true } catch { $false } }

if (-not (Test-Engine)) {
  $env:FNX_DATA_DIR = $Data; $env:FNX_HOST = '127.0.0.1'; $env:PORT = "$Port"; $env:FNX_LOCAL_APP = '1'
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

# App-venster (Edge in app-modus), anders de standaardbrowser
try { Start-Process msedge -ArgumentList "--app=$Url", '--window-size=1400,900' } catch { Start-Process $Url }
