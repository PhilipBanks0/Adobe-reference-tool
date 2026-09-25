<#
  Removes the Workpaper Reference Tool add-on, its updater and Start menu
  shortcuts. Your PDFs are not touched: tags and tapes already placed stay
  in them and keep working in Acrobat/Reader.
#>
[CmdletBinding()]
param([switch]$Quiet)

$ErrorActionPreference = 'Stop'
function Say([string]$msg) { if (-not $Quiet) { Write-Host $msg } }

if (-not $Quiet) {
    $answer = Read-Host "Uninstall the Reference Tool add-on? Your PDFs are not affected. (Y/N)"
    if ($answer -notmatch '^(y|yes)$') { Write-Host "Nothing was changed."; exit 0 }
}

$appDir = Join-Path $env:LOCALAPPDATA 'ReferenceTool'
$targets = @()
$infoPath = Join-Path $appDir 'installed.json'
if (Test-Path -LiteralPath $infoPath) {
    try { $targets += @((Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json).targets) } catch { }
}
$acroRoot = Join-Path $env:APPDATA 'Adobe\Acrobat'
if (Test-Path -LiteralPath $acroRoot) {
    Get-ChildItem -LiteralPath $acroRoot -Directory | ForEach-Object { $targets += (Join-Path $_.FullName 'JavaScripts') }
}

function Quote([string]$s) { return "'" + ($s -replace "'", "''") + "'" }

# Same approach as install.ps1: one visible administrator window running a
# script file (no hidden encoded command, which security software blocks).
# Returns 'ok', 'declined' (permission box answered No or closed) or 'blocked'.
function Invoke-Elevated([string[]]$steps) {
    $work = Join-Path ([IO.Path]::GetTempPath()) ('ReferenceTool-uninstall-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    $scriptPath = Join-Path $work 'admin-steps.ps1'
    $logPath = Join-Path $work 'admin-result.txt'
    $lines = @('$ErrorActionPreference = ''Stop''', 'Write-Host ''Reference Tool: removing it from Adobe Acrobat...''') +
        @($steps) + @(('Set-Content -LiteralPath ' + (Quote $logPath) + ' -Value ok'))
    [IO.File]::WriteAllText($scriptPath, ($lines -join "`r`n"), (New-Object Text.UTF8Encoding $true))
    try {
        if ($env:REFTOOL_TEST_ELEVATION -eq 'declined') { return 'declined' }
        if ($env:REFTOOL_TEST_ELEVATION -eq 'blocked' -or $env:OS -ne 'Windows_NT') { return 'blocked' }
        $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        if (-not (Test-Path -LiteralPath $psExe)) { $psExe = 'powershell.exe' }
        $psi = New-Object Diagnostics.ProcessStartInfo
        $psi.FileName = $psExe
        $psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $scriptPath + '"'
        $psi.Verb = 'runas'
        $psi.UseShellExecute = $true
        $proc = [Diagnostics.Process]::Start($psi)
        if ($proc) { $proc.WaitForExit() }
        if (Test-Path -LiteralPath $logPath) { return 'ok' }
        return 'blocked'
    } catch {
        $e = $_.Exception
        while ($e) {
            if ($e -is [ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq 1223) { return 'declined' }
            $e = $e.InnerException
        }
        return 'blocked'
    } finally {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$needAdmin = @()
foreach ($t in ($targets | Select-Object -Unique)) {
    $f = Join-Path $t 'ReferenceTool.js'
    if (Test-Path -LiteralPath $f) {
        try { Remove-Item -LiteralPath $f -Force; Say "  Removed $f" } catch { $needAdmin += $f }
    }
}
$adminCmds = @($needAdmin | ForEach-Object { "Remove-Item -LiteralPath $(Quote $_) -Force" })

# Take "reftool-update" back out of Acrobat's allowed link schemes (see install.ps1).
function Get-AcrobatUrlPolicyKeys {
    if ($env:REFTOOL_ACROBAT_POLICY_KEYS) { return @($env:REFTOOL_ACROBAT_POLICY_KEYS -split ';' | Where-Object { $_ }) }
    $out = @()
    $root = 'HKLM:\SOFTWARE\Policies\Adobe\Adobe Acrobat'
    foreach ($product in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
        $k = "$root\$($product.PSChildName)\FeatureLockDown\cDefaultLaunchURLPerms"
        if (Test-Path -LiteralPath $k) { $out += $k }
    }
    return $out
}
foreach ($k in @(Get-AcrobatUrlPolicyKeys)) {
    $cur = $null
    try { $cur = [string](Get-ItemProperty -LiteralPath $k -Name 'tSchemePerms' -ErrorAction Stop).tSchemePerms } catch { }
    if (-not $cur) { continue }
    $parts = @($cur -split '\|')
    $keep = @($parts | Where-Object { $_ -notlike 'reftool-update:*' })
    if ($keep.Count -eq $parts.Count) { continue }
    $new = $keep -join '|'
    try { Set-ItemProperty -LiteralPath $k -Name 'tSchemePerms' -Value $new }
    catch { $adminCmds += "Set-ItemProperty -LiteralPath $(Quote $k) -Name 'tSchemePerms' -Value $(Quote $new)" }
}

if ($adminCmds.Count -gt 0) {
    Say "  Windows will ask for permission to remove the add-on from Acrobat's program folder..."
    $result = Invoke-Elevated $adminCmds
    foreach ($f in $needAdmin) {
        if (Test-Path -LiteralPath $f) {
            Write-Host "  Could not remove $f"
            if ($result -eq 'declined') {
                Write-Host "  (Permission was declined. If Windows asked for an administrator name and password"
                Write-Host "   you don't have, ask IT to delete that file.)"
            } else {
                Write-Host "  (The permission step was blocked, probably by security software. Ask IT to delete that file.)"
            }
        } else { Say "  Removed $f" }
    }
}

try { Remove-Item -Path 'HKCU:\Software\Classes\reftool-update' -Recurse -Force -ErrorAction Stop; Say "  Removed the Acrobat update link" } catch { }

$startDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Reference Tool'
if (Test-Path -LiteralPath $startDir) { Remove-Item -LiteralPath $startDir -Recurse -Force; Say "  Removed Start menu shortcuts" }
if (Test-Path -LiteralPath $appDir) { Remove-Item -LiteralPath $appDir -Recurse -Force; Say "  Removed $appDir" }

Say ""
Say "Reference Tool uninstalled. Restart Acrobat to finish."
exit 0
