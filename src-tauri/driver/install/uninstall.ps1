<#
.SYNOPSIS
    Uninstalls the Nexus VAIO virtual audio driver.

.DESCRIPTION
    Removes the Nexus VAIO audio driver from the system:
    - Stops the driver service
    - Removes using pnputil
    - Cleans up driver files
    - Removes test certificate

.PARAMETER Force
    Force uninstallation without prompts.

.EXAMPLE
    .\uninstall.ps1
    .\uninstall.ps1 -Force
#>

param(
    [Parameter(Mandatory = $false)]
    [switch]$Force
)

#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"

#----------------------------------------------------------------------
# Helper functions
#----------------------------------------------------------------------

function Write-Banner {
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host "  Nexus VAIO Audio Driver Uninstaller" -ForegroundColor Cyan
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host ""
}

function Write-Step {
    param([string]$Message)
    Write-Host ">>> $Message" -ForegroundColor Yellow
}

function Write-Success {
    param([string]$Message)
    Write-Host "`n[SUCCESS] $Message`n" -ForegroundColor Green
}

function Write-Error {
    param([string]$Message)
    Write-Host "[ERROR] $Message" -ForegroundColor Red
}

function Write-Warning {
    param([string]$Message)
    Write-Host "[WARNING] $Message" -ForegroundColor DarkYellow
}

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

#----------------------------------------------------------------------
# Main uninstallation routine
#----------------------------------------------------------------------

function Uninstall-NexusVAIO {
    param([bool]$ForceUninstall)

    Write-Banner

    # Check admin rights
    if (-not (Test-Administrator)) {
        Write-Error "This script must be run as Administrator."
        Write-Host "Please restart PowerShell as Administrator and try again."
        exit 1
    }

    if (-not $ForceUninstall) {
        $confirm = Read-Host "This will remove the Nexus VAIO audio driver. Continue? (y/N)"
        if ($confirm -ne "y") {
            Write-Host "Uninstall cancelled."
            exit 0
        }
    }

    #----------------------------------------------------------------------
    # Step 1: Stop the driver service
    #----------------------------------------------------------------------
    Write-Step "Step 1/4: Stopping driver service..."

    $service = Get-Service -Name "nexusvaio" -ErrorAction SilentlyContinue
    if ($service) {
        Write-Host "Stopping service: nexusvaio (current state: $($service.Status))"
        
        try {
            Stop-Service -Name "nexusvaio" -Force -ErrorAction SilentlyContinue
            Write-Host "Service stopped."
        } catch {
            Write-Warning "Could not stop service: $_"
        }
    } else {
        Write-Host "Service not found - continuing."
    }

    # Remove service using sc.exe
    sc.exe delete nexusvaio 2>&1 | Out-Null
    Write-Host "Service entry removed."

    #----------------------------------------------------------------------
    # Step 2: Remove driver package using pnputil
    #----------------------------------------------------------------------
    Write-Step "Step 2/4: Removing driver package..."

    # Find all OEM INF files related to our driver
    $oemInfs = pnputil /enum-drivers | Select-String -Pattern "nexusvaio\.inf" -Context 0,2
    $removedCount = 0

    foreach ($match in $oemInfs) {
        # Get the line before the match which contains "Published Name"
        $context = $match.Context
        foreach ($line in $context.PreContext) {
            if ($line -match 'Published Name\s+:\s+(oem\d+\.inf)') {
                $oemInf = $matches[1]
                Write-Host "Removing driver package: $oemInf"
                
                $result = pnputil /delete-driver $oemInf /uninstall 2>&1 | Out-String
                Write-Host $result
                
                if ($LASTEXITCODE -eq 0) {
                    $removedCount++
                }
            }
        }
    }

    if ($removedCount -eq 0) {
        Write-Warning "No Nexus VAIO driver packages found to remove."
        Write-Host "The driver may have been installed via a different method."
    } else {
        Write-Host "Removed $removedCount driver package(s)."
    }

    # Also try to remove by INF path directly
    $infFiles = @(
        "$env:SystemRoot\System32\DriverStore\FileRepository\nexusvaio.inf_*",
        "$env:SystemRoot\inf\nexusvaio.inf"
    )

    foreach ($pattern in $infFiles) {
        $files = Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue
        foreach ($file in $files) {
            Write-Host "Found driver store file: $($file.FullName)"
        }
    }

    #----------------------------------------------------------------------
    # Step 3: Clean up driver files
    #----------------------------------------------------------------------
    Write-Step "Step 3/4: Cleaning up driver files..."

    $filesToRemove = @(
        "$env:SystemRoot\System32\drivers\nexusvaio.sys"
    )

    foreach ($file in $filesToRemove) {
        if (Test-Path $file) {
            try {
                Remove-Item $file -Force -ErrorAction SilentlyContinue
                Write-Host "Removed: $file"
            } catch {
                Write-Warning "Could not remove $file : $_"
            }
        }
    }

    #----------------------------------------------------------------------
    # Step 4: Remove test certificate (optional)
    #----------------------------------------------------------------------
    Write-Step "Step 4/4: Cleaning up test certificate..."

    $certName = "NexusVAIO Test Certificate"
    
    try {
        # Remove from Personal store
        $personalCerts = Get-ChildItem "Cert:\LocalMachine\My" | 
            Where-Object { $_.Subject -eq "CN=$certName" }
        
        foreach ($cert in $personalCerts) {
            Write-Host "Removing certificate: $($cert.Thumbprint)"
            Remove-Item "Cert:\LocalMachine\My\$($cert.Thumbprint)" -Force -ErrorAction SilentlyContinue
        }

        # Remove from TrustedPublisher store
        $trustedCerts = Get-ChildItem "Cert:\LocalMachine\TrustedPublisher" | 
            Where-Object { $_.Subject -eq "CN=$certName" }
        
        foreach ($cert in $trustedCerts) {
            Write-Host "Removing trusted certificate: $($cert.Thumbprint)"
            Remove-Item "Cert:\LocalMachine\TrustedPublisher\$($cert.Thumbprint)" -Force -ErrorAction SilentlyContinue
        }
    } catch {
        Write-Warning "Could not remove certificate: $_"
    }

    Write-Success "Nexus VAIO audio driver has been uninstalled."
    Write-Host "A reboot is recommended to complete the removal."
    
    if (-not $ForceUninstall) {
        $reboot = Read-Host "Reboot now? (y/N)"
        if ($reboot -eq "y") {
            Restart-Computer
        }
    }
}

# Run uninstaller
Uninstall-NexusVAIO -ForceUninstall:$Force
