# Downloadt de officiele Node.js-runtime (Windows x64) en controleert de SHA-256 van nodejs.org.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$V = 'v22.23.4'
$Zip = "node-$V-win-x64.zip"
$Expected = 'cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20'
$Tmp = Join-Path $env:TEMP "fnx-node-$([guid]::NewGuid())"
New-Item -ItemType Directory -Force $Tmp | Out-Null
try {
  Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$V/$Zip" -OutFile (Join-Path $Tmp $Zip)
  $Actual = (Get-FileHash (Join-Path $Tmp $Zip) -Algorithm SHA256).Hash.ToLower()
  if ($Actual -ne $Expected) { throw "Checksum klopt niet ($Actual)" }
  Expand-Archive (Join-Path $Tmp $Zip) -DestinationPath $Tmp -Force
  New-Item -ItemType Directory -Force (Join-Path $Here 'runtime') | Out-Null
  Copy-Item (Join-Path $Tmp "node-$V-win-x64\node.exe") (Join-Path $Here 'runtime\node.exe') -Force
  Copy-Item (Join-Path $Tmp "node-$V-win-x64\LICENSE") (Join-Path $Here 'runtime\NODE-LICENSE.txt') -Force
  Write-Host '  Runtime geinstalleerd (checksum gecontroleerd).'
  exit 0
} catch {
  Write-Host "  Fout: $($_.Exception.Message)"
  exit 1
} finally { Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue }
