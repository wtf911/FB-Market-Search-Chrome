# Builds a Chrome Web Store upload zip for the current manifest version.
#
# Uses an explicit ALLOW-LIST of the files that make up the extension, so dev
# tooling (tests/, package.json, scripts/, docs) can never ship by accident.
# When you add a new extension file, add it here AND in scripts/build-zip.sh
# (the cross-platform twin used by CI).
#
# Usage:  powershell -ExecutionPolicy Bypass -File build-zip.ps1
# Output: marketplace-description-search-v<version>.zip in this folder.

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

$files = @(
    "manifest.json", "background.js", "shared.js", "collector.js", "content.js",
    "popup.html", "popup.js", "gallery.html", "gallery.js", "parked.html", "panel.css",
    "icon16.png", "icon48.png", "icon128.png"
)
foreach ($f in $files) {
    if (-not (Test-Path $f)) { throw "build-zip: missing $f -- refusing to build." }
}

$manifest = Get-Content "manifest.json" -Raw | ConvertFrom-Json
$version  = $manifest.version
$zipName  = "marketplace-description-search-v$version.zip"

Write-Host "Packaging v$version :"
$files | ForEach-Object { Write-Host "  + $_" }

if (Test-Path $zipName) { Remove-Item $zipName -Force }
Compress-Archive -Path $files -DestinationPath $zipName -CompressionLevel Optimal

Write-Host "Built $zipName ($((Get-Item $zipName).Length) bytes)."
