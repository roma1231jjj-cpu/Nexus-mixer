//! Detection of the virtual audio cable endpoints.
//!
//! The mixer routes buses through signed virtual cables (VAC / VB-CABLE) instead of a
//! custom kernel driver: Windows only loads Microsoft-signed kernel images on
//! this machine, so an own test-signed driver cannot be used here.
//!
//! The state is cached for a couple of seconds and refreshed by
//! `EngineState::status()`, so a false negative is cheap to recover from.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use windows_sys::Win32::Foundation::ERROR_SUCCESS;
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ,
    REG_SZ, RRF_RT_REG_SZ,
};

use super::model::DriverStatus;

const CABLE_SERVICE: &str = "SYSTEM\\CurrentControlSet\\Services\\VBAudioVACMME";
const CACHE_TTL: Duration = Duration::from_secs(3);

struct Cache {
    at: Instant,
    status: DriverStatus,
}

static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

/// Current cable state. Cheap to call: the expensive endpoint enumeration runs
/// at most once per [`CACHE_TTL`].
pub fn detect() -> DriverStatus {
    let mut cache = CACHE.lock();
    if let Some(entry) = cache.as_ref() {
        if entry.at.elapsed() < CACHE_TTL {
            return entry.status.clone();
        }
    }

    let status = probe();
    *cache = Some(Cache {
        at: Instant::now(),
        status: status.clone(),
    });
    status
}

fn probe() -> DriverStatus {
    let image = cable_image();
    let endpoints = virtual_endpoints();

    let installed = service_registered() || image.is_some() || !endpoints.is_empty();
    let render_count = endpoints.iter().filter(|(_, output)| *output).count() as u32;
    let signed = image
        .as_ref()
        .map(|path| has_signature(path))
        .unwrap_or(false);

    // Collect display names for every detected cable endpoint
    let cable_names: Vec<String> = endpoints
        .iter()
        .filter(|(_, render)| *render)
        .map(|(name, _)| name.clone())
        .collect();

    // Технический статус для подсказки в статус-баре. Пользовательские
    // формулировки живут в i18n (settings.cableActiveText и соседние ключи),
    // иначе русский текст протекал в английский интерфейс.
    let message = if !installed {
        "Virtual cable not found: install Virtual Audio Cable (VAC) or VB-CABLE so the \
         virtual buses get their own output and input devices."
            .into()
    } else if cable_names.is_empty() {
        "The virtual cable driver is installed, but its devices are not visible to the system: \
         check Device Manager."
            .into()
    } else {
        format!("Virtual cable active: {}.", cable_names.join(", "))
    };

    DriverStatus {
        installed,
        version: None,
        signed,
        test_mode: false,
        endpoints: render_count,
        cable_endpoints: cable_names,
        message,
    }
}

/// Names of the live endpoints that belong to the virtual cable, paired with
/// `true` for render endpoints.
///
/// Enumeration goes through the MMDevices registry rather than CPAL: opening
/// all twelve VAC pins through CPAL takes several seconds on this machine,
/// while the registry is fast and already contains the friendly names.
fn virtual_endpoints() -> Vec<(String, bool)> {
    const DEVICE_DESC: &str = "{a45c254e-df1c-4efd-8020-67d146a850e0},2";
    let mut names = Vec::new();

    for (flow, render) in [("Render", true), ("Capture", false)] {
        let base = format!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\{flow}");
        let key: Vec<u16> = base.encode_utf16().chain(std::iter::once(0)).collect();
        let mut handle: HKEY = std::ptr::null_mut();
        let open =
            unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, key.as_ptr(), 0, KEY_READ, &mut handle) };
        if open != ERROR_SUCCESS {
            continue;
        }

        let mut index = 0;
        loop {
            let mut name = [0u16; 256];
            let mut length = name.len() as u32;
            let result = unsafe {
                RegEnumKeyExW(
                    handle,
                    index,
                    name.as_mut_ptr(),
                    &mut length,
                    std::ptr::null(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            };
            if result != ERROR_SUCCESS {
                break;
            }
            index += 1;
            let guid = String::from_utf16_lossy(&name[..length as usize]);
            let path = format!(r"{base}\{guid}\Properties");
            if let Some(desc) = read_string(&path, DEVICE_DESC) {
                if is_virtual(&desc) {
                    names.push((desc, render));
                }
            }
        }
        unsafe { RegCloseKey(handle) };
    }

    names.sort();
    names.dedup();
    names
}

fn is_virtual(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.contains("cable")
        || (lower.contains("nexus") && (lower.contains("vaio") || lower.contains("aux")))
}

/// VB-CABLE registers `VBAudioVACMME`; its image lives in the driver store, so
/// the path is resolved through the service key instead of a fixed name.
fn cable_image() -> Option<PathBuf> {
    if let Some(path) = read_string(CABLE_SERVICE, "ImagePath") {
        let relative = path
            .strip_prefix("\\SystemRoot\\")
            .or_else(|| path.strip_prefix("\\??\\"))
            .or_else(|| path.strip_prefix("system32\\"))
            .unwrap_or(&path);
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let candidate = if path.starts_with("\\SystemRoot\\") {
            PathBuf::from(&root).join(relative)
        } else {
            PathBuf::from(relative)
        };
        if candidate.exists() {
            return Some(candidate);
        }
    }

    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let dir = PathBuf::from(root).join("System32").join("drivers");
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_lowercase();
            name.starts_with("vbaudio") && name.ends_with(".sys")
        })
}

fn read_string(key: &str, value: &str) -> Option<String> {
    let key: Vec<u16> = key.encode_utf16().chain(std::iter::once(0)).collect();
    let value: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
    let mut size: u32 = 0;
    let mut kind: u32 = 0;
    let probe = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            &mut kind,
            std::ptr::null_mut(),
            &mut size,
        )
    };
    if probe != ERROR_SUCCESS || kind != REG_SZ || size == 0 {
        return None;
    }
    let mut buffer = vec![0u16; (size as usize).div_ceil(2)];
    let read = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            &mut kind,
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if read != ERROR_SUCCESS {
        return None;
    }
    let len = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..len]))
}

fn service_registered() -> bool {
    let key: Vec<u16> = CABLE_SERVICE
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut handle: HKEY = std::ptr::null_mut();
    let open = unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, key.as_ptr(), 0, KEY_READ, &mut handle) };
    if open != ERROR_SUCCESS {
        return false;
    }
    unsafe { RegCloseKey(handle) };
    true
}

/// True when the PE optional header carries a non-empty certificate table, i.e.
/// the image is Authenticode-signed. The certificate chain itself is validated
/// by the kernel loader, not here.
fn has_signature(path: &std::path::Path) -> bool {
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    pe_security_size(&bytes).unwrap_or(0) > 0
}

fn pe_security_size(bytes: &[u8]) -> Option<u32> {
    if bytes.len() < 0x40 || &bytes[0..2] != b"MZ" {
        return None;
    }
    let pe = u32::from_le_bytes(bytes.get(0x3C..0x40)?.try_into().ok()?) as usize;
    if bytes.get(pe..pe + 4)? != b"PE\0\0" {
        return None;
    }
    let optional = pe.checked_add(24)?;
    let magic = u16::from_le_bytes(bytes.get(optional..optional + 2)?.try_into().ok()?);
    let directories = match magic {
        0x20B => optional + 112,
        0x10B => optional + 96,
        _ => return None,
    };
    let entry = directories + 4 * 8;
    let size = u32::from_le_bytes(bytes.get(entry + 4..entry + 8)?.try_into().ok()?);
    Some(size)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_image_is_not_signed() {
        assert!(!has_signature(std::path::Path::new("no-such-file.sys")));
    }

    #[test]
    fn bare_bytes_are_not_a_pe() {
        assert_eq!(pe_security_size(b"not a pe file at all"), None);
        assert_eq!(pe_security_size(&[0u8; 2]), None);
    }

    #[test]
    fn cable_endpoints_are_detected() {
        assert!(is_virtual("CABLE Input (VB-Audio Virtual Cable)"));
        assert!(is_virtual("CABLE In 16ch (VB-Audio Virtual Cable)"));
        assert!(is_virtual("Nexus VAIO Output"));
        assert!(is_virtual("Nexus AUX Input"));
        assert!(!is_virtual("Speakers (Realtek High Definition Audio)"));
    }

    #[test]
    #[ignore = "requires a machine with the virtual cable installed"]
    fn cable_status_reports_installed() {
        let status = detect();
        println!("{status:?}");
        assert!(status.installed);
        assert!(status.endpoints > 0);
    }
}
