#Requires -Version 5.1
<#
.SYNOPSIS
  Build, sign and publish a Nexus-Mixer release to GitHub.

.DESCRIPTION
  Requires a GitHub token with `repo` scope in GITHUB_TOKEN and the updater
  private key in TAURI_SIGNING_PRIVATE_KEY (path or literal key).

.EXAMPLE
  $env:GITHUB_TOKEN = "..."
  $env:TAURI_SIGNING_PRIVATE_KEY = "C:\Users\me\.tauri\nexus-updater.key"
  powershell -ExecutionPolicy Bypass -File scripts\release.ps1
#>
param(
  [switch]$SkipBuild,
  [string]$Notes = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$pkg = Get-Content package.json -Raw | ConvertFrom-Json
$version = $pkg.version
$tag = "v$version"
$repo = "roma1231jjj-cpu/Nexus-mixer"
$token = $env:GITHUB_TOKEN
if (-not $token) { throw "GITHUB_TOKEN is not set." }
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) { throw "TAURI_SIGNING_PRIVATE_KEY is not set." }

$nsisDir = Join-Path $root "src-tauri/target/release/bundle/nsis"
$installer = Join-Path $nsisDir "Nexus-Mixer_${version}_x64-setup.exe"
$signature = "$installer.sig"

if (-not $SkipBuild) {
  Write-Host "Building frontend..." -ForegroundColor Cyan
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "frontend build failed" }

  Write-Host "Building signed NSIS release..." -ForegroundColor Cyan
  npx tauri build --bundles nsis
  if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }
}

if (-not (Test-Path $installer)) { throw "installer not found: $installer" }
if (-not (Test-Path $signature)) { throw "updater signature not found: $signature" }

$sigText = (Get-Content $signature -Raw).Trim()
$installerUrl = "https://github.com/$repo/releases/download/$tag/Nexus-Mixer_${version}_x64-setup.exe"
$latest = [ordered]@{
  version = $version
  notes = if ($Notes) { $Notes } else { "Nexus-Mixer $version" }
  pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = [ordered]@{
    "windows-x86_64" = [ordered]@{
      signature = $sigText
      url = $installerUrl
    }
  }
}
$latestPath = Join-Path $nsisDir "latest.json"
$json = $latest | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText($latestPath, $json, (New-Object System.Text.UTF8Encoding($false)))

$portable = Join-Path $nsisDir "Nexus-Mixer-${version}-portable.zip"
$exe = Join-Path $root "src-tauri/target/release/nexus-mixer.exe"
if (Test-Path $exe) {
  Compress-Archive -Path $exe -DestinationPath $portable -Force
}

$headers = @{
  Authorization = "Bearer $token"
  Accept = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
}

# Create the release once. If it already exists, reuse it and upload missing assets.
$release = $null
try {
  $release = Invoke-RestMethod -Method Get -Uri "https://api.github.com/repos/$repo/releases/tags/$tag" -Headers $headers
} catch {
  $body = [ordered]@{
    tag_name = $tag
    target_commitish = "main"
    name = "Nexus-Mixer $version"
    body = if ($Notes) { $Notes } else { (Get-Content CHANGELOG.md -Raw) }
    draft = $false
    prerelease = $false
  } | ConvertTo-Json -Depth 5
  $release = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$repo/releases" -Headers $headers -Body $body -ContentType "application/json"
  Write-Host "Created release $tag" -ForegroundColor Green
}

$assets = @($installer, $signature, $latestPath)
if (Test-Path $portable) { $assets += $portable }

foreach ($asset in $assets) {
  $name = Split-Path $asset -Leaf
  $existing = @($release.assets) | Where-Object { $_.name -eq $name }
  if ($existing) {
    Write-Host "Asset already exists: $name" -ForegroundColor DarkGray
    continue
  }
  $uploadBase = ($release.upload_url -replace '\{.*$', '')
  $uploadUrl = "$uploadBase?name=$([Uri]::EscapeDataString($name))"
  Write-Host "Uploading $name..." -ForegroundColor Cyan
  Invoke-RestMethod -Method Post -Uri $uploadUrl -Headers $headers -ContentType "application/octet-stream" -InFile $asset | Out-Null
}

Write-Host "Release published: https://github.com/$repo/releases/tag/$tag" -ForegroundColor Green
Write-Host "Updater manifest: https://github.com/$repo/releases/latest/download/latest.json"
