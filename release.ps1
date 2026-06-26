# One-command release: build the Chrome zip + push source to GitHub main.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File release.ps1
#   powershell -ExecutionPolicy Bypass -File release.ps1 -Message "custom commit msg"
#
# Steps:
#   1. Build marketplace-description-search-v<version>.zip (auto-includes files).
#   2. Commit any source changes as wtf911 (zips stay local -- gitignored).
#   3. Push to origin/main (wtf911/FB-Market-Search-Chrome).
#
# After it finishes, upload the printed .zip to the Chrome Web Store dashboard.

param([string]$Message)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

# 1. Build the package.
& "$PSScriptRoot\build-zip.ps1"
if ($LASTEXITCODE -ne 0) { throw "build-zip.ps1 failed." }

$version = (Get-Content "manifest.json" -Raw | ConvertFrom-Json).version
if (-not $Message) { $Message = "Release v$version" }

# 2. Commit source changes (the .zip itself is gitignored, so it won't be pushed).
git add -A
$pending = git status --porcelain
if ($pending) {
    git -c user.name="wtf911" -c user.email="paid2kill@gmail.com" commit -m $Message
    if ($LASTEXITCODE -ne 0) { throw "git commit failed." }
} else {
    Write-Host "No source changes to commit."
}

# 3. Push current commit to GitHub main.
git push origin HEAD:main
if ($LASTEXITCODE -ne 0) { throw "git push failed." }

Write-Host ""
Write-Host "Done. Pushed v$version to origin/main."
Write-Host "Next: upload marketplace-description-search-v$version.zip at"
Write-Host "  https://chrome.google.com/webstore/devconsole"
