<#
.SYNOPSIS
    Creates Nexus VAIO virtual audio devices using cfgmgr32 P/Invoke
    and installs the driver.

    Run this script AS ADMINISTRATOR.
#>

$ErrorActionPreference = "Stop"

if (-NOT ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
    Write-Host "[ERROR] This script must be run as Administrator!" -ForegroundColor Red
    Write-Host "Right-click PowerShell and select 'Run as Administrator'." -ForegroundColor Yellow
    exit 1
}

#==========================================================================
# Step 1: Add INF to driver store
#==========================================================================
$driverDir = "E:\nexus-mixer\src-tauri\driver\build\x64\Release"
$infPath = Join-Path $driverDir "nexusvaio.inf"
$sysPath = Join-Path $driverDir "nexusvaio.sys"

Write-Host "=== Step 1: Installing driver via pnputil ===" -ForegroundColor Cyan
if (-not (Test-Path $infPath)) { Write-Host "ERROR: INF not found: $infPath" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $sysPath)) { Write-Host "ERROR: SYS not found: $sysPath" -ForegroundColor Red; exit 1 }

pnputil /add-driver $infPath /install
if ($LASTEXITCODE -ne 0) {
    Write-Host "pnputil exit code: $LASTEXITCODE - adding INF only (device will be created later)" -ForegroundColor Yellow
    pnputil /add-driver $infPath
    if ($LASTEXITCODE -ne 0) {
        Write-Host "pnputil also failed to add INF to store" -ForegroundColor Red
    } else {
        Write-Host "INF added to store successfully" -ForegroundColor Green
    }
} else {
    Write-Host "Driver installed successfully!" -ForegroundColor Green
}

#==========================================================================
# Step 2: Remove existing devices if any
#==========================================================================
Write-Host "`n=== Step 2: Removing existing devices ===" -ForegroundColor Cyan
$existing = Get-PnpDevice -Class MEDIA -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -like "*Nexus*" }
foreach ($dev in $existing) {
    Write-Host "Removing: $($dev.FriendlyName) (InstanceId: $($dev.InstanceId))" -ForegroundColor Yellow
    try {
        $null = Disable-PnpDevice -InstanceId $dev.InstanceId -Confirm:$false
        $null = Uninstall-PnpDevice -InstanceId $dev.InstanceId -Confirm:$false
    } catch {
        Write-Host "  Could not uninstall: $_" -ForegroundColor DarkYellow
    }
}

#==========================================================================
# Step 3: Create Root\NexusVAIO and Root\NexusAUX using cfgmgr32
#==========================================================================
Write-Host "`n=== Step 3: Creating device nodes ===" -ForegroundColor Cyan

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class CfgMgr32
{
    [DllImport("CfgMgr32.dll", CharSet = CharSet.Unicode)]
    public static extern uint CM_Create_DevNode(
        out uint pdnDevInst,
        string pDeviceID,
        uint ulFlags,
        uint ulReserved
    );
    
    [DllImport("CfgMgr32.dll")]
    public static extern uint CM_Setup_DevNode(
        uint dnDevInst,
        uint ulFlags
    );

    [DllImport("CfgMgr32.dll")]
    public static extern uint CM_Reenumerate_DevNode(
        uint dnDevInst,
        uint ulFlags
    );

    // CR_SUCCESS = 0
    public const uint CM_CREATE_DEVICE_NODE_SYNTHETIC = 0x00000002;
    public const uint CM_REENUMERATE_SYNCHRONOUS = 0x00000001;
}
"@

$devices = @("Root\NexusVAIO", "Root\NexusAUX")
foreach ($hwid in $devices) {
    Write-Host "Creating device: $hwid" -ForegroundColor White
    $pdnDevInst = 0
    $result = [CfgMgr32]::CM_Create_DevNode([ref]$pdnDevInst, $hwid, [CfgMgr32]::CM_CREATE_DEVICE_NODE_SYNTHETIC, 0)
    if ($result -eq 0) {
        Write-Host "  CM_Create_DevNode OK (pdnDevInst=$pdnDevInst)" -ForegroundColor Green
        $setupResult = [CfgMgr32]::CM_Setup_DevNode($pdnDevInst, 0)
        if ($setupResult -eq 0) {
            Write-Host "  CM_Setup_DevNode OK" -ForegroundColor Green
        } else {
            Write-Host "  CM_Setup_DevNode returned: $setupResult" -ForegroundColor Yellow
        }
    } elseif ($result -eq 0xE0000203) { // CR_ALREADY_EXISTS
        Write-Host "  Already exists (CR_ALREADY_EXISTS), re-enumerating..." -ForegroundColor Yellow
        [CfgMgr32]::CM_Reenumerate_DevNode(0, [CfgMgr32]::CM_REENUMERATE_SYNCHRONOUS)
    } else {
        Write-Host "  CM_Create_DevNode failed: 0x$('{0:X8}' -f $result)" -ForegroundColor Red
    }
}

#==========================================================================
# Step 4: Verify
#==========================================================================
Write-Host "`n=== Step 4: Verifying installation ===" -ForegroundColor Cyan
Start-Sleep -Seconds 5

$audioDevices = Get-PnpDevice -Class MEDIA -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -like "*Nexus*" -or $_.InstanceId -like "*Nexus*" }
if ($audioDevices) {
    Write-Host "Found audio device(s):" -ForegroundColor Green
    $audioDevices | Format-Table FriendlyName, Status, Class, InstanceId -AutoSize
} else {
    Write-Host "No Nexus devices found yet. Check after reboot or manually:" -ForegroundColor Yellow
    Write-Host "  Get-PnpDevice -Class MEDIA | Where-Object { `$_.FriendlyName -like '*Nexus*' }" -ForegroundColor Gray
}

Write-Host "`nDone!" -ForegroundColor Cyan