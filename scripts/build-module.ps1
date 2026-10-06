# Builds the vegas-mcp startup module for VEGAS Pro 2026 into out\module.
#
#   VegasMcpStartupTest.dll  goes into the VEGAS install folder. Copying it needs administrator
#                            rights, so this script writes install-module-as-admin.ps1 for that step.
#                            The name matches the test module that VEGAS ran at startup.
#   VegasMcpBridge.dll       goes into %APPDATA%\vegas-mcp\module. No administrator rights needed.
#                            Updating it needs VEGAS closed, because VEGAS locks the DLL while open.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\build-module.ps1
param(
  [string]$VegasDir = "C:\Program Files\BorisFX\Vegas Pro 2026"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$out = Join-Path $repo "out\module"
New-Item -ItemType Directory -Force -Path $out | Out-Null

$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$api = Join-Path $VegasDir "ScriptPortal.Vegas.dll"
if (-not (Test-Path -LiteralPath $api)) { throw "VEGAS API not found: $api" }

$bridgeDll = Join-Path $out "VegasMcpBridge.dll"
& $csc /nologo /target:library /langversion:5 /warn:4 "/out:$bridgeDll" "/reference:$api" /reference:System.dll /reference:System.Core.dll /reference:System.Windows.Forms.dll (Join-Path $repo "vegas-bridge\Bridge.cs")
if ($LASTEXITCODE -ne 0) { throw "bridge build failed" }

$moduleDll = Join-Path $out "VegasMcpStartupTest.dll"
& $csc /nologo /target:library /langversion:5 /warn:4 "/out:$moduleDll" "/reference:$api" /reference:System.dll (Join-Path $repo "module\StartupModule.cs")
if ($LASTEXITCODE -ne 0) { throw "module build failed" }

$moduleDir = Join-Path $env:APPDATA "vegas-mcp\module"
New-Item -ItemType Directory -Force -Path $moduleDir | Out-Null
Copy-Item -LiteralPath $bridgeDll -Destination $moduleDir -Force

$adminScript = Join-Path $out "install-module-as-admin.ps1"
$lines = @(
  "# Run as administrator, with VEGAS closed.",
  "Remove-Item -LiteralPath '$VegasDir\VegasMcpLoader.dll' -ErrorAction SilentlyContinue",
  "Remove-Item -LiteralPath 'C:\ProgramData\VEGAS Pro\Application Extensions' -Recurse -Force -ErrorAction SilentlyContinue",
  "Copy-Item -LiteralPath '$moduleDll' -Destination '$VegasDir\VegasMcpStartupTest.dll' -Force",
  "if (Test-Path -LiteralPath '$VegasDir\VegasMcpStartupTest.dll') { 'module installed' } else { 'module NOT installed' }"
)
Set-Content -LiteralPath $adminScript -Value $lines -Encoding ascii

"built module: $moduleDll"
"built bridge: $bridgeDll"
"bridge copied to: $moduleDir"
"admin script: $adminScript"
