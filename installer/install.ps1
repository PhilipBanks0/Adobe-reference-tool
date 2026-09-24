<#
  Installs the Workpaper Reference Tool into Adobe Acrobat (Windows).

  - Copies ReferenceTool.js into every Acrobat user JavaScripts folder found
    (Acrobat DC, 2020, 2017, ...), creating the DC one if none exist.
  - Installs the updater and uninstaller to %LOCALAPPDATA%\ReferenceTool.
  - Adds Start menu shortcuts: "Update Reference Tool", "Uninstall Reference Tool".

  No admin rights needed. Run Install.cmd (double-click) or:
    powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 [-Quiet]
#>
[CmdletBinding()]
param(
    [switch]$Quiet,
    [switch]$NoShortcuts
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Say([string]$msg) { if (-not $Quiet) { Write-Host $msg } }

function Get-ToolVersion([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $m = Select-String -LiteralPath $path -Pattern 'var VERSION = "([^"]+)"' | Select-Object -First 1
    if ($m) { return $m.Matches[0].Groups[1].Value }
    return $null
}

$src = Join-Path $here 'ReferenceTool.js'
if (-not (Test-Path -LiteralPath $src)) {
    throw "ReferenceTool.js was not found next to the installer ($here). Unzip the whole release first."
}
$version = Get-ToolVersion $src
if (-not $version) { throw "Could not read the version from ReferenceTool.js." }

# Files downloaded from the internet are marked as blocked; clear that.
try { Get-ChildItem -LiteralPath $here -Recurse -File | Unblock-File -ErrorAction SilentlyContinue } catch { }

Say ""
Say "Workpaper Reference Tool $version - installer"
Say "---------------------------------------------"

# --- Acrobat JavaScripts folders -------------------------------------------
$acroRoot = Join-Path $env:APPDATA 'Adobe\Acrobat'
$targets = @()
if (Test-Path -LiteralPath $acroRoot) {
    Get-ChildItem -LiteralPath $acroRoot -Directory |
        Where-Object { $_.Name -match '^(DC|\d{4}|\d+\.\d+)$' } |
        ForEach-Object { $targets += (Join-Path $_.FullName 'JavaScripts') }
}
if ($targets.Count -eq 0) { $targets += (Join-Path $acroRoot 'DC\JavaScripts') }

$previous = $null
foreach ($t in $targets) {
    $dest = Join-Path $t 'ReferenceTool.js'
    if (-not $previous) { $previous = Get-ToolVersion $dest }
    New-Item -ItemType Directory -Force -Path $t | Out-Null
    Copy-Item -LiteralPath $src -Destination $dest -Force
    Say "  Installed add-on to $t"
}

# --- Updater / uninstaller ---------------------------------------------------
$appDir = Join-Path $env:LOCALAPPDATA 'ReferenceTool'
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
foreach ($f in @('update.ps1', 'uninstall.ps1', 'Update.cmd', 'Uninstall.cmd')) {
    $p = Join-Path $here $f
    if (Test-Path -LiteralPath $p) { Copy-Item -LiteralPath $p -Destination (Join-Path $appDir $f) -Force }
}
$info = [ordered]@{
    version     = $version
    targets     = $targets
    installedAt = (Get-Date).ToString('s')
}
$info | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $appDir 'installed.json') -Encoding UTF8

# --- Start menu shortcuts ----------------------------------------------------
if (-not $NoShortcuts) {
    try {
        $startDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Reference Tool'
        New-Item -ItemType Directory -Force -Path $startDir | Out-Null
        $shell = New-Object -ComObject WScript.Shell
        foreach ($s in @(@('Update Reference Tool', 'Update.cmd'), @('Uninstall Reference Tool', 'Uninstall.cmd'))) {
            $lnk = $shell.CreateShortcut((Join-Path $startDir ($s[0] + '.lnk')))
            $lnk.TargetPath = Join-Path $appDir $s[1]
            $lnk.WorkingDirectory = $appDir
            $lnk.Save()
        }
        Say "  Added Start menu shortcuts (Reference Tool folder)"
    } catch {
        Say "  (Could not create Start menu shortcuts: $($_.Exception.Message))"
    }
}

Say ""
if ($previous -and $previous -ne $version) {
    Say "Updated from $previous to $version."
} elseif ($previous) {
    Say "Reinstalled version $version."
} else {
    Say "Installed version $version."
}

$running = Get-Process -Name 'Acrobat', 'AcroRd32' -ErrorAction SilentlyContinue
if ($running) {
    Say "Acrobat is open - close and reopen it to load the new version."
} else {
    Say "Open Acrobat and look for Edit > Reference Tool."
}
Say "If the menu doesn't appear: Acrobat > Preferences > JavaScript > tick 'Enable Acrobat JavaScript'."
exit 0
