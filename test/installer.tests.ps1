<#
  End-to-end tests for install.ps1 / update.ps1 / uninstall.ps1.
  Uses a throwaway APPDATA/LOCALAPPDATA and a local mock of the GitHub API,
  so nothing on the machine is touched. Runs on Windows PowerShell 5.1 and pwsh 7.
    pwsh -NoProfile -File test/installer.tests.ps1
#>
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$ps = (Get-Process -Id $PID).Path
$python = @('python3', 'python') | Where-Object { Get-Command $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
if (-not $python) { throw "python is required for the mock GitHub server" }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("reftool-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$env:APPDATA = Join-Path $tmp 'Roaming'
$env:LOCALAPPDATA = Join-Path $tmp 'Local'
New-Item -ItemType Directory -Force -Path $env:APPDATA, $env:LOCALAPPDATA | Out-Null

$script:passed = 0; $script:failed = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
    if ($ok) { $script:passed++; Write-Host "  ok   $name" }
    else { $script:failed++; Write-Host "  FAIL $name $detail" }
}
function Run([string]$file, [string[]]$argList) {
    $out = & $ps -NoProfile -ExecutionPolicy Bypass -File $file @argList 2>&1 | Out-String
    return @{ code = $LASTEXITCODE; out = $out }
}
function JsVersion([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $m = Select-String -LiteralPath $path -Pattern 'var VERSION = "([^"]+)"' | Select-Object -First 1
    if ($m) { $m.Matches[0].Groups[1].Value }
}
function New-Package([string]$version, [string]$outDir) {
    $name = "ReferenceTool-v$version"
    $stage = Join-Path $outDir $name
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $repoRoot 'installer') -File | Copy-Item -Destination $stage
    $js = Get-Content -LiteralPath (Join-Path $repoRoot 'src/ReferenceTool.js') -Raw
    $js = $js -replace 'var VERSION = "[^"]+"', "var VERSION = `"$version`""
    [IO.File]::WriteAllText((Join-Path $stage 'ReferenceTool.js'), $js)
    $zip = Join-Path $outDir "$name.zip"
    Compress-Archive -Path $stage -DestinationPath $zip -Force
    return @{ stage = $stage; zip = $zip; name = "$name.zip" }
}

$acro = Join-Path $env:APPDATA 'Adobe/Acrobat'
$dcJs = Join-Path $acro 'DC/JavaScripts/ReferenceTool.js'
$appDir = Join-Path $env:LOCALAPPDATA 'ReferenceTool'
$current = JsVersion (Join-Path $repoRoot 'src/ReferenceTool.js')
$server = $null

try {
    Write-Host "Installer tests (current version $current)"

    # ---- fresh install --------------------------------------------------
    $pkgCur = New-Package $current (Join-Path $tmp 'pkg-current')
    New-Item -ItemType Directory -Force -Path (Join-Path $acro 'DC'), (Join-Path $acro '2020'), (Join-Path $acro 'Unrelated') | Out-Null
    $r = Run (Join-Path $pkgCur.stage 'install.ps1') @('-Quiet', '-NoShortcuts')
    Check "install exits 0" ($r.code -eq 0) $r.out
    Check "installs into Acrobat DC" ((JsVersion $dcJs) -eq $current)
    Check "installs into Acrobat 2020 too" ((JsVersion (Join-Path $acro '2020/JavaScripts/ReferenceTool.js')) -eq $current)
    Check "skips unrelated folders" (-not (Test-Path (Join-Path $acro 'Unrelated/JavaScripts')))
    Check "installs updater" ((Test-Path (Join-Path $appDir 'update.ps1')) -and (Test-Path (Join-Path $appDir 'Update.cmd')))
    $info = Get-Content (Join-Path $appDir 'installed.json') -Raw | ConvertFrom-Json
    Check "records installed version" ($info.version -eq $current)

    # ---- mock GitHub with a newer release -------------------------------
    $new = '9.9.9'
    $relDir = Join-Path $tmp 'release'
    New-Item -ItemType Directory -Force -Path $relDir | Out-Null
    $pkgNew = New-Package $new $relDir
    $hash = (Get-FileHash -LiteralPath $pkgNew.zip -Algorithm SHA256).Hash.ToLower()
    Set-Content -LiteralPath (Join-Path $relDir 'SHA256SUMS.txt') -Value "$hash  $($pkgNew.name)"
    $port = Get-Random -Minimum 20000 -Maximum 40000
    $base = "http://127.0.0.1:$port"
    $latest = @{
        tag_name = "v$new"; html_url = "https://example.test/v$new"; body = "Test release notes"
        assets = @(
            @{ name = $pkgNew.name; browser_download_url = "$base/download/$($pkgNew.name)" },
            @{ name = 'SHA256SUMS.txt'; browser_download_url = "$base/download/SHA256SUMS.txt" }
        )
    }
    ($latest | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath (Join-Path $relDir 'latest.json')
    $spArgs = @{ FilePath = $python; ArgumentList = @(('"' + (Join-Path $PSScriptRoot 'mock_github.py') + '"'), $port, ('"' + $relDir + '"')); PassThru = $true }
    if ($IsWindows -or $PSVersionTable.PSEdition -eq 'Desktop') { $spArgs.WindowStyle = 'Hidden' }
    $server = Start-Process @spArgs
    Start-Sleep -Seconds 2

    $upd = Join-Path $appDir 'update.ps1'
    $common = @('-ApiBase', $base, '-Repo', 'owner/repo')

    $r = Run $upd (@('-CheckOnly') + $common)
    Check "check-only reports update available (exit 10)" ($r.code -eq 10) $r.out
    Check "shows release notes" ($r.out -match 'Test release notes')
    Check "check-only changes nothing" ((JsVersion $dcJs) -eq $current)

    # ---- tampered download is refused ------------------------------------
    Set-Content -LiteralPath (Join-Path $relDir 'SHA256SUMS.txt') -Value ("0" * 64 + "  $($pkgNew.name)")
    $r = Run $upd (@('-Yes') + $common)
    Check "bad checksum fails (exit 1)" ($r.code -eq 1) $r.out
    Check "bad checksum installs nothing" ((JsVersion $dcJs) -eq $current)
    Set-Content -LiteralPath (Join-Path $relDir 'SHA256SUMS.txt') -Value "$hash  $($pkgNew.name)"

    # ---- real update -------------------------------------------------------
    $r = Run $upd (@('-Yes') + $common)
    Check "update exits 0" ($r.code -eq 0) $r.out
    Check "update installs new version (DC)" ((JsVersion $dcJs) -eq $new)
    Check "update installs new version (2020)" ((JsVersion (Join-Path $acro '2020/JavaScripts/ReferenceTool.js')) -eq $new)

    $r = Run $upd (@('-CheckOnly') + $common)
    Check "up to date afterwards (exit 0)" ($r.code -eq 0 -and $r.out -match "up to date") $r.out

    # ---- offline ---------------------------------------------------------
    $r = Run $upd @('-CheckOnly', '-ApiBase', 'http://127.0.0.1:1', '-Repo', 'owner/repo')
    Check "offline is reported (exit 2)" ($r.code -eq 2) $r.out

    # ---- uninstall -------------------------------------------------------
    $r = Run (Join-Path $appDir 'uninstall.ps1') @('-Quiet')
    Check "uninstall exits 0" ($r.code -eq 0) $r.out
    Check "uninstall removes add-on" (-not (Test-Path $dcJs) -and -not (Test-Path (Join-Path $acro '2020/JavaScripts/ReferenceTool.js')))
    Check "uninstall removes updater" (-not (Test-Path $appDir))

    # ---- program-folder install (what current Acrobat needs) --------------
    $appJs = Join-Path $tmp 'Program Files/Adobe/Acrobat DC/Acrobat/Javascripts'
    New-Item -ItemType Directory -Force -Path $appJs | Out-Null
    $env:REFTOOL_ACROBAT_APP_DIRS = $appJs
    # leftover per-user copy from an older version
    New-Item -ItemType Directory -Force -Path (Join-Path $acro 'DC/JavaScripts') | Out-Null
    Copy-Item -LiteralPath (Join-Path $pkgCur.stage 'ReferenceTool.js') -Destination $dcJs -Force
    $r = Run (Join-Path $pkgCur.stage 'install.ps1') @('-Quiet', '-NoShortcuts')
    Check "installs into Acrobat program folder" ((JsVersion (Join-Path $appJs 'ReferenceTool.js')) -eq $current) $r.out
    Check "removes old per-user copy (no double load)" (-not (Test-Path $dcJs))
    $info = Get-Content (Join-Path $appDir 'installed.json') -Raw | ConvertFrom-Json
    Check "records program-folder target" (@($info.targets) -contains $appJs)
    $r = Run (Join-Path $appDir 'update.ps1') (@('-Yes') + $common)
    Check "update replaces program-folder copy" ((JsVersion (Join-Path $appJs 'ReferenceTool.js')) -eq $new) $r.out
    Check "update doesn't recreate per-user copy" (-not (Test-Path $dcJs))
    $r = Run (Join-Path $appDir 'uninstall.ps1') @('-Quiet')
    Check "uninstall removes program-folder copy" (-not (Test-Path (Join-Path $appJs 'ReferenceTool.js'))) $r.out

    # ---- permission declined: falls back to the per-user folder -----------
    if (-not ($IsWindows -or $PSVersionTable.PSEdition -eq 'Desktop') -and ((& id -u) -ne '0')) {
        & chmod 555 $appJs
        $r = Run (Join-Path $pkgCur.stage 'install.ps1') @('-NoShortcuts')
        & chmod 755 $appJs
        Check "declined permission falls back to per-user folder" ((JsVersion $dcJs) -eq $current) $r.out
        Check "explains why and what to do" ($r.out -match "program folder" -and $r.out -match "Run Install.cmd again")
    }
    # ---- running straight from the source folder (installer\ + src\) --------
    $r = Run (Join-Path $repoRoot 'installer/install.ps1') @('-Quiet', '-NoShortcuts')
    Check "installs from the source folder layout" ($r.code -eq 0 -and (JsVersion (Join-Path $appJs 'ReferenceTool.js')) -eq $current) $r.out

    Remove-Item Env:\REFTOOL_ACROBAT_APP_DIRS
}
finally {
    if ($server) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "$($script:passed) passed, $($script:failed) failed"
if ($script:failed -gt 0) { exit 1 }
exit 0
