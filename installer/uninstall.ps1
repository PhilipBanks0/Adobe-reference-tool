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

foreach ($t in ($targets | Select-Object -Unique)) {
    $f = Join-Path $t 'ReferenceTool.js'
    if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force; Say "  Removed $f" }
}

$startDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Reference Tool'
if (Test-Path -LiteralPath $startDir) { Remove-Item -LiteralPath $startDir -Recurse -Force; Say "  Removed Start menu shortcuts" }
if (Test-Path -LiteralPath $appDir) { Remove-Item -LiteralPath $appDir -Recurse -Force; Say "  Removed $appDir" }

Say ""
Say "Reference Tool uninstalled. Restart Acrobat to finish."
exit 0
