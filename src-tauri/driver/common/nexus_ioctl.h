//--------------------------------------------------------------------------
// nexus_ioctl.h - IOCTL definitions shared between driver and user-mode
//
// This header defines the IOCTL interface for the Nexus VAIO virtual audio
// driver. The user-mode audio engine communicates with the driver through
// these control codes, using shared memory for audio data transfer.
//
// Copyright (c) 2024-2025 Nexus VAIO. All rights reserved.
//--------------------------------------------------------------------------

#pragma once

#ifdef __cplusplus
extern "C" {
#endif

//--------------------------------------------------------------------------
// Device type - use a unique value
//--------------------------------------------------------------------------
#define NEXUS_DEVICE_TYPE 0x8001

//--------------------------------------------------------------------------
// IOCTL function codes
//--------------------------------------------------------------------------
#define NEXUS_IOCTL_GET_POSITION \
    CTL_CODE(NEXUS_DEVICE_TYPE, 0x800, METHOD_BUFFERED, FILE_READ_ACCESS | FILE_WRITE_ACCESS)

#define NEXUS_IOCTL_SET_FORMAT \
    CTL_CODE(NEXUS_DEVICE_TYPE, 0x801, METHOD_BUFFERED, FILE_READ_ACCESS | FILE_WRITE_ACCESS)

#define NEXUS_IOCTL_GET_LATENCY \
    CTL_CODE(NEXUS_DEVICE_TYPE, 0x802, METHOD_BUFFERED, FILE_READ_ACCESS | FILE_WRITE_ACCESS)

#define NEXUS_IOCTL_RESET_STREAM \
    CTL_CODE(NEXUS_DEVICE_TYPE, 0x803, METHOD_BUFFERED, FILE_READ_ACCESS | FILE_WRITE_ACCESS)

#define NEXUS_IOCTL_GET_STREAM_STATE \
    CTL_CODE(NEXUS_DEVICE_TYPE, 0x804, METHOD_BUFFERED, FILE_READ_ACCESS | FILE_WRITE_ACCESS)

#define NEXUS_IOCTL_SET_VOLUME \
    CTL_CODE(NEXUS_DEVICE_TYPE, 0x805, METHOD_BUFFERED, FILE_READ_ACCESS | FILE_WRITE_ACCESS)

#define NEXUS_IOCTL_GET_MUTE \
    CTL_CODE(NEXUS_DEVICE_TYPE, 0x806, METHOD_BUFFERED, FILE_READ_ACCESS | FILE_WRITE_ACCESS)

#define NEXUS_IOCTL_SET_MUTE \
    CTL_CODE(NEXUS_DEVICE_TYPE, 0x807, METHOD_BUFFERED, FILE_READ_ACCESS | FILE_WRITE_ACCESS)

#define NEXUS_IOCTL_CONNECT_PROCESS \
    CTL_CODE(NEXUS_DEVICE_TYPE, 0x808, METHOD_BUFFERED, FILE_READ_ACCESS | FILE_WRITE_ACCESS)

#define NEXUS_IOCTL_DISCONNECT_PROCESS \
    CTL_CODE(NEXUS_DEVICE_TYPE, 0x809, METHOD_BUFFERED, FILE_READ_ACCESS | FILE_WRITE_ACCESS)

//--------------------------------------------------------------------------
// Maximum number of channels supported
//--------------------------------------------------------------------------
#define NEXUS_MAX_CHANNELS 8
#define NEXUS_MIN_CHANNELS 2

//--------------------------------------------------------------------------
// Supported sample rates
//--------------------------------------------------------------------------
#define NEXUS_RATE_44100 44100
#define NEXUS_RATE_48000 48000
#define NEXUS_RATE_96000 96000

//--------------------------------------------------------------------------
// Buffer and notification configuration
//--------------------------------------------------------------------------
#define NEXUS_DEFAULT_BUFFER_SIZE_MS 10   // 10ms buffer per notification
#define NEXUS_DEFAULT_NOTIFICATION_COUNT 4 // 4 notification intervals per buffer
#define NEXUS_MIN_BUFFER_SIZE_PAGES 2      // Minimum 2 pages for cyclic buffer

//--------------------------------------------------------------------------
// Shared memory header - placed at the beginning of the shared memory section
// All offsets are relative to the start of the shared memory mapping.
//--------------------------------------------------------------------------
typedef struct _NEXUS_SHARED_MEMORY_HEADER
{
    //
    // Signature to validate the shared memory mapping
    //
    ULONG   Signature;
#define NEXUS_SHARED_MEMORY_SIGNATURE 0x4E455855  // "NEXU"

    //
    // Size of this header
    //
    ULONG   HeaderSize;

    //
    // Total size of the shared memory block
    //
    ULONG   TotalSize;

    //
    // Current audio format description
    //
    struct {
        ULONG  SampleRate;     // Samples per second (44100, 48000, 96000)
        USHORT Channels;       // Number of channels (2-8)
        USHORT BitsPerSample;  // Bits per sample (32 for float)
        ULONG  BlockAlign;     // Frame size in bytes
        ULONG  AvgBytesPerSec; // Average bytes per second
    } Format;

    //
    // Buffer layout
    //
    struct {
        ULONG  BufferSize;        // Total buffer size in bytes
        ULONG  NotificationCount; // Number of notification points
        ULONG  NotificationSize;  // Bytes per notification interval
        ULONG  WriteOffset;       // Current write position (driver)
        ULONG  ReadOffset;        // Current read position (user-mode)
    } Buffer;

    //
    // Stream state
    //
    struct {
        LONG   State;          // KSSTATE: stop=0, acquire=1, pause=2, run=3
        LONG   UnderrunCount;  // Counter increments on underrun
        LONG   OverrunCount;   // Counter increments on overrun
        LONG   Reserved;
    } Stream;

    //
    // Volume and mute settings (per channel, up to NEXUS_MAX_CHANNELS)
    //
    struct {
        LONG   Volume[NEXUS_MAX_CHANNELS];   // 0..10000 linear scale
        BOOLEAN Mute[NEXUS_MAX_CHANNELS];
        BYTE   Reserved[8];
    } Control;

    //
    // Process identifier of the connected user-mode engine
    //
    ULONG   ConnectedProcessId;

    //
    // Padding to align to 64 bytes
    //
    BYTE    Padding[8];

} NEXUS_SHARED_MEMORY_HEADER, *PNEXUS_SHARED_MEMORY_HEADER;

//--------------------------------------------------------------------------
// IOCTL structures
//--------------------------------------------------------------------------

typedef struct _NEXUS_POSITION_INFO
{
    ULONG   WriteOffset;     // Driver write position
    ULONG   ReadOffset;      // User-mode read position
    ULONG   PacketsInBuffer; // Number of complete packets ready
    ULONG   UnderrunCount;
    ULONG   OverrunCount;
    LONGLONG DpcCount;       // Total DPC interrupts
} NEXUS_POSITION_INFO, *PNEXUS_POSITION_INFO;

typedef struct _NEXUS_FORMAT_INFO
{
    ULONG  SampleRate;
    USHORT Channels;
    USHORT BitsPerSample;
    ULONG  BlockAlign;
    ULONG  AvgBytesPerSec;
} NEXUS_FORMAT_INFO, *PNEXUS_FORMAT_INFO;

typedef struct _NEXUS_LATENCY_INFO
{
    LONGLONG FifoSize;       // FIFO size in bytes (0 for virtual)
    ULONG   BufferSize;      // Buffer size in bytes
    ULONG   Latency;         // Latency in 100ns units
} NEXUS_LATENCY_INFO, *PNEXUS_LATENCY_INFO;

typedef struct _NEXUS_VOLUME_INFO
{
    LONG    Volume;
    USHORT  Channel;
    BOOLEAN IsMute;
    BYTE    Reserved[5];
} NEXUS_VOLUME_INFO, *PNEXUS_VOLUME_INFO;

//--------------------------------------------------------------------------
// Event names for shared memory synchronization
//--------------------------------------------------------------------------
#define NEXUS_EVENT_NAME_PREFIX L"\\BaseNamedObjects\\NexusVAIO_Event_"
#define NEXUS_EVENT_NAME_DRIVER_READY L"\\BaseNamedObjects\\NexusVAIO_DriverReady"
#define NEXUS_EVENT_NAME_CLIENT_READY L"\\BaseNamedObjects\\NexusVAIO_ClientReady"

#define NEXUS_SHARED_MEMORY_NAME_PREFIX L"\\BaseNamedObjects\\NexusVAIO_SharedMem_"

//--------------------------------------------------------------------------
// Debug flags
//--------------------------------------------------------------------------
#define NEXUS_DBG_ERROR   0x00000001
#define NEXUS_DBG_WARNING 0x00000002
#define NEXUS_DBG_INFO    0x00000004
#define NEXUS_DBG_VERBOSE 0x00000008

extern ULONG g_NexusDebugFlags;

#define NEXUS_DBG_PRINT(level, format, ...) \
    do { \
        if (g_NexusDebugFlags & (level)) { \
            DbgPrint("[NexusVAIO] " format, __VA_ARGS__); \
        } \
    } while (0)

#ifdef __cplusplus
}
#endif
