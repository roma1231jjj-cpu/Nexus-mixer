<#
.SYNOPSIS
    Installs the Nexus VAIO virtual audio driver.

.DESCRIPTION
    This script handles full installation of the Nexus VAIO audio driver:
    - Checks for administrator privileges
    - Enables test signing mode if needed
    - Copies driver files to the system
    - Creates and installs a test certificate
    - Signs the driver
    - Installs using pnputil
    - Verifies the installation

.PARAMETER DriverPath
    Path to the directory containing the compiled driver files.
    Defaults to "..\build\x64\Release"

.PARAMETER Force
    Force installation without prompts.

.EXAMPLE
    .\install.ps1
    .\install.ps1 -DriverPath "..\build\x64\Release" -Force
#>

param(
    [Parameter(Mandatory = $false)]
    [string]$DriverPath = (Join-Path $PSScriptRoot "..\build\x64\Release"),

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
    Write-Host "  Nexus VAIO Audio Driver Installer" -ForegroundColor Cyan
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
# Main installation routine
#----------------------------------------------------------------------

function Install-NexusVAIO {
    param(
        [string]$DriverDir,
        [bool]$ForceInstall
    )

    Write-Banner

    # Check admin rights
    if (-not (Test-Administrator)) {
        Write-Error "This script must be run as Administrator."
        Write-Host "Please restart PowerShell as Administrator and try again."
        exit 1
    }

    # Resolve driver path
    $DriverDir = Resolve-Path $DriverDir -ErrorAction SilentlyContinue
    if (-not $DriverDir) {
        Write-Error "Driver directory not found: $DriverDir"
        Write-Host "Build the driver first using build.ps1 or specify -DriverPath."
        exit 1
    }

    Write-Step "Using driver directory: $DriverDir"

    # Verify required files exist
    $sysFile = Join-Path $DriverDir "nexusvaio.sys"
    $infFile = Join-Path $DriverDir "nexusvaio.inf"
    $catFile = Join-Path $DriverDir "nexusvaio.cat"

    if (-not (Test-Path $sysFile)) {
        Write-Error "Driver file not found: $sysFile"
        exit 1
    }

    if (-not (Test-Path $infFile)) {
        Write-Error "INF file not found: $infFile"
        exit 1
    }

    $hasCat = Test-Path $catFile
    if (-not $hasCat -and -not $ForceInstall) {
        Write-Warning "Catalog file (.cat) not found. Driver may not install on secure systems."
        $confirm = Read-Host "Continue without catalog file? (y/N)"
        if ($confirm -ne "y") {
            exit 1
        }
    }

    #----------------------------------------------------------------------
    # Step 1: Enable test signing
    #----------------------------------------------------------------------
    Write-Step "Step 1/6: Checking test signing mode..."

    $testSigning = bcdedit /enum {current} | Select-String "testsigning"
    if (-not $testSigning) {
        Write-Host "Test signing is NOT enabled. Enabling..."
        if ($ForceInstall -or (Read-Host "Enable test signing and reboot? (y/N)") -eq "y") {
            bcdedit /set testsigning on
            Write-Host "Test signing enabled. A reboot is required."
            Write-Host "After reboot, run this script again to complete installation."
            
            if (-not $ForceInstall) {
                $rebootNow = Read-Host "Reboot now? (y/N)"
                if ($rebootNow -eq "y") {
                    Restart-Computer
                }
            }
            exit 0
        }
    } else {
        Write-Host "Test signing is already enabled."
    }

    #----------------------------------------------------------------------
    # Step 2: Create and install test certificate
    #----------------------------------------------------------------------
    Write-Step "Step 2/6: Creating test certificate..."

    $certName = "NexusVAIO Test Certificate"
    $certStore = "Cert:\LocalMachine\TrustedPublisher"
    $cert = Get-ChildItem $certStore | Where-Object { $_.Subject -eq "CN=$certName" } | Select-Object -First 1

    if (-not $cert) {
        Write-Host "Creating new test certificate..."
        
        # Create temporary certificate file
        $certFile = Join-Path $env:TEMP "NexusVAIO.cer"
        $pvkFile = Join-Path $env:TEMP "NexusVAIO.pvk"
        
        # Use makecert or New-SelfSignedCertificate
        try {
            $cert = New-SelfSignedCertificate `
                -Subject "CN=$certName" `
                -Type CodeSigning `
                -CertStoreLocation "Cert:\LocalMachine\My" `
                -KeyUsage DigitalSignature `
                -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3") `
                -NotAfter (Get-Date).AddYears(5)

            # Export the certificate
            Export-Certificate -Cert $cert -FilePath $certFile -Type CERT | Out-Null
            
            # Install to TrustedPublisher store
            $certStoreObj = Get-Item $certStore
            $certStoreObj.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
            $certStoreObj.Add($cert)
            $certStoreObj.Close()

            Write-Host "Certificate created and installed: $($cert.Thumbprint)"
        } catch {
            Write-Error "Failed to create certificate: $_"
            Write-Host "Falling back to makecert..."
            
            $makecert = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\makecert.exe"
            if (Test-Path $makecert) {
                & $makecert -r -pe -n "CN=$certName" -ss My -sr LocalMachine -$ "individual" -sv $pvkFile $certFile
                & "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\cert2spc.exe" $certFile $pvkFile
                & "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\pvk2pfx.exe" -pvk $pvkFile -spc $certFile -pfx (Join-Path $env:TEMP "NexusVAIO.pfx")
            } else {
                Write-Error "makecert not found. Install Windows SDK or use New-SelfSignedCertificate (available on Windows 10+)."
                exit 1
            }
        }
    } else {
        Write-Host "Using existing certificate: $($cert.Thumbprint)"
    }

    #----------------------------------------------------------------------
    # Step 3: Sign the driver
    #----------------------------------------------------------------------
    Write-Step "Step 3/6: Signing driver..."

    $signtool = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe"
    if (-not (Test-Path $signtool)) {
        Write-Error "signtool.exe not found at $signtool"
        exit 1
    }

    # Sign the .sys file
    & $signtool sign /v `
        /fd sha256 `
        /a `
        /n "$certName" `
        /t http://timestamp.digicert.com `
        $sysFile 2>&1 | Out-Host

    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to sign driver. Exit code: $LASTEXITCODE"
        exit 1
    }

    # Sign the .cat file if it exists
    if ($hasCat) {
        & $signtool sign /v `
            /fd sha256 `
            /a `
            /n "$certName" `
            /t http://timestamp.digicert.com `
            $catFile 2>&1 | Out-Host
    }

    Write-Success "Driver signed successfully."

    #----------------------------------------------------------------------
    # Step 4: Copy driver files to system directory (optional)
    #----------------------------------------------------------------------
    Write-Step "Step 4/6: Copying driver files..."

    $targetDir = "$env:SystemRoot\System32\drivers"
    $targetSys = Join-Path $targetDir "nexusvaio.sys"

    try {
        Copy-Item $sysFile $targetSys -Force
        Write-Host "Copied: $sysFile -> $targetSys"
    } catch {
        Write-Warning "Could not copy to $targetDir : $_"
        Write-Warning "Using pnputil to install from source directory instead."
    }

    #----------------------------------------------------------------------
    # Step 5: Install the driver using pnputil
    #----------------------------------------------------------------------
    Write-Step "Step 5/6: Installing driver with pnputil..."

    # Remove any existing installation first
    $existingDrivers = pnputil /enum-drivers | Select-String "nexusvaio.inf"
    if ($existingDrivers) {
        Write-Host "Removing existing Nexus VAIO driver installation..."
        $existingPublishers = pnputil /enum-drivers | Select-String "Published Name" -Context 0,1
        $existingPublishers -match '(oem\d+\.inf)' | ForEach-Object {
            $oemInf = $matches[1]
            if ($oemInf) {
                Write-Host "Removing: $oemInf"
                pnputil /delete-driver $oemInf /uninstall 2>&1 | Out-Null
            }
        }
    }

    # Install the driver
    Write-Host "Installing driver from: $infFile"
    $installResult = pnputil /add-driver $infFile /install 2>&1 | Out-String

    Write-Host $installResult

    if ($LASTEXITCODE -ne 0) {
        Write-Error "pnputil failed with exit code: $LASTEXITCODE"
        Write-Host "Installation output:"
        Write-Host $installResult
        exit 1
    }

    #----------------------------------------------------------------------
    # Step 6: Verify installation
    #----------------------------------------------------------------------
    Write-Step "Step 6/6: Verifying installation..."

    Start-Sleep -Seconds 3

    # Check if the driver service exists
    $service = Get-Service -Name "nexusvaio" -ErrorAction SilentlyContinue
    if ($service) {
        Write-Host "Service status: $($service.Status)"
        if ($service.Status -eq "Running") {
            Write-Success "Nexus VAIO driver is installed and running!"
        } elseif ($service.Status -eq "Stopped") {
            Write-Warning "Driver service is installed but not running."
            Write-Host "Start the service or reboot the system."
        }
    } else {
        Write-Warning "Service not found. The driver may not have loaded correctly."
    }

    # Check for audio devices
    $audioDevices = Get-PnpDevice -Class "MEDIA" -ErrorAction SilentlyContinue | 
        Where-Object { $_.FriendlyName -like "*Nexus*" }
    
    if ($audioDevices) {
        Write-Host "Found audio device(s):"
        $audioDevices | Format-Table FriendlyName, Status, Class -AutoSize
        Write-Success "Installation complete! The Nexus VAIO audio devices should appear in your audio settings."
    } else {
        Write-Warning "No Nexus VAIO audio devices found yet. They may appear after a reboot."
        Write-Host "Check Sound Settings or run: Get-PnpDevice -Class MEDIA | Where-Object { `$_.FriendlyName -like '*Nexus*' }"
    }

    Write-Host "`n============================================" -ForegroundColor Cyan
    Write-Host "  Installation completed!" -ForegroundColor Cyan
    Write-Host "============================================" -ForegroundColor Cyan
}

# Run the installer
Install-NexusVAIO -DriverDir $DriverPath -ForceInstall:$Force
