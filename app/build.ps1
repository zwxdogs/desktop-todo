# Build DesktopTodo (Tauri 2) release exe -> dist/DesktopTodo/DesktopTodo.exe + zip
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File app\build.ps1
# ASCII-only: Windows PowerShell 5.1 misparses UTF-8 scripts without BOM.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $root
try {
    $cargo = (Get-Command cargo -ErrorAction Stop).Source
    Write-Host "[build] cargo build --release"
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & $cargo build --release --manifest-path "src-tauri/Cargo.toml"
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev
    if ($code -ne 0) { throw "cargo build failed (exit $code)" }

    $exe = "src-tauri/target/release/desktop-todo.exe"
    if (-not (Test-Path $exe)) { throw "missing $exe" }

    $conf = Get-Content "src-tauri/tauri.conf.json" -Raw -Encoding UTF8 | ConvertFrom-Json
    $ver = $conf.version
    $outDir = "../dist/DesktopTodo"
    New-Item -ItemType Directory -Force $outDir | Out-Null
    Copy-Item $exe "$outDir/DesktopTodo.exe" -Force
    $zip = "../dist/DesktopTodo-$ver-win64.zip"
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Compress-Archive -Path "$outDir/DesktopTodo.exe" -DestinationPath $zip

    Write-Host "[build] done:"
    Get-Item "$outDir/DesktopTodo.exe", $zip |
        Format-Table Name, @{n="MB";e={"{0:N1}" -f ($_.Length/1MB)}}, LastWriteTime
    Write-Host "[build] deploy: stop DesktopTodo.exe, copy dist\DesktopTodo\DesktopTodo.exe"
    Write-Host "        to the deploy dir, keep config.json, remove old _internal\"
} finally {
    Pop-Location
}
exit 0
