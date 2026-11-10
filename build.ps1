# Build DesktopTodo portable edition: PyInstaller onedir -> zip
# Usage: .\build.ps1   (requires Python 3.12 via py launcher)
# ASCII-only + stderr-tolerant on purpose:
#   - Windows PowerShell 5.1 misparses UTF-8 scripts without BOM;
#   - under $ErrorActionPreference="Stop", any native stderr line aborts the
#     script, so every native call goes through Invoke-Native and is judged
#     by $LASTEXITCODE instead;
#   - every argument starting with "-" must be quoted, or PS 5.1 treats it
#     as a parameter token instead of a value.
$ErrorActionPreference = "Stop"

function Invoke-Native {
    param(
        [string]$Description,
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Cmd
    )
    if ($Cmd.Count -lt 1) { throw "Invoke-Native: no command given for '$Description'" }
    $exe = $Cmd[0]
    $rest = @()
    if ($Cmd.Count -gt 1) { $rest = $Cmd[1..($Cmd.Count - 1)] }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $exe @rest
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
    if ($code -ne 0) { throw "$Description failed (exit $code)" }
}

# 1. Python 3.12 must be available
Invoke-Native "Python 3.12 check" py "-3.12" "--version"

# 2. PyInstaller into the 3.12 user site (--user: no admin needed)
$prev = $ErrorActionPreference
$ErrorActionPreference = "Continue"
py "-3.12" "-c" "import PyInstaller" 2> $null | Out-Null
$hasPyi = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = $prev
if (-not $hasPyi) {
    Write-Host "[build] installing PyInstaller into Python 3.12 (--user)..."
    Invoke-Native "PyInstaller installation" py "-3.12" "-m" pip install "--user" pyinstaller
}

# 3. Generate icon if missing
if (-not (Test-Path "assets/app.ico")) {
    Write-Host "[build] generating icon..."
    Invoke-Native "icon generation" python gen_icon.py
}

# 4. Version comes from APP_VERSION in todo.pyw (single source of truth)
$src = Get-Content todo.pyw -Encoding UTF8 -Raw
if ($src -notmatch 'APP_VERSION\s*=\s*"([\d.]+)"') { throw "APP_VERSION not found in todo.pyw" }
$ver = $Matches[1]
$zip = "dist/DesktopTodo-$ver-win64.zip"
Write-Host "[build] version $ver -> $zip"

# 5. PyInstaller onedir build (noisy on stderr -> Invoke-Native)
Invoke-Native "PyInstaller build" py "-3.12" "-m" PyInstaller DesktopTodo.spec "--noconfirm" "--clean"

# 6. Zip it: archive root is DesktopTodo.exe + _internal/ directly
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path "dist/DesktopTodo/*" -DestinationPath $zip
Write-Host "[build] done:"
Get-Item "dist/DesktopTodo/DesktopTodo.exe", $zip |
    Format-Table Name, @{n="MB";e={"{0:N1}" -f ($_.Length/1MB)}}, LastWriteTime
Write-Host "[build] release: gh release create v$ver `"$zip`" --title `"v$ver`""
