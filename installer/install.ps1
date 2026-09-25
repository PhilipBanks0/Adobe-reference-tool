<#
  Installs the Workpaper Reference Tool into Adobe Acrobat (Windows).

  - Copies ReferenceTool.js into Acrobat's application JavaScripts folder
    (e.g. C:\Program Files\Adobe\Acrobat DC\Acrobat\Javascripts). Current
    Acrobat versions only load add-ons from there, so Windows asks once for
    admin permission (UAC). If that doesn't work, it says why (permission
    declined, not an administrator, blocked, or the copy failed) and what to
    ask IT for, and falls back to the per-user folder (older Acrobat only).
  - Installs the updater and uninstaller to %LOCALAPPDATA%\ReferenceTool.
  - Registers a "reftool-update:" link that starts the updater, and adds it to
    Acrobat's allowed link schemes (same admin prompt) so "Install now" works.
  - Adds Start menu shortcuts: "Update Reference Tool", "Uninstall Reference Tool".

  Run Install.cmd (double-click) or:
    powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 [-Quiet] [-UserFolderOnly] [-AcrobatFolder <folder>]

  -AcrobatFolder  Acrobat's JavaScripts folder (or the folder with Acrobat.exe), for
                  when Acrobat is installed somewhere the installer doesn't look. In
                  Acrobat, Ctrl+J then app.getPath("app","javascript") shows it.
                  Remembered, so updates use it too.

  Exit codes: 0 = done; 3 = Acrobat was found, but the add-on couldn't be put in
  its program folder (the output says why and what to do).
#>
[CmdletBinding()]
param(
    [switch]$Quiet,
    [switch]$NoShortcuts,
    [switch]$UserFolderOnly,
    [string]$AcrobatFolder
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Say([string]$msg) { if (-not $Quiet) { Write-Host $msg } }
# Problems the user has to see, even when the updater runs this with -Quiet.
function Tell([string]$msg) { Write-Host $msg }

function Get-ToolVersion([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $m = Select-String -LiteralPath $path -Pattern 'var VERSION = "([^"]+)"' | Select-Object -First 1
    if ($m) { return $m.Matches[0].Groups[1].Value }
    return $null
}
function Get-Hash([string]$path) { return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash }

$src = Join-Path $here 'ReferenceTool.js'
# Running from a copy of the source code (installer\ next to src\) also works.
$repoSrc = Join-Path (Split-Path -Parent $here) 'src\ReferenceTool.js'
if (-not (Test-Path -LiteralPath $src) -and (Test-Path -LiteralPath $repoSrc)) { $src = $repoSrc }
if (-not (Test-Path -LiteralPath $src)) {
    throw "ReferenceTool.js was not found next to the installer ($here). Unzip the whole release first."
}
$version = Get-ToolVersion $src
if (-not $version) { throw "Could not read the version from ReferenceTool.js." }
$srcHash = Get-Hash $src

# Files downloaded from the internet are marked as blocked; clear that.
try { Get-ChildItem -LiteralPath $here -Recurse -File | Unblock-File -ErrorAction SilentlyContinue } catch { }

$appDir = Join-Path $env:LOCALAPPDATA 'ReferenceTool'
$infoPath = Join-Path $appDir 'installed.json'
$lastInfo = $null
if (Test-Path -LiteralPath $infoPath) {
    try { $lastInfo = Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json } catch { }
}

Say ""
Say "Workpaper Reference Tool $version - installer"
Say "---------------------------------------------"

# --- Where Acrobat is installed ---------------------------------------------
function Get-AcrobatAppJsDirs {
    # Tests can point this at fake folders.
    if ($env:REFTOOL_ACROBAT_APP_DIRS) { return @($env:REFTOOL_ACROBAT_APP_DIRS -split ';' | Where-Object { $_ }) }
    $dirs = @()
    # Every Acrobat version that registered an install path (DC, 2020, 2017, ...).
    foreach ($root in @('HKLM:\SOFTWARE\Adobe\Adobe Acrobat', 'HKLM:\SOFTWARE\WOW6432Node\Adobe\Adobe Acrobat')) {
        foreach ($product in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
            try {
                $v = (Get-ItemProperty -LiteralPath "$($product.PSPath)\InstallPath" -ErrorAction Stop).'(default)'
                if ($v -and (Test-Path -LiteralPath $v)) { $dirs += $v.TrimEnd('\') }
            } catch { }
        }
    }
    # ...and the usual folders, 64-bit and 32-bit (Program Files (x86)).
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if (-not $base) { continue }
        foreach ($d in @(Get-ChildItem -LiteralPath (Join-Path $base 'Adobe') -Directory -Filter 'Acrobat*' -ErrorAction SilentlyContinue)) {
            $app = Join-Path $d.FullName 'Acrobat'
            if (Test-Path -LiteralPath (Join-Path $app 'Acrobat.exe')) { $dirs += $app }
        }
    }
    $out = @()
    foreach ($d in ($dirs | Select-Object -Unique)) {
        $js = Get-ChildItem -LiteralPath $d -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -ieq 'JavaScripts' } | Select-Object -First 1
        if ($js) { $out += $js.FullName } else { $out += (Join-Path $d 'Javascripts') }
    }
    return @($out | Select-Object -Unique)
}

# Accepts Acrobat's JavaScripts folder, the folder with Acrobat.exe, or the path
# app.getPath() prints in Acrobat's console (/C/Program Files/...).
function Resolve-AcrobatFolder([string]$path) {
    $p = $path.Trim().Trim('"')
    if ($env:OS -eq 'Windows_NT' -and $p -match '^/([A-Za-z])/(.*)$') { $p = $Matches[1] + ':\' + ($Matches[2] -replace '/', '\') }
    $p = $p.TrimEnd('\', '/')
    if (Test-Path -LiteralPath (Join-Path $p 'Acrobat.exe')) { return (Join-Path $p 'Javascripts') }
    $sub = Join-Path $p 'Acrobat'
    if (Test-Path -LiteralPath (Join-Path $sub 'Acrobat.exe')) { return (Join-Path $sub 'Javascripts') }
    return $p
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

function Quote([string]$s) { return "'" + ($s -replace "'", "''") + "'" }

# What kind of Windows account this is, which decides what the permission box asks:
#   elevated  already running as administrator (no box needed)
#   admin     an administrator account: Windows asks Yes/No
#   standard  not an administrator: Windows asks for an administrator's name and password
#   unknown   couldn't tell
function Get-AccountKind {
    if ($env:REFTOOL_TEST_ACCOUNT) { return $env:REFTOOL_TEST_ACCOUNT }
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        if ((New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { return 'elevated' }
        # Until it's elevated, an administrator's session still lists the
        # Administrators group (S-1-5-32-544), marked "used for deny only".
        $groups = & (Join-Path $env:SystemRoot 'System32\whoami.exe') /groups 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $groups) { return 'unknown' }
        if (($groups | Out-String) -match 'S-1-5-32-544') { return 'admin' }
        return 'standard'
    } catch { return 'unknown' }
}

# Runs the admin steps in one visible PowerShell window as administrator (one
# Windows permission prompt). The steps go in a script file, not an encoded
# command line in a hidden window, which security software tends to block.
# Returns @{ result = 'ok' | 'declined' | 'blocked' | 'failed'; detail = '...' }
function Invoke-Elevated([string]$workDir, [string[]]$steps) {
    $scriptPath = Join-Path $workDir 'admin-steps.ps1'
    $logPath = Join-Path $workDir 'admin-result.txt'
    $lines = @(
        '$ErrorActionPreference = ''Stop''',
        ('$log = ' + (Quote $logPath)),
        'try { $host.UI.RawUI.WindowTitle = ''Reference Tool installer (administrator)'' } catch { }',
        'Write-Host ''Reference Tool: installing into Adobe Acrobat...''',
        'Set-Content -LiteralPath $log -Value ''started'' -Encoding UTF8',
        'try {'
    ) + @($steps | ForEach-Object { '    ' + $_ }) + @(
        '    Set-Content -LiteralPath $log -Value ''ok'' -Encoding UTF8',
        '} catch {',
        '    Set-Content -LiteralPath $log -Value (''failed: '' + $_.Exception.Message) -Encoding UTF8',
        '    exit 1',
        '}',
        'exit 0'
    )
    # With a BOM, so Windows PowerShell reads non-English folder names correctly.
    [IO.File]::WriteAllText($scriptPath, ($lines -join "`r`n"), (New-Object Text.UTF8Encoding $true))

    # Tests: 'declined' / 'blocked' pretend; 'run' runs the steps without a prompt.
    $mode = $env:REFTOOL_TEST_ELEVATION
    if ($mode -eq 'declined') { return @{ result = 'declined'; detail = '' } }
    try {
        if ($mode -eq 'run') {
            & (Get-Process -Id $PID).Path -NoProfile -ExecutionPolicy Bypass -File $scriptPath | Out-Null
        } elseif ($mode -ne 'blocked') {
            if ($env:OS -ne 'Windows_NT') { return @{ result = 'blocked'; detail = 'Windows is required.' } }
            $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            if (-not (Test-Path -LiteralPath $psExe)) { $psExe = 'powershell.exe' }
            $psi = New-Object Diagnostics.ProcessStartInfo
            $psi.FileName = $psExe
            $psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $scriptPath + '"'
            $psi.Verb = 'runas'
            $psi.UseShellExecute = $true
            $proc = [Diagnostics.Process]::Start($psi)
            if ($proc) { $proc.WaitForExit() }
        }
    } catch {
        # 1223 (ERROR_CANCELLED): the permission box was answered No, or closed.
        $e = $_.Exception
        while ($e) {
            if ($e -is [ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq 1223) { return @{ result = 'declined'; detail = '' } }
            $e = $e.InnerException
        }
        $e = $_.Exception
        while ($e.InnerException) { $e = $e.InnerException }
        return @{ result = 'blocked'; detail = $e.Message }
    }
    $log = ''
    if (Test-Path -LiteralPath $logPath) { $log = ([string](Get-Content -LiteralPath $logPath -Raw -Encoding UTF8)).Trim() }
    if ($log -eq 'ok') { return @{ result = 'ok'; detail = '' } }
    if ($log -like 'failed: *') { return @{ result = 'failed'; detail = $log.Substring(8) } }
    # The admin window never got to (or never finished) its steps.
    return @{ result = 'blocked'; detail = '' }
}

# Acrobat only hands a link to Windows if its scheme is allowed in the machine
# policy list (tSchemePerms, 2 = allow). Without an entry, "Install now" in
# Acrobat silently does nothing. Adobe's own updates can rewrite the list, so
# every install (and so every update) puts the entry back.
$UpdateScheme = 'reftool-update'
function Get-AcrobatUrlPolicyKeys {
    # Tests can point this at a throwaway key.
    if ($env:REFTOOL_ACROBAT_POLICY_KEYS) { return @($env:REFTOOL_ACROBAT_POLICY_KEYS -split ';' | Where-Object { $_ }) }
    $out = @()
    $root = 'HKLM:\SOFTWARE\Policies\Adobe\Adobe Acrobat'
    foreach ($product in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
        $k = "$root\$($product.PSChildName)\FeatureLockDown\cDefaultLaunchURLPerms"
        if (Test-Path -LiteralPath $k) { $out += $k }
    }
    return $out
}
function Get-SchemePerms([string]$key) {
    try { return [string](Get-ItemProperty -LiteralPath $key -Name 'tSchemePerms' -ErrorAction Stop).tSchemePerms } catch { return $null }
}
function Test-SchemeAllowed([string]$key) {
    return (@((Get-SchemePerms $key) -split '\|') -contains "$($UpdateScheme):2")
}

# --- Acrobat's program folder -----------------------------------------------
$appTargets = @()
$customFolder = $null
if (-not $UserFolderOnly) {
    if ($AcrobatFolder) {
        $customFolder = Resolve-AcrobatFolder $AcrobatFolder
        if (-not (Test-Path -LiteralPath (Split-Path -Parent $customFolder))) {
            throw "The Acrobat folder '$AcrobatFolder' doesn't exist. In Acrobat, press Ctrl+J, type app.getPath(`"app`",`"javascript`") and press Ctrl+Enter to see the right one."
        }
    } elseif ($lastInfo -and $lastInfo.acrobatFolder -and (Test-Path -LiteralPath (Split-Path -Parent $lastInfo.acrobatFolder))) {
        $customFolder = [string]$lastInfo.acrobatFolder
    }
    $appTargets = @(Get-AcrobatAppJsDirs)
    if ($customFolder) { $appTargets = @(@($customFolder) + $appTargets | Select-Object -Unique) }
}
$installed = @()
$previous = $null
$needAdmin = @()

foreach ($t in $appTargets) {
    $dest = Join-Path $t 'ReferenceTool.js'
    if (-not $previous) { $previous = Get-ToolVersion $dest }
    try {
        # Already there (for example IT copied it in): nothing to do, no prompt.
        if ((Test-Path -LiteralPath $dest) -and (Get-Hash $dest) -eq $srcHash) { $installed += $t; continue }
        if (-not (Test-Path -LiteralPath $t)) { New-Item -ItemType Directory -Force -Path $t | Out-Null }
        Copy-Item -LiteralPath $src -Destination $dest -Force
        $installed += $t
    } catch {
        $needAdmin += $t
    }
}

# The admin window copies from a copy in the temp folder: the installer's own
# folder may be on a mapped drive, which an administrator window can't see.
$workDir = Join-Path ([IO.Path]::GetTempPath()) ('ReferenceTool-install-' + [guid]::NewGuid().ToString('N'))
$staged = Join-Path $workDir 'ReferenceTool.js'
$adminSteps = @()
foreach ($t in $needAdmin) {
    $adminSteps += "if (-not (Test-Path -LiteralPath $(Quote $t))) { New-Item -ItemType Directory -Force -Path $(Quote $t) | Out-Null }"
    $adminSteps += "Copy-Item -LiteralPath $(Quote $staged) -Destination $(Quote (Join-Path $t 'ReferenceTool.js')) -Force"
}

# Allow the "reftool-update:" link in Acrobat. Only an existing list is
# extended: writing one from scratch could drop Adobe's built-in blocks.
$policyKeys = @()
$policySteps = @()
if (-not $UserFolderOnly) {
    foreach ($k in @(Get-AcrobatUrlPolicyKeys)) {
        $cur = Get-SchemePerms $k
        if (-not $cur -or (Test-SchemeAllowed $k)) { continue }
        $keep = @($cur -split '\|' | Where-Object { $_ -and $_ -notlike "$($UpdateScheme):*" })
        $new = ($keep + "$($UpdateScheme):2") -join '|'
        $policyKeys += $k
        try { Set-ItemProperty -LiteralPath $k -Name 'tSchemePerms' -Value $new }
        catch { $policySteps += "Set-ItemProperty -LiteralPath $(Quote $k) -Name 'tSchemePerms' -Value $(Quote $new)" }
    }
}

$account = $null
$elev = $null
if ($adminSteps.Count -gt 0 -or $policySteps.Count -gt 0) { $account = Get-AccountKind }
# Someone who isn't an administrator would need an administrator's password just
# for the update link; don't ask for that. The Start menu updater works without it.
if ($policySteps.Count -gt 0 -and ($adminSteps.Count -gt 0 -or $account -ne 'standard')) { $adminSteps += $policySteps }

if ($adminSteps.Count -gt 0) {
    $what = if ($needAdmin.Count -gt 0) { "install into Acrobat's program folder" } else { "let Acrobat start the updater" }
    if ($account -eq 'standard') {
        Tell "  Windows will now ask for an administrator's name and password, because your"
        Tell "  account isn't an administrator on this PC. If you don't have one, click No;"
        Tell "  the note at the end says what to ask IT for."
    } else {
        Tell "  Windows will ask for permission to $($what): click Yes."
    }
    try {
        New-Item -ItemType Directory -Force -Path $workDir | Out-Null
        Copy-Item -LiteralPath $src -Destination $staged -Force
        $elev = Invoke-Elevated $workDir $adminSteps
    } finally {
        Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    foreach ($t in $needAdmin) {
        if ((Get-ToolVersion (Join-Path $t 'ReferenceTool.js')) -eq $version) { $installed += $t }
    }
}

foreach ($t in $installed) { Say "  Installed add-on to $t" }
if ($policyKeys.Count -gt 0) {
    if (@($policyKeys | Where-Object { -not (Test-SchemeAllowed $_) }).Count -eq 0) {
        Say "  Allowed Acrobat to open the updater link"
    } else {
        Say "  (Could not allow the updater link in Acrobat, so 'Install now' there may do nothing."
        Say "   Use Start menu > Reference Tool > Update Reference Tool instead.)"
    }
}

# What stopped the program-folder install, if anything.
$problem = $null
if (-not $UserFolderOnly) {
    if ($appTargets.Count -eq 0) { $problem = 'notfound' }
    elseif ($installed.Count -eq 0) { $problem = 'noprogramfolder' }
}

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
        if ($UserFolderOnly) { Say "  Installed add-on to $u" }
        else { Say "  Copied the add-on to your own folder, which only older Acrobat versions read: $u" }
    }
}
$targets = $installed

# --- Updater / uninstaller ---------------------------------------------------
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
if ($customFolder) { $info.acrobatFolder = $customFolder }
$info | ConvertTo-Json | Set-Content -LiteralPath $infoPath -Encoding UTF8

# --- "reftool-update:" link, so Acrobat can start the updater ----------------
# Per-user (HKCU), no admin needed. Acrobat's "Install now" opens this link.
if (-not $NoShortcuts) {
    try {
        $key = 'HKCU:\Software\Classes\reftool-update'
        New-Item -Path "$key\shell\open\command" -Force | Out-Null
        Set-ItemProperty -Path $key -Name '(default)' -Value 'URL:Reference Tool updater'
        Set-ItemProperty -Path $key -Name 'URL Protocol' -Value ''
        $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $cmd = '"' + $ps + '" -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $appDir 'update.ps1') + '" -Yes -FromAcrobat'
        Set-ItemProperty -Path "$key\shell\open\command" -Name '(default)' -Value $cmd
        Say "  Registered the updater so Acrobat can start it"
    } catch {
        Say "  (Could not register the Acrobat update link: $($_.Exception.Message))"
    }
}

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

# --- Couldn't get into Acrobat's program folder: say why and what to do ------
if ($problem -eq 'noprogramfolder') {
    $folder = $needAdmin[0]
    $file = Join-Path $folder 'ReferenceTool.js'
    $user = if ($env:USERNAME) { $env:USERNAME } else { [Environment]::UserName }
    $who = if ($env:USERDOMAIN) { "$env:USERDOMAIN\$user" } else { $user }
    $result = if ($elev) { $elev.result } else { '' }
    $detail = if ($elev) { $elev.detail } else { '' }
    Tell ""
    Tell "NOT FINISHED: Acrobat won't load the add-on until it's in Acrobat's program folder:"
    Tell "  $folder"
    $askIt = $true
    if ($result -eq 'declined' -and $account -eq 'standard') {
        Tell "Your account isn't an administrator on this PC, and no administrator name and"
        Tell "password was entered when Windows asked."
    } elseif ($result -eq 'declined' -and ($account -eq 'admin' -or $account -eq 'elevated')) {
        Tell "Permission was declined when Windows asked. Close Acrobat, run Install.cmd again"
        Tell "and click Yes."
        $askIt = $false
    } elseif ($result -eq 'declined') {
        Tell "The Windows permission box was answered No or closed. If you clicked No, close"
        Tell "Acrobat, run Install.cmd again and click Yes. If it asked for an administrator"
        Tell "name and password you don't have, ask IT."
    } elseif ($result -eq 'blocked') {
        Tell "Something on this PC, probably security software, stopped the permission step"
        Tell "before it finished."
        if ($detail) { Tell "  ($detail)" }
    } elseif ($result -eq 'failed') {
        Tell "The permission step ran, but copying the add-on failed:"
        Tell "  $detail"
    } else {
        Tell "The add-on couldn't be copied there."
    }
    if ($askIt) {
        Tell ""
        Tell "Ask IT to help. You can send them this:"
        Tell "  Please help me install an Acrobat add-on (Workpaper Reference Tool $version)."
        Tell "  I'll run Install.cmd; please enter an administrator name and password when"
        Tell "  Windows asks. (Or copy ReferenceTool.js from the installer folder into the"
        Tell "  folder below yourself.) It adds one file, ReferenceTool.js, to"
        Tell "    $folder"
        Tell "  Optional, so later updates install without you: give my account Modify on it:"
        Tell "    icacls `"$file`" /grant `"$($who):M`""
    }
    exit 3
}

Say ""
if ($problem -eq 'notfound') {
    Say "NOTE: couldn't find Adobe Acrobat Pro or Standard in the usual places. If the menu"
    Say "doesn't appear in Acrobat: open Acrobat, press Ctrl+J, type"
    Say "  app.getPath(`"app`",`"javascript`")"
    Say "and press Ctrl+Enter. Then, in a Command Prompt in the installer folder, run:"
    Say "  Install.cmd -AcrobatFolder `"<the folder it shows>`""
    Say ""
}
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
