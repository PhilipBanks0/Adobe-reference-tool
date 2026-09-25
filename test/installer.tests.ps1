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
# Never touch a real Acrobat: no program folders, and a throwaway key in place
# of Acrobat's allowed-link-schemes policy (created below, on Windows only).
$env:REFTOOL_ACROBAT_APP_DIRS = ';'
$onWindows = ($IsWindows -or $PSVersionTable.PSEdition -eq 'Desktop')
$policyRoot = 'HKCU:\Software\ReferenceToolTests\' + [guid]::NewGuid().ToString('N')
$policyKey = "$policyRoot\cDefaultLaunchURLPerms"
$noListKey = "$policyRoot\NoList"
$env:REFTOOL_ACROBAT_POLICY_KEYS = "$policyKey;$noListKey"
$adobePerms = 'version:2|shell:3|acrobat:2|mailto:2|file:1'
function SchemePerms { (Get-ItemProperty -LiteralPath $policyKey).tSchemePerms }

$script:passed = 0; $script:failed = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
    if ($ok) { $script:passed++; Write-Host "  ok   $name" }
    else { $script:failed++; Write-Host "  FAIL $name $detail" }
}
function Run([string]$file, [string[]]$argList) {
    # Windows PowerShell 5.1 turns a child's error output into a terminating
    # error under 'Stop', which would end the whole test run.
    $ErrorActionPreference = 'Continue'
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
    if ($onWindows) {
        New-Item -Path $policyKey -Force | Out-Null
        New-Item -Path $noListKey -Force | Out-Null
        Set-ItemProperty -LiteralPath $policyKey -Name 'tSchemePerms' -Value $adobePerms
    }
    # leftover per-user copy from an older version
    New-Item -ItemType Directory -Force -Path (Join-Path $acro 'DC/JavaScripts') | Out-Null
    Copy-Item -LiteralPath (Join-Path $pkgCur.stage 'ReferenceTool.js') -Destination $dcJs -Force
    $r = Run (Join-Path $pkgCur.stage 'install.ps1') @('-Quiet', '-NoShortcuts')
    Check "installs into Acrobat program folder" ((JsVersion (Join-Path $appJs 'ReferenceTool.js')) -eq $current) $r.out
    Check "removes old per-user copy (no double load)" (-not (Test-Path $dcJs))
    $info = Get-Content (Join-Path $appDir 'installed.json') -Raw | ConvertFrom-Json
    Check "records program-folder target" (@($info.targets) -contains $appJs)
    if ($onWindows) {
        Check "allows the update link in Acrobat" ((SchemePerms) -eq "$adobePerms|reftool-update:2") (SchemePerms)
        Check "doesn't create a missing scheme list" ($null -eq (Get-ItemProperty -LiteralPath $noListKey).tSchemePerms)
        # An Acrobat update rewrites the list; a stale entry must be replaced, not doubled.
        Set-ItemProperty -LiteralPath $policyKey -Name 'tSchemePerms' -Value "$adobePerms|reftool-update:3"
    }
    $r = Run (Join-Path $appDir 'update.ps1') (@('-Yes') + $common)
    Check "update replaces program-folder copy" ((JsVersion (Join-Path $appJs 'ReferenceTool.js')) -eq $new) $r.out
    Check "update doesn't recreate per-user copy" (-not (Test-Path $dcJs))
    if ($onWindows) { Check "update puts the link entry back once" ((SchemePerms) -eq "$adobePerms|reftool-update:2") (SchemePerms) }
    $r = Run (Join-Path $appDir 'uninstall.ps1') @('-Quiet')
    Check "uninstall removes program-folder copy" (-not (Test-Path (Join-Path $appJs 'ReferenceTool.js'))) $r.out
    if ($onWindows) { Check "uninstall removes only the link entry" ((SchemePerms) -eq $adobePerms) (SchemePerms) }

    # ---- permission declined: falls back to the per-user folder -----------
    if (-not ($IsWindows -or $PSVersionTable.PSEdition -eq 'Desktop') -and ((& id -u) -ne '0')) {
        & chmod 555 $appJs
        $r = Run (Join-Path $pkgCur.stage 'install.ps1') @('-NoShortcuts')
        & chmod 755 $appJs
        Check "declined permission falls back to per-user folder" ((JsVersion $dcJs) -eq $current) $r.out
        Check "explains why and what to do" ($r.code -eq 3 -and $r.out -match "NOT FINISHED" -and $r.out -match "program folder") $r.out
        # Already in place (e.g. IT copied it in): no permission needed.
        $r = Run (Join-Path $pkgCur.stage 'install.ps1') @('-Quiet', '-NoShortcuts')
        $appFile = Join-Path $appJs 'ReferenceTool.js'
        & chmod 444 $appFile; & chmod 555 $appJs
        $r = Run (Join-Path $pkgCur.stage 'install.ps1') @('-NoShortcuts')
        & chmod 755 $appJs; & chmod 644 $appFile
        Check "same version already in place: no permission prompt" ($r.code -eq 0 -and $r.out -notmatch 'Windows will ask') $r.out
    }
    # ---- running straight from the source folder (installer\ + src\) --------
    $r = Run (Join-Path $repoRoot 'installer/install.ps1') @('-Quiet', '-NoShortcuts')
    Check "installs from the source folder layout" ($r.code -eq 0 -and (JsVersion (Join-Path $appJs 'ReferenceTool.js')) -eq $current) $r.out

    # ---- Windows: the "reftool-update:" link Acrobat uses (CI only) ------
    if (($IsWindows -or $PSVersionTable.PSEdition -eq 'Desktop') -and $env:CI) {
        $r = Run (Join-Path $pkgCur.stage 'install.ps1') @('-Quiet')
        $cmd = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Classes\reftool-update\shell\open\command').'(default)'
        Check "registers the Acrobat update link" ($cmd -match 'update\.ps1' -and $cmd -match '-FromAcrobat') $cmd
        Check "update link is a URL protocol" ($null -ne (Get-ItemProperty -LiteralPath 'HKCU:\Software\Classes\reftool-update').'URL Protocol')
        $r = Run (Join-Path $appDir 'uninstall.ps1') @('-Quiet')
        Check "uninstall removes the update link" (-not (Test-Path 'HKCU:\Software\Classes\reftool-update'))
    }

    # ---- program folder can't be written: says why and what to do ----------
    # A folder can't be created inside a file, even by an administrator, so the
    # copy fails the same way on every OS. REFTOOL_TEST_ELEVATION stands in for
    # the Windows permission box; REFTOOL_TEST_ACCOUNT for the kind of account.
    $notDir = Join-Path $tmp 'not-a-folder.txt'
    Set-Content -LiteralPath $notDir -Value 'x'
    $env:REFTOOL_ACROBAT_APP_DIRS = Join-Path $notDir 'Javascripts'
    $install = Join-Path $pkgCur.stage 'install.ps1'
    if (Test-Path $dcJs) { Remove-Item $dcJs -Force }

    $env:REFTOOL_TEST_ACCOUNT = 'standard'; $env:REFTOOL_TEST_ELEVATION = 'declined'
    $r = Run $install @('-NoShortcuts')
    Check "not an administrator: exits 3" ($r.code -eq 3) $r.out
    Check "not an administrator: warns before the prompt" ($r.out -match "ask for an administrator's name and password") $r.out
    Check "not an administrator: says why" ($r.out -match "isn't an administrator on this PC, and no administrator") $r.out
    Check "not an administrator: IT note names the folder and icacls" ($r.out -match 'Ask IT' -and $r.out.Contains($env:REFTOOL_ACROBAT_APP_DIRS) -and $r.out -match 'icacls ".+ReferenceTool\.js" /grant ".+:M"') $r.out
    Check "not an administrator: no success message" ($r.out -notmatch 'Installed version|Reinstalled version|Open Acrobat and look') $r.out
    Check "not an administrator: still copies to the per-user folder" ((JsVersion $dcJs) -eq $current)

    $env:REFTOOL_TEST_ACCOUNT = 'admin'
    $r = Run $install @('-NoShortcuts')
    Check "clicked No: says to click Yes, no IT note" ($r.code -eq 3 -and $r.out -match 'click Yes' -and $r.out -notmatch 'Ask IT') $r.out

    $env:REFTOOL_TEST_ELEVATION = 'blocked'
    $r = Run $install @('-NoShortcuts')
    Check "blocked: points at security software and IT" ($r.code -eq 3 -and $r.out -match 'security software' -and $r.out -match 'Ask IT') $r.out

    $env:REFTOOL_TEST_ELEVATION = 'run'
    $r = Run $install @('-NoShortcuts')
    Check "admin step runs from a script file and reports its error" ($r.code -eq 3 -and $r.out -match 'copying the add-on failed:\s*\r?\n\s+\S') $r.out

    $r = Run $install @('-Quiet', '-NoShortcuts')
    Check "-Quiet still shows the problem" ($r.code -eq 3 -and $r.out -match 'NOT FINISHED') $r.out

    $r = Run (Join-Path $appDir 'update.ps1') (@('-Yes') + $common)
    Check "update says the new version couldn't be installed (exit 1)" ($r.code -eq 1 -and $r.out -match "couldn't be put in Acrobat's program folder") $r.out
    Remove-Item Env:\REFTOOL_TEST_ACCOUNT, Env:\REFTOOL_TEST_ELEVATION

    # ---- Acrobat installed somewhere else: -AcrobatFolder -----------------
    $env:REFTOOL_ACROBAT_APP_DIRS = ';'
    $custom = Join-Path $tmp 'Other Adobe/Acrobat'
    New-Item -ItemType Directory -Force -Path $custom | Out-Null
    Set-Content -LiteralPath (Join-Path $custom 'Acrobat.exe') -Value ''
    $customJs = Join-Path (Join-Path $custom 'Javascripts') 'ReferenceTool.js'
    $r = Run $install @('-Quiet', '-NoShortcuts', '-AcrobatFolder', $custom)
    Check "-AcrobatFolder installs into that Acrobat's Javascripts folder" ($r.code -eq 0 -and (JsVersion $customJs) -eq $current) $r.out
    Remove-Item -LiteralPath $customJs
    $r = Run $install @('-Quiet', '-NoShortcuts')
    Check "remembers -AcrobatFolder for updates" ($r.code -eq 0 -and (JsVersion $customJs) -eq $current) $r.out
    $r = Run $install @('-Quiet', '-NoShortcuts', '-AcrobatFolder', (Join-Path $tmp 'no/such/folder'))
    Check "rejects an Acrobat folder that doesn't exist (exit 2)" ($r.code -eq 2 -and $r.out -match "doesn't exist" -and $r.out -notmatch 'Installed add-on|Installed version') $r.out

    Remove-Item Env:\REFTOOL_ACROBAT_APP_DIRS
}
finally {
    if ($server) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    if ($onWindows) {
        Remove-Item -LiteralPath $policyRoot -Recurse -Force -ErrorAction SilentlyContinue
        $testsKey = 'HKCU:\Software\ReferenceToolTests'
        if ((Test-Path $testsKey) -and -not (Get-ChildItem $testsKey)) { Remove-Item $testsKey -Force }
    }
}

Write-Host ""
Write-Host "$($script:passed) passed, $($script:failed) failed"
if ($script:failed -gt 0) { exit 1 }
exit 0
