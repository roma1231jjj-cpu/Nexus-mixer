//! Serializable types shared with the React UI.
//!
//! The TypeScript mirror lives in `src/types.ts`. Field names are camelCase on
//! the wire so `invoke("set_engine_config", { config })` can forward a plain
//! object without a translation layer.

use serde::{Deserialize, Serialize};

use super::ai::AiStatus;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EngineApi {
    #[default]
    WasapiShared,
    WasapiExclusive,
    Asio,
    WdmKs,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeviceKind {
    Input,
    Output,
    VirtualPlayback,
    VirtualCapture,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceInfo {
    /// Stable endpoint id. Today it is derived from the friendly name; the
    /// WASAPI backend will switch to `IMMDevice::GetId` later.
    pub id: String,
    pub name: String,
    pub kind: DeviceKind,
    pub api: EngineApi,
    pub channels: u16,
    pub sample_rate: u32,
    pub is_default: bool,
    pub online: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EngineConfig {
    pub api: EngineApi,
    pub sample_rate: u32,
    pub buffer_size: u32,
    pub virtual_channels: u8,
    pub safety_ms: u32,
    pub clock_master: String,
    pub follow_default_devices: bool,
    pub run_in_tray: bool,
    pub start_with_windows: bool,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            api: EngineApi::WasapiShared,
            sample_rate: 48_000,
            buffer_size: 256,
            virtual_channels: 8,
            safety_ms: 4,
            clock_master: "A1".into(),
            follow_default_devices: false,
            run_in_tray: true,
            start_with_windows: false,
        }
    }
}

impl EngineConfig {
    /// Buffer + safety time, in milliseconds.
    pub fn latency_ms(&self) -> f32 {
        let buffer = self.buffer_size.max(1) as f32 / self.sample_rate.max(1) as f32 * 1000.0;
        buffer + self.safety_ms as f32
    }

    /// True when the change requires reopening the WASAPI streams. Cosmetic
    /// switches (`run_in_tray`, `start_with_windows`, follow-default) are applied
    /// without interrupting audio.
    pub fn audio_changed(&self, other: &Self) -> bool {
        self.api != other.api
            || self.sample_rate != other.sample_rate
            || self.buffer_size != other.buffer_size
            || self.virtual_channels != other.virtual_channels
            || self.safety_ms != other.safety_ms
            || self.clock_master != other.clock_master
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DriverStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub signed: bool,
    pub test_mode: bool,
    pub endpoints: u32,
    /// Names of individual cable endpoints detected, e.g.
    /// `["CABLE Input (VB-Audio Virtual Cable)"]`.
    pub cable_endpoints: Vec<String>,
    pub message: String,
}

impl Default for DriverStatus {
    fn default() -> Self {
        Self {
            installed: false,
            version: None,
            signed: false,
            test_mode: false,
            endpoints: 0,
            cable_endpoints: Vec::new(),
            message: "Виртуальный кабель не найден — виртуальные шины работают в режиме эмуляции."
                .into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub running: bool,
    pub api: EngineApi,
    pub sample_rate: u32,
    pub buffer_size: u32,
    pub latency_ms: f32,
    pub cpu_percent: f32,
    pub xruns: u64,
    /// Frames rendered by the master callback since start. The UI uses this as
    /// a watchdog: a frozen counter means the audio thread stalled.
    pub frames: u64,
    pub driver: DriverStatus,
    /// Sidecar state: `offline`, `loading`, `ready` or `error`.
    pub ai_status: String,
    /// Backend reported by the sidecar (`passthrough`, `onnx`, …).
    pub ai_backend: String,
    /// Full control-plane snapshot for the AI panel.
    pub ai: AiStatus,
}

impl Default for EngineStatus {
    fn default() -> Self {
        let config = EngineConfig::default();
        Self {
            running: false,
            api: config.api,
            sample_rate: config.sample_rate,
            buffer_size: config.buffer_size,
            latency_ms: config.latency_ms(),
            cpu_percent: 0.0,
            xruns: 0,
            frames: 0,
            driver: DriverStatus::default(),
            ai_status: "offline".into(),
            ai_backend: "Nexus AI sidecar".into(),
            ai: AiStatus::default(),
        }
    }
}
