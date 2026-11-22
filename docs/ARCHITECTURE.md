# Архитектура Nexus-Mixer

Документ описывает, как устроен проект сейчас и как в него встраиваются
Rust-движок, виртуальный драйвер и ИИ-конверсия.

---

## 1. Слои

```
┌──────────────────────────────────────────────────────────────┐
│  React UI (Vite + TypeScript)                                │
│  zustand store · компоненты · пресеты · localStorage          │
└───────────────────────────┬──────────────────────────────────┘
                            │ invoke / events
┌───────────────────────────▼──────────────────────────────────┐
│  Tauri shell (Rust)                                          │
│  команды · окно · tray · lifecycle · логи                    │
└───────────────────────────┬──────────────────────────────────┘
                            │ Arc<EngineState>
┌───────────────────────────▼──────────────────────────────────┐
│  Audio engine (Rust)                                         │
│  capture threads → ring buffers → DSP graph → playback       │
│  WAV recorder · meters · AI bridge (IPC)                     │
└───────────────┬──────────────────────────────┬───────────────┘
                │ WASAPI shared/exclusive       │ named pipe / localhost
┌───────────────▼──────────────┐   ┌───────────▼────────────────┐
│  Физические устройства       │   │  AI sidecar (Python/ONNX)   │
│  микрофоны, колонки, loopback│   │  RVC · denoise · resample   │
└──────────────────────────────┘   └────────────────────────────┘
                ▲
┌───────────────┴──────────────┐
│  VB-CABLE (WHQL) endpoints  │   виртуальные шины B1/B2
└──────────────────────────────┘
```

Ключевое правило: **UI никогда не работает со звуком напрямую**. Он описывает
желаемое состояние, движок приводит к нему реальный граф. Это позволяет держать
браузерную версию и desktop-версию на одном коде.

---

## 2. Frontend

### 2.1 Состояние

Единый стор `src/store/useMixer.ts` (zustand + `persist`):

- `strips`, `buses` — аудиомодель;
- `engine`, `recorder`, `ai` — настройки подсистем;
- `presets`, `macros`, `aiModels` — библиотеки;
- `status` — телеметрия (не персистится);
- `theme`, выбранный канал, открытая вкладка рэка.

`partialize` сохраняет только пользовательские данные. `devices` и `status` всегда
приходят из окружения, чтобы не тащить в localStorage устаревшие endpoint id.

Соло реализовано вычисляемо: `soloActive` — производный флаг, `isStripAudible()`
учитывает mute и solo. В аудиопоток уходит уже разрешённое состояние.

### 2.2 Мост в Rust

`src/lib/engineBridge.ts` — тонкая типизированная обёртка над `invoke`:

| Команда | Аргумент | Результат |
| --- | --- | --- |
| `list_audio_devices` | — | `AudioDeviceInfo[]` |
| `get_engine_status` | — | `EngineStatus` |
| `set_engine_config` | `{ config: EngineSettings }` | `EngineStatus` |
| `set_mixer_state` | `{ snapshot }` | `null` |
| `get_mixer_state` | — | последний snapshot |
| `start_engine` | — | `Result<EngineStatus, String>` |
| `stop_engine` | — | `EngineStatus` |
| `get_meter_levels` | — | `{ strips, buses }` в dBFS или `null` |
| `get_engine_info` | — | `RuntimeInfo` с реальной частотой, числом потоков и предупреждениями |
| `get_recorder_status` | — | `RecorderStatus` (файл, секунды, дропы, ошибка) |
| `get_driver_status` | — | `DriverStatus` |

`src/lib/useEngineBridge.ts`:

1. при старте читает статус, конфиг и устройства, нормализует устаревшие mock-id;
2. подписывается на стор и шлёт snapshot с debounce 60 мс (склейка drag-событий);
3. раз в секунду опрашивает статус, раз в 3 секунды — `runtimeInfo`, 20 Гц — метры,
   раз в секунду — статус рекордера.

Метры публикуются в `src/audio/meterBus.ts` (module-level store без React-render),
а `useMeter` читает оттуда целевые значения в своём RAF-цикле. В браузере
`engineBridge.available === false`, хуки становятся no-op, метры работают на
симуляции. Контракт метра (`MeterRefs`) один и тот же, поэтому замена источника
данных не затрагивает компоненты.

### 2.3 Стили

- `base.css` — токены, темы, aurora-фон, общие утилиты.
- `layout.css` — каркас, titlebar, toolbar, доска, рэк, статус-бар.
- `panels.css` — контролы, FX-панели, матрица, drawer, адаптив.
- `redesign.css` — актуальная визуальная система 0.2: токены, консольная сетка,
  док-рэк, состояния каналов и таблиц; подключается последней.

Тема задаётся `data-theme` на `<html>`; `main.tsx` применяет её до первого paint,
чтобы не было вспышки. Глубокие ссылки читаются в `main.tsx` (тема) и `App.tsx`
(вкладка, канал, drawer).

---

## 3. Rust-движок

### 3.1 Модули

| Модуль | Ответственность |
| --- | --- |
| `engine::model` | serde-модели, camelCase на проводе, значения по умолчанию |
| `engine::devices` | перечисление endpoint'ов через `cpal` (WASAPI) |
| `engine::buffer` | lock-free SPSC ring: capture → mix и master → follower-шины |
| `engine::dsp` | biquad, envelope, gate, компрессор, de-esser, сатуратор, лимитер, метры |
| `engine::graph` | 5×5 граф, `MixerParams` → `GraphParams`, `MeterBank` |
| `engine::runtime` | `cpal`-потоки, clock master, рекордерный tap, `EngineStats` |
| `engine::recorder` | lock-free tap + отдельный поток WAV-writer |
| `engine::state` | `Arc<EngineState>`: конфиг, snapshot, запуск/остановка, публикация параметров |
| `lib.rs` | команды Tauri, инициализация, логирование |

`dsp.rs` не знает про I/O и не аллоцирует после конструктора. Это позволяет
тестировать его обычным `cargo test` без звуковой карты.

### 3.2 Сигнальный граф

```
hw1 ─┐
hw2 ─┤
hw3 ─┼─► input gain ─► phase ─► gate ─► comp ─► EQ ─► de-ess ─► sat ─► tilt ─┐
vaio ┤                                                                       │
aux ─┘                                                                       │
                                       ┌─────────────────────────────────────┘
                                       ▼
                              routing matrix (5×5, dB per send)
                                       │
        ┌──────────────┬───────────────┼───────────────┬──────────────┐
        ▼              ▼               ▼               ▼              ▼
       A1             A2              A3              B1             B2
        │              │               │               │              │
   EQ→delay→width→gain→mono→limiter ─┬─► master WASAPI stream (clock) ──► recorder tap
                                      └─► SPSC ring ─► follower WASAPI stream
```

Порядок фиксирован и совпадает с UI-рэком. Пользовательские параметры
маппятся 1:1 в `*Params` структуры `dsp.rs`.

### 3.3 Потоки

| Поток | Что делает | Ограничения |
| --- | --- | --- |
| UI / Tauri main | команды, сериализация | может блокироваться |
| `nexus-audio` (control) | открывает потоки, держит их живыми, ждёт stop | блокируется на `recv()` |
| Capture (на устройство) | читает WASAPI, пишет в SPSC | без malloc, без lock |
| Master output | читает SPSC входов, DSP, пишет во все шины, делает recorder tap | без malloc, без lock |
| Follower output (на шину) | читает SPSC своей шины | без malloc, без lock |
| `nexus-recorder` | WAV-writer, split, status | отдельный поток, диск |
| AI sidecar | RVC-инференс | отдельный процесс, TCP/JSON + PCM |
| `nexus-ai` | realtime dry/wet обмен | следующий этап, SPSC-кольца |

Параметры публикуются как `GraphParams` — `Copy`-структура фиксированного размера
в bounded `crossbeam`-канале. Аудиопоток забирает последний снимок на границе
блока и никогда не берёт `RwLock` в callback. Snapshot UI и конфиг хранятся под
`parking_lot::Mutex` только в control-слое.

### 3.4 Задержка

```
latency_ms = buffer_size / sample_rate * 1000 + safety_ms
```

Для 48 кГц / 256 кадров / 4 мс safety: `5.33 + 4 = 9.33 мс` — это только движок.
Фактическая частота и размер буфера берутся из открытого master-стрима, поэтому
статус-бар показывает реальные значения, а не запрошенные. Полный round-trip
добавляет задержку драйвера, AI-чанк и WASAPI.

### 3.5 Обработка ошибок и деградация

- Перечисление устройств устойчиво к отдельным сбоям: одно битое устройство не
  скрывает остальные.
- `start_engine` возвращает `Result<_, String>`; UI показывает toast с причиной.
- Если ни одна шина не привязана к доступному выходу, движок открывает Windows
  default output и добавляет предупреждение в `RuntimeInfo`.
- Повторные endpoint'ы дедуплицируются: одна и та же шина/вход не открывается
  дважды. Нормализация устройств отдаёт default output только первой физической
  шине, которой нужен endpoint; остальные остаются пустыми до явного выбора,
  чтобы не создавать заведомо пропускаемые дубликаты.
- Логирование — `tracing`, никогда не роняет старт: `try_init()` игнорирует
  повторную инициализацию.

### 3.6 AI sidecar

Control-plane клиент живёт в `engine/ai.rs`. Он не касается аудиопотока:
подключение, handshake и ping выполняются по команде UI, а статус кэшируется в
`RwLock` и попадает в `EngineStatus.ai`. Tauri-команды:
`connect_ai_sidecar`, `disconnect_ai_sidecar`, `get_ai_status`,
`ping_ai_sidecar`, `configure_ai_sidecar`.

- Транспорт: TCP `127.0.0.1:47600`, кадры `[u32 len][u8 kind][payload]`,
  таймауты connect 1.5 с, handshake 3 с, операций 2 с.
- Ошибка handshake/IO переводит статус в `error` и закрывает сокет; UI снова
  предлагает «Подключить».
- `EngineStatus.ai` содержит state, backend, model, sample rate, chunk frames,
  RTF, endpoint, message и измеренный `roundtripMs`.
- Backend `passthrough` честно означает отсутствие конверсии. Realtime-тракт
  (`nexus-ai`, dry/wet SPSC, crossfade) и ONNX/RVC — следующий этап.
- Underrun/overrun считаются аудиопотоком через `AtomicU64`; CPU-load считается
  как отношение времени обработки блока к дедлайну и сглаживается.
- Рекордер никогда не блокирует audio callback: при переполнении кольца кадры
  дропаются, счётчик виден в UI.
- **Hot-plug:** UI раз в 4 секунды сравнивает отпечаток списка endpoint'ов. Если
  устройство, назначенное каналу или шине, исчезло, назначения нормализуются на
  доступные fallback и граф пересобирается. Перезапуски ограничены одним раз в
  15 секунд, чтобы не мигать при нестабильном USB/Bluetooth.
- **Watchdog:** `EngineStatus.frames` — счётчик кадров master-callback. Если он не
  растёт три опроса подряд, UI вызывает `restartEngine()` и показывает toast.
- **Трей и жизненный цикл:** при `runInTray` кнопка закрытия прячет окно вместо
  выхода; меню трея умеет показать окно, скрыть его и завершить процесс. Смена
  `runInTray`/`startWithWindows` не перезапускает аудиопотоки — перезапуск
  происходит только при изменении API, частоты, буфера, каналов, safety или
  clock master.

---

## 4. Модель данных

`src/types.ts` — источник истины для UI. Rust-модели в `engine/model.rs`
сериализуются в camelCase, поэтому структуры совпадают поле-в-поле:

| TS | Rust |
| --- | --- |
| `StripId`, `BusId` | `String` в snapshot (свободная форма) |
| `EngineSettings` | `EngineConfig` |
| `EngineStatus` | `EngineStatus` |
| `RuntimeInfo` | `RuntimeInfo` |
| `MeterLevels` | `MeterLevels` |
| `RecorderStatus` | `RecorderStatus` |
| `RecorderSettings` | `RecorderParams` |
| `DriverStatus` | `DriverStatus` |
| `AudioDevice` | `AudioDeviceInfo` |
| `EqBand`, FX-параметры | `*Params` в `dsp.rs` |

Правило: любое новое поле сначала появляется в `types.ts`, затем в Rust-модели,
затем в DSP. Snapshot всегда передаётся как plain JSON — без кастомной
сериализации и без версионирования на уровне команд (версия живёт в persist).

---

## 5. Тестирование

- **UI:** `npm run typecheck`, `npm run build`; интерактивные проверки через
  headless Chrome (mute, routing, keyboard fader, preset, theme, drawer).
- **DSP и граф:** `cargo test` в `src-tauri` — 43 зелёных теста: biquad, gate,
  компрессор, лимитер, сатуратор, de-esser, pan law, width, smoother, SPSC,
  маршрутизация, метры и WAV-рекордер (пишет и валидирует реальный файл).
- **WASAPI smoke:** `cargo test -- --ignored` — два теста, которым нужны реальные
  endpoint'ы:
  - `engine_starts_with_default_device` — открывает default output, проверяет,
    что master callback выполняется;
  - `engine_opens_capture_and_playback` — открывает default mic + speakers,
    прогоняет граф, проверяет конечные метры и записывает WAV.
- **Интеграция:** loopback-тест тон 1 кГц через виртуальную пару VB-CABLE —
  проверено вручную, автоматический тест требует установленного кабеля.
- **AI:** офлайн-прогон RVC на эталонных wav, метрики RTF и артефактов.

---

## 6. Безопасность и приватность

- CSP в Tauri отключён только на время разработки; перед релизом включается
  строгий CSP.
- Никаких сетевых запросов из движка. ИИ работает локально.
- Модели и пресеты — обычные файлы в пользовательской папке, без автозагрузки
  кода.
- Capabilities ограничены управлением окном; новые permissions добавляются
  точечно.

---

## 7. Что дальше

Полный план — в [ROADMAP.md](ROADMAP.md). Ближайшие технические шаги:

1. `IMMNotificationClient` вместо 4-секундного опроса и кроссфейд при смене
   устройства во время работы.
2. Soak-тест: 10 минут непрерывной работы без xrun и роста памяти.
3. FLAC/MP3-энкодеры и честный статус формата в рекордере.
4. Автозапуск с Windows и запуск свёрнутым в трей.
5. Realtime AI-тракт: `nexus-ai`, dry/wet SPSC-кольца, чанки и crossfade;
   затем ONNX/RVC backend в sidecar.
6. DSP-режим ИИ: питч/формант-шифтер + RNNoise.
7. Довести собственный драйвер до подписи Microsoft (сейчас шины идут через
   VB-CABLE), см. [DRIVER.md](DRIVER.md).
