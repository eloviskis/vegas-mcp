# Installs what vegas-mcp needs on this Windows machine, one step at a time.
#
#   scripts\install.ps1 -Plan                         show the steps; change nothing
#   scripts\install.ps1 -Check                        run the read-only doctor
#   scripts\install.ps1 -Apply deps,whisper,build,bridge,desktop,code
#
# Every step is idempotent: it does nothing when its part is already in place, and it backs up
# any config file before changing it. Steps that install software or download a model are
# separate, so the caller can confirm each one first. Run an elevated PowerShell for "bridge"
# if the VEGAS folder is protected.

param(
  [switch]$Plan,
  [switch]$Check,
  [string]$Apply = "",
  [string]$Repo = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"
$script:Failed = $false

$veg = "C:\Program Files\BorisFX\Vegas Pro 2026"
$scriptMenu = Join-Path $veg "Script Menu"
$venv = Join-Path $env:USERPROFILE ".vegas-mcp\whisper-venv"
$venvPython = Join-Path $venv "Scripts\python.exe"
$distEntry = Join-Path $Repo "dist\index.js"
$bridgeSource = Join-Path $Repo "vegas-bridge\Bridge.cs"
$bridgeTarget = Join-Path $scriptMenu "Bridge.cs"

function Write-Ok([string]$Message) { Write-Host "  OK    $Message" -ForegroundColor Green }
function Write-Info([string]$Message) { Write-Host "  ...   $Message" -ForegroundColor Cyan }
function Write-Fail([string]$Message) { Write-Host "  FAIL  $Message" -ForegroundColor Red; $script:Failed = $true }

function Test-Command([string]$Name) { return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

function Get-NodeExe {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Get-DesktopConfig {
  $packageRoots = Get-ChildItem (Join-Path $env:LOCALAPPDATA "Packages") -Directory -Filter "Claude_*" -ErrorAction SilentlyContinue
  foreach ($root in $packageRoots) {
    $candidate = Join-Path $root.FullName "LocalCache\Roaming\Claude\claude_desktop_config.json"
    if (Test-Path $candidate) { return $candidate }
  }
  $plain = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
  if (Test-Path $plain) { return $plain }
  return $null
}

function Get-DesktopAppRunning {
  # The Claude Code extension also runs as "claude"; it lives under .vscode, so exclude it.
  $procs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq "claude" }
  foreach ($p in $procs) {
    if ($p.Path -and $p.Path -notmatch "\\\.vscode\\|claude-code") { return $true }
  }
  return $false
}

function Save-Backup([string]$Path) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backup = "$Path.bak-$stamp"
  Copy-Item $Path $backup
  Write-Info "backup: $backup"
}

function Write-Utf8NoBom([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function Step-Deps {
  Write-Host "[deps] Node.js 20+, Python 3.11, FFmpeg" -ForegroundColor White
  $tools = @(
    @{ Name = "Node.js"; Command = "node"; Id = "OpenJS.NodeJS.LTS" },
    @{ Name = "Python"; Command = "python"; Id = "Python.Python.3.11" },
    @{ Name = "FFmpeg"; Command = "ffmpeg"; Id = "Gyan.FFmpeg" }
  )
  foreach ($tool in $tools) {
    if (Test-Command $tool.Command) {
      Write-Ok "$($tool.Name) is already installed"
      continue
    }
    if (-not (Test-Command "winget")) {
      Write-Fail "$($tool.Name) is missing and winget is not available. Install $($tool.Name) by hand, then open a new terminal."
      continue
    }
    Write-Info "installing $($tool.Name) with winget ($($tool.Id))"
    winget install --id $tool.Id -e --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -eq 0) {
      Write-Ok "$($tool.Name) installed. Open a NEW terminal before the next steps, so PATH is refreshed."
    } else {
      Write-Fail "winget could not install $($tool.Name) (exit $LASTEXITCODE)"
    }
  }
}

function Step-Whisper {
  Write-Host "[whisper] Whisper environment and the 'small' model (about 0.5 GB)" -ForegroundColor White
  if (-not (Test-Command "python")) { Write-Fail "python is not on PATH. Run the deps step first, then open a new terminal."; return }
  if (-not (Test-Path $venvPython)) {
    Write-Info "creating $venv"
    python -m venv $venv
  }
  & $venvPython -m pip install --quiet --upgrade pip
  & $venvPython -m pip install --quiet faster-whisper
  if ($LASTEXITCODE -ne 0) { Write-Fail "pip could not install faster-whisper"; return }
  Write-Ok "faster-whisper installed in $venv"

  $cache = Join-Path $env:USERPROFILE ".cache\huggingface\hub\models--Systran--faster-whisper-small"
  if (Test-Path $cache) {
    Write-Ok "model 'small' already downloaded"
  } else {
    Write-Info "downloading model 'small' (about 0.5 GB, first run only)"
    & $venvPython -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')"
    if ($LASTEXITCODE -eq 0) { Write-Ok "model 'small' downloaded" } else { Write-Fail "model download failed" }
  }
}

function Step-Build {
  Write-Host "[build] Node dependencies and the server build" -ForegroundColor White
  if (-not (Test-Command "npm")) { Write-Fail "npm is not on PATH. Run the deps step first, then open a new terminal."; return }
  Push-Location $Repo
  try {
    if (Test-Path "node_modules") { Write-Ok "root dependencies present" } else { Write-Info "npm ci (root)"; npm ci; if ($LASTEXITCODE -ne 0) { Write-Fail "npm ci failed in the repo"; return } }
    if (Test-Path "remotion\node_modules") { Write-Ok "remotion dependencies present" } else { Write-Info "npm ci (remotion)"; Push-Location "remotion"; try { npm ci; if ($LASTEXITCODE -ne 0) { Write-Fail "npm ci failed in remotion"; return } } finally { Pop-Location } }
    Write-Info "npm run build"
    npm run build
    if ($LASTEXITCODE -eq 0 -and (Test-Path $distEntry)) { Write-Ok "server built: $distEntry" } else { Write-Fail "build failed" }
  } finally {
    Pop-Location
  }
}

function Step-Bridge {
  Write-Host "[bridge] Bridge.cs in the VEGAS Script Menu" -ForegroundColor White
  if (-not (Test-Path $scriptMenu)) { Write-Fail "VEGAS Pro 2026 Script Menu not found at $scriptMenu"; return }
  if ((Test-Path $bridgeTarget) -and ((Get-FileHash $bridgeSource).Hash -eq (Get-FileHash $bridgeTarget).Hash)) {
    Write-Ok "Bridge.cs already current"
    return
  }
  try {
    Copy-Item $bridgeSource $bridgeTarget -Force
    Write-Ok "copied Bridge.cs to $scriptMenu"
  } catch {
    Write-Fail "cannot write to $scriptMenu. Run this step from an elevated PowerShell (Run as administrator)."
  }
}

function Step-Desktop {
  Write-Host "[desktop] Register vegas-mcp in the Claude desktop app" -ForegroundColor White
  $cfgPath = Get-DesktopConfig
  if (-not $cfgPath) { Write-Fail "Claude desktop config not found. Open the Claude desktop app once, close it, and run this step again."; return }
  $nodeExe = Get-NodeExe
  if (-not $nodeExe) { Write-Fail "node is not on PATH. Run the deps step first."; return }

  # Nothing to change when the registration is already there, so an open app is no problem then.
  $config = Get-Content $cfgPath -Raw | ConvertFrom-Json
  $existing = $null
  if ($config.PSObject.Properties["mcpServers"]) { $existing = $config.mcpServers.PSObject.Properties["vegas-mcp"] }
  if ($existing -and ($existing.Value.args -contains $distEntry)) {
    Write-Ok "vegas-mcp already registered"
    return
  }

  if (Get-DesktopAppRunning) { Write-Fail "Close the Claude desktop app first. It rewrites this file and would undo the change."; return }
  Save-Backup $cfgPath
  $entry = [pscustomobject]@{ command = $nodeExe; args = @($distEntry) }
  if (-not $config.PSObject.Properties["mcpServers"]) {
    $config | Add-Member -NotePropertyName "mcpServers" -NotePropertyValue ([pscustomobject]@{})
  }
  $config.mcpServers | Add-Member -NotePropertyName "vegas-mcp" -NotePropertyValue $entry -Force
  Write-Utf8NoBom $cfgPath ($config | ConvertTo-Json -Depth 100)

  $check = Get-Content $cfgPath -Raw | ConvertFrom-Json
  if ($check.mcpServers.PSObject.Properties["vegas-mcp"]) {
    Write-Ok "vegas-mcp registered in $cfgPath. Reopen the Claude desktop app to load it."
  } else {
    Write-Fail "the change did not persist; restore the backup in the same folder"
  }
}

function Step-Code {
  Write-Host "[code] Register vegas-mcp in Claude Code for this repo" -ForegroundColor White
  $cfgPath = Join-Path $env:USERPROFILE ".claude.json"
  if (-not (Test-Path $cfgPath)) { Write-Fail "$cfgPath not found. Open Claude Code once in this repo, then run this step again."; return }
  $nodeExe = Get-NodeExe
  if (-not $nodeExe) { Write-Fail "node is not on PATH. Run the deps step first."; return }

  $key = $Repo.Replace("\", "/")
  $config = Get-Content $cfgPath -Raw | ConvertFrom-Json
  if (-not $config.PSObject.Properties["projects"]) { $config | Add-Member -NotePropertyName "projects" -NotePropertyValue ([pscustomobject]@{}) }
  $project = $config.projects.PSObject.Properties | Where-Object { $_.Name -ieq $key } | Select-Object -First 1
  if ($project -and $project.Value.mcpServers -and $project.Value.mcpServers.PSObject.Properties["vegas-mcp"]) {
    Write-Ok "vegas-mcp already registered for $key"
    return
  }

  Save-Backup $cfgPath
  $entry = [pscustomobject]@{ type = "stdio"; command = $nodeExe; args = @($distEntry) }
  if (-not $project) {
    $config.projects | Add-Member -NotePropertyName $key -NotePropertyValue ([pscustomobject]@{ mcpServers = [pscustomobject]@{} })
    $project = $config.projects.PSObject.Properties | Where-Object { $_.Name -eq $key } | Select-Object -First 1
  }
  if (-not $project.Value.PSObject.Properties["mcpServers"]) {
    $project.Value | Add-Member -NotePropertyName "mcpServers" -NotePropertyValue ([pscustomobject]@{})
  }
  $project.Value.mcpServers | Add-Member -NotePropertyName "vegas-mcp" -NotePropertyValue $entry -Force
  Write-Utf8NoBom $cfgPath ($config | ConvertTo-Json -Depth 100)
  Write-Ok "vegas-mcp registered for $key. Start a new Claude Code session to load it."
}

# ---- main ----

if ($Check) {
  & (Join-Path $PSScriptRoot "doctor.ps1") -Repo $Repo
  exit $LASTEXITCODE
}

$allSteps = @("deps", "whisper", "build", "bridge", "desktop", "code")
$descriptions = @{
  deps    = "install Node.js 20 LTS, Python 3.11 and FFmpeg with winget (downloads software)"
  whisper = "create the Whisper environment and download the 'small' model (about 0.5 GB)"
  build   = "npm ci in the repo and in remotion, then npm run build"
  bridge  = "copy vegas-bridge\Bridge.cs into the VEGAS 2026 Script Menu"
  desktop = "register vegas-mcp in the Claude desktop config (the app must be closed)"
  code    = "register vegas-mcp in ~/.claude.json for this repo"
}

if ($Plan -or $Apply -eq "") {
  Write-Host "vegas-mcp install steps (repo: $Repo)" -ForegroundColor White
  foreach ($step in $allSteps) { Write-Host ("  {0,-8} {1}" -f $step, $descriptions[$step]) }
  Write-Host ""
  Write-Host "Run one or more with: scripts\install.ps1 -Apply deps,whisper,build,bridge,desktop,code"
  Write-Host "Run scripts\install.ps1 -Check to see what is still missing."
  exit 0
}

$requested = $Apply.Split(",") | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ -ne "" }
foreach ($name in $requested) {
  if ($allSteps -notcontains $name) { Write-Fail "unknown step '$name'. Valid: $($allSteps -join ', ')"; exit 1 }
}

foreach ($name in $requested) {
  switch ($name) {
    "deps" { Step-Deps }
    "whisper" { Step-Whisper }
    "build" { Step-Build }
    "bridge" { Step-Bridge }
    "desktop" { Step-Desktop }
    "code" { Step-Code }
  }
  Write-Host ""
}

Write-Host "Final check:" -ForegroundColor White
& (Join-Path $PSScriptRoot "doctor.ps1") -Repo $Repo
$doctorExit = $LASTEXITCODE
if ($script:Failed -or $doctorExit -ne 0) {
  Write-Host "Some steps need attention. The lines above say what to do." -ForegroundColor Yellow
  exit 1
}
Write-Host "Install finished. Open VEGAS Pro 2026, load the test project, run Tools > Scripting > Bridge, then reopen the Claude desktop app." -ForegroundColor Green
exit 0
