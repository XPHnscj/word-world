$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$logDirectory = Join-Path $projectRoot "outputs\launcher"
$dataDirectory = Join-Path $projectRoot "data"
$stdoutLog = Join-Path $logDirectory "server.log"
$stderrLog = Join-Path $logDirectory "server-error.log"
$appMarker = "雅思语境记忆"
$port = 3000
$appUrl = "http://127.0.0.1:$port"
$launcherVersion = "2026.08.17-sqlite-fixed-3000"

New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null
@{
  version = $launcherVersion
  url = $appUrl
  projectRoot = $projectRoot
} | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $logDirectory "launcher-state.json")

function Test-App([int]$Port) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port" -TimeoutSec 1
    return $response.StatusCode -ge 200 -and $response.Content.Contains($appMarker)
  } catch {
    return $false
  }
}

function Test-PortInUse([int]$Port) {
  try {
    $client = [System.Net.Sockets.TcpClient]::new()
    $result = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    $connected = $result.AsyncWaitHandle.WaitOne(250) -and $client.Connected
    $client.Close()
    return $connected
  } catch {
    return $false
  }
}

try {
  if (Test-App $port) {
    Start-Process $appUrl
    exit 0
  }

  if (Test-PortInUse $port) {
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
      if (Test-App $port) {
        Start-Process $appUrl
        exit 0
      }
      Start-Sleep -Milliseconds 500
    }
    throw "Port 3000 is occupied by another program. Close it and open the launcher again. The app never changes ports, so local learning data stays attached to one address."
  }

  $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
  if (-not $npm) {
    $npm = (Get-Command npm -ErrorAction SilentlyContinue).Source
  }
  if (-not $npm) {
    throw "Node.js/npm was not found. Install Node.js 20 or later."
  }
  if (-not (Test-Path (Join-Path $projectRoot "package.json"))) {
    throw "Project files are missing: $projectRoot"
  }

  Start-Process -FilePath $npm `
    -ArgumentList @("run", "dev", "--", "--port", "$port") `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog

  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    if (Test-App $port) {
      Start-Process $appUrl
      exit 0
    }
    Start-Sleep -Milliseconds 500
  }

  throw "The app did not become ready. See $stderrLog"
} catch {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show(
    $_.Exception.Message,
    "IELTS Context Memory",
    "OK",
    "Error"
  ) | Out-Null
  exit 1
}
