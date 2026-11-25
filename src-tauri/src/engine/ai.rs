//! Nexus Voice AI sidecar client — protocol v1.
//!
//! The local Python process described in `docs/AI_SIDECAR.md` speaks a simple
//! framed protocol over TCP: JSON control messages and binary PCM frames. This
//! module implements the *control plane* only:
//!
//! - TCP connect with timeouts and the `hello` → `ready` handshake;
//! - a cached [`AiStatus`] the UI can poll without blocking the audio thread;
//! - `ping` and `configure` commands used by the AI panel.
//!
//! Realtime audio (dry/wet rings, chunk scheduling, crossfade) is deliberately
//! not wired yet. The reported backend therefore reflects what the sidecar
//! actually says, so the UI never claims conversion that is not happening.

use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Protocol version implemented by this client.
pub const PROTOCOL_VERSION: u32 = 1;

pub const DEFAULT_HOST: &str = "127.0.0.1";
pub const DEFAULT_PORT: u16 = 47_600;

const CONNECT_TIMEOUT: Duration = Duration::from_millis(1_500);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_millis(3_000);
const OPERATION_TIMEOUT: Duration = Duration::from_millis(2_000);
const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// Frame kinds on the wire.
pub const KIND_JSON: u8 = 0x4A;
pub const KIND_AUDIO: u8 = 0x41;
pub const KIND_PING: u8 = 0x50;
pub const KIND_PONG: u8 = 0x51;

/// Connection state surfaced to the UI. Mirrors the TypeScript union.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiState {
    #[default]
    Offline,
    Loading,
    Ready,
    Error,
}

impl AiState {
    pub fn as_str(self) -> &'static str {
        match self {
            AiState::Offline => "offline",
            AiState::Loading => "loading",
            AiState::Ready => "ready",
            AiState::Error => "error",
        }
    }
}

/// Everything the AI panel needs to describe the sidecar without blocking.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiStatus {
    pub state: AiState,
    pub backend: String,
    pub model: Option<String>,
    pub sample_rate: u32,
    pub chunk_frames: u32,
    pub rtf: f32,
    pub endpoint: String,
    pub message: String,
    /// Measured `ping` round-trip, once the UI has probed the link.
    pub roundtrip_ms: Option<f32>,
}

impl Default for AiStatus {
    fn default() -> Self {
        Self {
            state: AiState::Offline,
            backend: "Nexus AI sidecar".into(),
            model: None,
            sample_rate: 48_000,
            chunk_frames: 7_680,
            rtf: 1.0,
            endpoint: format!("{DEFAULT_HOST}:{DEFAULT_PORT}"),
            message: "Sidecar не подключён — запустите python tools/ai-sidecar/sidecar.py".into(),
            roundtrip_ms: None,
        }
    }
}

struct Connection {
    stream: TcpStream,
}

/// Thread-safe control-plane client. The stream is only touched by explicit
/// UI commands, never from the audio callback.
pub struct AiClient {
    connection: Mutex<Option<Connection>>,
    status: RwLock<AiStatus>,
}

impl Default for AiClient {
    fn default() -> Self {
        Self::new()
    }
}

/// Handshake response from the sidecar.
struct Ready {
    backend: String,
    model: Option<String>,
    sample_rate: u32,
    chunk_frames: u32,
    rtf: f32,
}

impl AiClient {
    pub fn new() -> Self {
        Self {
            connection: Mutex::new(None),
            status: RwLock::new(AiStatus::default()),
        }
    }

    /// Cached snapshot for `EngineStatus`. Never performs I/O.
    pub fn status(&self) -> AiStatus {
        self.status.read().clone()
    }

    /// Send one binary audio frame. The realtime thread owns the read side, so
    /// a failure here simply marks the chunk as dropped.
    pub fn send_audio(&self, seq: u32, samples: &[f32]) -> Result<(), String> {
        let mut guard = self.connection.lock();
        let connection = guard
            .as_mut()
            .ok_or_else(|| "Sidecar не подключён".to_string())?;
        let mut payload = Vec::with_capacity(4 + samples.len() * 4);
        payload.extend_from_slice(&seq.to_le_bytes());
        for sample in samples {
            payload.extend_from_slice(&sample.to_le_bytes());
        }
        write_frame(&mut connection.stream, KIND_AUDIO, &payload)
    }

    /// Read the next event from the sidecar. Bounded by a short read timeout so
    /// the realtime loop can re-check its stop condition.
    pub fn recv_event(&self) -> Result<(u8, Vec<u8>), String> {
        let mut guard = self.connection.lock();
        let connection = guard
            .as_mut()
            .ok_or_else(|| "Sidecar не подключён".to_string())?;
        let _ = connection
            .stream
            .set_read_timeout(Some(Duration::from_millis(400)));
        read_frame(&mut connection.stream)
    }

    /// Ping/pong probe used by the realtime loop and the UI button.
    pub fn send_ping(&self) -> Result<(), String> {
        let mut guard = self.connection.lock();
        let connection = guard
            .as_mut()
            .ok_or_else(|| "Sidecar не подключён".to_string())?;
        write_frame(&mut connection.stream, KIND_PING, &[])
    }

    /// Open a connection, perform the handshake and return the fresh status.
    pub fn connect(
        &self,
        host: &str,
        port: u16,
        sample_rate: u32,
        chunk_frames: u32,
    ) -> Result<AiStatus, String> {
        self.clear_connection();

        let endpoint = format!("{host}:{port}");
        {
            let mut status = self.status.write();
            status.state = AiState::Loading;
            status.backend = "Nexus AI sidecar".into();
            status.model = None;
            status.rtf = 1.0;
            status.endpoint = endpoint.clone();
            status.message = format!("Подключение к {endpoint}…");
            status.roundtrip_ms = None;
            status.sample_rate = sample_rate.max(1);
            status.chunk_frames = chunk_frames;
        }

        match self.open(host, port, sample_rate, chunk_frames) {
            Ok((stream, ready)) => {
                *self.connection.lock() = Some(Connection { stream });
                let mut status = self.status.write();
                status.state = AiState::Ready;
                status.backend = ready.backend;
                status.model = ready.model;
                status.sample_rate = ready.sample_rate;
                status.chunk_frames = ready.chunk_frames;
                status.rtf = ready.rtf;
                status.roundtrip_ms = None;
                status.message = format!(
                    "Готов: {} · {} Гц · чанк {} кадров",
                    status.backend, status.sample_rate, status.chunk_frames
                );
                Ok(status.clone())
            }
            Err(error) => {
                let mut status = self.status.write();
                status.state = AiState::Error;
                status.backend = "Nexus AI sidecar".into();
                status.model = None;
                status.rtf = 1.0;
                status.message = error.clone();
                status.roundtrip_ms = None;
                Err(error)
            }
        }
    }

    /// Ask the sidecar to exit and drop the socket. Idempotent.
    pub fn disconnect(&self) -> AiStatus {
        if let Some(mut connection) = self.connection.lock().take() {
            let _ = write_json(&mut connection.stream, &json!({ "type": "shutdown" }));
            let _ = connection
                .stream
                .set_read_timeout(Some(Duration::from_millis(250)));
            let _ = read_frame(&mut connection.stream);
            let _ = connection.stream.shutdown(Shutdown::Both);
        }

        let mut status = self.status.write();
        status.state = AiState::Offline;
        status.backend = "Nexus AI sidecar".into();
        status.model = None;
        status.rtf = 1.0;
        status.roundtrip_ms = None;
        status.message = "Sidecar отключён".into();
        status.clone()
    }

    /// Round-trip probe. A failure tears the connection down and reports an
    /// error state, so the UI can offer "Подключить" again.
    pub fn ping(&self) -> Result<AiStatus, String> {
        if self.connection.lock().is_none() {
            return Err("Sidecar не подключён — сначала нажмите «Подключить»".into());
        }
        let started = Instant::now();
        let result = self.with_stream(|stream| {
            write_frame(stream, KIND_PING, &[])?;
            loop {
                let (kind, payload) = read_frame(stream)?;
                match kind {
                    KIND_PONG => return Ok(()),
                    KIND_JSON => {
                        let message: Value = serde_json::from_slice(&payload)
                            .map_err(|error| format!("Некорректный JSON от sidecar: {error}"))?;
                        match message.get("type").and_then(Value::as_str) {
                            Some("pong") => return Ok(()),
                            Some("error") => {
                                return Err(format!(
                                    "Sidecar: {}",
                                    message
                                        .get("message")
                                        .and_then(Value::as_str)
                                        .unwrap_or("неизвестная ошибка")
                                ))
                            }
                            _ => continue,
                        }
                    }
                    _ => continue,
                }
            }
        });

        match result {
            Ok(()) => {
                let roundtrip = started.elapsed().as_secs_f32() * 1000.0;
                let mut status = self.status.write();
                status.state = AiState::Ready;
                status.roundtrip_ms = Some(roundtrip);
                status.message = format!("Связь в порядке · {roundtrip:.1} мс");
                Ok(status.clone())
            }
            Err(error) => Err(self.fail(&error)),
        }
    }

    /// Forward model/parameter changes. The passthrough backend accepts them
    /// and reports `configured`; the real backend will store them for the next
    /// chunk.
    pub fn configure(&self, config: Value) -> Result<AiStatus, String> {
        if self.connection.lock().is_none() {
            return Err("Sidecar не подключён — сначала нажмите «Подключить»".into());
        }
        let message = match config {
            Value::Object(mut map) => {
                map.insert("type".into(), json!("configure"));
                Value::Object(map)
            }
            other => json!({ "type": "configure", "params": other }),
        };

        let result = self.with_stream(|stream| {
            write_json(stream, &message)?;
            loop {
                let (kind, payload) = read_frame(stream)?;
                if kind != KIND_JSON {
                    continue;
                }
                let response: Value = serde_json::from_slice(&payload)
                    .map_err(|error| format!("Некорректный JSON от sidecar: {error}"))?;
                match response.get("type").and_then(Value::as_str) {
                    Some("configured") => return Ok(()),
                    Some("error") => {
                        return Err(format!(
                            "Sidecar: {}",
                            response
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("неизвестная ошибка")
                        ))
                    }
                    _ => continue,
                }
            }
        });

        match result {
            Ok(()) => {
                let mut status = self.status.write();
                status.state = AiState::Ready;
                status.message = "Параметры конвертера применены".into();
                Ok(status.clone())
            }
            Err(error) => Err(self.fail(&error)),
        }
    }

    fn open(
        &self,
        host: &str,
        port: u16,
        sample_rate: u32,
        chunk_frames: u32,
    ) -> Result<(TcpStream, Ready), String> {
        let address = (host, port)
            .to_socket_addrs()
            .map_err(|error| format!("Не удалось разрешить {host}:{port}: {error}"))?
            .next()
            .ok_or_else(|| format!("Адрес {host}:{port} не найден"))?;

        let mut stream = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT)
            .map_err(|error| format!("Не удалось подключиться к {host}:{port}: {error}"))?;
        let _ = stream.set_nodelay(true);
        let _ = stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT));
        let _ = stream.set_write_timeout(Some(OPERATION_TIMEOUT));

        write_json(
            &mut stream,
            &json!({
                "type": "hello",
                "protocol": PROTOCOL_VERSION,
                "client": "nexus-mixer/0.1",
                "sample_rate": sample_rate.max(1),
                "chunk_frames": chunk_frames,
                "channels": 1,
            }),
        )?;

        let (kind, payload) = read_frame(&mut stream)?;
        if kind != KIND_JSON {
            return Err(format!("Sidecar ответил кадром 0x{kind:02X} вместо JSON"));
        }
        let message: Value = serde_json::from_slice(&payload)
            .map_err(|error| format!("Некорректный JSON handshake: {error}"))?;

        match message.get("type").and_then(Value::as_str) {
            Some("ready") => {
                let protocol = message.get("protocol").and_then(Value::as_u64).unwrap_or(0);
                if protocol != PROTOCOL_VERSION as u64 {
                    return Err(format!(
                        "Sidecar использует протокол {protocol}, ожидался {PROTOCOL_VERSION}"
                    ));
                }
                let _ = stream.set_read_timeout(Some(OPERATION_TIMEOUT));
                Ok((
                    stream,
                    Ready {
                        backend: message
                            .get("backend")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown")
                            .to_string(),
                        model: message
                            .get("model")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        sample_rate: message
                            .get("sample_rate")
                            .and_then(Value::as_u64)
                            .unwrap_or(sample_rate as u64)
                            as u32,
                        chunk_frames: message
                            .get("chunk_frames")
                            .and_then(Value::as_u64)
                            .unwrap_or(chunk_frames as u64)
                            as u32,
                        rtf: message.get("rtf").and_then(Value::as_f64).unwrap_or(1.0) as f32,
                    },
                ))
            }
            Some("error") => Err(format!(
                "Sidecar: {}",
                message
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("неизвестная ошибка")
            )),
            other => Err(format!("Неожиданный ответ sidecar: {other:?}")),
        }
    }

    fn with_stream<T>(
        &self,
        action: impl FnOnce(&mut TcpStream) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self.connection.lock();
        let connection = guard
            .as_mut()
            .ok_or_else(|| "Sidecar не подключён".to_string())?;
        action(&mut connection.stream)
    }

    fn clear_connection(&self) {
        if let Some(connection) = self.connection.lock().take() {
            let _ = connection.stream.shutdown(Shutdown::Both);
        }
    }

    fn fail(&self, error: &str) -> String {
        self.clear_connection();
        let mut status = self.status.write();
        status.state = AiState::Error;
        status.roundtrip_ms = None;
        status.message = error.to_string();
        error.to_string()
    }
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

pub fn write_frame<W: Write>(writer: &mut W, kind: u8, payload: &[u8]) -> Result<(), String> {
    let length = payload.len() + 1;
    if length > MAX_FRAME_BYTES {
        return Err(format!("Кадр слишком большой: {length} байт"));
    }
    let mut header = [0u8; 5];
    header[..4].copy_from_slice(&(length as u32).to_le_bytes());
    header[4] = kind;
    writer
        .write_all(&header)
        .and_then(|()| writer.write_all(payload))
        .and_then(|()| writer.flush())
        .map_err(io_error)
}

fn write_json<W: Write>(writer: &mut W, message: &Value) -> Result<(), String> {
    let payload = serde_json::to_vec(message)
        .map_err(|error| format!("Не удалось сериализовать сообщение sidecar: {error}"))?;
    write_frame(writer, KIND_JSON, &payload)
}

pub fn read_frame<R: Read>(reader: &mut R) -> Result<(u8, Vec<u8>), String> {
    read_frame_result(reader).map_err(io_error)
}

fn read_frame_result<R: Read>(reader: &mut R) -> io::Result<(u8, Vec<u8>)> {
    let mut header = [0u8; 4];
    reader.read_exact(&mut header)?;
    let length = u32::from_le_bytes(header) as usize;
    if !(1..=MAX_FRAME_BYTES).contains(&length) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid frame length: {length}"),
        ));
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;
    Ok((body[0], body[1..].to_vec()))
}

fn io_error(error: io::Error) -> String {
    format!("Ошибка обмена с sidecar: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_roundtrip_between_writer_and_reader() {
        let mut buffer = Vec::new();
        write_frame(&mut buffer, KIND_PING, &[]).unwrap();
        let message = json!({ "type": "hello", "protocol": PROTOCOL_VERSION });
        write_json(&mut buffer, &message).unwrap();

        let mut cursor = io::Cursor::new(buffer);
        let (kind, payload) = read_frame(&mut cursor).unwrap();
        assert_eq!(kind, KIND_PING);
        assert!(payload.is_empty());

        let (kind, payload) = read_frame(&mut cursor).unwrap();
        assert_eq!(kind, KIND_JSON);
        let decoded: Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(decoded, message);
    }

    #[test]
    fn oversized_frame_is_rejected() {
        let mut cursor = io::Cursor::new(((MAX_FRAME_BYTES + 1) as u32).to_le_bytes().to_vec());
        let error = read_frame_result(&mut cursor).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn zero_length_frame_is_rejected() {
        let mut cursor = io::Cursor::new(0u32.to_le_bytes().to_vec());
        let error = read_frame_result(&mut cursor).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn default_status_is_honest_and_offline() {
        let client = AiClient::new();
        let status = client.status();
        assert_eq!(status.state, AiState::Offline);
        assert_eq!(status.endpoint, "127.0.0.1:47600");
        assert_eq!(status.sample_rate, 48_000);
        assert!(status.model.is_none());
    }

    #[test]
    fn disconnect_is_idempotent_without_a_connection() {
        let client = AiClient::new();
        let first = client.disconnect();
        let second = client.disconnect();
        assert_eq!(first.state, AiState::Offline);
        assert_eq!(second.state, AiState::Offline);
    }

    #[test]
    fn ping_without_connection_keeps_offline_state() {
        let client = AiClient::new();
        let error = client.ping().unwrap_err();
        assert!(error.contains("не подключён"), "{error}");
        assert_eq!(client.status().state, AiState::Offline);
    }

    #[test]
    fn links_to_a_mock_sidecar_end_to_end() {
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();

            let (kind, payload) = read_frame(&mut stream).unwrap();
            assert_eq!(kind, KIND_JSON);
            let hello: Value = serde_json::from_slice(&payload).unwrap();
            assert_eq!(hello["type"], "hello");
            assert_eq!(hello["protocol"], PROTOCOL_VERSION);
            assert_eq!(hello["sample_rate"], 48_000);
            assert_eq!(hello["chunk_frames"], 1_920);

            write_json(
                &mut stream,
                &json!({
                    "type": "ready",
                    "protocol": PROTOCOL_VERSION,
                    "backend": "passthrough",
                    "model": null,
                    "sample_rate": 48_000,
                    "chunk_frames": 1_920,
                    "rtf": 1.0,
                }),
            )
            .unwrap();

            let (kind, payload) = read_frame(&mut stream).unwrap();
            assert_eq!(kind, KIND_JSON);
            let configure: Value = serde_json::from_slice(&payload).unwrap();
            assert_eq!(configure["type"], "configure");
            assert_eq!(configure["pitch"], 2);
            write_json(&mut stream, &json!({ "type": "configured", "ok": true })).unwrap();

            let (kind, payload) = read_frame(&mut stream).unwrap();
            assert_eq!(kind, KIND_PING);
            assert!(payload.is_empty());
            write_frame(&mut stream, KIND_PONG, &[]).unwrap();

            let (kind, payload) = read_frame(&mut stream).unwrap();
            assert_eq!(kind, KIND_JSON);
            let shutdown: Value = serde_json::from_slice(&payload).unwrap();
            assert_eq!(shutdown["type"], "shutdown");
            write_json(&mut stream, &json!({ "type": "bye" })).unwrap();
        });

        let client = AiClient::new();
        let status = client.connect("127.0.0.1", port, 48_000, 1_920).unwrap();
        assert_eq!(status.state, AiState::Ready);
        assert_eq!(status.backend, "passthrough");
        assert_eq!(status.chunk_frames, 1_920);
        assert_eq!(status.rtf, 1.0);

        let status = client.configure(json!({ "pitch": 2 })).unwrap();
        assert_eq!(status.state, AiState::Ready);
        assert_eq!(status.message, "Параметры конвертера применены");

        let status = client.ping().unwrap();
        assert_eq!(status.state, AiState::Ready);
        assert!(status.roundtrip_ms.is_some());

        let status = client.disconnect();
        assert_eq!(status.state, AiState::Offline);
        server.join().unwrap();
    }

    /// End-to-end check against the stdlib-only reference server.
    ///
    /// Run explicitly:
    /// `cargo test engine::ai::tests::connects_to_reference_python_sidecar -- --ignored`
    #[test]
    #[ignore = "requires python and tools/ai-sidecar/sidecar.py"]
    fn connects_to_reference_python_sidecar() {
        use std::process::{Child, Command, Stdio};

        struct ChildGuard(Child);
        impl Drop for ChildGuard {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace root");
        let script = root.join("tools/ai-sidecar/sidecar.py");
        let port = 47_613u16;

        let child = Command::new("python")
            .arg(&script)
            .arg("--port")
            .arg(port.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("python must be on PATH");
        let _guard = ChildGuard(child);

        let client = AiClient::new();
        let mut last_error = String::new();
        for _ in 0..60 {
            match client.connect("127.0.0.1", port, 48_000, 1_920) {
                Ok(status) => {
                    assert_eq!(status.state, AiState::Ready);
                    assert_eq!(status.backend, "passthrough");
                    assert_eq!(status.chunk_frames, 1_920);

                    let status = client.configure(json!({ "pitch": 3 })).unwrap();
                    assert_eq!(status.state, AiState::Ready);
                    let status = client.ping().expect("ping must reach the sidecar");
                    assert!(status.roundtrip_ms.is_some());
                    assert_eq!(client.disconnect().state, AiState::Offline);
                    return;
                }
                Err(error) => {
                    last_error = error;
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
        panic!("reference sidecar did not start: {last_error}");
    }
}
