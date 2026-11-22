//--------------------------------------------------------------------------
// minimal_test.cpp - Minimal PortCls driver test (no subdevices)
//--------------------------------------------------------------------------

#include <wdm.h>
#include <portcls.h>

#pragma comment(lib, "portcls.lib")
#pragma comment(lib, "ks.lib")

// Suppress delete operators
void __cdecl operator delete(void*, unsigned __int64) { }
void __cdecl operator delete[](void*, unsigned __int64) { }

#pragma code_seg("PAGE")
NTSTATUS
StartDevice(
    _In_ PDEVICE_OBJECT  DeviceObject,
    _In_ PIRP            Irp,
    _In_ PRESOURCELIST   ResourceList)
{
    PAGED_CODE();
    UNREFERENCED_PARAMETER(DeviceObject);
    UNREFERENCED_PARAMETER(Irp);
    UNREFERENCED_PARAMETER(ResourceList);
    DbgPrint("[NexusVAIO_Mini] StartDevice returning STATUS_SUCCESS\n");
    return STATUS_SUCCESS;
}

#pragma code_seg("PAGE")
VOID
DriverUnload(_In_ PDRIVER_OBJECT DriverObject)
{
    PAGED_CODE();
    UNREFERENCED_PARAMETER(DriverObject);
    DbgPrint("[NexusVAIO_Mini] DriverUnload\n");
}

#pragma code_seg("PAGE")
extern "C" NTSTATUS
AddDevice(
    _In_ PDRIVER_OBJECT  DriverObject,
    _In_ PDEVICE_OBJECT  PhysicalDeviceObject)
{
    PAGED_CODE();
    NTSTATUS ntStatus = PcAddAdapterDevice(
        DriverObject,
        PhysicalDeviceObject,
        StartDevice,
        2,
        sizeof(ULONG));
    DbgPrint("[NexusVAIO_Mini] PcAddAdapterDevice: 0x%x\n", ntStatus);
    return ntStatus;
}

extern "C" NTSTATUS
DriverEntry(
    _In_ PDRIVER_OBJECT  DriverObject,
    _In_ PUNICODE_STRING RegistryPath)
{
    DriverObject->DriverUnload = DriverUnload;
    DbgPrint("[NexusVAIO_Mini] DriverEntry\n");
    return PcInitializeAdapterDriver(DriverObject, RegistryPath, AddDevice);
}