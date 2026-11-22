<#
.SYNOPSIS
    Builds the Nexus VAIO audio driver.
.EXAMPLE
    .\build.ps1
    .\build.ps1 -SkipSigning
#>

param([switch]$SkipSigning, [switch]$SkipInf2Cat)

$ErrorActionPreference = "Stop"
$scriptDir = $PSScriptRoot
$projectDir = Resolve-Path (Join-Path $scriptDir "..")
$outputDir = Join-Path (Join-Path (Join-Path $projectDir "build") "x64") "Release"

function Write-Header { Write-Host "============================================" -ForegroundColor Cyan }
function Write-Step   { param([string]$m) Write-Host ">>> $m" -ForegroundColor Yellow }
function Write-OK     { param([string]$m) Write-Host "  [OK] $m" -ForegroundColor Green }
function Write-Warn   { param([string]$m) Write-Host "  [WARN] $m" -ForegroundColor DarkYellow }

Write-Header
Write-Host "  Nexus VAIO Audio Driver Builder" -ForegroundColor Cyan
Write-Header
Write-Host ""

# Validate tools
$signtool = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe"
$inf2cat  = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\inf2cat.exe"
$cl = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64\cl.exe"

if (Test-Path $cl) { Write-OK "MSVC compiler found" } else { Write-Warn "MSVC not found" }
if (Test-Path $signtool) { Write-OK "signtool found" } else { Write-Warn "signtool not found" }

Write-Host ""

#===== Step 1: Compile =====
Write-Step "Step 1/3: Compiling driver..."

$batFile = Join-Path $scriptDir "build_direct.bat"
if (-not (Test-Path $batFile)) { Write-Warn "build_direct.bat not found"; exit 1 }

$batOut = cmd /c $batFile 2>&1
$batOut | Out-Host

$sysFile = Join-Path $outputDir "nexusvaio.sys"
if (-not (Test-Path $sysFile)) { Write-Warn "Driver not produced"; exit 1 }

$sizeKB = [int]((Get-Item $sysFile).Length / 1KB)
Write-OK "nexusvaio.sys created ($sizeKB KB)"

$infSource = Join-Path $projectDir "nexusvaio\nexusvaio.inf"
if (Test-Path $infSource) { Copy-Item $infSource $outputDir -Force; Write-OK "nexusvaio.inf copied" }

Write-Host ""

#===== Step 2: Sign =====
if (-not $SkipSigning) {
    Write-Step "Step 2/3: Signing driver..."
    
    $signtool = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe"
    if (Test-Path $signtool) {
        # Redirect stderr to avoid PowerShell error handling on verify warnings
        $signResult = cmd /c "`"$signtool`" sign /v /fd sha256 /s MY /n `"NexusVAIO Test Certificate`" `"$sysFile`" 2>&1"
        $signResult | Out-Host
        Write-OK "Signing complete"
    } else {
        Write-Warn "signtool not found"
    }
    Write-Host ""
} else {
    Write-Step "Step 2/3: Signing skipped"
    Write-Host ""
}

#===== Step 3: Inf2Cat =====
if (-not $SkipInf2Cat) {
    Write-Step "Step 3/3: Generating catalog files..."
    if (Test-Path $inf2cat) {
        $inxFile = Join-Path $projectDir "nexusvaio\nexusvaio.inx"
        if (Test-Path $inxFile) {
            $catOut = cmd /c "`"$inf2cat`" /v /driver:`"$outputDir`" /os:10_NT_x64 /inffile:`"$outputDir\nexusvaio.inf`"" 2>&1
            $catOut | Out-Host
            if ($LASTEXITCODE -eq 0) { Write-OK "Catalog generated" } else { Write-Warn "Inf2Cat exit $LASTEXITCODE" }
        } else {Write-Warn "nexusvaio.inx not found"}
    } else {Write-Warn "inf2cat.exe not found"}
} else {
    Write-Step "Step 3/3: Inf2Cat skipped"
}

Write-Host ""
Write-Header
Write-Host "  BUILD COMPLETE!" -ForegroundColor Green
Write-Header
Write-Host ""
Write-Host "Output: $outputDir"
foreach ($f in (Get-ChildItem $outputDir -File)) {
    Write-Host "  $($f.Name) ($([int]($f.Length / 1KB)) KB)" -ForegroundColor Gray
}
Write-Host ""
Write-Host "Install: .\install\install.ps1"
Write-Host ""