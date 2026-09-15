# One-command release: build the Chrome zip, commit, tag and push main.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File release.ps1
#   powershell -ExecutionPolicy Bypass -File release.ps1 -Message "custom commit msg"
#
# Guard rails (each one exists because it bit us):
#   * must be on main with a clean tree except for tracked edits (no untracked files
#     sneak in: only `git add -u`),
#   * refuses to run if tag v<version> already exists -- bump manifest.json first,
#   * commits as whoever runs it (no hardcoded identity), then tags v<version>.
#
# After it finishes, upload the printed .zip to the Chrome Web Store dashboard.

param([string]$Message)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne "main") { throw "release.ps1: you are on '$branch'; switch to main first." }

$version = (Get-Content "manifest.json" -Raw | ConvertFrom-Json).version
$tag = "v$version"
if ((git tag -l $tag).Trim() -eq $tag) { throw "release.ps1: tag $tag already exists -- bump the version in manifest.json first." }

$untracked = git ls-files --others --exclude-standard
if ($untracked) { Write-Host "Ignoring untracked files (add them explicitly if they belong in the release):"; $untracked | ForEach-Object { Write-Host "  ? $_" } }

# 1. Build the package (fails if any extension file is missing).
& "$PSScriptRoot\build-zip.ps1"
if ($LASTEXITCODE -ne 0) { throw "build-zip.ps1 failed." }

# 2. Commit tracked changes only.
git add -u
$pending = git status --porcelain --untracked-files=no
if ($pending) {
    if (-not $Message) { $Message = "Release $tag" }
    git commit -m $Message
    if ($LASTEXITCODE -ne 0) { throw "git commit failed." }
} else {
    Write-Host "No source changes to commit."
}

# 3. Tag and push.
git tag -a $tag -m "Release $tag"
git push origin main --follow-tags
if ($LASTEXITCODE -ne 0) { throw "git push failed." }

Write-Host ""
Write-Host "Done. Pushed $tag to origin/main."
Write-Host "Next: upload marketplace-description-search-$tag.zip at"
Write-Host "  https://chrome.google.com/webstore/devconsole"
