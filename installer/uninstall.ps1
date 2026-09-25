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

function Invoke-Elevated([string]$command) {
    $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    try {
        $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden `
            -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $enc)
        return ($p.ExitCode -eq 0)
    } catch { return $false }
}
function Quote([string]$s) { return "'" + ($s -replace "'", "''") + "'" }

$needAdmin = @()
foreach ($t in ($targets | Select-Object -Unique)) {
    $f = Join-Path $t 'ReferenceTool.js'
    if (Test-Path -LiteralPath $f) {
        try { Remove-Item -LiteralPath $f -Force; Say "  Removed $f" } catch { $needAdmin += $f }
    }
}
if ($needAdmin.Count -gt 0) {
    Say "  Windows will ask for permission to remove the add-on from Acrobat's program folder..."
    $cmd = ($needAdmin | ForEach-Object { "Remove-Item -LiteralPath $(Quote $_) -Force" }) -join '; '
    [void](Invoke-Elevated $cmd)
    foreach ($f in $needAdmin) {
        if (Test-Path -LiteralPath $f) { Say "  Could not remove $f (permission declined)" } else { Say "  Removed $f" }
    }
}

try { Remove-Item -Path 'HKCU:\Software\Classes\reftool-update' -Recurse -Force -ErrorAction Stop; Say "  Removed the Acrobat update link" } catch { }

$startDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Reference Tool'
if (Test-Path -LiteralPath $startDir) { Remove-Item -LiteralPath $startDir -Recurse -Force; Say "  Removed Start menu shortcuts" }
if (Test-Path -LiteralPath $appDir) { Remove-Item -LiteralPath $appDir -Recurse -Force; Say "  Removed $appDir" }

Say ""
Say "Reference Tool uninstalled. Restart Acrobat to finish."
exit 0
