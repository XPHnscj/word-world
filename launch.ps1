$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$logDirectory = Join-Path $projectRoot "outputs\launcher"
$dataDirectory = Join-Path $projectRoot "data"
$stdoutLog = Join-Path $logDirectory "server.log"
$stderrLog = Join-Path $logDirectory "server-error.log"
$appMarker = "语境记忆"
$port = 3000
$appUrl = "http://127.0.0.1:$port"
$launcherVersion = "2026.08.17-sqlite-fixed-3000"
$statePath = Join-Path $logDirectory "launcher-state.json"

New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null

function Test-App([int]$Port) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port" -TimeoutSec 1
    if ($response.StatusCode -lt 200 -or -not $response.Content.Contains($appMarker)) {
      return $false
    }

    # A stale Next dev process can return valid HTML while its stylesheet asset is 404.
    # Treat that state as unhealthy so the launcher does not keep reopening an unstyled app.
    $stylesheet = [regex]::Match($response.Content, 'href="([^"]+\.css[^\"]*)"')
    if (-not $stylesheet.Success) {
      return $false
    }
    $stylesheetUrl = $stylesheet.Groups[1].Value
    if ($stylesheetUrl.StartsWith('/')) {
      $stylesheetUrl = "http://127.0.0.1:$Port$stylesheetUrl"
    }
    $stylesheetResponse = Invoke-WebRequest -UseBasicParsing -Uri $stylesheetUrl -TimeoutSec 1
    return $stylesheetResponse.StatusCode -ge 200 -and $stylesheetResponse.Content.Length -gt 100
  } catch {
    return $false
  }
}

function Stop-ManagedApp() {
  if (-not (Test-Path $statePath)) {
    return
  }
  try {
    $state = Get-Content -Raw $statePath | ConvertFrom-Json
    $processId = [int]$state.processId
    if ($processId -le 0) {
      return
    }
    $managedProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" |
      Where-Object { $_.CommandLine -and $_.CommandLine.Contains($projectRoot) }
    if ($managedProcess) {
      # Kill only the recorded project process tree; never touch an unrelated listener on 3000.
      & taskkill.exe /PID $processId /T /F 2>$null | Out-Null
      Start-Sleep -Milliseconds 500
    }
  } catch {
    # An old launcher state may not have a process id; do not kill an unknown process.
  }
}

function Save-LauncherState([int]$ProcessId) {
  @{
    version = $launcherVersion
    url = $appUrl
    projectRoot = $projectRoot
    processId = $ProcessId
  } | ConvertTo-Json | Set-Content -Encoding UTF8 $statePath
}

function Find-ManagedProcessId() {
  $nextProcess = Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($projectRoot) -and $_.CommandLine -match 'next.*dev.*--port\s+3000' } |
    Select-Object -First 1
  if ($nextProcess) {
    return [int]$nextProcess.ProcessId
  }
  return 0
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
    $existingProcessId = Find-ManagedProcessId
    if ($existingProcessId -gt 0) {
      Save-LauncherState $existingProcessId
    }
    Start-Process $appUrl
    exit 0
  }

  if (Test-PortInUse $port) {
    Stop-ManagedApp
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

  $startedProcess = Start-Process -FilePath $npm `
    -ArgumentList @("run", "dev", "--", "--port", "$port") `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru

  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    if (Test-App $port) {
      $managedProcessId = Find-ManagedProcessId
      Save-LauncherState $(if ($managedProcessId -gt 0) { $managedProcessId } else { [int]$startedProcess.Id })
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
    "Context Memory",
    "OK",
    "Error"
  ) | Out-Null
  exit 1
}
