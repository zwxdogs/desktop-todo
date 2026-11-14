# release.ps1 - one command from a clean tree to a rebuilt, redeployed, running app.
#
# Steps: preflight -> version -> build -> commit -> deploy -> tag -> (push with -Push).
# The version lives in app/src-tauri/tauri.conf.json; tools/version.mjs writes the
# same value into Cargo.toml and Cargo.lock and fails the run on any disagreement.
# Deployment keeps config.json and drops the legacy PyInstaller _internal directory.
# The historical zips under dist\ are build artifacts and are left alone.
#
# This file is UTF-8 **with BOM** on purpose: Windows PowerShell 5.1 misparses
# UTF-8 scripts without a BOM, and the default deploy path contains Chinese.
param(
    [ValidateSet('patch', 'minor', 'major')]
    [string]$Bump = 'patch',
    [string]$Version = '',
    [switch]$DryRun,
    [string]$DeployDir = 'E:\桌面待办\DesktopTodo',
    [switch]$Push
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$ExeSource = Join-Path $Root 'dist\DesktopTodo\DesktopTodo.exe'
$script:Step = 'preflight'

function Say([string]$message) { Write-Host "[release] $message" }
function Fail([string]$message) {
    Write-Host "[release] FAILED at $($script:Step): $message"
    exit 1
}
function Step([string]$name, [scriptblock]$body) {
    $script:Step = $name
    Say "${name}:"
    & $body
}
function Maybe([string]$plan, [scriptblock]$action) {
    if ($DryRun) { Say $plan } else { & $action }
}
function Invoke-Version([string[]]$arguments) {
    $output = & 'node' (Join-Path $Root 'tools\version.mjs') @arguments
    if ($LASTEXITCODE -ne 0) { Fail "node tools/version.mjs $($arguments -join ' ') failed" }
    return ($output | Out-String).Trim()
}
function Invoke-Checked([string]$label, [string[]]$arguments) {
    $output = & 'git' -C $Root @arguments
    if ($LASTEXITCODE -ne 0) { Fail "$label failed: git $($arguments -join ' ')" }
    return $output
}

Step 'preflight' {
    Say "repo:    $Root"
    Say "deploy:  $DeployDir"
    Say "mode:    $(if ($DryRun) { 'dry run (nothing is written)' } else { 'release' })"

    $branch = ((Invoke-Checked 'git branch' @('branch', '--show-current')) -join '').Trim()
    if ($branch -ne 'dev') { Fail "expected branch dev, found '$branch'" }
    Say "branch:  dev"

    $dirty = ((Invoke-Checked 'git status' @('status', '--porcelain')) -join "`n").Trim()
    if ($dirty) { Fail "working tree is not clean; commit or stash first:$([Environment]::NewLine)$dirty" }

    if (-not (Test-Path $ExeSource)) { Fail "no built exe at $ExeSource" }
    if (-not (Test-Path $DeployDir)) { Fail "deploy dir not found: $DeployDir" }
    if (-not (Test-Path (Join-Path $DeployDir 'config.json'))) { Fail "no config.json in $DeployDir" }

    $script:Current = Invoke-Version @('current')
    Invoke-Version @('check') | Out-Null
    if ($Version) {
        $script:Next = Invoke-Version @('assert-newer', $script:Current, $Version)
    } else {
        $script:Next = Invoke-Version @('next', $Bump)
    }
    $tag = "v$($script:Next)"
    $existing = ((Invoke-Checked 'git tag' @('tag', '--list', $tag)) -join "`n").Trim()
    if ($existing) { Fail "tag $tag already exists" }

    Say "version: $($script:Current) -> $($script:Next)"
}

Step 'version' {
    Maybe "would write $($script:Next) into tauri.conf.json, Cargo.toml and Cargo.lock" {
        Invoke-Version @('set', $script:Next) | Out-Null
        Invoke-Version @('check') | Out-Null
        Say "wrote $($script:Next) into all three files"
    }
}

Step 'build' {
    Maybe "would build $($script:Next) and write dist\DesktopTodo\DesktopTodo.exe" {
        & 'powershell' -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'build.ps1')
        if ($LASTEXITCODE -ne 0) {
            & 'git' -C $Root checkout -- app/src-tauri/tauri.conf.json app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock | Out-Null
            Fail 'build.ps1 failed; the version files were rolled back'
        }
        Say "built $(Join-Path $Root 'dist\DesktopTodo\DesktopTodo.exe')"
    }
}

Step 'commit' {
    $files = @('app/src-tauri/tauri.conf.json', 'app/src-tauri/Cargo.toml', 'app/src-tauri/Cargo.lock')
    Maybe "would commit: chore: 发布 v$($script:Next)" {
        Invoke-Checked 'git add' (@('add', '--') + $files) | Out-Null
        & 'git' -C $Root diff --cached --quiet
        if ($LASTEXITCODE -ne 0) {
            Invoke-Checked 'git commit' @('commit', '-m', "chore: 发布 v$($script:Next)") | Out-Null
            Say "committed: chore: 发布 v$($script:Next)"
        } else {
            Say 'version files were already committed'
        }
    }
}

Step 'deploy' {
    $configPath = Join-Path $DeployDir 'config.json'
    $configHash = (Get-FileHash $configPath).Hash
    Maybe "would stop DesktopTodo, copy the exe, drop legacy _internal, start it again" {
        $proc = Get-Process -Name DesktopTodo -ErrorAction SilentlyContinue
        if ($proc) {
            $proc | Stop-Process -Force
            for ($i = 0; $i -lt 50; $i += 1) {
                if (-not (Get-Process -Name DesktopTodo -ErrorAction SilentlyContinue)) { break }
                Start-Sleep -Milliseconds 100
            }
        }
        Copy-Item $ExeSource (Join-Path $DeployDir 'DesktopTodo.exe') -Force
        $legacy = Join-Path $DeployDir '_internal'
        if (Test-Path $legacy) {
            Remove-Item $legacy -Recurse -Force
            Say 'removed legacy PyInstaller _internal\'
        }
        if ((Get-FileHash $configPath).Hash -ne $configHash) { Fail 'config.json changed or disappeared during deploy' }
        Start-Process (Join-Path $DeployDir 'DesktopTodo.exe') -WorkingDirectory $DeployDir
        Start-Sleep -Seconds 3
        if (-not (Get-Process -Name DesktopTodo -ErrorAction SilentlyContinue)) { Fail 'the app did not stay running after restart' }
        Say 'deployed and restarted'
    }
}

Step 'tag' {
    Maybe "would merge dev into main, tag v$($script:Next), return to dev" {
        Invoke-Checked 'git checkout main' @('checkout', 'main') | Out-Null
        Invoke-Checked 'git merge --ff-only dev' @('merge', '--ff-only', 'dev') | Out-Null
        Invoke-Checked 'git tag' @('tag', "v$($script:Next)") | Out-Null
        Invoke-Checked 'git checkout dev' @('checkout', 'dev') | Out-Null
        Say "main is now at v$($script:Next)"
    }
}

if ($Push) {
    Step 'push' {
        Maybe "would push main and v$($script:Next) to origin" {
            Invoke-Checked 'git push main' @('push', 'origin', 'main') | Out-Null
            Invoke-Checked 'git push tag' @('push', 'origin', "v$($script:Next)") | Out-Null
            Say 'pushed main and the tag'
        }
    }
} else {
    Say 'push: skipped (pass -Push to publish main and the tag)'
}

Say "released v$($script:Next)"