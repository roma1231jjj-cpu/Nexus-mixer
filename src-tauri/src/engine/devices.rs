//! Device enumeration.
//!
//! `cpal` gives us a portable view over WASAPI on Windows. Endpoint ids are
//! friendly names for now; the low-latency backend will move to `windows-rs`
//! and use `IMMDevice::GetId` so ids survive renames and locale changes.

use std::collections::BTreeMap;

use anyhow::Result;
use cpal::traits::{DeviceTrait, HostTrait};

use super::model::{AudioDeviceInfo, DeviceKind, EngineApi};

fn input_info(device: &cpal::Device, is_default: bool) -> Option<AudioDeviceInfo> {
    let name = device.name().ok()?;
    let config = device.default_input_config().ok();
    Some(AudioDeviceInfo {
        id: format!("in:{name}"),
        kind: kind_of(&name, false),
        name,
        api: EngineApi::WasapiShared,
        channels: config.as_ref().map(|c| c.channels()).unwrap_or(2),
        sample_rate: config.as_ref().map(|c| c.sample_rate().0).unwrap_or(48_000),
        is_default,
        online: true,
    })
}

fn output_info(device: &cpal::Device, is_default: bool) -> Option<AudioDeviceInfo> {
    let name = device.name().ok()?;
    let config = device.default_output_config().ok();
    Some(AudioDeviceInfo {
        id: format!("out:{name}"),
        kind: kind_of(&name, true),
        name,
        api: EngineApi::WasapiShared,
        channels: config.as_ref().map(|c| c.channels()).unwrap_or(2),
        sample_rate: config.as_ref().map(|c| c.sample_rate().0).unwrap_or(48_000),
        is_default,
        online: true,
    })
}

/// Virtual cables (VB-CABLE, Nexus VAIO) are regular WASAPI endpoints, but the
/// UI groups them separately so a bus can be pointed at them at a glance.
fn kind_of(name: &str, render: bool) -> DeviceKind {
    let lower = name.to_lowercase();
    let virtual_cable = lower.contains("cable")
        || lower.contains("vb-audio")
        || (lower.contains("nexus") && (lower.contains("vaio") || lower.contains("aux")));
    match (virtual_cable, render) {
        (true, true) => DeviceKind::VirtualPlayback,
        (true, false) => DeviceKind::VirtualCapture,
        (false, true) => DeviceKind::Output,
        (false, false) => DeviceKind::Input,
    }
}

/// Enumerate every input and output endpoint of the default host.
///
/// Errors from individual devices are ignored on purpose: one broken driver
/// must not hide the rest of the list.
pub fn enumerate() -> Result<Vec<AudioDeviceInfo>> {
    let host = cpal::default_host();
    let default_input = host.default_input_device().and_then(|d| d.name().ok());
    let default_output = host.default_output_device().and_then(|d| d.name().ok());

    let mut devices: BTreeMap<String, AudioDeviceInfo> = BTreeMap::new();

    if let Ok(inputs) = host.input_devices() {
        for device in inputs {
            if let Some(info) = input_info(&device, false) {
                let is_default = default_input.as_deref() == Some(info.name.as_str());
                devices.insert(info.id.clone(), AudioDeviceInfo { is_default, ..info });
            }
        }
    }

    if let Ok(outputs) = host.output_devices() {
        for device in outputs {
            if let Some(info) = output_info(&device, false) {
                let is_default = default_output.as_deref() == Some(info.name.as_str());
                devices.insert(info.id.clone(), AudioDeviceInfo { is_default, ..info });
            }
        }
    }

    let mut list: Vec<AudioDeviceInfo> = devices.into_values().collect();
    list.sort_by(|a, b| {
        b.is_default
            .cmp(&a.is_default)
            .then_with(|| format!("{:?}{}", a.kind, a.name).cmp(&format!("{:?}{}", b.kind, b.name)))
    });
    Ok(list)
}
