# Builds a Chrome Web Store upload zip for the current manifest version.
#
# Auto-includes EVERY file/folder in this directory EXCEPT the blocklist below
# (dev tooling, docs, version-control + OS cruft). So when you add a new
# extension file, you don't have to tell anyone -- it's packaged automatically.
#
# Usage:  powershell -ExecutionPolicy Bypass -File build-zip.ps1
# Output: marketplace-description-search-v<version>.zip in this folder.

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

# --- What to KEEP OUT of the Chrome package -------------------------------
# If you ever add a file that should NOT ship in the extension, add it here.
$excludeNames = @("node_modules")          # exact names (files or folders)
$excludeExt   = @(".zip", ".ps1", ".md")   # built artifacts, scripts, docs
$excludeGlob  = @("Thumbs.db", "*.swp", "*.log", "*.bak", "*~")
# Anything starting with "." (.git, .gitignore, .vscode, .DS_Store ...) is
# excluded automatically -- real extension files are never dot-prefixed.
# --------------------------------------------------------------------------

$items = Get-ChildItem -Force | Where-Object {
    $name = $_.Name
    if ($name.StartsWith("."))        { return $false }
    if ($excludeNames -contains $name) { return $false }
    if ($_.PSIsContainer)             { return $true }   # keep asset subfolders
    if ($excludeExt -contains $_.Extension.ToLower()) { return $false }
    foreach ($g in $excludeGlob) { if ($name -like $g) { return $false } }
    return $true
}

# Sanity: a Chrome extension is invalid without a manifest at the root.
if (-not ($items.Name -contains "manifest.json")) {
    throw "manifest.json not found in package set -- refusing to build."
}

# Name the zip from the manifest version so it's always correct.
$manifest = Get-Content "manifest.json" -Raw | ConvertFrom-Json
$version  = $manifest.version
$zipName  = "marketplace-description-search-v$version.zip"

Write-Host "Packaging v$version :"
$items | ForEach-Object { Write-Host "  + $($_.Name)" }

if (Test-Path $zipName) { Remove-Item $zipName -Force }
Compress-Archive -Path ($items | ForEach-Object { $_.FullName }) -DestinationPath $zipName -CompressionLevel Optimal

Write-Host "Built $zipName ($((Get-Item $zipName).Length) bytes)."
