<#
  Updates the Workpaper Reference Tool from the latest GitHub release.

    Update.cmd                 check, show what's new, ask, then install
    update.ps1 -CheckOnly      just report (exit code 10 = update available)
    update.ps1 -Yes            install without asking

  Downloads are checked against the release's SHA256SUMS.txt before installing.
#>
[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$Yes,
    # Started from Acrobat's "Install now": keep the window open at the end.
    [switch]$FromAcrobat,
    [string]$Repo = 'PhilipBanks0/Adobe-reference-tool',
    [string]$ApiBase = 'https://api.github.com'
)

$ErrorActionPreference = 'Stop'

function Finish([int]$code) {
    if ($FromAcrobat) {
        Write-Host ""
        if ($code -eq 0) { Write-Host "Restart Acrobat to use the new version." }
        [void](Read-Host "Press Enter to close this window")
    }
    exit $code
}
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
$ProgressPreference = 'SilentlyContinue'
$headers = @{ 'User-Agent' = 'ReferenceTool-Updater'; 'Accept' = 'application/vnd.github+json' }

function Get-ToolVersion([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $m = Select-String -LiteralPath $path -Pattern 'var VERSION = "([^"]+)"' | Select-Object -First 1
    if ($m) { return $m.Matches[0].Groups[1].Value }
    return $null
}

function Compare-Version([string]$a, [string]$b) {
    $pa = (($a -replace '^v', '') -split '[-+]')[0].Split('.')
    $pb = (($b -replace '^v', '') -split '[-+]')[0].Split('.')
    for ($i = 0; $i -lt 3; $i++) {
        $x = 0; $y = 0
        if ($i -lt $pa.Count) { [void][int]::TryParse($pa[$i], [ref]$x) }
        if ($i -lt $pb.Count) { [void][int]::TryParse($pb[$i], [ref]$y) }
        if ($x -lt $y) { return -1 }
        if ($x -gt $y) { return 1 }
    }
    return 0
}

function Get-InstalledVersion {
    $appDir = Join-Path $env:LOCALAPPDATA 'ReferenceTool'
    $infoPath = Join-Path $appDir 'installed.json'
    if (Test-Path -LiteralPath $infoPath) {
        $info = Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json
        foreach ($t in @($info.targets)) {
            $v = Get-ToolVersion (Join-Path $t 'ReferenceTool.js')
            if ($v) { return $v }
        }
    }
    return Get-ToolVersion (Join-Path $env:APPDATA 'Adobe\Acrobat\DC\JavaScripts\ReferenceTool.js')
}

$installed = Get-InstalledVersion
Write-Host "Workpaper Reference Tool updater"
Write-Host ("Installed version: " + $(if ($installed) { $installed } else { 'not installed' }))

try {
    $rel = Invoke-RestMethod -Uri "$ApiBase/repos/$Repo/releases/latest" -Headers $headers -UseBasicParsing
} catch {
    Write-Host "Couldn't reach GitHub: $($_.Exception.Message)"
    Write-Host "Check your internet connection, or download the release manually from https://github.com/$Repo/releases"
    Finish 2
}

$latest = ($rel.tag_name -replace '^v', '')
Write-Host "Latest release:    $latest"

if ($installed -and (Compare-Version $latest $installed) -le 0) {
    Write-Host "You're up to date."
    Finish 0
}

Write-Host ""
Write-Host "What's new in $($latest):"
if ($rel.body) { Write-Host ($rel.body.Trim()) } else { Write-Host "  (no release notes)" }
Write-Host ""

if ($CheckOnly) { Finish 10 }

if (-not $Yes) {
    $answer = Read-Host "Install version $latest now? (Y/N)"
    if ($answer -notmatch '^(y|yes)$') { Write-Host "No changes made."; Finish 0 }
}

$zipAsset = @($rel.assets | Where-Object { $_.name -like 'ReferenceTool-*.zip' }) | Select-Object -First 1
$sumAsset = @($rel.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' }) | Select-Object -First 1
if (-not $zipAsset) { Write-Host "This release has no installer zip attached. Download it manually from $($rel.html_url)"; Finish 3 }

$work = Join-Path ([IO.Path]::GetTempPath()) ("ReferenceTool-update-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $work | Out-Null
try {
    $zipPath = Join-Path $work $zipAsset.name
    Write-Host "Downloading $($zipAsset.name)..."
    Invoke-WebRequest -Uri $zipAsset.browser_download_url -OutFile $zipPath -Headers @{ 'User-Agent' = 'ReferenceTool-Updater' } -UseBasicParsing

    if ($sumAsset) {
        $sumPath = Join-Path $work 'SHA256SUMS.txt'
        Invoke-WebRequest -Uri $sumAsset.browser_download_url -OutFile $sumPath -Headers @{ 'User-Agent' = 'ReferenceTool-Updater' } -UseBasicParsing
        $line = Get-Content -LiteralPath $sumPath | Where-Object { $_ -match ('\s\*?' + [regex]::Escape($zipAsset.name) + '$') } | Select-Object -First 1
        if (-not $line) { throw "The checksum file doesn't list $($zipAsset.name)." }
        $expected = ($line -split '\s+')[0].ToLower()
        $actual = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLower()
        if ($expected -ne $actual) { throw "Download failed its integrity check (SHA-256 mismatch). Nothing was installed." }
        Write-Host "Download verified."
    } else {
        Write-Host "Warning: this release has no SHA256SUMS.txt, so the download could not be verified."
    }

    $unz = Join-Path $work 'unzipped'
    Expand-Archive -LiteralPath $zipPath -DestinationPath $unz -Force
    $installer = Get-ChildItem -LiteralPath $unz -Recurse -Filter 'install.ps1' | Select-Object -First 1
    if (-not $installer) { throw "install.ps1 was not found in the downloaded release." }

    & $installer.FullName -Quiet
    $now = Get-InstalledVersion
    if ($now -ne $latest) { throw "Install finished but the installed version is '$now', expected '$latest'." }
    Write-Host "Updated to version $latest."
    if (-not $FromAcrobat -and (Get-Process -Name 'Acrobat', 'AcroRd32' -ErrorAction SilentlyContinue)) {
        Write-Host "Close and reopen Acrobat to start using it."
    }
    Finish 0
} catch {
    Write-Host "Update failed: $($_.Exception.Message)"
    Finish 1
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
