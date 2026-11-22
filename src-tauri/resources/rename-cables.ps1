# Nexus-Mixer — rename detected virtual audio endpoints to Nexus Cable B1..B12.
# Run elevated by the app (UAC). Only endpoints whose description/friendly
# name contains "cable" or "nexus" are touched; physical devices are left alone.
#
# Works with both Virtual Audio Cable (VAC, "Line N (Virtual Audio Cable)") and
# the single-line VB-CABLE driver. VAC lines map by their line number, so
# Line 1 -> B1 … Line 12 -> B12. A leftover VB-CABLE pair is renamed to
# "Nexus Legacy Cable Input/Output" so it never collides with a VAC line.
#
# Uses the .NET registry API instead of Set-ItemProperty: the audio endpoint
# property keys are owned by SYSTEM and the PowerShell provider path opens them
# with rights that are rejected even for an elevated administrator. Opening the
# key with SetValue|QueryValues is the supported way to write these values.

$ErrorActionPreference = 'Stop'
$basePath = 'SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio'
$statePath = 'SOFTWARE\Nexus-Mixer\CableMap'
$descProp = '{a45c254e-df1c-4efd-8020-67d146a850e0},2'
$friendlyProp = '{a45c254e-df1c-4efd-8020-67d146a850e0},14'
$ifaceProp = '{b3f8fa53-0004-438e-9003-51a46e139bfc},6'
$flows = @('Render', 'Capture')
$base = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
    [Microsoft.Win32.RegistryHive]::LocalMachine,
    [Microsoft.Win32.RegistryView]::Registry64
)
$writeRights = [System.Security.AccessControl.RegistryRights]0x3 # SetValue | QueryValues
$check = [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree
$renamed = 0
$processed = 0
$errors = 0

# Stable mapping from endpoint registry path -> Nexus name. Without it a second
# run cannot tell a renamed VAC line from the renamed legacy VB-CABLE pair.
$mapping = @{}
$stateRead = $base.OpenSubKey($statePath)
if ($stateRead) {
    foreach ($name in $stateRead.GetValueNames()) {
        $mapping[$name] = [string]$stateRead.GetValue($name)
    }
    $stateRead.Close()
}
$stateWrite = $base.CreateSubKey($statePath)

foreach ($flow in $flows) {
    $root = $base.OpenSubKey("$basePath\$flow")
    if (-not $root) { continue }

    $found = @()
    $hasVacLine = $false
    foreach ($sub in $root.GetSubKeyNames()) {
        $propsPath = "$basePath\$flow\$sub\Properties"
        $props = $base.OpenSubKey($propsPath)
        if (-not $props) { continue }
        $desc = $props.GetValue($descProp)
        $friendly = $props.GetValue($friendlyProp)
        $iface = [string]$props.GetValue($ifaceProp)
        $props.Close()
        $name = if ($desc) { $desc } else { $friendly }
        if (-not $name) { continue }
        # The 16-channel VB-CABLE render endpoint cannot be opened alongside
        # the normal stereo cable, so leave it untouched and out of B1..B12.
        # VAC endpoint properties carry only "Line N"; the "(Virtual Audio
        # Cable)" suffix is added by WASAPI and is not stored here.
        if ($name -match '(?i)16\s*ch') { continue }
        $isVac = $iface -match '(?i)virtual audio cable'
        if (-not $isVac -and $name -notmatch '(?i)cable|nexus|^line\s+\d+$') { continue }
        if ($name -match '(?i)line\s+\d+') { $hasVacLine = $true }
        $found += [pscustomobject]@{
            Path = $propsPath
            Key = "$flow\$sub"
            Name = $name
            Flow = $flow
            IsVac = $isVac
        }
    }
    $root.Close()

    foreach ($item in $found) {
        if (-not $item.IsVac) {
            # VB-CABLE (single stereo pair) cannot provide B1..B12. Keep it out
            # of the numbered VAC map so the two drivers never share a name.
            $suffix = if ($item.Flow -eq 'Render') { 'Input' } else { 'Output' }
            $target = "Nexus Legacy Cable $suffix"
        } elseif ($item.Name -match '(?i)line\s+(\d+)') {
            $target = "Nexus Cable B$([int]$matches[1])"
        } elseif ($mapping[$item.Key] -match '(?i)^Nexus Cable B\d+$') {
            # Renamed on an earlier run; the endpoint path is the stable key.
            $target = $mapping[$item.Key]
        } elseif ($item.Name -match '(?i)^Nexus Cable B\d+$') {
            $target = $item.Name
        } else {
            $suffix = if ($item.Flow -eq 'Render') { 'Input' } else { 'Output' }
            $target = "Nexus Legacy Cable $suffix"
        }
        if ($mapping[$item.Key] -ne $target) {
            $mapping[$item.Key] = $target
            $stateWrite.SetValue($item.Key, $target, [Microsoft.Win32.RegistryValueKind]::String)
        }

        if ($item.Name -eq $target) { continue }
        try {
            $key = $base.OpenSubKey($item.Path, $check, $writeRights)
            if (-not $key) { throw "не удалось открыть ключ $($item.Path)" }
            $key.SetValue($descProp, $target, [Microsoft.Win32.RegistryValueKind]::String)
            $key.SetValue($friendlyProp, $target, [Microsoft.Win32.RegistryValueKind]::String)
            $key.Close()
            $renamed++
            Write-Host ("{0}: {1} -> {2}" -f $item.Flow, $item.Name, $target)
        } catch {
            $errors++
            Write-Host ("{0}: {1} -> ошибка: {2}" -f $item.Flow, $item.Name, $_.Exception.Message)
        }
    }
    $processed += $found.Count
    Write-Host ("{0}: обработано {1} endpoint(s)" -f $flow, $found.Count)
}

$stateWrite.Close()
$base.Close()

# Audio endpoints are cached by the audio service. Restarting it makes the new
# names visible to Discord, OBS, browsers and Nexus itself.
Restart-Service -Name Audiosrv -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 700
Write-Host 'Nexus Cable names applied. Restart the mixer app to refresh its device list.'
exit $(if ($errors -gt 0 -or $processed -eq 0) { 1 } else { 0 })
