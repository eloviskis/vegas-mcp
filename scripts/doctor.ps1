# Read-only check of the vegas-mcp setup on this machine. It changes nothing.
#
#   powershell -ExecutionPolicy Bypass -File scripts\doctor.ps1
#
# Each line says OK, FAIL or INFO. FAIL lines say what to run or copy to fix them.
# Exit code 0 means no FAIL lines.

param(
  [string]$Repo = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"
$results = New-Object System.Collections.ArrayList

function Add-Check([string]$Name, [string]$Status, [string]$Detail) {
  [void]$results.Add([pscustomobject]@{ Check = $Name; Status = $Status; Detail = $Detail })
}

function Test-Command([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

$venvPython = Join-Path $env:USERPROFILE ".vegas-mcp\whisper-venv\Scripts\python.exe"
$veg = "C:\Program Files\BorisFX\Vegas Pro 2026"
$scriptMenu = Join-Path $veg "Script Menu"
$bridgeSource = Join-Path $Repo "vegas-bridge\Bridge.cs"
$bridgeTarget = Join-Path $scriptMenu "Bridge.cs"
$tokenFile = Join-Path $env:APPDATA "vegas-mcp\bridge-token.txt"
$distEntry = Join-Path $Repo "dist\index.js"
$nodeExe = "C:\Program Files\nodejs\node.exe"
if (-not (Test-Path $nodeExe)) {
  $found = Get-Command node -ErrorAction SilentlyContinue
  if ($found) { $nodeExe = $found.Source }
}

# Node.js 20 or newer, the server's minimum.
if (Test-Command "node") {
  $nodeVersion = (& node --version) 2>$null
  if ($nodeVersion -match "^v(\d+)" -and [int]$matches[1] -ge 20) {
    Add-Check "Node.js 20+" "OK" $nodeVersion
  } else {
    Add-Check "Node.js 20+" "FAIL" "found $nodeVersion. Install Node.js 20 LTS or newer."
  }
} else {
  Add-Check "Node.js 20+" "FAIL" "node is not on PATH. Install Node.js 20 LTS."
}

if (Test-Command "npm") {
  Add-Check "npm" "OK" ((& npm --version) 2>$null)
} else {
  Add-Check "npm" "FAIL" "npm is not on PATH. It comes with Node.js."
}

# Python 3.10 to 3.12 for faster-whisper.
$pythonCmd = $null
foreach ($candidate in @("python", "py")) {
  if (Test-Command $candidate) { $pythonCmd = $candidate; break }
}
if ($pythonCmd) {
  $pyVersion = (& $pythonCmd --version) 2>&1 | Out-String
  if ($pyVersion -match "Python 3\.(1[0-2])\.") {
    Add-Check "Python 3.10-3.12" "OK" $pyVersion.Trim()
  } else {
    Add-Check "Python 3.10-3.12" "FAIL" "found $($pyVersion.Trim()). Install Python 3.11 for the Whisper environment."
  }
} else {
  Add-Check "Python 3.10-3.12" "FAIL" "python is not on PATH. Install Python 3.11."
}

# ffmpeg and ffprobe, used for audio extraction and file checks.
foreach ($tool in @("ffmpeg", "ffprobe")) {
  if (Test-Command $tool) {
    $line = ((& $tool -version) 2>&1 | Select-Object -First 1)
    Add-Check $tool "OK" "$line"
  } else {
    Add-Check $tool "FAIL" "not on PATH. Install FFmpeg (winget install Gyan.FFmpeg) and open a new terminal."
  }
}

# VEGAS Pro 2026 and its scripting assembly.
$dll = Join-Path $veg "ScriptPortal.Vegas.dll"
if (Test-Path $dll) {
  $version = (Get-Item $dll).VersionInfo.FileVersion
  Add-Check "VEGAS Pro 2026 installed" "OK" "ScriptPortal.Vegas.dll $version"
} else {
  Add-Check "VEGAS Pro 2026 installed" "FAIL" "not found at $veg. The bridge only works with VEGAS Pro 2026."
}

# The bridge script in VEGAS's Script Menu must match the repo's copy.
if (-not (Test-Path $bridgeSource)) {
  Add-Check "Bridge.cs in repo" "FAIL" "missing at $bridgeSource. Check out the repository again."
} elseif (-not (Test-Path $bridgeTarget)) {
  Add-Check "Bridge.cs in VEGAS Script Menu" "FAIL" "not copied yet. Copy $bridgeSource to $scriptMenu (as administrator if the folder is protected)."
} else {
  $same = (Get-FileHash $bridgeSource).Hash -eq (Get-FileHash $bridgeTarget).Hash
  if ($same) {
    Add-Check "Bridge.cs in VEGAS Script Menu" "OK" "matches the repository"
  } else {
    Add-Check "Bridge.cs in VEGAS Script Menu" "FAIL" "differs from the repository. Copy $bridgeSource over $bridgeTarget."
  }
}

# Whisper environment and model.
if (Test-Path $venvPython) {
  $probe = (& $venvPython -c "import faster_whisper; print('ok')") 2>&1 | Out-String
  if ($probe -match "ok") {
    Add-Check "Whisper environment" "OK" $venvPython
  } else {
    Add-Check "Whisper environment" "FAIL" "faster-whisper does not import. Run: $venvPython -m pip install faster-whisper"
  }
} else {
  Add-Check "Whisper environment" "FAIL" "missing at $venvPython. Create it with: python -m venv `"$env:USERPROFILE\.vegas-mcp\whisper-venv`" and then pip install faster-whisper."
}

$modelCache = Join-Path $env:USERPROFILE ".cache\huggingface\hub\models--Systran--faster-whisper-small"
if (Test-Path $modelCache) {
  Add-Check "Whisper 'small' model" "OK" "cached"
} else {
  Add-Check "Whisper 'small' model" "FAIL" "not downloaded yet. The first transcription downloads about 0.5 GB; the install script can do it now."
}

# Repository build and dependencies.
if (Test-Path $distEntry) {
  Add-Check "Server built (dist/index.js)" "OK" $distEntry
} else {
  Add-Check "Server built (dist/index.js)" "FAIL" "run: npm ci && npm run build in $Repo"
}
if ((Test-Path (Join-Path $Repo "node_modules")) -and (Test-Path (Join-Path $Repo "remotion\node_modules"))) {
  Add-Check "Node dependencies installed" "OK" "root and remotion"
} else {
  Add-Check "Node dependencies installed" "FAIL" "run: npm ci in $Repo and npm ci in $Repo\remotion"
}

# Claude desktop: the MSIX package keeps its config under LocalCache.
$desktopConfig = $null
$packageRoots = Get-ChildItem (Join-Path $env:LOCALAPPDATA "Packages") -Directory -Filter "Claude_*" -ErrorAction SilentlyContinue
foreach ($root in $packageRoots) {
  $candidate = Join-Path $root.FullName "LocalCache\Roaming\Claude\claude_desktop_config.json"
  if (Test-Path $candidate) { $desktopConfig = $candidate; break }
}
if (-not $desktopConfig) {
  $plain = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
  if (Test-Path $plain) { $desktopConfig = $plain }
}
if (-not $desktopConfig) {
  Add-Check "Claude desktop config" "INFO" "not found. Open the Claude desktop app once, then run this check again."
} else {
  $desktop = Get-Content $desktopConfig -Raw | ConvertFrom-Json
  $entry = $null
  if ($desktop.PSObject.Properties["mcpServers"]) {
    $entry = $desktop.mcpServers.PSObject.Properties["vegas-mcp"]
  }
  if ($entry -and ($entry.Value.args -contains $distEntry)) {
    Add-Check "Claude desktop: vegas-mcp registered" "OK" $desktopConfig
  } else {
    Add-Check "Claude desktop: vegas-mcp registered" "FAIL" "not registered in $desktopConfig. Run scripts\install.ps1 and reopen the Claude desktop app."
  }
}

# Claude Code: a project entry in ~/.claude.json.
$claudeCodeConfig = Join-Path $env:USERPROFILE ".claude.json"
$projectKey = $Repo.Replace("\", "/")
if (-not (Test-Path $claudeCodeConfig)) {
  Add-Check "Claude Code: vegas-mcp registered" "INFO" "no ~/.claude.json. Open Claude Code in the repo once."
} else {
  $code = Get-Content $claudeCodeConfig -Raw | ConvertFrom-Json
  $project = $null
  if ($code.PSObject.Properties["projects"]) {
    $project = $code.projects.PSObject.Properties | Where-Object { $_.Name -ieq $projectKey } | Select-Object -First 1
  }
  if ($project -and $project.Value.mcpServers -and $project.Value.mcpServers.PSObject.Properties["vegas-mcp"]) {
    Add-Check "Claude Code: vegas-mcp registered" "OK" $projectKey
  } else {
    Add-Check "Claude Code: vegas-mcp registered" "FAIL" "not registered for $projectKey. Run scripts\install.ps1."
  }
}

# The bridge is only reachable while VEGAS runs it; that is information, not a failure.
if (Test-Path $tokenFile) {
  try {
    $token = (Get-Content $tokenFile -Raw).Trim()
    $client = New-Object System.Net.Sockets.TcpClient
    $client.Connect("127.0.0.1", 47802)
    $writer = New-Object System.IO.StreamWriter($client.GetStream())
    $writer.AutoFlush = $true
    $writer.WriteLine("$token status")
    $reader = New-Object System.IO.StreamReader($client.GetStream())
    $reply = $reader.ReadLine()
    $client.Close()
    if ($reply -match '"ok": true') {
      Add-Check "VEGAS bridge running" "OK" "answers on 127.0.0.1:47802"
    } else {
      Add-Check "VEGAS bridge running" "INFO" "answered: $reply"
    }
  } catch {
    Add-Check "VEGAS bridge running" "INFO" "not running. Open the test project in VEGAS and run Tools > Scripting > Bridge."
  }
} else {
  Add-Check "VEGAS bridge running" "INFO" "never started on this machine yet"
}

$results | Format-Table -AutoSize -Wrap | Out-String | Write-Host
$fails = @($results | Where-Object { $_.Status -eq "FAIL" }).Count
if ($fails -eq 0) {
  Write-Host "Setup check passed: no FAIL lines." -ForegroundColor Green
  exit 0
}
Write-Host "$fails FAIL line(s). Fix them in the order listed, then run this check again." -ForegroundColor Yellow
exit 1
