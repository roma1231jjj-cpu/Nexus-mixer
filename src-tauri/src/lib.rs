//! Nexus-Mixer desktop shell.
//!
//! The React UI talks to the engine through a small, explicit command surface.
//! Every command returns data in the exact shape the UI already uses for its
//! browser-only mock, so `src/lib/engineBridge.ts` can transparently switch
//! between "simulated" and "real" without touching components.

pub mod engine;

use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State, WindowEvent,
};

use crate::engine::{
    ai::{AiStatus, DEFAULT_HOST, DEFAULT_PORT},
    devices,
    graph::{MeterLevels, MixerParams},
    model::{AudioDeviceInfo, DriverStatus, EngineConfig, EngineStatus},
    recorder::RecorderStatus,
    runtime::RuntimeInfo,
    state::EngineState,
};

type SharedEngine<'a> = State<'a, Arc<EngineState>>;

/// Enumerate WASAPI input/output endpoints.
///
/// Individual endpoint failures are ignored inside [`devices::enumerate`].
#[tauri::command]
async fn list_audio_devices() -> Result<Vec<AudioDeviceInfo>, String> {
    // CPAL endpoint enumeration takes several seconds with twelve VAC lines;
    // run it off the IPC/main thread so device refresh never freezes the UI.
    tauri::async_runtime::spawn_blocking(devices::enumerate)
        .await
        .map_err(|error| format!("Не удалось перечислить аудиоустройства: {error}"))?
        .map_err(|error| format!("Не удалось перечислить аудиоустройства: {error:#}"))
}

/// Snapshot of the engine, suitable for polling from the UI status bar.
#[tauri::command]
fn get_engine_status(state: SharedEngine<'_>) -> EngineStatus {
    state.status()
}

/// Publish a new engine configuration and return the resulting snapshot.
/// If the engine is running, only audio-affecting changes restart the streams;
/// tray/autostart switches are applied silently.
#[tauri::command]
fn set_engine_config(config: EngineConfig, state: SharedEngine<'_>) -> Result<EngineStatus, String> {
    let previous = state.config();
    let was_running = state.is_engine_running();
    let restart = was_running && previous.audio_changed(&config);
    if restart {
        state.stop_engine();
    }
    state.set_config(config);
    if restart {
        state.start_engine(state.config(), state.mixer_snapshot())?;
    }
    Ok(state.status())
}

/// Store the last mixer snapshot and, when the engine is live, publish it as
/// allocation-free graph parameters.
#[tauri::command]
fn set_mixer_state(snapshot: serde_json::Value, state: SharedEngine<'_>) -> Result<(), String> {
    let params: MixerParams = serde_json::from_value(snapshot.clone())
        .map_err(|error| format!("Некорректный snapshot микшера: {error}"))?;
    state.publish_ai(&snapshot);
    state.set_mixer_snapshot(snapshot);
    state.publish_params(params.to_graph());
    state.publish_recorder(params.recorder);
    Ok(())
}

/// Read back the last snapshot (used for window reloads and diagnostics).
#[tauri::command]
fn get_mixer_state(state: SharedEngine<'_>) -> serde_json::Value {
    state.mixer_snapshot()
}

/// Start the real WASAPI engine with the last published configuration and
/// mixer snapshot. Returns an actionable error instead of silently flipping the
/// status flag, so the UI can show why the device graph could not be opened.
#[tauri::command]
async fn start_engine(state: SharedEngine<'_>) -> Result<EngineStatus, String> {
    // Building the WASAPI graph is blocking work (dozens of endpoints can take
    // many seconds). Keep it off the IPC/main thread so the window stays
    // responsive and status polling does not queue behind the device open.
    let engine = Arc::clone(state.inner());
    let config = engine.config();
    let snapshot = engine.mixer_snapshot();
    let starter = Arc::clone(&engine);
    tauri::async_runtime::spawn_blocking(move || starter.start_engine(config, snapshot))
        .await
        .map_err(|error| format!("Не удалось запустить аудиодвижок: {error}"))??;
    tracing::info!("engine start requested");
    Ok(engine.status())
}

#[tauri::command]
fn stop_engine(state: SharedEngine<'_>) -> EngineStatus {
    state.stop_engine();
    tracing::info!("engine stop requested");
    state.status()
}

/// Latest peak levels (dBFS) for the five strips and five buses.
/// `null` means the engine is not running.
#[tauri::command]
fn get_meter_levels(state: SharedEngine<'_>) -> Option<MeterLevels> {
    state.meters()
}

/// Runtime details of the live device graph: actual sample rate, endpoint
/// count and non-fatal warnings collected while opening WASAPI streams.
#[tauri::command]
fn get_engine_info(state: SharedEngine<'_>) -> Option<RuntimeInfo> {
    state.runtime_info()
}

/// Live recorder state (file path, elapsed time, dropped frames, last error).
#[tauri::command]
fn get_recorder_status(state: SharedEngine<'_>) -> Option<RecorderStatus> {
    state.recorder_status()
}

#[tauri::command]
fn get_driver_status(state: SharedEngine<'_>) -> DriverStatus {
    state.driver()
}

/// Rename detected virtual cable endpoints to `Nexus Cable B1..B12`.
///
/// The endpoint properties live under HKLM, so the script is launched through
/// UAC. The app itself stays non-elevated. The script only touches endpoints
/// whose friendly name contains "cable" or "nexus".
#[tauri::command]
fn rename_virtual_cables(app: AppHandle) -> Result<String, String> {
    let script: PathBuf = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/rename-cables.ps1")
    } else {
        app.path()
            .resource_dir()
            .map_err(|error| format!("Не найден каталог ресурсов: {error}"))?
            .join("resources/rename-cables.ps1")
    };

    if !script.exists() {
        return Err(format!("Не найден скрипт переименования: {}", script.display()));
    }

    let escaped = script.display().to_string().replace('\'', "''");
    let command = format!(
        "$p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','{escaped}'); exit $p.ExitCode"
    );
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &command])
        .output()
        .map_err(|error| format!("Не удалось запустить PowerShell: {error}"))?;

    if output.status.success() {
        Ok("Кабели переименованы. Перезапустите Nexus-Mixer, чтобы обновить список устройств.".into())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            "Переименование отменено или не удалось. Нужны права администратора.".into()
        } else {
            stderr
        })
    }
}

/// Sample rate and chunk size the AI sidecar should use. While the engine is
/// live the actual clock-master rate wins; otherwise the requested config is
/// used. The chunk size comes from the published AI settings (default 160 ms).
fn ai_stream_format(state: &EngineState) -> (u32, u32) {
    let sample_rate = state
        .runtime_info()
        .map(|info| info.sample_rate)
        .filter(|rate| *rate > 0)
        .unwrap_or_else(|| state.config().sample_rate)
        .max(1);
    let chunk_ms = state
        .mixer_snapshot()
        .get("ai")
        .and_then(|ai| ai.get("chunkMs"))
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(160);
    let frames = (sample_rate as u64 * chunk_ms / 1000).clamp(160, 15_360) as u32;
    (sample_rate, frames)
}

/// Connect to the local Python sidecar and perform the protocol-v1 handshake.
/// `config` is forwarded as a `configure` message when the handshake succeeds.
#[tauri::command]
fn connect_ai_sidecar(
    host: Option<String>,
    port: Option<u16>,
    sample_rate: Option<u32>,
    chunk_frames: Option<u32>,
    config: Option<serde_json::Value>,
    state: SharedEngine<'_>,
) -> Result<AiStatus, String> {
    let (default_rate, default_chunk) = ai_stream_format(&state);
    let sample_rate = sample_rate.unwrap_or(default_rate).max(1);
    // Prefer an explicit chunk size, then the one in the `configure` payload
    // (the UI sends `chunk_ms`), then the last published snapshot.
    let chunk_frames = chunk_frames
        .or_else(|| {
            config
                .as_ref()
                .and_then(|value| value.get("chunk_ms"))
                .and_then(serde_json::Value::as_u64)
                .map(|ms| ((sample_rate as u64 * ms) / 1000).clamp(160, 15_360) as u32)
        })
        .unwrap_or(default_chunk);

    state.ai().connect(
        host.as_deref().unwrap_or(DEFAULT_HOST),
        port.unwrap_or(DEFAULT_PORT),
        sample_rate,
        chunk_frames,
    )?;

    if let Some(config) = config {
        if let Err(error) = state.ai().configure(config) {
            tracing::warn!(%error, "AI sidecar configure failed");
        }
    }
    Ok(state.ai().status())
}

#[tauri::command]
fn disconnect_ai_sidecar(state: SharedEngine<'_>) -> AiStatus {
    state.ai().disconnect()
}

/// Cached sidecar status. Also embedded in [`EngineStatus`], so the UI can read
/// it from the one-second status poll without an extra round-trip.
#[tauri::command]
fn get_ai_status(state: SharedEngine<'_>) -> AiStatus {
    state.ai().status()
}

#[tauri::command]
fn ping_ai_sidecar(state: SharedEngine<'_>) -> Result<AiStatus, String> {
    state.ai().ping()
}

#[tauri::command]
fn configure_ai_sidecar(
    config: serde_json::Value,
    state: SharedEngine<'_>,
) -> Result<AiStatus, String> {
    state.ai().configure(config)
}

/// Application entry point shared by `main.rs` and mobile targets.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Logging must never abort startup: if a second logger is already
    // installed (tests, hot reload) we simply keep the existing subscriber.
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("nexus_mixer_lib=info,tauri=warn")),
        )
        .with_target(false)
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Arc::new(EngineState::new()))
        .invoke_handler(tauri::generate_handler![
            list_audio_devices,
            get_engine_status,
            set_engine_config,
            set_mixer_state,
            get_mixer_state,
            start_engine,
            stop_engine,
            get_meter_levels,
            get_engine_info,
            get_recorder_status,
            get_driver_status,
            rename_virtual_cables,
            connect_ai_sidecar,
            disconnect_ai_sidecar,
            get_ai_status,
            ping_ai_sidecar,
            configure_ai_sidecar,
        ])
        .setup(|app| {
            let state = app.state::<Arc<EngineState>>();
            let status = state.status();
            tracing::info!(
                sample_rate = status.sample_rate,
                buffer_size = status.buffer_size,
                latency_ms = status.latency_ms,
                "Nexus-Mixer engine ready — Nexus × АутSquad"
            );

            // --- tray icon ---------------------------------------------------
            // The window is frameless, so the tray is the only way back after
            // "close to tray". Menu items mirror the settings drawer switches.
            let show_item = MenuItem::with_id(app, "tray-show", "Показать окно", true, None::<&str>)?;
            let hide_item = MenuItem::with_id(app, "tray-hide", "Скрыть в трей", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "tray-quit", "Выход", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &hide_item, &quit_item])?;

            let mut tray = TrayIconBuilder::with_id("nexus-tray")
                .tooltip("Nexus-Mixer — Nexus × АутSquad")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "tray-show" => show_main_window(app),
                    "tray-hide" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.hide();
                        }
                    }
                    "tray-quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Respect the "Работать в трее" switch. When it is off, the close
            // button terminates the app as usual.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<Arc<EngineState>>();
                if state.config().run_in_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Nexus-Mixer: fatal error while running the Tauri application");
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
