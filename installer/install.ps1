<#
  Installs the Workpaper Reference Tool into Adobe Acrobat (Windows).

  - Copies ReferenceTool.js into Acrobat's application JavaScripts folder
    (e.g. C:\Program Files\Adobe\Acrobat DC\Acrobat\Javascripts). Current
    Acrobat versions only load add-ons from there, so Windows asks once for
    admin permission (UAC). If that's declined, it falls back to the per-user
    folder, which only older Acrobat versions read.
  - Installs the updater and uninstaller to %LOCALAPPDATA%\ReferenceTool.
  - Adds Start menu shortcuts: "Update Reference Tool", "Uninstall Reference Tool".

  Run Install.cmd (double-click) or:
    powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 [-Quiet] [-UserFolderOnly]
#>
[CmdletBinding()]
param(
    [switch]$Quiet,
    [switch]$NoShortcuts,
    [switch]$UserFolderOnly
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
# Running from a copy of the source code (installer\ next to src\) also works.
$repoSrc = Join-Path (Split-Path -Parent $here) 'src\ReferenceTool.js'
if (-not (Test-Path -LiteralPath $src) -and (Test-Path -LiteralPath $repoSrc)) { $src = $repoSrc }
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

# --- Where Acrobat is installed ---------------------------------------------
function Get-AcrobatAppJsDirs {
    # Tests can point this at fake folders.
    if ($env:REFTOOL_ACROBAT_APP_DIRS) { return @($env:REFTOOL_ACROBAT_APP_DIRS -split ';' | Where-Object { $_ }) }
    $dirs = @()
    $keys = @(
        'HKLM:\SOFTWARE\Adobe\Adobe Acrobat\DC\InstallPath',
        'HKLM:\SOFTWARE\WOW6432Node\Adobe\Adobe Acrobat\DC\InstallPath',
        'HKLM:\SOFTWARE\Adobe\Adobe Acrobat\2020\InstallPath',
        'HKLM:\SOFTWARE\WOW6432Node\Adobe\Adobe Acrobat\2020\InstallPath'
    )
    foreach ($k in $keys) {
        try {
            $v = (Get-ItemProperty -LiteralPath $k -ErrorAction Stop).'(default)'
            if ($v -and (Test-Path -LiteralPath $v)) { $dirs += $v }
        } catch { }
    }
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if (-not $base) { continue }
        foreach ($name in @('Adobe\Acrobat DC\Acrobat', 'Adobe\Acrobat 2020\Acrobat')) {
            $d = Join-Path $base $name
            if (Test-Path -LiteralPath (Join-Path $d 'Acrobat.exe')) { $dirs += $d }
        }
    }
    $out = @()
    foreach ($d in ($dirs | Select-Object -Unique)) {
        $js = Get-ChildItem -LiteralPath $d -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -ieq 'JavaScripts' } | Select-Object -First 1
        if ($js) { $out += $js.FullName } else { $out += (Join-Path $d 'Javascripts') }
    }
    return @($out | Select-Object -Unique)
}

function Get-UserJsDirs {
    $root = Join-Path $env:APPDATA 'Adobe\Acrobat'
    $out = @()
    if (Test-Path -LiteralPath $root) {
        Get-ChildItem -LiteralPath $root -Directory |
            Where-Object { $_.Name -match '^(DC|\d{4}|\d+\.\d+)$' } |
            ForEach-Object { $out += (Join-Path $_.FullName 'JavaScripts') }
    }
    return $out
}

# Run a PowerShell snippet as administrator (one UAC prompt). Returns $true on success.
function Invoke-Elevated([string]$command) {
    $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    try {
        $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden `
            -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $enc)
        return ($p.ExitCode -eq 0)
    } catch {
        return $false
    }
}

function Quote([string]$s) { return "'" + ($s -replace "'", "''") + "'" }

$appTargets = @()
if (-not $UserFolderOnly) { $appTargets = @(Get-AcrobatAppJsDirs) }
$installed = @()
$previous = $null
$needAdmin = @()

foreach ($t in $appTargets) {
    $dest = Join-Path $t 'ReferenceTool.js'
    if (-not $previous) { $previous = Get-ToolVersion $dest }
    try {
        if (-not (Test-Path -LiteralPath $t)) { New-Item -ItemType Directory -Force -Path $t | Out-Null }
        Copy-Item -LiteralPath $src -Destination $dest -Force
        $installed += $t
    } catch {
        $needAdmin += $t
    }
}

if ($needAdmin.Count -gt 0) {
    Say "  Windows will ask for permission to install into Acrobat's program folder..."
    $cmds = @('$ErrorActionPreference = ''Stop''')
    foreach ($t in $needAdmin) {
        $cmds += "if (-not (Test-Path -LiteralPath $(Quote $t))) { New-Item -ItemType Directory -Force -Path $(Quote $t) | Out-Null }"
        $cmds += "Copy-Item -LiteralPath $(Quote $src) -Destination $(Quote (Join-Path $t 'ReferenceTool.js')) -Force"
    }
    [void](Invoke-Elevated ($cmds -join '; '))
    foreach ($t in $needAdmin) {
        if ((Get-ToolVersion (Join-Path $t 'ReferenceTool.js')) -eq $version) { $installed += $t }
    }
}

foreach ($t in $installed) { Say "  Installed add-on to $t" }

$userDirs = @(Get-UserJsDirs)
if ($installed.Count -gt 0) {
    # Remove per-user copies from earlier versions so Acrobat doesn't load two.
    foreach ($u in $userDirs) {
        $f = Join-Path $u 'ReferenceTool.js'
        if (Test-Path -LiteralPath $f) {
            if (-not $previous) { $previous = Get-ToolVersion $f }
            Remove-Item -LiteralPath $f -Force
        }
    }
} else {
    # Fallback: per-user folder (read by older Acrobat versions only).
    if ($userDirs.Count -eq 0) { $userDirs = @(Join-Path $env:APPDATA 'Adobe\Acrobat\DC\JavaScripts') }
    foreach ($u in $userDirs) {
        $dest = Join-Path $u 'ReferenceTool.js'
        if (-not $previous) { $previous = Get-ToolVersion $dest }
        New-Item -ItemType Directory -Force -Path $u | Out-Null
        Copy-Item -LiteralPath $src -Destination $dest -Force
        $installed += $u
        Say "  Installed add-on to $u"
    }
    if (-not $UserFolderOnly) {
        Say ""
        Say "  NOTE: couldn't install into Acrobat's program folder (permission declined or Acrobat not found)."
        Say "  Current versions of Acrobat only load add-ons from there. Run Install.cmd again and click Yes"
        Say "  when Windows asks for permission."
    }
}
$targets = $installed

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
    Say "Acrobat is open - quit it completely (Menu > Exit application) and reopen it to load the new version."
} else {
    Say "Open Acrobat and look for Menu > Reference Tool (top-left Menu button; Edit > Reference Tool in classic Acrobat)."
}
Say "If the menu doesn't appear: Acrobat > Preferences > JavaScript > tick 'Enable Acrobat JavaScript'."
exit 0
