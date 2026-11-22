//--------------------------------------------------------------------------
// driver.cpp - Nexus VAIO Virtual Audio Driver
//
// A WDM PortCls audio adapter (non-WDF) modeled on the Microsoft
// SimpleAudioSample speaker endpoint:
//   - WaveRT port + miniport (render): 2 pins (system sink + bridge),
//     1 connection, 48KHz/16-bit/stereo PCM with signal-processing-mode
//     attributes on the streaming pin.
//   - Topology port + miniport: VOLUME + MUTE nodes with KSPROPSETID_Audio
//     handlers, speaker bridge.
//   - One physical connection Wave<->Topology (KSPIN_WAVE_RENDER3_SOURCE
//     <-> KSPIN_TOPO_WAVEOUT_SOURCE).
//
// Device instances are ROOT enumerated (Root\NexusVAIO / Root\NexusAUX).
//--------------------------------------------------------------------------

#include <wdm.h>

// Generate GUID data definitions (IIDs/CLSIDs/KSCATEGORYs/KSNODETYPEs).
#define INITGUID
#include <guiddef.h>
#include <portcls.h>
#include <ks.h>
#include <ksmedia.h>

#pragma comment(lib, "portcls.lib")
#pragma comment(lib, "ks.lib")
#pragma comment(lib, "wdmsec.lib")
#pragma comment(lib, "ksguid.lib")

#define POOL_TAG 'xenN'

//--------------------------------------------------------------------------
// Diagnostic markers.
//
// Device startup fails with STATUS_INSUFFICIENT_RESOURCES and we cannot see
// DbgPrint without a kernel debugger. Persist coarse progress markers in the
// registry so we can tell exactly which call fails.
//--------------------------------------------------------------------------
static VOID
DiagLog(
    _In_ PCWSTR Name,
    _In_ ULONG  Value)
{
    UNICODE_STRING    keyPath;
    UNICODE_STRING    valueName;
    OBJECT_ATTRIBUTES oa;
    HANDLE            hKey = NULL;

    RtlInitUnicodeString(
        &keyPath,
        L"\\Registry\\Machine\\SYSTEM\\CurrentControlSet\\Services\\nexusvaio\\Diag");

    InitializeObjectAttributes(
        &oa,
        &keyPath,
        OBJ_CASE_INSENSITIVE | OBJ_KERNEL_HANDLE,
        NULL,
        NULL);

    if (NT_SUCCESS(ZwCreateKey(
            &hKey,
            KEY_SET_VALUE,
            &oa,
            0,
            NULL,
            0,
            NULL)))
    {
        RtlInitUnicodeString(&valueName, Name);
        ZwSetValueKey(
            hKey,
            &valueName,
            0,
            REG_DWORD,
            (PVOID)&Value,
            sizeof(Value));
        ZwClose(hKey);
    }
}


// Suppress default C++ delete/delete[] operators to avoid kernel link errors.
void __cdecl operator delete(void*, unsigned __int64) { }
void __cdecl operator delete[](void*, unsigned __int64) { }

//==========================================================================
// Endpoint numbering (kept identical to the SimpleAudioSample speaker).
//==========================================================================

// Wave pins - render only, no offload.
enum
{
    KSPIN_WAVE_RENDER3_SINK_SYSTEM = 0,
    KSPIN_WAVE_RENDER3_SOURCE
};

// Topology pins.
enum
{
    KSPIN_TOPO_WAVEOUT_SOURCE = 0,
    KSPIN_TOPO_LINEOUT_DEST
};

// Topology nodes.
enum
{
    KSNODE_TOPO_VOLUME = 0,
    KSNODE_TOPO_MUTE
};

// Supported PCM configuration (single format).
#define DEVICE_MAX_CHANNELS            2
#define HOST_MIN_BITS_PER_SAMPLE       16
#define HOST_MAX_BITS_PER_SAMPLE       16
#define HOST_MIN_SAMPLE_RATE           48000
#define HOST_MAX_SAMPLE_RATE           48000
#define MAX_INPUT_SYSTEM_STREAMS       1

// Volume state encoding: 0x10000 == 0 dB (matches the SysVad convention).
#define ALL_CHANNELS_ID                ((ULONG)0xFFFFFFFF)
#define VOLUME_STEPPING_DELTA          0x8000
#define VOLUME_SIGNED_MAXIMUM          0x00000000
#define VOLUME_SIGNED_MINIMUM          (-96 * 0x10000)

#ifndef VT_ILLEGAL
#define VT_ILLEGAL                     0xFFFF
#endif

// KSPROPERTY_TYPE_ALL is a convenience mask (not in ks.h).
#ifndef KSPROPERTY_TYPE_ALL
#define KSPROPERTY_TYPE_ALL             (KSPROPERTY_TYPE_GET | KSPROPERTY_TYPE_SET | KSPROPERTY_TYPE_BASICSUPPORT)
#endif

// Suppress deprecated ExAllocatePoolWithTag warning — it still works fine
// and is used by all WDK sample drivers.
#pragma warning(disable: 4996)

//==========================================================================
// Forward declarations
//==========================================================================
class CMiniportWaveRT;
class CMiniportTopology;
class CMiniportWaveRTStream;

NTSTATUS PropertyHandler_WaveFilter(PPCPROPERTY_REQUEST);
NTSTATUS PropertyHandler_Topology(PPCPROPERTY_REQUEST);

NTSTATUS StartDevice(PDEVICE_OBJECT, PIRP, PRESOURCELIST);

//==========================================================================
// Signal processing mode attribute (required for Windows 10+ audio
// endpoints to be presented by AudioEndpointBuilder).
//
// The KSATTRIBUTE_LIST must immediately follow the KSDATARANGE in memory
// when the KSDATARANGE_ATTRIBUTES flag is set.
//==========================================================================

// Contiguous block: KSDATARANGE_AUDIO | KSATTRIBUTE_LIST | KSATTRIBUTE *
// Use a static struct to guarantee adjacency.

static
KSATTRIBUTE PinDataRangeSignalProcessingModeAttribute =
{
    sizeof(KSATTRIBUTE),
    0,
    STATICGUIDOF(KSATTRIBUTEID_AUDIOSIGNALPROCESSING_MODE),
};

static
PKSATTRIBUTE PinDataRangeAttributes[] =
{
    &PinDataRangeSignalProcessingModeAttribute,
};

struct {
    KSDATARANGE_AUDIO  DataRange;
    KSATTRIBUTE_LIST   AttributeList;
} SpeakerPinDataRangeStream =
{
    // DataRange
    {
        {
            sizeof(KSDATARANGE_AUDIO),
            KSDATARANGE_ATTRIBUTES,
            0,
            0,
            STATICGUIDOF(KSDATAFORMAT_TYPE_AUDIO),
            STATICGUIDOF(KSDATAFORMAT_SUBTYPE_PCM),
            STATICGUIDOF(KSDATAFORMAT_SPECIFIER_WAVEFORMATEX)
        },
        DEVICE_MAX_CHANNELS,
        HOST_MIN_BITS_PER_SAMPLE,
        HOST_MAX_BITS_PER_SAMPLE,
        HOST_MIN_SAMPLE_RATE,
        HOST_MAX_SAMPLE_RATE
    },
    // AttributeList
    {
        ARRAYSIZE(PinDataRangeAttributes),
        PinDataRangeAttributes,
    }
};

//==========================================================================
// Wave filter tables
//==========================================================================

// The single supported device format (48KHz, 16-bit, stereo, PCM).
static
KSDATAFORMAT_WAVEFORMATEXTENSIBLE SpeakerHostPinSupportedDeviceFormats[] =
{
    { // 0
        {
            sizeof(KSDATAFORMAT_WAVEFORMATEXTENSIBLE),
            0,
            0,
            0,
            STATICGUIDOF(KSDATAFORMAT_TYPE_AUDIO),
            STATICGUIDOF(KSDATAFORMAT_SUBTYPE_PCM),
            STATICGUIDOF(KSDATAFORMAT_SPECIFIER_WAVEFORMATEX)
        },
        {
            {
                WAVE_FORMAT_EXTENSIBLE,
                2,            // nChannels
                48000,        // nSamplesPerSec
                192000,       // nAvgBytesPerSec
                4,            // nBlockAlign
                16,           // wBitsPerSample
                sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX)
            },
            16,                             // wValidBitsPerSample
            KSAUDIO_SPEAKER_STEREO,         // dwChannelMask
            STATICGUIDOF(KSDATAFORMAT_SUBTYPE_PCM)
        }
    }
};

// Streaming pin data range (with attribute list).
static
KSDATARANGE_AUDIO SpeakerPinDataRangesStream[] =
{
    { // 0
        {
            sizeof(KSDATARANGE_AUDIO),
            KSDATARANGE_ATTRIBUTES,     // an attributes list follows this data range
            0,
            0,
            STATICGUIDOF(KSDATAFORMAT_TYPE_AUDIO),
            STATICGUIDOF(KSDATAFORMAT_SUBTYPE_PCM),
            STATICGUIDOF(KSDATAFORMAT_SPECIFIER_WAVEFORMATEX)
        },
        DEVICE_MAX_CHANNELS,
        HOST_MIN_BITS_PER_SAMPLE,
        HOST_MAX_BITS_PER_SAMPLE,
        HOST_MIN_SAMPLE_RATE,
        HOST_MAX_SAMPLE_RATE
    }
};

static
PKSDATARANGE SpeakerPinDataRangePointersStream[] =
{
    (PKSDATARANGE)&SpeakerPinDataRangeStream.DataRange,
};

// Bridge pin data range (analog, non-streaming).
static
KSDATARANGE SpeakerPinDataRangesBridge[] =
{
    {
        sizeof(KSDATARANGE),
        0,
        0,
        0,
        STATICGUIDOF(KSDATAFORMAT_TYPE_AUDIO),
        STATICGUIDOF(KSDATAFORMAT_SUBTYPE_ANALOG),
        STATICGUIDOF(KSDATAFORMAT_SPECIFIER_NONE)
    }
};

static
PKSDATARANGE SpeakerPinDataRangePointersBridge[] =
{
    &SpeakerPinDataRangesBridge[0]
};

static
PCPIN_DESCRIPTOR SpeakerWaveMiniportPins[] =
{
    // KSPIN_WAVE_RENDER3_SINK_SYSTEM (streaming render pin)
    {
        MAX_INPUT_SYSTEM_STREAMS,   // MaxGlobalInstanceCount
        MAX_INPUT_SYSTEM_STREAMS,   // MaxFilterInstanceCount
        0,                          // MinFilterInstanceCount
        NULL,                       // AutomationTable
        {                           // KsPinDescriptor
            0,
            NULL,
            0,
            NULL,
            ARRAYSIZE(SpeakerPinDataRangePointersStream),
            SpeakerPinDataRangePointersStream,
            KSPIN_DATAFLOW_IN,
            KSPIN_COMMUNICATION_SINK,
            &KSCATEGORY_AUDIO,
            NULL,
            0
        }
    },
    // KSPIN_WAVE_RENDER3_SOURCE (bridge pin)
    {
        0,
        0,
        0,
        NULL,
        {
            0,
            NULL,
            0,
            NULL,
            ARRAYSIZE(SpeakerPinDataRangePointersBridge),
            SpeakerPinDataRangePointersBridge,
            KSPIN_DATAFLOW_OUT,
            KSPIN_COMMUNICATION_NONE,
            &KSCATEGORY_AUDIO,
            NULL,
            0
        }
    }
};

static
PCCONNECTION_DESCRIPTOR SpeakerWaveMiniportConnections[] =
{
    {   PCFILTER_NODE,            KSPIN_WAVE_RENDER3_SINK_SYSTEM,
        PCFILTER_NODE,            KSPIN_WAVE_RENDER3_SOURCE
    }
};

static
PCPROPERTY_ITEM PropertiesSpeakerWaveFilter[] =
{
    {
        &KSPROPSETID_Pin,
        KSPROPERTY_PIN_PROPOSEDATAFORMAT,
        KSPROPERTY_TYPE_SET | KSPROPERTY_TYPE_BASICSUPPORT,
        PropertyHandler_WaveFilter
    }
};

DEFINE_PCAUTOMATION_TABLE_PROP(AutomationSpeakerWaveFilter, PropertiesSpeakerWaveFilter);

static
PCFILTER_DESCRIPTOR SpeakerWaveMiniportFilterDescriptor =
{
    0,                                              // Version
    &AutomationSpeakerWaveFilter,                   // AutomationTable
    sizeof(PCPIN_DESCRIPTOR),                       // PinSize
    ARRAYSIZE(SpeakerWaveMiniportPins),             // PinCount
    SpeakerWaveMiniportPins,                        // Pins
    sizeof(PCNODE_DESCRIPTOR),                      // NodeSize
    0,                                              // NodeCount
    NULL,                                           // Nodes
    ARRAYSIZE(SpeakerWaveMiniportConnections),      // ConnectionCount
    SpeakerWaveMiniportConnections,                 // Connections
    0,                                              // CategoryCount
    NULL                                            // Categories
};

//==========================================================================
// Topology filter tables
//==========================================================================

static
KSDATARANGE TopoPinDataRangesBridge[] =
{
    {
        sizeof(KSDATARANGE),
        0,
        0,
        0,
        STATICGUIDOF(KSDATAFORMAT_TYPE_AUDIO),
        STATICGUIDOF(KSDATAFORMAT_SUBTYPE_ANALOG),
        STATICGUIDOF(KSDATAFORMAT_SPECIFIER_NONE)
    }
};

static
PKSDATARANGE TopoPinDataRangePointersBridge[] =
{
    &TopoPinDataRangesBridge[0]
};

static
PCPIN_DESCRIPTOR TopoMiniportPins[] =
{
    // KSPIN_TOPO_WAVEOUT_SOURCE
    {
        0,
        0,
        0,
        NULL,
        {
            0,
            NULL,
            0,
            NULL,
            ARRAYSIZE(TopoPinDataRangePointersBridge),
            TopoPinDataRangePointersBridge,
            KSPIN_DATAFLOW_IN,
            KSPIN_COMMUNICATION_NONE,
            &KSCATEGORY_AUDIO,
            NULL,
            0
        }
    },
    // KSPIN_TOPO_LINEOUT_DEST
    {
        0,
        0,
        0,
        NULL,
        {
            0,
            NULL,
            0,
            NULL,
            ARRAYSIZE(TopoPinDataRangePointersBridge),
            TopoPinDataRangePointersBridge,
            KSPIN_DATAFLOW_OUT,
            KSPIN_COMMUNICATION_NONE,
            &KSNODETYPE_SPEAKER,
            NULL,
            0
        }
    }
};

static
PCPROPERTY_ITEM SpeakerPropertiesVolume[] =
{
    {
        &KSPROPSETID_Audio,
        KSPROPERTY_AUDIO_VOLUMELEVEL,
        KSPROPERTY_TYPE_GET | KSPROPERTY_TYPE_SET | KSPROPERTY_TYPE_BASICSUPPORT,
        PropertyHandler_Topology
    }
};

DEFINE_PCAUTOMATION_TABLE_PROP(AutomationSpeakerVolume, SpeakerPropertiesVolume);

static
PCPROPERTY_ITEM SpeakerPropertiesMute[] =
{
    {
        &KSPROPSETID_Audio,
        KSPROPERTY_AUDIO_MUTE,
        KSPROPERTY_TYPE_GET | KSPROPERTY_TYPE_SET | KSPROPERTY_TYPE_BASICSUPPORT,
        PropertyHandler_Topology
    }
};

DEFINE_PCAUTOMATION_TABLE_PROP(AutomationSpeakerMute, SpeakerPropertiesMute);

static
PCNODE_DESCRIPTOR TopologyNodes[] =
{
    // KSNODE_TOPO_VOLUME
    {
        0,
        &AutomationSpeakerVolume,
        &KSNODETYPE_VOLUME,
        &KSAUDFNAME_MASTER_VOLUME
    },
    // KSNODE_TOPO_MUTE
    {
        0,
        &AutomationSpeakerMute,
        &KSNODETYPE_MUTE,
        &KSAUDFNAME_MASTER_MUTE
    }
};

static
PCCONNECTION_DESCRIPTOR TopoMiniportConnections[] =
{
    //  FromNode,                 FromPin,                    ToNode,             ToPin
    {   PCFILTER_NODE,            KSPIN_TOPO_WAVEOUT_SOURCE,    KSNODE_TOPO_VOLUME, 1 },
    {   KSNODE_TOPO_VOLUME,       0,                            KSNODE_TOPO_MUTE,   1 },
    {   KSNODE_TOPO_MUTE,         0,                            PCFILTER_NODE,      KSPIN_TOPO_LINEOUT_DEST }
};

static
PCFILTER_DESCRIPTOR TopoMiniportFilterDescriptor =
{
    0,                                              // Version
    NULL,                                           // AutomationTable
    sizeof(PCPIN_DESCRIPTOR),                       // PinSize
    ARRAYSIZE(TopoMiniportPins),                    // PinCount
    TopoMiniportPins,                               // Pins
    sizeof(PCNODE_DESCRIPTOR),                      // NodeSize
    ARRAYSIZE(TopologyNodes),                       // NodeCount
    TopologyNodes,                                  // Nodes
    ARRAYSIZE(TopoMiniportConnections),             // ConnectionCount
    TopoMiniportConnections,                        // Connections
    0,                                              // CategoryCount
    NULL                                            // Categories
};

//==========================================================================
// Shared property helpers
//==========================================================================

#pragma code_seg("PAGE")
NTSTATUS
ValidatePropertyParams(
    _In_ PPCPROPERTY_REQUEST PropertyRequest,
    _In_ ULONG               cbValueSize,
    _In_ ULONG               cbInstanceSize /* = 0 */
    )
{
    PAGED_CODE();

    NTSTATUS ntStatus = STATUS_UNSUCCESSFUL;

    if (PropertyRequest && cbValueSize)
    {
        if (0 == PropertyRequest->ValueSize)
        {
            PropertyRequest->ValueSize = cbValueSize;
            ntStatus = STATUS_BUFFER_OVERFLOW;
        }
        else if (PropertyRequest->ValueSize < cbValueSize)
        {
            ntStatus = STATUS_BUFFER_TOO_SMALL;
        }
        else if (cbInstanceSize != 0 &&
                 (PropertyRequest->Instance == NULL ||
                  PropertyRequest->InstanceSize < cbInstanceSize))
        {
            ntStatus = STATUS_BUFFER_TOO_SMALL;
        }
        else if (PropertyRequest->Value)
        {
            ntStatus = STATUS_SUCCESS;
        }
    }
    else
    {
        ntStatus = STATUS_INVALID_PARAMETER;
    }

    if (PropertyRequest &&
        STATUS_SUCCESS != ntStatus &&
        STATUS_BUFFER_OVERFLOW != ntStatus)
    {
        PropertyRequest->ValueSize = 0;
    }

    return ntStatus;
}

#pragma code_seg("PAGE")
NTSTATUS
PropertyHandler_BasicSupport(
    _In_ PPCPROPERTY_REQUEST PropertyRequest,
    _In_ ULONG               Flags,
    _In_ DWORD               PropTypeSetId
    )
{
    PAGED_CODE();

    NTSTATUS ntStatus = STATUS_INVALID_PARAMETER;

    if (PropertyRequest->ValueSize >= sizeof(KSPROPERTY_DESCRIPTION))
    {
        PKSPROPERTY_DESCRIPTION PropDesc =
            (PKSPROPERTY_DESCRIPTION)(PropertyRequest->Value);

        PropDesc->AccessFlags       = Flags;
        PropDesc->DescriptionSize   = sizeof(KSPROPERTY_DESCRIPTION);
        if (VT_ILLEGAL != PropTypeSetId)
        {
            PropDesc->PropTypeSet.Set   = KSPROPTYPESETID_General;
            PropDesc->PropTypeSet.Id    = PropTypeSetId;
        }
        else
        {
            PropDesc->PropTypeSet.Set   = GUID_NULL;
            PropDesc->PropTypeSet.Id    = 0;
        }
        PropDesc->PropTypeSet.Flags   = 0;
        PropDesc->MembersListCount    = 0;
        PropDesc->Reserved            = 0;

        PropertyRequest->ValueSize = sizeof(KSPROPERTY_DESCRIPTION);
        ntStatus = STATUS_SUCCESS;
    }
    else if (PropertyRequest->ValueSize >= sizeof(ULONG))
    {
        *(PULONG)(PropertyRequest->Value) = Flags;
        PropertyRequest->ValueSize = sizeof(ULONG);
        ntStatus = STATUS_SUCCESS;
    }
    else
    {
        PropertyRequest->ValueSize = 0;
        ntStatus = STATUS_BUFFER_TOO_SMALL;
    }

    return ntStatus;
}

#pragma code_seg("PAGE")
NTSTATUS
PropertyHandler_BasicSupportVolume(
    _In_ PPCPROPERTY_REQUEST PropertyRequest,
    _In_ ULONG               MaxChannels
    )
{
    PAGED_CODE();

    NTSTATUS ntStatus = STATUS_SUCCESS;
    ULONG cbFullProperty =
        sizeof(KSPROPERTY_DESCRIPTION) +
        sizeof(KSPROPERTY_MEMBERSHEADER) +
        sizeof(KSPROPERTY_STEPPING_LONG) * MaxChannels;

    if (PropertyRequest->ValueSize >= sizeof(KSPROPERTY_DESCRIPTION))
    {
        PKSPROPERTY_DESCRIPTION PropDesc =
            (PKSPROPERTY_DESCRIPTION)(PropertyRequest->Value);

        PropDesc->AccessFlags       = KSPROPERTY_TYPE_ALL;
        PropDesc->DescriptionSize   = cbFullProperty;
        PropDesc->PropTypeSet.Set   = KSPROPTYPESETID_General;
        PropDesc->PropTypeSet.Id    = VT_I4;
        PropDesc->PropTypeSet.Flags = 0;
        PropDesc->MembersListCount  = 1;
        PropDesc->Reserved          = 0;

        if (PropertyRequest->ValueSize >= cbFullProperty)
        {
            PKSPROPERTY_MEMBERSHEADER Members =
                (PKSPROPERTY_MEMBERSHEADER)(PropDesc + 1);

            Members->MembersFlags   = KSPROPERTY_MEMBER_STEPPEDRANGES;
            Members->MembersSize    = sizeof(KSPROPERTY_STEPPING_LONG);
            Members->MembersCount   = MaxChannels;
            Members->Flags          = KSPROPERTY_MEMBER_FLAG_BASICSUPPORT_MULTICHANNEL;

            PKSPROPERTY_STEPPING_LONG Range =
                (PKSPROPERTY_STEPPING_LONG)(Members + 1);

            for (ULONG i = 0; i < MaxChannels; ++i)
            {
                Range[i].Bounds.SignedMaximum = VOLUME_SIGNED_MAXIMUM;
                Range[i].Bounds.SignedMinimum = VOLUME_SIGNED_MINIMUM;
                Range[i].SteppingDelta        = VOLUME_STEPPING_DELTA;
                Range[i].Reserved             = 0;
            }

            PropertyRequest->ValueSize = cbFullProperty;
        }
        else
        {
            PropertyRequest->ValueSize = sizeof(KSPROPERTY_DESCRIPTION);
        }
    }
    else if (PropertyRequest->ValueSize >= sizeof(ULONG))
    {
        *(PULONG)(PropertyRequest->Value) = KSPROPERTY_TYPE_ALL;
        PropertyRequest->ValueSize = sizeof(ULONG);
    }
    else
    {
        PropertyRequest->ValueSize = 0;
        ntStatus = STATUS_BUFFER_TOO_SMALL;
    }

    return ntStatus;
}

#pragma code_seg("PAGE")
NTSTATUS
PropertyHandler_BasicSupportMute(
    _In_ PPCPROPERTY_REQUEST PropertyRequest,
    _In_ ULONG               MaxChannels
    )
{
    PAGED_CODE();

    NTSTATUS ntStatus = STATUS_SUCCESS;
    ULONG cbFullProperty =
        sizeof(KSPROPERTY_DESCRIPTION) +
        sizeof(KSPROPERTY_MEMBERSHEADER) +
        sizeof(KSPROPERTY_STEPPING_LONG) * MaxChannels;

    if (PropertyRequest->ValueSize >= sizeof(KSPROPERTY_DESCRIPTION))
    {
        PKSPROPERTY_DESCRIPTION PropDesc =
            (PKSPROPERTY_DESCRIPTION)(PropertyRequest->Value);

        PropDesc->AccessFlags       = KSPROPERTY_TYPE_ALL;
        PropDesc->DescriptionSize   = cbFullProperty;
        PropDesc->PropTypeSet.Set   = KSPROPTYPESETID_General;
        PropDesc->PropTypeSet.Id    = VT_BOOL;
        PropDesc->PropTypeSet.Flags = 0;
        PropDesc->MembersListCount  = 1;
        PropDesc->Reserved          = 0;

        if (PropertyRequest->ValueSize >= cbFullProperty)
        {
            PKSPROPERTY_MEMBERSHEADER Members =
                (PKSPROPERTY_MEMBERSHEADER)(PropDesc + 1);

            Members->MembersFlags   = KSPROPERTY_MEMBER_STEPPEDRANGES;
            Members->MembersSize    = sizeof(KSPROPERTY_STEPPING_LONG);
            Members->MembersCount   = MaxChannels;
            Members->Flags          = KSPROPERTY_MEMBER_FLAG_BASICSUPPORT_MULTICHANNEL;

            PKSPROPERTY_STEPPING_LONG Range =
                (PKSPROPERTY_STEPPING_LONG)(Members + 1);

            for (ULONG i = 0; i < MaxChannels; ++i)
            {
                Range[i].Bounds.SignedMaximum = 1;
                Range[i].Bounds.SignedMinimum = 0;
                Range[i].SteppingDelta        = 1;
                Range[i].Reserved             = 0;
            }

            PropertyRequest->ValueSize = cbFullProperty;
        }
        else
        {
            PropertyRequest->ValueSize = sizeof(KSPROPERTY_DESCRIPTION);
        }
    }
    else if (PropertyRequest->ValueSize >= sizeof(ULONG))
    {
        *(PULONG)(PropertyRequest->Value) = KSPROPERTY_TYPE_ALL;
        PropertyRequest->ValueSize = sizeof(ULONG);
    }
    else
    {
        PropertyRequest->ValueSize = 0;
        ntStatus = STATUS_BUFFER_TOO_SMALL;
    }

    return ntStatus;
}

//==========================================================================
// CMiniportWaveRTStream - virtual WaveRT stream.
//
// Position is derived from the system performance counter so the audio
// engine sees a monotonically advancing stream (a virtual device has no
// real hardware, but the engine still needs a moving position).
//==========================================================================
class CMiniportWaveRTStream : public IMiniportWaveRTStream
{
public:
    CMiniportWaveRTStream();
    ~CMiniportWaveRTStream();

    // IUnknown
    STDMETHODIMP_(NTSTATUS) QueryInterface(REFIID, PVOID*);
    STDMETHODIMP_(ULONG) AddRef();
    STDMETHODIMP_(ULONG) Release();

    // IMiniportWaveRTStream
    STDMETHODIMP_(NTSTATUS) SetFormat(PKSDATAFORMAT DataFormat);
    STDMETHODIMP_(NTSTATUS) SetState(KSSTATE State);
    STDMETHODIMP_(NTSTATUS) GetPosition(PKSAUDIO_POSITION Position);
    STDMETHODIMP_(NTSTATUS) AllocateAudioBuffer(
        ULONG RequestedSize, PMDL* AudioBufferMdl, ULONG* ActualSize,
        ULONG* OffsetFromFirstPage, MEMORY_CACHING_TYPE* CacheType);
    STDMETHODIMP_(VOID) FreeAudioBuffer(PMDL AudioBufferMdl, ULONG BufferSize);
    STDMETHODIMP_(VOID) GetHWLatency(KSRTAUDIO_HWLATENCY* hwLatency);
    STDMETHODIMP_(NTSTATUS) GetPositionRegister(KSRTAUDIO_HWREGISTER* Register);
    STDMETHODIMP_(NTSTATUS) GetClockRegister(KSRTAUDIO_HWREGISTER* Register);

    NTSTATUS Init(PUNKNOWN PortStream);

public:
    LONG               Ref;
    PUNKNOWN           pPortStream;
    KSPIN_LOCK         PositionLock;
    KSSTATE            State;
    ULONG              BufferSize;
    ULONG              ByteRate;
    LARGE_INTEGER      StartQpc;
};

CMiniportWaveRTStream::CMiniportWaveRTStream()
    : Ref(1),
      pPortStream(NULL),
      State(KSSTATE_STOP),
      BufferSize(0),
      ByteRate(0)
{
    StartQpc.QuadPart = 0;
    KeInitializeSpinLock(&PositionLock);
}

CMiniportWaveRTStream::~CMiniportWaveRTStream()
{
    if (pPortStream)
    {
        ((IUnknown*)pPortStream)->Release();
        pPortStream = NULL;
    }
}

NTSTATUS CMiniportWaveRTStream::QueryInterface(REFIID iid, PVOID* ppv)
{
    if (!ppv) return STATUS_INVALID_PARAMETER;
    if (IsEqualGUIDAligned(iid, IID_IUnknown) ||
        IsEqualGUIDAligned(iid, IID_IMiniportWaveRTStream))
        *ppv = (IMiniportWaveRTStream*)this;
    else
    {
        *ppv = NULL;
        return STATUS_INVALID_PARAMETER;
    }
    ((IUnknown*)*ppv)->AddRef();
    return STATUS_SUCCESS;
}

ULONG CMiniportWaveRTStream::AddRef()
{
    return InterlockedIncrement(&Ref);
}

ULONG CMiniportWaveRTStream::Release()
{
    LONG r = InterlockedDecrement(&Ref);
    if (!r)
    {
        this->~CMiniportWaveRTStream();
        ExFreePoolWithTag(this, POOL_TAG);
    }
    return r;
}

NTSTATUS CMiniportWaveRTStream::Init(PUNKNOWN PortStream)
{
    pPortStream = PortStream;
    if (pPortStream) ((IUnknown*)pPortStream)->AddRef();
    return STATUS_SUCCESS;
}

#pragma code_seg("PAGE")
static BOOLEAN
IsPcmFormatSupported(_In_ PKSDATAFORMAT pKsFormat)
{
    PAGED_CODE();

    if (!pKsFormat) return FALSE;
    if (!IsEqualGUIDAligned(pKsFormat->MajorFormat, KSDATAFORMAT_TYPE_AUDIO)) return FALSE;
    if (!IsEqualGUIDAligned(pKsFormat->SubFormat, KSDATAFORMAT_SUBTYPE_PCM)) return FALSE;
    if (!IsEqualGUIDAligned(pKsFormat->Specifier, KSDATAFORMAT_SPECIFIER_WAVEFORMATEX)) return FALSE;

    PWAVEFORMATEX pWfx = NULL;

    if (pKsFormat->FormatSize == sizeof(KSDATAFORMAT_WAVEFORMATEX))
    {
        pWfx = &((PKSDATAFORMAT_WAVEFORMATEX)pKsFormat)->WaveFormatEx;
        if (pWfx->wFormatTag != WAVE_FORMAT_PCM) return FALSE;
    }
    else if (pKsFormat->FormatSize >= sizeof(KSDATAFORMAT_WAVEFORMATEXTENSIBLE))
    {
        PKSDATAFORMAT_WAVEFORMATEXTENSIBLE pWf =
            (PKSDATAFORMAT_WAVEFORMATEXTENSIBLE)pKsFormat;
        pWfx = &pWf->WaveFormatExt.Format;
        if (pWfx->wFormatTag != WAVE_FORMAT_EXTENSIBLE) return FALSE;
        if (pWf->WaveFormatExt.Samples.wValidBitsPerSample != pWfx->wBitsPerSample) return FALSE;
        if (pWf->WaveFormatExt.dwChannelMask != KSAUDIO_SPEAKER_STEREO) return FALSE;
        if (!IsEqualGUIDAligned(pWf->WaveFormatExt.SubFormat, KSDATAFORMAT_SUBTYPE_PCM)) return FALSE;
    }
    else
    {
        return FALSE;
    }

    return (pWfx->nChannels == DEVICE_MAX_CHANNELS &&
            pWfx->nSamplesPerSec == HOST_MAX_SAMPLE_RATE &&
            pWfx->wBitsPerSample == HOST_MAX_BITS_PER_SAMPLE);
}

#pragma code_seg("PAGE")
NTSTATUS CMiniportWaveRTStream::SetFormat(PKSDATAFORMAT DataFormat)
{
    PAGED_CODE();
    if (!IsPcmFormatSupported(DataFormat)) return STATUS_INVALID_PARAMETER;

    PWAVEFORMATEX pWfx;
    if (DataFormat->FormatSize == sizeof(KSDATAFORMAT_WAVEFORMATEX))
        pWfx = &((PKSDATAFORMAT_WAVEFORMATEX)DataFormat)->WaveFormatEx;
    else
        pWfx = &((PKSDATAFORMAT_WAVEFORMATEXTENSIBLE)DataFormat)->WaveFormatExt.Format;

    KIRQL oldIrql;
    KeAcquireSpinLock(&PositionLock, &oldIrql);
    ByteRate = pWfx->nAvgBytesPerSec;
    BufferSize = 0;
    KeReleaseSpinLock(&PositionLock, oldIrql);
    return STATUS_SUCCESS;
}

NTSTATUS CMiniportWaveRTStream::SetState(KSSTATE State_)
{
    if (State_ < KSSTATE_STOP || State_ > KSSTATE_RUN) return STATUS_INVALID_PARAMETER;

    KIRQL oldIrql;
    KeAcquireSpinLock(&PositionLock, &oldIrql);

    if (State_ == KSSTATE_RUN)
    {
        LARGE_INTEGER freq;
        KeQueryPerformanceCounter(&freq);
        StartQpc = KeQueryPerformanceCounter(NULL);
    }
    else if (State_ == KSSTATE_STOP)
    {
        StartQpc.QuadPart = 0;
    }

    State = State_;
    KeReleaseSpinLock(&PositionLock, oldIrql);
    return STATUS_SUCCESS;
}

NTSTATUS CMiniportWaveRTStream::GetPosition(PKSAUDIO_POSITION Position)
{
    if (!Position) return STATUS_INVALID_PARAMETER;

    ULONGLONG ullPos = 0;

    KIRQL oldIrql;
    KeAcquireSpinLock(&PositionLock, &oldIrql);

    if (State == KSSTATE_RUN && BufferSize > 0 && ByteRate > 0)
    {
        LARGE_INTEGER freq;
        LARGE_INTEGER now = KeQueryPerformanceCounter(&freq);

        ULONGLONG elapsed100ns =
            (ULONGLONG)(now.QuadPart - StartQpc.QuadPart) * 10000000ULL /
            (ULONGLONG)freq.QuadPart;

        ULONGLONG bytes = elapsed100ns * (ULONGLONG)ByteRate / 10000000ULL;
        ullPos = bytes % (ULONGLONG)BufferSize;
    }

    Position->PlayOffset = (ULONG)ullPos;
    Position->WriteOffset = (ULONG)ullPos;

    KeReleaseSpinLock(&PositionLock, oldIrql);
    return STATUS_SUCCESS;
}

#pragma code_seg("PAGE")
NTSTATUS CMiniportWaveRTStream::AllocateAudioBuffer(
    ULONG RequestedSize,
    PMDL* AudioBufferMdl,
    ULONG* ActualSize,
    ULONG* OffsetFromFirstPage,
    MEMORY_CACHING_TYPE* CacheType)
{
    PAGED_CODE();

    if (!AudioBufferMdl || !ActualSize || !OffsetFromFirstPage || !CacheType)
        return STATUS_INVALID_PARAMETER;

    if (RequestedSize == 0) return STATUS_UNSUCCESSFUL;

    PHYSICAL_ADDRESS highAddress;
    highAddress.HighPart = 0;
    highAddress.LowPart = MAXULONG;

    PMDL pMdl = ((PPORTWAVERTSTREAM)pPortStream)->AllocatePagesForMdl(highAddress, RequestedSize);
    if (!pMdl) return STATUS_UNSUCCESSFUL;

    ULONG size = (ULONG)MmGetMdlByteCount(pMdl);

    *AudioBufferMdl = pMdl;
    *ActualSize = size;
    *OffsetFromFirstPage = 0;
    *CacheType = MmCached;

    KIRQL oldIrql;
    KeAcquireSpinLock(&PositionLock, &oldIrql);
    BufferSize = size;
    KeReleaseSpinLock(&PositionLock, oldIrql);
    return STATUS_SUCCESS;
}

#pragma code_seg("PAGE")
VOID CMiniportWaveRTStream::FreeAudioBuffer(PMDL AudioBufferMdl, ULONG BufferSize_)
{
    PAGED_CODE();
    UNREFERENCED_PARAMETER(BufferSize_);

    if (pPortStream && AudioBufferMdl)
        ((PPORTWAVERTSTREAM)pPortStream)->FreePagesFromMdl(AudioBufferMdl);

    KIRQL oldIrql;
    KeAcquireSpinLock(&PositionLock, &oldIrql);
    BufferSize = 0;
    KeReleaseSpinLock(&PositionLock, oldIrql);
}

#pragma code_seg("PAGE")
VOID CMiniportWaveRTStream::GetHWLatency(KSRTAUDIO_HWLATENCY* hwLatency)
{
    PAGED_CODE();
    if (hwLatency)
    {
        hwLatency->FifoSize = 0;
        hwLatency->ChipsetDelay = 0;
        hwLatency->CodecDelay = 0;
    }
}

#pragma code_seg("PAGE")
NTSTATUS CMiniportWaveRTStream::GetPositionRegister(KSRTAUDIO_HWREGISTER* Register)
{
    PAGED_CODE();
    UNREFERENCED_PARAMETER(Register);
    return STATUS_NOT_IMPLEMENTED;
}

#pragma code_seg("PAGE")
NTSTATUS CMiniportWaveRTStream::GetClockRegister(KSRTAUDIO_HWREGISTER* Register)
{
    PAGED_CODE();
    UNREFERENCED_PARAMETER(Register);
    return STATUS_NOT_IMPLEMENTED;
}

//==========================================================================
// CMiniportWaveRT
//==========================================================================
class CMiniportWaveRT : public IMiniportWaveRT
{
public:
    CMiniportWaveRT() : Ref(1), Port(NULL) {}
    ~CMiniportWaveRT() { if (Port) Port->Release(); }

    // IUnknown
    STDMETHODIMP_(NTSTATUS) QueryInterface(REFIID, PVOID*);
    STDMETHODIMP_(ULONG) AddRef();
    STDMETHODIMP_(ULONG) Release();

    // IMiniportWaveRT / IMiniport
    STDMETHODIMP_(NTSTATUS) DataRangeIntersection(
        ULONG, PKSDATARANGE, PKSDATARANGE, ULONG, PVOID, PULONG);
    STDMETHODIMP_(NTSTATUS) Init(PUNKNOWN, PRESOURCELIST, PPORTWAVERT);
    STDMETHODIMP_(NTSTATUS) NewStream(
        PMINIPORTWAVERTSTREAM*, PPORTWAVERTSTREAM, ULONG, BOOLEAN, PKSDATAFORMAT);
    STDMETHODIMP_(NTSTATUS) GetDeviceDescription(PDEVICE_DESCRIPTION);
    STDMETHODIMP_(NTSTATUS) GetDescription(PPCFILTER_DESCRIPTOR*);

    NTSTATUS HandlerProposedFormat(PPCPROPERTY_REQUEST);

public:
    LONG       Ref;
    PPORTWAVERT Port;
    BOOLEAN    StreamActive;
};

NTSTATUS CMiniportWaveRT::QueryInterface(REFIID iid, PVOID* ppv)
{
    if (!ppv) return STATUS_INVALID_PARAMETER;
    if (IsEqualGUIDAligned(iid, IID_IUnknown) ||
        IsEqualGUIDAligned(iid, IID_IMiniport) ||
        IsEqualGUIDAligned(iid, IID_IMiniportWaveRT))
        *ppv = (IMiniportWaveRT*)this;
    else
    {
        *ppv = NULL;
        return STATUS_INVALID_PARAMETER;
    }
    ((IUnknown*)*ppv)->AddRef();
    return STATUS_SUCCESS;
}

ULONG CMiniportWaveRT::AddRef() { return InterlockedIncrement(&Ref); }

ULONG CMiniportWaveRT::Release()
{
    LONG r = InterlockedDecrement(&Ref);
    if (!r)
    {
        this->~CMiniportWaveRT();
        ExFreePoolWithTag(this, POOL_TAG);
    }
    return r;
}

#pragma code_seg("PAGE")
NTSTATUS CMiniportWaveRT::DataRangeIntersection(
    ULONG PinId,
    PKSDATARANGE ClientDataRange,
    PKSDATARANGE MyDataRange,
    ULONG OutputBufferLength,
    PVOID ResultantFormat,
    PULONG ResultantFormatLength)
{
    PAGED_CODE();

    if (!ClientDataRange || !MyDataRange || !ResultantFormatLength)
        return STATUS_INVALID_PARAMETER;

    // Only the streaming pin produces PCM; the bridge pin is analog and
    // handled by the default class handler.
    if (PinId != KSPIN_WAVE_RENDER3_SINK_SYSTEM)
        return STATUS_NOT_IMPLEMENTED;

    if (!IsEqualGUIDAligned(ClientDataRange->Specifier, KSDATAFORMAT_SPECIFIER_WAVEFORMATEX))
        return STATUS_NOT_IMPLEMENTED;

    ULONG requiredSize = sizeof(KSDATAFORMAT_WAVEFORMATEXTENSIBLE);

    if (!OutputBufferLength)
    {
        *ResultantFormatLength = requiredSize;
        return STATUS_BUFFER_OVERFLOW;
    }
    if (OutputBufferLength < requiredSize)
    {
        *ResultantFormatLength = requiredSize;
        return STATUS_BUFFER_TOO_SMALL;
    }

    if (((PKSDATARANGE_AUDIO)MyDataRange)->MaximumChannels !=
        ((PKSDATARANGE_AUDIO)ClientDataRange)->MaximumChannels)
    {
        return STATUS_NO_MATCH;
    }

    *(PKSDATAFORMAT_WAVEFORMATEXTENSIBLE)ResultantFormat =
        SpeakerHostPinSupportedDeviceFormats[0];
    *ResultantFormatLength = requiredSize;

    return STATUS_SUCCESS;
}

#pragma code_seg("PAGE")
NTSTATUS CMiniportWaveRT::Init(PUNKNOWN UnknownAdapter, PRESOURCELIST ResourceList, PPORTWAVERT Port_)
{
    UNREFERENCED_PARAMETER(UnknownAdapter);
    UNREFERENCED_PARAMETER(ResourceList);
    PAGED_CODE();

    Port = Port_;
    if (Port) Port->AddRef();
    return STATUS_SUCCESS;
}

#pragma code_seg("PAGE")
NTSTATUS CMiniportWaveRT::NewStream(
    PMINIPORTWAVERTSTREAM* Stream,
    PPORTWAVERTSTREAM PortStream,
    ULONG Pin,
    BOOLEAN Capture,
    PKSDATAFORMAT DataFormat)
{
    PAGED_CODE();

    if (!Stream || !PortStream) return STATUS_INVALID_PARAMETER;
    *Stream = NULL;

    // Render-only: only the system sink pin can stream.
    if (Pin != KSPIN_WAVE_RENDER3_SINK_SYSTEM || Capture)
        return STATUS_INVALID_PARAMETER;

    if (!IsPcmFormatSupported(DataFormat))
        return STATUS_INVALID_PARAMETER;

    CMiniportWaveRTStream* pStream =
        (CMiniportWaveRTStream*)ExAllocatePoolWithTag(
            NonPagedPoolNx, sizeof(CMiniportWaveRTStream), POOL_TAG);
    if (!pStream) return STATUS_INSUFFICIENT_RESOURCES;

    pStream->CMiniportWaveRTStream::CMiniportWaveRTStream();

    NTSTATUS ntStatus = pStream->Init((PUNKNOWN)PortStream);
    if (NT_SUCCESS(ntStatus)) ntStatus = pStream->SetFormat(DataFormat);

    if (!NT_SUCCESS(ntStatus))
    {
        pStream->~CMiniportWaveRTStream();
        ExFreePoolWithTag(pStream, POOL_TAG);
        return ntStatus;
    }

    ntStatus = pStream->QueryInterface(IID_IMiniportWaveRTStream, (PVOID*)Stream);
    pStream->Release();
    return ntStatus;
}

#pragma code_seg("PAGE")
NTSTATUS CMiniportWaveRT::GetDeviceDescription(PDEVICE_DESCRIPTION DeviceDescription)
{
    PAGED_CODE();
    if (!DeviceDescription) return STATUS_INVALID_PARAMETER;
    RtlZeroMemory(DeviceDescription, sizeof(*DeviceDescription));
    DeviceDescription->Version = DEVICE_DESCRIPTION_VERSION;
    DeviceDescription->Master = TRUE;
    DeviceDescription->ScatterGather = TRUE;
    DeviceDescription->DmaWidth = Width32Bits;
    DeviceDescription->DmaSpeed = Compatible;
    DeviceDescription->Dma32BitAddresses = TRUE;
    return STATUS_SUCCESS;
}

#pragma code_seg("PAGE")
NTSTATUS CMiniportWaveRT::GetDescription(PPCFILTER_DESCRIPTOR* Description)
{
    PAGED_CODE();
    if (!Description) return STATUS_INVALID_PARAMETER;
    *Description = (PPCFILTER_DESCRIPTOR)&SpeakerWaveMiniportFilterDescriptor;
    return STATUS_SUCCESS;
}

#pragma code_seg("PAGE")
NTSTATUS CMiniportWaveRT::HandlerProposedFormat(PPCPROPERTY_REQUEST PropertyRequest)
{
    PAGED_CODE();

    if (PropertyRequest->InstanceSize < FIELD_OFFSET(KSP_PIN, PinId))
        return STATUS_INVALID_PARAMETER;

    PKSP_PIN kspPin = CONTAINING_RECORD(PropertyRequest->Instance, KSP_PIN, PinId);

    if (kspPin->PinId == KSPIN_WAVE_RENDER3_SOURCE)
        return STATUS_NOT_SUPPORTED;
    if (kspPin->PinId != KSPIN_WAVE_RENDER3_SINK_SYSTEM)
        return STATUS_INVALID_PARAMETER;

    if (PropertyRequest->Verb & KSPROPERTY_TYPE_BASICSUPPORT)
    {
        return PropertyHandler_BasicSupport(
            PropertyRequest,
            PropertyRequest->PropertyItem->Flags,
            VT_ILLEGAL);
    }

    ULONG cbMinSize = sizeof(KSDATAFORMAT_WAVEFORMATEXTENSIBLE);

    if (PropertyRequest->ValueSize == 0)
    {
        PropertyRequest->ValueSize = cbMinSize;
        return STATUS_BUFFER_OVERFLOW;
    }
    if (PropertyRequest->ValueSize < cbMinSize)
    {
        return STATUS_BUFFER_TOO_SMALL;
    }

    if (PropertyRequest->Verb & KSPROPERTY_TYPE_GET)
    {
        return STATUS_INVALID_DEVICE_REQUEST;
    }
    else if (PropertyRequest->Verb & KSPROPERTY_TYPE_SET)
    {
        if (!IsPcmFormatSupported((PKSDATAFORMAT)PropertyRequest->Value))
            return STATUS_NO_MATCH;
        return STATUS_SUCCESS;
    }

    return STATUS_INVALID_DEVICE_REQUEST;
}

#pragma code_seg("PAGE")
NTSTATUS PropertyHandler_WaveFilter(PPCPROPERTY_REQUEST PropertyRequest)
{
    PAGED_CODE();

    if (!PropertyRequest || !PropertyRequest->MajorTarget)
        return STATUS_INVALID_PARAMETER;

    CMiniportWaveRT* pMiniport = (CMiniportWaveRT*)PropertyRequest->MajorTarget;

    if (IsEqualGUIDAligned(*PropertyRequest->PropertyItem->Set, KSPROPSETID_Pin))
    {
        if (PropertyRequest->PropertyItem->Id == KSPROPERTY_PIN_PROPOSEDATAFORMAT)
            return pMiniport->HandlerProposedFormat(PropertyRequest);
    }

    return STATUS_INVALID_DEVICE_REQUEST;
}

//==========================================================================
// CMiniportTopology
//==========================================================================
class CMiniportTopology : public IMiniportTopology
{
public:
    CMiniportTopology();
    ~CMiniportTopology() {}

    // IUnknown
    STDMETHODIMP_(NTSTATUS) QueryInterface(REFIID, PVOID*);
    STDMETHODIMP_(ULONG) AddRef();
    STDMETHODIMP_(ULONG) Release();

    // IMiniportTopology / IMiniport
    STDMETHODIMP_(NTSTATUS) DataRangeIntersection(
        ULONG, PKSDATARANGE, PKSDATARANGE, ULONG, PVOID, PULONG);
    STDMETHODIMP_(NTSTATUS) Init(PUNKNOWN, PRESOURCELIST, PPORTTOPOLOGY);
    STDMETHODIMP_(NTSTATUS) GetDescription(PPCFILTER_DESCRIPTOR*);

    NTSTATUS GetProperty(PPCPROPERTY_REQUEST);

public:
    LONG         Ref;
    KSPIN_LOCK   StateLock;
    LONG         Volume[DEVICE_MAX_CHANNELS];
    BOOLEAN      Mute[DEVICE_MAX_CHANNELS];
};

CMiniportTopology::CMiniportTopology() : Ref(1)
{
    for (ULONG i = 0; i < DEVICE_MAX_CHANNELS; ++i)
    {
        Volume[i] = 0;     // 0 dB
        Mute[i] = FALSE;
    }
    KeInitializeSpinLock(&StateLock);
}

NTSTATUS CMiniportTopology::QueryInterface(REFIID iid, PVOID* ppv)
{
    if (!ppv) return STATUS_INVALID_PARAMETER;
    if (IsEqualGUIDAligned(iid, IID_IUnknown) ||
        IsEqualGUIDAligned(iid, IID_IMiniport) ||
        IsEqualGUIDAligned(iid, IID_IMiniportTopology))
        *ppv = (IMiniportTopology*)this;
    else
    {
        *ppv = NULL;
        return STATUS_INVALID_PARAMETER;
    }
    ((IUnknown*)*ppv)->AddRef();
    return STATUS_SUCCESS;
}

ULONG CMiniportTopology::AddRef() { return InterlockedIncrement(&Ref); }

ULONG CMiniportTopology::Release()
{
    LONG r = InterlockedDecrement(&Ref);
    if (!r)
    {
        this->~CMiniportTopology();
        ExFreePoolWithTag(this, POOL_TAG);
    }
    return r;
}

NTSTATUS CMiniportTopology::DataRangeIntersection(
    ULONG, PKSDATARANGE, PKSDATARANGE, ULONG, PVOID, PULONG)
{
    return STATUS_NOT_IMPLEMENTED;
}

NTSTATUS CMiniportTopology::Init(PUNKNOWN UnknownAdapter, PRESOURCELIST ResourceList, PPORTTOPOLOGY Port)
{
    UNREFERENCED_PARAMETER(UnknownAdapter);
    UNREFERENCED_PARAMETER(ResourceList);
    UNREFERENCED_PARAMETER(Port);
    return STATUS_SUCCESS;
}

NTSTATUS CMiniportTopology::GetDescription(PPCFILTER_DESCRIPTOR* Description)
{
    if (!Description) return STATUS_INVALID_PARAMETER;
    *Description = (PPCFILTER_DESCRIPTOR)&TopoMiniportFilterDescriptor;
    return STATUS_SUCCESS;
}

#pragma code_seg("PAGE")
NTSTATUS
PropertyHandler_Volume(
    CMiniportTopology* pMiniport,
    PPCPROPERTY_REQUEST PropertyRequest)
{
    PAGED_CODE();

    if (PropertyRequest->Verb & KSPROPERTY_TYPE_BASICSUPPORT)
        return PropertyHandler_BasicSupportVolume(PropertyRequest, DEVICE_MAX_CHANNELS);

    NTSTATUS ntStatus = ValidatePropertyParams(PropertyRequest, sizeof(LONG), sizeof(ULONG));
    if (!NT_SUCCESS(ntStatus)) return ntStatus;

    ULONG ulChannel = *(PULONG)(PropertyRequest->Instance);
    PLONG plVolume  = (PLONG)(PropertyRequest->Value);

    if (ulChannel >= DEVICE_MAX_CHANNELS && ulChannel != ALL_CHANNELS_ID)
        return STATUS_INVALID_PARAMETER;

    KIRQL oldIrql;
    KeAcquireSpinLock(&pMiniport->StateLock, &oldIrql);

    if (PropertyRequest->Verb & KSPROPERTY_TYPE_GET)
    {
        *plVolume = pMiniport->Volume[ulChannel == ALL_CHANNELS_ID ? 0 : ulChannel];
        PropertyRequest->ValueSize = sizeof(LONG);
        KeReleaseSpinLock(&pMiniport->StateLock, oldIrql);
        return STATUS_SUCCESS;
    }
    else if (PropertyRequest->Verb & KSPROPERTY_TYPE_SET)
    {
        if (ulChannel == ALL_CHANNELS_ID)
        {
            for (ULONG i = 0; i < DEVICE_MAX_CHANNELS; ++i)
                pMiniport->Volume[i] = *plVolume;
        }
        else
        {
            pMiniport->Volume[ulChannel] = *plVolume;
        }
        KeReleaseSpinLock(&pMiniport->StateLock, oldIrql);
        return STATUS_SUCCESS;
    }

    KeReleaseSpinLock(&pMiniport->StateLock, oldIrql);
    return STATUS_INVALID_DEVICE_REQUEST;
}

#pragma code_seg("PAGE")
NTSTATUS
PropertyHandler_Mute(
    CMiniportTopology* pMiniport,
    PPCPROPERTY_REQUEST PropertyRequest)
{
    PAGED_CODE();

    if (PropertyRequest->Verb & KSPROPERTY_TYPE_BASICSUPPORT)
        return PropertyHandler_BasicSupportMute(PropertyRequest, DEVICE_MAX_CHANNELS);

    NTSTATUS ntStatus = ValidatePropertyParams(PropertyRequest, sizeof(BOOL), sizeof(ULONG));
    if (!NT_SUCCESS(ntStatus)) return ntStatus;

    ULONG ulChannel = *(PULONG)(PropertyRequest->Instance);
    PBOOL pfMute    = (PBOOL)(PropertyRequest->Value);

    if (ulChannel >= DEVICE_MAX_CHANNELS && ulChannel != ALL_CHANNELS_ID)
        return STATUS_INVALID_PARAMETER;

    KIRQL oldIrql;
    KeAcquireSpinLock(&pMiniport->StateLock, &oldIrql);

    if (PropertyRequest->Verb & KSPROPERTY_TYPE_GET)
    {
        *pfMute = pMiniport->Mute[ulChannel == ALL_CHANNELS_ID ? 0 : ulChannel];
        PropertyRequest->ValueSize = sizeof(BOOL);
        KeReleaseSpinLock(&pMiniport->StateLock, oldIrql);
        return STATUS_SUCCESS;
    }
    else if (PropertyRequest->Verb & KSPROPERTY_TYPE_SET)
    {
        BOOLEAN bMute = (*pfMute) ? TRUE : FALSE;
        if (ulChannel == ALL_CHANNELS_ID)
        {
            for (ULONG i = 0; i < DEVICE_MAX_CHANNELS; ++i)
                pMiniport->Mute[i] = bMute;
        }
        else
        {
            pMiniport->Mute[ulChannel] = bMute;
        }
        KeReleaseSpinLock(&pMiniport->StateLock, oldIrql);
        return STATUS_SUCCESS;
    }

    KeReleaseSpinLock(&pMiniport->StateLock, oldIrql);
    return STATUS_INVALID_DEVICE_REQUEST;
}

#pragma code_seg("PAGE")
NTSTATUS
CMiniportTopology::GetProperty(PPCPROPERTY_REQUEST PropertyRequest)
{
    PAGED_CODE();

    switch (PropertyRequest->PropertyItem->Id)
    {
    case KSPROPERTY_AUDIO_VOLUMELEVEL:
        return PropertyHandler_Volume(this, PropertyRequest);

    case KSPROPERTY_AUDIO_MUTE:
        return PropertyHandler_Mute(this, PropertyRequest);

    default:
        return STATUS_INVALID_DEVICE_REQUEST;
    }
}

#pragma code_seg("PAGE")
NTSTATUS
PropertyHandler_Topology(PPCPROPERTY_REQUEST PropertyRequest)
{
    PAGED_CODE();

    if (!PropertyRequest || !PropertyRequest->MajorTarget)
        return STATUS_INVALID_PARAMETER;

    CMiniportTopology* pMiniport = (CMiniportTopology*)PropertyRequest->MajorTarget;
    return pMiniport->GetProperty(PropertyRequest);
}

//==========================================================================
// Adapter: driver entry, add device, start device
//==========================================================================

#define MAX_SUBDEVICES 2

// Our private device extension. PcAddAdapterDevice appends PortCls's own
// adapter data after this block, so DeviceObject->DeviceExtension points
// at our fields and zeroing them is safe.
typedef struct _DEVICE_EXTENSION
{
    PPORTWAVERT       pWavePort;
    CMiniportWaveRT*  pWaveMiniport;
    PPORTTOPOLOGY     pTopoPort;
    CMiniportTopology*pTopoMiniport;
} DEVICE_EXTENSION, *PDEVICE_EXTENSION;

#pragma code_seg("PAGE")
NTSTATUS
StartDevice(
    _In_ PDEVICE_OBJECT  DeviceObject,
    _In_ PIRP            Irp,
    _In_ PRESOURCELIST   ResourceList)
{
    PAGED_CODE();

    DiagLog(L"SD_enter", 1);

    PDEVICE_EXTENSION pDevExt = (PDEVICE_EXTENSION)DeviceObject->DeviceExtension;
    RtlZeroMemory(pDevExt, sizeof(DEVICE_EXTENSION));

    NTSTATUS ntStatus = STATUS_SUCCESS;

    DbgPrint("[NexusVAIO] StartDevice begin\n");

    //
    // WaveRT subdevice.
    //
    pDevExt->pWaveMiniport = (CMiniportWaveRT*)ExAllocatePoolWithTag(
        NonPagedPoolNx, sizeof(CMiniportWaveRT), POOL_TAG);
    if (!pDevExt->pWaveMiniport)
    {
        DbgPrint("[NexusVAIO] WaveRT alloc failed\n");
        ntStatus = STATUS_INSUFFICIENT_RESOURCES;
        goto exit;
    }
    pDevExt->pWaveMiniport->CMiniportWaveRT::CMiniportWaveRT();
    DiagLog(L"SD_1_alloc", 1);

    DbgPrint("[NexusVAIO] PcNewPort(WaveRT)...\n");
    ntStatus = PcNewPort((PPORT*)&pDevExt->pWavePort, CLSID_PortWaveRT);
    if (!NT_SUCCESS(ntStatus))
    {
        DbgPrint("[NexusVAIO] PcNewPort(WaveRT) failed: 0x%x\n", ntStatus);
        goto exit;
    }
    DiagLog(L"SD_2_newport", (ULONG)ntStatus);

    DbgPrint("[NexusVAIO] WavePort->Init...\n");
    ntStatus = pDevExt->pWavePort->Init(
        DeviceObject, Irp, (PUNKNOWN)pDevExt->pWaveMiniport, NULL, ResourceList);
    if (!NT_SUCCESS(ntStatus))
    {
        DbgPrint("[NexusVAIO] WavePort->Init failed: 0x%x\n", ntStatus);
        goto exit;
    }
    DiagLog(L"SD_3_portinit", (ULONG)ntStatus);

    DbgPrint("[NexusVAIO] WaveMiniport->Init...\n");
    ntStatus = pDevExt->pWaveMiniport->Init(NULL, ResourceList, pDevExt->pWavePort);
    if (!NT_SUCCESS(ntStatus))
    {
        DbgPrint("[NexusVAIO] WaveMiniport->Init failed: 0x%x\n", ntStatus);
        goto exit;
    }
    DiagLog(L"SD_4_miniinit", (ULONG)ntStatus);

    DbgPrint("[NexusVAIO] RegisterSubdevice WaveSpeaker...\n");
    ntStatus = PcRegisterSubdevice(DeviceObject, (PWSTR)L"WaveSpeaker", (PUNKNOWN)pDevExt->pWavePort);
    if (!NT_SUCCESS(ntStatus))
    {
        DbgPrint("[NexusVAIO] PcRegisterSubdevice(WaveSpeaker) failed: 0x%x\n", ntStatus);
        goto exit;
    }
    DiagLog(L"SD_5_reg", (ULONG)ntStatus);

    //
    // Topology subdevice — DISABLED for testing.
    //
#if 0
    DbgPrint("[NexusVAIO] Allocating Topology miniport...\n");
    pDevExt->pTopoMiniport = (CMiniportTopology*)ExAllocatePoolWithTag(
        NonPagedPoolNx, sizeof(CMiniportTopology), POOL_TAG);
    if (!pDevExt->pTopoMiniport)
    {
        DbgPrint("[NexusVAIO] Topo alloc failed\n");
        ntStatus = STATUS_INSUFFICIENT_RESOURCES;
        goto exit;
    }
    pDevExt->pTopoMiniport->CMiniportTopology::CMiniportTopology();

    DbgPrint("[NexusVAIO] PcNewPort(Topo)...\n");
    ntStatus = PcNewPort((PPORT*)&pDevExt->pTopoPort, CLSID_PortTopology);
    if (!NT_SUCCESS(ntStatus))
    {
        DbgPrint("[NexusVAIO] PcNewPort(Topo) failed: 0x%x\n", ntStatus);
        goto exit;
    }

    DbgPrint("[NexusVAIO] TopoPort->Init...\n");
    ntStatus = pDevExt->pTopoPort->Init(
        DeviceObject, Irp, (PUNKNOWN)pDevExt->pTopoMiniport, NULL, ResourceList);
    if (!NT_SUCCESS(ntStatus))
    {
        DbgPrint("[NexusVAIO] TopoPort->Init failed: 0x%x\n", ntStatus);
        goto exit;
    }

    DbgPrint("[NexusVAIO] TopoMiniport->Init...\n");
    ntStatus = pDevExt->pTopoMiniport->Init(NULL, ResourceList, pDevExt->pTopoPort);
    if (!NT_SUCCESS(ntStatus))
    {
        DbgPrint("[NexusVAIO] TopoMiniport->Init failed: 0x%x\n", ntStatus);
        goto exit;
    }

    DbgPrint("[NexusVAIO] RegisterSubdevice TopologySpeaker...\n");
    ntStatus = PcRegisterSubdevice(DeviceObject, (PWSTR)L"TopologySpeaker", (PUNKNOWN)pDevExt->pTopoPort);
    if (!NT_SUCCESS(ntStatus))
    {
        DbgPrint("[NexusVAIO] PcRegisterSubdevice(TopologySpeaker) failed: 0x%x\n", ntStatus);
        goto exit;
    }

    //
    // Register the physical connection between the wave bridge pin and the
    // topology bridge pin (render path: wave -> topology).
    //
    DbgPrint("[NexusVAIO] RegisterPhysicalConnection...\n");
    ntStatus = PcRegisterPhysicalConnection(
        DeviceObject,
        (PUNKNOWN)pDevExt->pWavePort,  KSPIN_WAVE_RENDER3_SOURCE,
        (PUNKNOWN)pDevExt->pTopoPort,  KSPIN_TOPO_WAVEOUT_SOURCE);
    if (!NT_SUCCESS(ntStatus))
    {
        DbgPrint("[NexusVAIO] PcRegisterPhysicalConnection failed: 0x%x\n", ntStatus);
        goto exit;
    }
#endif

    DbgPrint("[NexusVAIO] StartDevice: WaveSpeaker registered OK (WaveRT only)\n");
    DiagLog(L"SD_done", 1);
    return STATUS_SUCCESS;

exit:
    DbgPrint("[NexusVAIO] StartDevice failed: 0x%x\n", ntStatus);
    DiagLog(L"SD_fail", (ULONG)ntStatus);
    if (pDevExt->pWaveMiniport) pDevExt->pWaveMiniport->Release();
    if (pDevExt->pWavePort)     pDevExt->pWavePort->Release();
    if (pDevExt->pTopoMiniport) pDevExt->pTopoMiniport->Release();
    if (pDevExt->pTopoPort)     pDevExt->pTopoPort->Release();
    RtlZeroMemory(pDevExt, sizeof(DEVICE_EXTENSION));
    return ntStatus;
}

#pragma code_seg("PAGE")
VOID
DriverUnload(_In_ PDRIVER_OBJECT DriverObject)
{
    PAGED_CODE();
    UNREFERENCED_PARAMETER(DriverObject);
    DbgPrint("[NexusVAIO] DriverUnload\n");
}

#pragma code_seg("PAGE")
extern "C" NTSTATUS
AddDevice(
    _In_ PDRIVER_OBJECT  DriverObject,
    _In_ PDEVICE_OBJECT  PhysicalDeviceObject)
{
    PAGED_CODE();

    DiagLog(L"AddDevice_enter", 1);

    NTSTATUS ntStatus = PcAddAdapterDevice(
        DriverObject,
        PhysicalDeviceObject,
        StartDevice,
        MAX_SUBDEVICES,
        sizeof(DEVICE_EXTENSION));

    DiagLog(L"AddDevice_ret", (ULONG)ntStatus);

    if (!NT_SUCCESS(ntStatus))
        DbgPrint("[NexusVAIO] PcAddAdapterDevice failed: 0x%x\n", ntStatus);

    return ntStatus;
}

extern "C" NTSTATUS
DriverEntry(
    _In_ PDRIVER_OBJECT  DriverObject,
    _In_ PUNICODE_STRING RegistryPath)
{
    DiagLog(L"DriverEntry", 1);

    DriverObject->DriverUnload = DriverUnload;

    DbgPrint("[NexusVAIO] DriverEntry (PortCls WDM adapter)\n");

    NTSTATUS ntStatus = PcInitializeAdapterDriver(DriverObject, RegistryPath, AddDevice);
    DiagLog(L"DriverEntry_ret", (ULONG)ntStatus);
    return ntStatus;
}