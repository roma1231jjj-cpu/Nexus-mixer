# Nexus VAIO Audio Driver

A Windows kernel-mode virtual audio driver that creates software-defined audio
endpoints for the Nexus VAIO audio mixing system. Built on the Microsoft PortCls
(Port Class) driver framework, following patterns from the SYSVAD (Software
Virtual Audio Device) sample.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│                    User Mode                                │
│  ┌──────────────────────┐  ┌─────────────────────────────┐ │
│  │ Audio Engine          │  │ WASAPI / MMDevice API      │ │
│  │ (Shared Memory I/O)   │  │ (Windows Audio)            │ │
│  └───────┬──────────────┘  └──────────┬──────────────────┘ │
│          │ Shared Memory / IOCTL       │                    │
├──────────┼─────────────────────────────┼────────────────────┤
│          │       Kernel Mode           │                    │
│  ┌───────▼─────────────────────────────▼──────────────┐    │
│  │              PortCls (portcls.sys)                  │    │
│  │  ┌─────────────────┐  ┌─────────────────────────┐  │    │
│  │  │ IPortWaveRT      │  │ IPortTopology           │  │    │
│  │  └────────┬────────┘  └──────────┬──────────────┘  │    │
│  │           │                      │                  │    │
│  │  ┌────────▼──────────────────────▼──────────────┐  │    │
│  │  │         nexusvaio.sys (this driver)           │  │    │
│  │  │  ┌──────────┐ ┌────────────┐ ┌────────────┐  │  │    │
│  │  │  │ Miniport │ │ Miniport   │ │ Topology   │  │  │    │
│  │  │  │ WaveRT   │ │ Stream     │ │ Miniport   │  │  │    │
│  │  │  └──────────┘ └────────────┘ └────────────┘  │  │    │
│  │  │  ┌──────────┐ ┌──────────────────────────┐   │  │    │
│  │  │  │ Shared   │ │ Adapter Common / IOCTL   │   │  │    │
│  │  │  │ Memory   │ │ Interface                │   │  │    │
│  │  │  └──────────┘ └──────────────────────────┘   │  │    │
│  │  └──────────────────────────────────────────────┘  │    │
│  └─────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

## Virtual Audio Endpoints

The driver creates **4 virtual audio endpoints** across **2 sub-devices**:

| Sub-Device | Endpoint      | Friendly Name       | Direction |
|------------|---------------|---------------------|-----------|
| 0 (VAIO)   | Render (Play) | Nexus VAIO Output   | Output    |
| 0 (VAIO)   | Capture (Rec) | Nexus VAIO Input    | Input     |
| 1 (AUX)    | Render (Play) | Nexus AUX Output    | Output    |
| 1 (AUX)    | Capture (Rec) | Nexus AUX Input     | Input     |

## Supported Audio Formats

- **Sample Rates**: 44100 Hz, 48000 Hz, 96000 Hz
- **Channels**: 2 to 8
- **Format**: 32-bit IEEE Float (KSDATAFORMAT_SUBTYPE_IEEE_FLOAT)
- **Buffer**: Cyclic buffer with notification-based timing
- **Latency**: ~10 ms

## Hardware IDs

```
SW\{f8b4c5a0-7b4c-11ef-8a1d-00155d0a0b01}\NEXUSVAIO
SW\{f8b4c5a1-7b4c-11ef-8a1d-00155d0a0b01}\NEXUSAUX
USB\VID_FFFF&PID_0001&MI_00
USB\VID_FFFF&PID_0001&MI_01
```

## Project Structure

```
driver/
├── nexusvaio.sln                    # Visual Studio 2022 solution
├── nexusvaio/
│   ├── nexusvaio.vcxproj            # VC++ project file
│   ├── nexusvaio.vcxproj.filters    # Project filters
│   ├── adapter.cpp                  # DriverEntry, AddDevice, CAdapterCommon
│   ├── miniport.cpp                 # IMiniportWaveRT implementation
│   ├── miniportstream.cpp           # IMiniportWaveRTStream implementation
│   ├── topology.cpp                 # KS topology, pins, nodes, controls
│   ├── sharedmem.cpp                # Shared memory, IOCTL interface
│   ├── nexusvaio.rc                 # Version resources
│   ├── nexusvaio.inf                # Driver installation INF
│   └── nexusvaio.inx                # INX for Inf2Cat processing
├── common/
│   └── nexus_ioctl.h                # IOCTL definitions (shared header)
├── install/
│   ├── build.ps1                    # Build automation script
│   ├── install.ps1                  # Installation script
│   └── uninstall.ps1                # Uninstallation script
└── README.md                        # This file
```

## Prerequisites

- **Windows SDK 10.0.26100.0** or later
- **Visual Studio 2022 Build Tools** with C++ workload
- **Windows Driver Kit (WDK)** for kernel-mode compilation
- Windows 10 or later (x64)

## Building

### Using PowerShell Build Script

```powershell
cd driver
.\install\build.ps1
```

Options:
- `-Configuration Debug` — debug build
- `-SkipSigning` — bypass driver signing
- `-SkipInf2Cat` — skip catalog file generation

### Using Visual Studio

1. Open `nexusvaio.sln` in Visual Studio 2022
2. Select **Release** and **x64** configuration
3. Build Solution (F7)

## Installation

### Automated Installation

```powershell
# Build first
.\install\build.ps1

# Install (requires admin)
.\install\install.ps1
```

### Manual Installation

1. Enable test signing: `bcdedit /set testsigning on` (reboot required)
2. Copy `nexusvaio.sys` to `C:\Windows\System32\drivers\`
3. Right-click `nexusvaio.inf` → **Install**
4. Or use: `pnputil /add-driver nexusvaio.inf /install`

### Uninstallation

```powershell
.\install\uninstall.ps1
```

## IOCTL Interface

The driver exposes an IOCTL interface for user-mode audio engine communication:

| IOCTL | Code | Description |
|-------|------|-------------|
| `NEXUS_IOCTL_GET_POSITION` | 0x800 | Get buffer read/write positions |
| `NEXUS_IOCTL_SET_FORMAT` | 0x801 | Set audio format |
| `NEXUS_IOCTL_GET_LATENCY` | 0x802 | Get hardware latency |
| `NEXUS_IOCTL_RESET_STREAM` | 0x803 | Reset stream state |
| `NEXUS_IOCTL_GET_STREAM_STATE` | 0x804 | Get current stream state |
| `NEXUS_IOCTL_SET_VOLUME` | 0x805 | Set channel volume |
| `NEXUS_IOCTL_GET_MUTE` | 0x806 | Get channel mute state |
| `NEXUS_IOCTL_SET_MUTE` | 0x807 | Set channel mute state |
| `NEXUS_IOCTL_CONNECT_PROCESS` | 0x808 | Register user-mode process |
| `NEXUS_IOCTL_DISCONNECT_PROCESS` | 0x809 | Unregister user-mode process |

## Shared Memory Protocol

The driver creates a named shared memory section (`\BaseNamedObjects\NexusVAIO_SharedMem_N`)
synchronized via named events (`\BaseNamedObjects\NexusVAIO_Event_N`) for
efficient zero-copy audio data transfer between user-mode and kernel-mode.

## Debugging

The driver outputs debug messages via `DbgPrint`. Use DebugView (Sysinternals)
to capture them:

```
Filter:  [NexusVAIO]
```

Debug levels (set `g_NexusDebugFlags`):
- `0x01` — Errors
- `0x02` — Warnings
- `0x04` — Information
- `0x08` — Verbose

## License

Copyright (c) 2024-2025 Nexus VAIO. All rights reserved.
