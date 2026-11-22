use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use parking_lot::{Mutex, RwLock};
use serde_json::Value;

use super::ai::AiClient;
use super::graph::{GraphParams, MeterLevels};
use super::model::{DriverStatus, EngineConfig, EngineStatus};
use super::recorder::{RecorderParams, RecorderStatus};
use super::runtime::{EngineRuntime, RuntimeInfo};

/// Shared, lock-light runtime state. The audio callback only ever touches
/// atomics; configuration changes are published through `RwLock` and picked up
/// at block boundaries by the engine.
pub struct EngineState {
    config: RwLock<EngineConfig>,
    mixer_snapshot: RwLock<Value>,
    runtime: Mutex<Option<EngineRuntime>>,
    /// Serializes start attempts without holding `runtime` for the whole
    /// device-open phase (which can take tens of seconds with many VAC lines).
    starting: Mutex<()>,
    running: AtomicBool,
    xruns: AtomicU64,
    cpu_milli: AtomicU64,
    driver: RwLock<DriverStatus>,
    ai: AiClient,
}

impl Default for EngineState {
    fn default() -> Self {
        Self::new()
    }
}

impl EngineState {
    pub fn new() -> Self {
        Self {
            config: RwLock::new(EngineConfig::default()),
            mixer_snapshot: RwLock::new(Value::Null),
            runtime: Mutex::new(None),
            starting: Mutex::new(()),
            running: AtomicBool::new(false),
            xruns: AtomicU64::new(0),
            cpu_milli: AtomicU64::new(0),
            driver: RwLock::new(DriverStatus::default()),
            ai: AiClient::new(),
        }
    }

    pub fn config(&self) -> EngineConfig {
        self.config.read().clone()
    }

    pub fn set_config(&self, config: EngineConfig) {
        *self.config.write() = config;
    }

    pub fn set_mixer_snapshot(&self, snapshot: Value) {
        *self.mixer_snapshot.write() = snapshot;
    }

    pub fn mixer_snapshot(&self) -> Value {
        self.mixer_snapshot.read().clone()
    }

    /// Start the WASAPI engine. Idempotent: returns the current info if it is
    /// already running.
    pub fn start_engine(&self, config: EngineConfig, snapshot: Value) -> Result<RuntimeInfo, String> {
        // Never hold the runtime lock while WASAPI opens the device graph:
        // the UI polls `status()` several times a second, and blocking that
        // lock for 20+ seconds makes the whole window look frozen.
        let _starting = self.starting.lock();
        if let Some(runtime) = self.runtime.lock().as_ref() {
            return Ok(runtime.info().clone());
        }

        let runtime = EngineRuntime::start(&config, &snapshot).map_err(|error| format!("{error:#}"))?;
        let info = runtime.info().clone();
        self.set_config(config);
        let mut guard = self.runtime.lock();
        if let Some(existing) = guard.as_ref() {
            return Ok(existing.info().clone());
        }
        *guard = Some(runtime);
        drop(guard);
        self.start();
        tracing::info!(
            sample_rate = info.sample_rate,
            buffer_size = info.buffer_size,
            inputs = info.input_streams,
            outputs = info.output_streams,
            "audio engine started"
        );
        Ok(info)
    }

    pub fn stop_engine(&self) {
        // Drop the runtime (and join the audio thread) without holding the
        // lock, so a concurrent `status()` is never blocked for long.
        let runtime = self.runtime.lock().take();
        drop(runtime);
        self.stop();
        tracing::info!("audio engine stopped");
    }

    pub fn is_engine_running(&self) -> bool {
        self.runtime.lock().is_some()
    }

    /// Publish allocation-free graph parameters to the running audio callback.
    pub fn publish_params(&self, params: GraphParams) {
        if let Some(runtime) = self.runtime.lock().as_ref() {
            runtime.send_params(params);
        }
    }

    /// Apply recorder settings (start/stop/restart file) without rebuilding the
    /// device graph.
    pub fn publish_recorder(&self, params: RecorderParams) {
        if let Some(runtime) = self.runtime.lock().as_ref() {
            runtime.set_recorder(params);
        }
    }

    /// Re-arm the realtime Voice AI path from the latest mixer snapshot.
    pub fn publish_ai(&self, snapshot: &Value) {
        if let Some(runtime) = self.runtime.lock().as_ref() {
            runtime.publish_ai(snapshot);
        }
    }

    pub fn recorder_status(&self) -> Option<RecorderStatus> {
        self.runtime
            .lock()
            .as_ref()
            .map(|runtime| runtime.recorder_status())
    }

    pub fn meters(&self) -> Option<MeterLevels> {
        self.runtime.lock().as_ref().map(|runtime| runtime.meters())
    }

    pub fn runtime_info(&self) -> Option<RuntimeInfo> {
        self.runtime.lock().as_ref().map(|runtime| runtime.info().clone())
    }

    pub fn start(&self) {
        self.running.store(true, Ordering::Release);
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::Release);
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }

    /// Control-plane client for the local Voice AI sidecar.
    pub fn ai(&self) -> &AiClient {
        &self.ai
    }

    pub fn set_driver(&self, driver: DriverStatus) {
        *self.driver.write() = driver;
    }

    pub fn driver(&self) -> DriverStatus {
        self.driver.read().clone()
    }

    pub fn note_xrun(&self) {
        self.xruns.fetch_add(1, Ordering::Relaxed);
    }

    pub fn set_cpu_percent(&self, percent: f32) {
        self.cpu_milli
            .store((percent * 1000.0).max(0.0) as u64, Ordering::Relaxed);
    }

    pub fn status(&self) -> EngineStatus {
        let config = self.config.read().clone();
        let driver = self.refresh_driver();

        let runtime = self.runtime.lock();
        let live = runtime.as_ref().map(|runtime| {
            (
                runtime.info().clone(),
                runtime.stats().xruns(),
                runtime.stats().cpu_percent(),
                runtime.stats().frames(),
            )
        });
        drop(runtime);

        let (sample_rate, buffer_size, latency_ms, xruns, cpu_percent, frames) = match live {
            Some((info, xruns, cpu, frames)) => (
                info.sample_rate,
                info.buffer_size,
                info.latency_ms() + config.safety_ms as f32,
                xruns,
                cpu,
                frames,
            ),
            None => (
                config.sample_rate,
                config.buffer_size,
                config.latency_ms(),
                self.xruns.load(Ordering::Relaxed),
                0.0,
                0,
            ),
        };

        let ai = self.ai.status();

        EngineStatus {
            running: self.is_running(),
            api: config.api,
            sample_rate,
            buffer_size,
            latency_ms,
            cpu_percent,
            xruns,
            frames,
            driver,
            ai_status: ai.state.as_str().into(),
            ai_backend: ai.backend.clone(),
            ai,
        }
    }

    /// Refresh the cached driver state from the system. The probe itself is
    /// throttled, so calling this from every status poll is cheap.
    fn refresh_driver(&self) -> DriverStatus {
        #[cfg(windows)]
        let detected = super::driver::detect();
        #[cfg(not(windows))]
        let detected = DriverStatus::default();

        let stale = {
            let current = self.driver.read();
            current.installed != detected.installed
                || current.endpoints != detected.endpoints
                || current.signed != detected.signed
                || current.test_mode != detected.test_mode
        };
        if stale {
            *self.driver.write() = detected.clone();
        }
        detected
    }
}
