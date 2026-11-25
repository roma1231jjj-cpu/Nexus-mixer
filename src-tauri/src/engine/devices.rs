//! Device enumeration.
//!
//! `cpal` gives us a portable view over WASAPI on Windows, and the friendly
//! name is all it exposes, so endpoint ids are derived from that name. Two
//! microphones of the same model report the very same friendly name, and ids
//! used to collide: the second one silently replaced the first in the map and
//! the mixer opened the wrong endpoint. A repeated name now gets an `#N` suffix
//! in enumeration order, while a unique name keeps the plain
//! `in:<name>` / `out:<name>` id, so saved snapshots keep resolving.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::Result;
use cpal::traits::{DeviceTrait, HostTrait};

use super::model::{AudioDeviceInfo, DeviceKind, EngineApi};

/// Separator between a friendly name and its occurrence number.
pub const OCCURRENCE_MARK: char = '#';

/// Assigns endpoint ids to friendly names, one direction at a time.
///
/// The first endpoint with a given name keeps the bare name; every later one
/// gets `#2`, `#3`, … A device that is literally called `Line#2` would collide
/// with that scheme, so an id that is already taken pushes the suffix further
/// up instead of overwriting the neighbour.
#[derive(Default)]
struct NameIds {
    seen: BTreeMap<String, usize>,
    used: BTreeSet<String>,
}

impl NameIds {
    /// Returns the id and the 1-based occurrence of `name`.
    fn assign(&mut self, name: &str) -> (String, usize) {
        let next = self.seen.entry(name.to_string()).or_insert(0);
        let mut occurrence = (*next).max(1);
        loop {
            let id = if occurrence == 1 {
                name.to_string()
            } else {
                format!("{name}{OCCURRENCE_MARK}{occurrence}")
            };
            if self.used.insert(id.clone()) {
                *next = occurrence;
                return (id, occurrence);
            }
            occurrence += 1;
        }
    }
}

/// Splits the occurrence suffix off an id.
///
/// `"Microphone (USB)#2"` → `("Microphone (USB)", 2)`, `"Microphone (USB)"` →
/// `("Microphone (USB)", 1)`. A trailing `#1` is *not* treated as a suffix:
/// [`NameIds::assign`] never writes one, so `Mic#1` is a real device name.
pub fn parse_name_occurrence(raw: &str) -> (&str, usize) {
    if let Some((base, suffix)) = raw.rsplit_once(OCCURRENCE_MARK) {
        if !base.is_empty()
            && !suffix.is_empty()
            && suffix.bytes().all(|byte| byte.is_ascii_digit())
        {
            if let Ok(value) = suffix.parse::<usize>() {
                if value >= 2 {
                    return (base, value);
                }
            }
        }
    }
    (raw, 1)
}

fn nth_exact(names: &[String], target: &str, occurrence: usize) -> Option<usize> {
    let mut seen = 0;
    for (index, name) in names.iter().enumerate() {
        if name == target {
            seen += 1;
            if seen == occurrence {
                return Some(index);
            }
        }
    }
    None
}

fn nth_ignore_case(names: &[String], target: &str, occurrence: usize) -> Option<usize> {
    let mut seen = 0;
    for (index, name) in names.iter().enumerate() {
        if name.eq_ignore_ascii_case(target) {
            seen += 1;
            if seen == occurrence {
                return Some(index);
            }
        }
    }
    None
}

/// Index of the endpoint that `raw` (an id without the `in:`/`out:` prefix)
/// refers to, using the enumeration order of `names`.
///
/// Replaying the id assignment is the exact inverse of what [`enumerate`]
/// produced, so every id it hands out resolves back to the endpoint it came
/// from — including a device that is literally called `Line#2`. The remaining
/// steps only serve ids that no longer match the current order, plus the
/// case-insensitive lookup older snapshots relied on.
pub fn match_name(names: &[String], raw: &str) -> Option<usize> {
    let mut ids = NameIds::default();
    for (index, name) in names.iter().enumerate() {
        if ids.assign(name).0 == raw {
            return Some(index);
        }
    }
    let (base, occurrence) = parse_name_occurrence(raw);
    if let Some(index) = nth_exact(names, base, occurrence) {
        return Some(index);
    }
    nth_ignore_case(names, raw, 1).or_else(|| {
        if occurrence > 1 {
            nth_ignore_case(names, base, occurrence)
        } else {
            None
        }
    })
}

fn input_info(device: &cpal::Device, id: String, is_default: bool) -> Option<AudioDeviceInfo> {
    let name = device.name().ok()?;
    let config = device.default_input_config().ok();
    Some(AudioDeviceInfo {
        id,
        kind: kind_of(&name, false),
        name,
        api: EngineApi::WasapiShared,
        channels: config.as_ref().map(|c| c.channels()).unwrap_or(2),
        sample_rate: config.as_ref().map(|c| c.sample_rate().0).unwrap_or(48_000),
        is_default,
        online: true,
    })
}

fn output_info(device: &cpal::Device, id: String, is_default: bool) -> Option<AudioDeviceInfo> {
    let name = device.name().ok()?;
    let config = device.default_output_config().ok();
    Some(AudioDeviceInfo {
        id,
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
    let mut input_ids = NameIds::default();
    let mut output_ids = NameIds::default();

    if let Ok(inputs) = host.input_devices() {
        for device in inputs {
            let Ok(name) = device.name() else {
                continue;
            };
            let (id, occurrence) = input_ids.assign(&name);
            // Only the endpoint that kept the bare id can be the Windows
            // default: identical names further down the list are other units.
            let is_default = occurrence == 1 && default_input.as_deref() == Some(name.as_str());
            if let Some(info) = input_info(&device, format!("in:{id}"), is_default) {
                devices.insert(info.id.clone(), info);
            }
        }
    }

    if let Ok(outputs) = host.output_devices() {
        for device in outputs {
            let Ok(name) = device.name() else {
                continue;
            };
            let (id, occurrence) = output_ids.assign(&name);
            let is_default = occurrence == 1 && default_output.as_deref() == Some(name.as_str());
            if let Some(info) = output_info(&device, format!("out:{id}"), is_default) {
                devices.insert(info.id.clone(), info);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|name| name.to_string()).collect()
    }

    fn assign_all(list: &[&str]) -> Vec<String> {
        let mut ids = NameIds::default();
        list.iter().map(|name| ids.assign(name).0).collect()
    }

    #[test]
    fn unique_names_keep_the_bare_id() {
        assert_eq!(
            assign_all(&["Microphone (USB)", "Speakers"]),
            names(&["Microphone (USB)", "Speakers"])
        );
    }

    #[test]
    fn repeated_names_get_an_ordered_suffix() {
        assert_eq!(
            assign_all(&["Microphone (USB)", "Microphone (USB)", "Microphone (USB)"]),
            names(&[
                "Microphone (USB)",
                "Microphone (USB)#2",
                "Microphone (USB)#3"
            ])
        );
    }

    #[test]
    fn suffix_does_not_swallow_a_literal_name() {
        // A device that is really called `Line#2` keeps its name; the second
        // `Line` is pushed to `Line#3` instead of overwriting it.
        assert_eq!(
            assign_all(&["Line#2", "Line", "Line"]),
            names(&["Line#2", "Line", "Line#3"])
        );
    }

    #[test]
    fn occurrence_is_reported() {
        let mut ids = NameIds::default();
        assert_eq!(ids.assign("Mic"), ("Mic".to_string(), 1));
        assert_eq!(ids.assign("Mic"), ("Mic#2".to_string(), 2));
        assert_eq!(ids.assign("Mic"), ("Mic#3".to_string(), 3));
    }

    #[test]
    fn parse_suffix() {
        assert_eq!(
            parse_name_occurrence("Microphone (USB)#2"),
            ("Microphone (USB)", 2)
        );
        assert_eq!(
            parse_name_occurrence("Microphone (USB)#12"),
            ("Microphone (USB)", 12)
        );
        assert_eq!(
            parse_name_occurrence("Microphone (USB)"),
            ("Microphone (USB)", 1)
        );
        // `#1` is never generated, so it must stay part of the name.
        assert_eq!(parse_name_occurrence("Line#1"), ("Line#1", 1));
        assert_eq!(parse_name_occurrence("#2"), ("#2", 1));
        assert_eq!(parse_name_occurrence("Line#x"), ("Line#x", 1));
        assert_eq!(parse_name_occurrence("Line#"), ("Line#", 1));
    }

    #[test]
    fn match_resolves_each_generated_id() {
        let list = names(&["Microphone (USB)", "Microphone (USB)", "Speakers"]);
        assert_eq!(match_name(&list, "Microphone (USB)"), Some(0));
        assert_eq!(match_name(&list, "Microphone (USB)#2"), Some(1));
        assert_eq!(match_name(&list, "Speakers"), Some(2));
        assert_eq!(match_name(&list, "Microphone (USB)#3"), None);
        assert_eq!(match_name(&list, "Missing"), None);
    }

    #[test]
    fn match_handles_literal_suffix_names() {
        let list = names(&["Line#2", "Line", "Line"]);
        assert_eq!(match_name(&list, "Line#2"), Some(0));
        assert_eq!(match_name(&list, "Line"), Some(1));
        assert_eq!(match_name(&list, "Line#3"), Some(2));
    }

    #[test]
    fn match_falls_back_to_case_insensitive() {
        let list = names(&["Microphone (USB)"]);
        assert_eq!(match_name(&list, "microphone (usb)"), Some(0));
        let list = names(&["Microphone (USB)", "Microphone (USB)"]);
        assert_eq!(match_name(&list, "microphone (usb)#2"), Some(1));
    }

    #[test]
    fn match_is_the_inverse_of_assign() {
        let list = names(&["A", "A", "B", "A#2", "A"]);
        let generated = assign_all(&["A", "A", "B", "A#2", "A"]);
        for (index, id) in generated.iter().enumerate() {
            assert_eq!(match_name(&list, id), Some(index), "id {id}");
        }
    }
}
