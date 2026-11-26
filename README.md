# Nexus-Mixer

**Студийная аудиоконсоль для Windows: 8 источников, 15 шин и 12 виртуальных кабелей.**
Микрофон, музыка, браузер, игры и Discord — в одной консоли с DSP, маршрутизацией
и голосовыми эффектами в реальном времени.

[English version](README.en.md)

[![Release](https://img.shields.io/github/v/release/roma1231jjj-cpu/Nexus-mixer?style=flat-square&label=release&color=8b5cf6)](https://github.com/roma1231jjj-cpu/Nexus-mixer/releases/latest)
[![Tests](https://img.shields.io/badge/tests-101%20passed-2ea043?style=flat-square)](#тесты)
[![Windows](https://img.shields.io/badge/platform-Windows%2010%2F11-4b5563?style=flat-square)](#установка)
[![Tauri](https://img.shields.io/badge/Tauri-2-24c8db?style=flat-square)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-realtime-b7410e?style=flat-square)](https://www.rust-lang.org)

> **Nexus × АутSquad** · v0.5.1 · Windows 10/11 x64 · интерфейс на русском и английском

Три темы в английском интерфейсе:

| Nexus-Studio | Nexus-Dark | Nexus-Frost |
| --- | --- | --- |
| ![](docs/screenshots/en-theme-studio.png) | ![](docs/screenshots/en-theme-dark.png) | ![](docs/screenshots/en-theme-light.png) |

| Настройки | Инструкция |
| --- | --- |
| ![](docs/screenshots/en-settings.png) | ![](docs/screenshots/en-guide.png) |

Русский интерфейс:

| Консоль | Настройки | Инструкция |
| --- | --- | --- |
| ![](docs/screenshots/ru-rack.png) | ![](docs/screenshots/ru-settings.png) | ![](docs/screenshots/ru-guide.png) |

Приборная панель, а не сайт: каналы, метры, маршрутизация и шины видны сразу,
без вкладок и лишних кликов.

---

## Язык интерфейса

Интерфейс полностью двуязычный — русский и английский. Переключение мгновенное,
без перезагрузки окна и без перезапуска движка.

- Кнопка **RU / EN** в тулбаре — справа, рядом с инструкцией.
- **Настройки → Интерфейс и поведение → Язык интерфейса** — там же переключатель
  на два положения.
- Выбор записывается в `localStorage` под ключом `nm-lang` и переживает
  перезапуск приложения. По умолчанию — русский.
- Названия каналов, шин и пресетов переключаются вместе с языком; собственные
  имена, которые вы ввели руками, остаются как есть.
- Тексты лотов, README и страницы релизов — тоже на двух языках.

Что не переводится намеренно: названия технологий (Voicemeeter, ASIO, VBAN,
WASAPI, VAC, dB, Hz), пути к файлам и имена устройств Windows.

---

## Три характера

Одна консоль, три оптики. Переключение — в тулбаре или в
**Настройки → Интерфейс и поведение**.

| **Nexus-Noir** — основная | **Nexus-Studio** — текущая | **Nexus-Frost** |
| --- | --- | --- |
| Чёрное стекло · фиолет | Матовая приборная панель | Белое стекло · синий |
| ![](.shots/nexus-dark-0.4.3.png) | ![](.shots/nexus-studio-0.4.3.png) | ![](.shots/nexus-light-0.4.3.png) |

Тема — это не смена цвета: пересобраны контраст текста, границы, свечение,
фейдеры, метры, селекторы устройств и модальные окна.

---

## Что нового в 0.5.1

- **Undo снова отменяет первое действие.** Снимок берётся из предыдущего
  состояния Zustand, а не из уже изменённого.
- **PANIC не откатывает каналы.** Запоминается только mute; громкость, FX и
  маршрутизация, сделанные после нажатия, остаются.
- **Momentary-макрос отпускает только своё.** Удержание кнопки больше не
  возвращает чужие изменения, сделанные в это время.
- **Клавиша не залипает.** Отпускание определяется по физической клавише, а не
  по текущим модификаторам; потеря фокуса сбрасывает все удержания.
- **Чистая установка снова находит микрофон.** Демонстрационные ID устройств
  убраны, первый запуск назначает реальный вход и Windows-выход.
- **Вернувшееся устройство переподключается.** Граф перезапускается не только
  при потере endpoint, но и при его возврате.
- **Soundpad без двойной громкости и гонки загрузки.** Preview использует master
  один раз, loop применяется при переключении, поздний decode повторяет sync.
- **Ручной выбор B1/B2 не перезаписывается** «ожидаемым» кабелем, а неудачный
  импорт не оставляет мусор в IndexedDB.

## Что нового в 0.5.0

- **PADS играет движок, а не браузер.** Сэмпл грузится в Rust-банк и звучит через
  выбранный канал, шину или мастер — со всеми FX, эквалайзером и панорамой этого
  пути. Файлы пэдов лежат в IndexedDB: перезапуск приложения их не теряет, а
  сэмпл без файла честно помечается «нет файла» и чинится кнопкой «Прикрепить».
- **Секвенсор попадает в сетку.** Шаги планируются по аудио-часу с запасом 25 мс,
  а не по таймеру React; паттерн, BPM и свинг сохраняются.
- **Рекордер не теряет хвост.** Перед закрытием файла очередь вычищается в WAV,
  настройки применяются к следующей сессии, а не к идущей, при пределе RIFF
  запись сама продолжается в новом сегменте. Пустая маска шин — ошибка, а не
  молчаливая запись «в A1».
- **Устройства больше не путаются.** Одинаковые имена получают устойчивый
  суффикс `#2`, формат входа с другим sample rate ресемплится в захвате, поддерживаются
  I16/U16/I32/F64 — не только F32.
- **Часы не уплывают.** Дрейф между входом и выходом компенсируется по
  заполнению кольца (±300 ppm), поэтому длинная запись не щёлкает.
- **Undo/Redo и сцены покрывают всё:** фейдеры, pan, mute/solo, маршрутизация,
  имена, FX, шины, master EQ, VCA, назначения устройств и AI-блок.
- **PANIC возвращает прежнее состояние**, а не просто снимает mute; моменты
  макросов (momentary) отпускаются корректно.
- **Ошибки видно.** У каждого вызова движка свой результат, старт/стоп больше не
  гоняются, в статусе настоящий размер буфера.

Полный список — в [CHANGELOG.md](CHANGELOG.md).

---

## Что нового в 0.4.0

- **Двуязычный интерфейс** — русский и английский, переключатель в тулбаре и в
  настройках, без перезагрузки.
- **Nexus-Noir** — основная чёрно-фиолетовая стеклянная тема с glow-границами.
- **Nexus-Studio** — привычная матовая тема сохранена как отдельный скин.
- **Nexus-Frost** — бело-синее стекло для светлого рабочего места.
- **Три формата поставки** — установщик, одиночный portable `.exe`, portable `.zip`.
- **Подпись Nexus × АутSquad** в титлбаре.
- Портативный `.exe` работает без папки `resources` — скрипт кабелей встроен.
- Старые сохранения мигрируют в **Nexus-Studio**, чтобы обновление не меняло
  привычный вид консоли само по себе.

Полный список — в [CHANGELOG.md](CHANGELOG.md).

---

## Что это

Nexus-Mixer встаёт между микрофоном, приложениями и устройствами вывода. Мы
собираем звук в один микшер, обрабатываем каждый канал, раздаём его по физическим
и виртуальным шинам — и отдаём Discord, OBS, Zoom и играм как обычный микрофон.

- **8 входов** — 6 аппаратных + 2 виртуальных.
- **3 физических выхода** — наушники, вторая пара, колонки.
- **12 независимых виртуальных кабелей** — VAC 4.70, линии `Nexus Cable B1…B12`.
- **Матрица 8 × 15** с уровнем посыла.
- **Realtime-движок Rust/WASAPI**, а не Web Audio.
- **Локальные голосовые пресеты** — работают сразу, без Python и скачивания моделей.

---

## Возможности

### Микшер

| | |
| --- | --- |
| Источники | `hw1…hw6`, `vaio`, `aux` — 8 слотов, 5 видны по умолчанию |
| Выходы | `A1` наушники, `A2` наушники 2, `A3` колонки, `B1…B12` кабели |
| Канал | gain, pan, phase, mono, mute, solo, 48V, tilt |
| Шина | EQ, limiter, delay 0–500 мс, stereo width 0–200 %, dim |
| Маршрутизация | клик — вкл/выкл, drag — уровень, клавиатура — доступно |
| VCA | группы с общим фейдером и mute, назначаются на каналы |

### Обработка

**Канал:** gate → compressor → 10-band EQ → de-esser → saturator → voice tilt.

- hum notches и high-pass для бюджетных конденсаторных микрофонов;
- «бархатная» цепочка: тёплый низ, контроль коробки, мягкий верх;
- gate с полным закрытием — кулеры и фон не проходят в Discord;
- 10-полосный параметрический EQ с интерактивной кривой;
- split-band de-esser, сатуратор и tilt.

**Шина:** 10-band EQ, lookahead limiter, delay, width, gain/dim/mute.

### Голос в реальном времени

Локальный DSP-движок работает без интернета, Python и ONNX-моделей:

- **Монстр** — глубокий, тяжёлый;
- **Демон** — максимально низкий;
- **Великан** — большой и спокойный;
- **Ребёнок** — высокий детский;
- **Женский** — мягкий женский тембр;
- **Пришелец** — тонкий и странный;
- **Робот** — кольцевая модуляция;
- **Шёпот** — воздушный;
- **Без эффекта** — обычный голос.

Плюс ручки **PITCH / FORMANT / MIX**, выбор источника и режимы **OFF / DSP / AI / HYBRID**.
Для настоящих RVC-моделей остаётся локальный Python-sidecar — он не обязателен для
встроенных голосов.

### Обновление

- Проверка обновлений при запуске и вручную: **Настройки → Обновления**.
- **0.5.1 собрана без updater-артефактов:** приватный ключ Tauri Updater
  недоступен, поэтому подписать `latest.json` нельзя. Автообновление с 0.5.0
  на 0.5.1 не сработает — установите 0.5.1 вручную поверх старой версии.
- Когда владелец вернёт `TAURI_SIGNING_PRIVATE_KEY`, достаточно пересобрать
  NSIS и опубликовать подписанный `latest.json`; публичный ключ в
  `src-tauri/tauri.conf.json` уже соответствует старым установкам.

### Ещё

- Трей, закрытие в трей, меню «Показать окно / Выход».
- Рекордер WAV 16/24/32-bit с выбором шин: настройки применяются к следующей сессии, хвост очереди не теряется, при пределе RIFF файл автоматически продолжается в новом сегменте, пустая маска шин не подменяется на A1.
- Макросы и горячие клавиши.
- MIDI Learn через Web MIDI.
- Undo/Redo для всех параметров микшера: фейдеры, pan, mute/solo, маршрутизация, имена, FX, шины, master EQ и VCA.
- Сцены хранят имена каналов, назначения устройств, настройки движка и полный AI-блок.
- PADS (Soundpad): сэмплы играет движок, а не Web Audio — звук идёт в выбранный канал, шину или мастер через их обработку; файлы пэдов лежат в IndexedDB и переживают перезапуск; секвенсор планирует шаги по аудио-времени и сохраняет паттерн.
- Сохранение состояния, кастомный frameless titlebar.
- Deep links: `?tab=ai`, `?strip=hw1`, `?bus=B1`, `?theme=studio|dark|light`,
  `?drawer=settings`, `?lang=ru|en`.

---

## Скачать

Все сборки лежат на [GitHub Releases](https://github.com/roma1231jjj-cpu/Nexus-mixer/releases/latest)
и разделены по версиям.

| Формат | Файл | Для чего |
| --- | --- | --- |
| Установщик | `Nexus-Mixer_0.5.1_x64-setup.exe` | обычная установка |
| Одиночный portable | `Nexus-Mixer_0.5.1_x64-portable.exe` | запуск без установки |
| Portable-архив | `Nexus-Mixer-0.5.1-portable.zip` | portable `.exe` + README |

Внутри проекта артефакты складываются в `release/vX.Y.Z/` и не смешиваются с
рабочими файлами. Структура описана в [release/README.md](release/README.md).

### Установка

1. Откройте [последний релиз](https://github.com/roma1231jjj-cpu/Nexus-mixer/releases/latest).
2. Скачайте установщик или portable-сборку.
3. Запустите **Nexus-Mixer**.
4. Для виртуальных кабелей установите **Virtual Audio Cable 4.70** (12 линий).
   Без него физические выходы работают, но виртуальные шины будут недоступны.

Установщик ставит приложение в `%LOCALAPPDATA%` (или выбранную папку).
В 0.5.1 автообновление приостановлено (см. раздел «Обновление»);
portable-сборка обновляется вручную.

---

## Сборка из исходников

Нужны **Node.js 22+**, **Rust 1.77+**, **MSVC Build Tools**, **Windows SDK** и WebView2.

```powershell
npm ci
npm run dev            # UI в браузере
npm run desktop:dev    # Tauri dev-окно
npm run desktop:build  # release NSIS
```

Проверки перед коммитом:

```powershell
npm run typecheck
npm run build
```

Сборка без updater-подписи (текущий режим 0.5.1):

```powershell
npx tauri build --no-bundle    # raw exe для portable
npx tauri build --bundles nsis # NSIS без .sig и latest.json
```

Сборка с автообновлением (только когда доступен приватный ключ):

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = "C:\path\to\nexus-updater.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
npx tauri build --no-bundle
npx tauri build --bundles nsis # NSIS + .sig + latest.json
```

Скрипт `scripts/release.ps1` собирает три формата, кладёт их в
`release/vX.Y.Z/`, считает SHA-256, создаёт GitHub Release и загружает
подписанный `latest.json` только при наличии ключа.

### Тесты

```powershell
cd src-tauri
cargo test --all-targets
```

54 теста движка: DSP, маршрутизация, VCA, метры, лимитер, рекордер, локальный
голосовой pitch-shifter.

---

## Версии

| Версия | Что важно |
| --- | --- |
| **0.5.0** | PADS через движок, рекордер без потерь, устройства и дрейф часов, полный undo/redo |
| **0.4.0** | двуязычный интерфейс, Nexus-Studio / Nexus-Noir / Nexus-Frost, 3 формата поставки |
| 0.3.1 | проверенное сквозное автообновление |
| 0.3.0 | локальные голоса, updater, GitHub Releases |
| 0.2.1 | 12 кабелей VAC, бархатная цепочка, стабильный старт движка |

---

## CI / Release

| Workflow | Что делает |
| --- | --- |
| [`ci.yml`](docs/workflows/ci.yml) | typecheck + Vite build + Rust tests |
| [`release.yml`](docs/workflows/release.yml) | NSIS, подпись, GitHub Release, `latest.json` |

> GitHub ограничивает загрузку `.github/workflows/*` токеном без scope `workflow`.
> Файлы лежат в [`docs/workflows`](docs/workflows) и готовы к переносу в
> `.github/workflows` после выдачи токену этого scope.

Релиз создаётся тегом:

```powershell
git tag v0.5.1
git push origin v0.5.1
```

Секреты репозитория:

| Secret | Значение |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | содержимое `nexus-updater.key` |

`GITHUB_TOKEN` выдаётся Actions автоматически.

---

## Архитектура

```
src/
  App.tsx                 каркас, deep links, auto-update check
  i18n/                   ru.ts + en.ts, словари по разделам, useT()/t()
  components/             Strip, Bus, RoutingMatrix, UpdateBanner, SettingsDrawer
  components/rack/        FX, Voice AI, Macros, Recorder, VCA Groups
  store/useMixer.ts       zustand + persist + theme migration
  store/useUpdater.ts     Tauri updater state machine
  lib/engineBridge.ts     typed invoke bridge
  lib/useEngineBridge.ts  sync, meters, device hot-plug
  styles/                 studio.css + console-v2.css + glass.css + lang.css

src-tauri/
  src/engine/             realtime graph, WASAPI runtime, DSP, recorder
  src/engine/dsp.rs       Biquad, gate, compressor, de-esser, pitch shifter
  src/engine/graph.rs     strip → routing → bus, local voice stage
  src/lib.rs              Tauri commands, tray, updater plugins
  tauri.conf.json         window, bundle, updater endpoint

docs/screenshots/         снимки интерфейса RU и EN
release/vX.Y.Z/           installer + portable exe + zip + latest.json
docs/workflows/           CI and signed release recipes
tools/ai-sidecar/         optional Python RVC sidecar
docs/                     architecture, AI, driver, roadmap
```

### Сигнальный путь

```
WASAPI input → strip gain/pan → gate → compressor → EQ
             → de-esser → saturator → local voice
             → routing matrix → bus EQ/limiter/gain → WASAPI output
```

Всё в audio callback без аллокаций, локов и паник. Параметры приходят
`Copy`-снимком между блоками.

---

## Документация

- [Архитектура](docs/ARCHITECTURE.md)
- [AI / Voice](docs/AI.md)
- [AI sidecar protocol](docs/AI_SIDECAR.md)
- [Виртуальный драйвер](docs/DRIVER.md)
- [Roadmap](docs/ROADMAP.md)
- [Changelog](CHANGELOG.md)
- [Release workflow](docs/workflows/release.yml)
- [Лицензия](LICENSE)
- [Безопасность](SECURITY.md)

---

## Ограничения

- Windows-only; WASAPI shared — основной режим.
- Виртуальные кабели требуют установленного VAC 4.70; лицензия VAC отдельная.
- Встроенные голоса — DSP-эффекты, а не нейросетевой клон голоса. RVC-модели
  подключаются через sidecar.
- Рекордер пишет WAV; FLAC/MP3 — в roadmap.
- Portable-сборка не устанавливает автообновление — обновляйте вручную.

---

## Лицензия

**Proprietary.** © 2026 Nexus × АутSquad. Все права защищены.

Исходный код публикуется для прозрачности и совместной разработки. Коммерческое
использование, перепаковка и распространение под другим именем — по письменному
разрешению авторов.
