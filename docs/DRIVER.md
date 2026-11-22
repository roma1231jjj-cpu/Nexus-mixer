# Виртуальный аудиодрайвер Nexus VAIO

> **Текущий статус: приложение работает через VB-CABLE.** Собственный драйвер
> собран, подписан и устанавливается, но на Windows-сборках с включённым WDAC
> (`Microsoft Windows Driver Policy`) ядро загружает только образы с подписью
> Microsoft — тестовая подпись там не действует. Поэтому по умолчанию шины B1/B2
> направляются в подписанные эндпоинты VB-CABLE (`CABLE Input`, `CABLE In 16ch`).
> Драйвер остаётся в репозитории для машин, где разрешён test-signing.

Документ описывает собственный драйвер виртуальных аудиоустройств Nexus-Mixer.
Это отдельный компонент: движок работает с обычными WASAPI-endpoint'ами и не
знает, физические они или виртуальные.

> **Честно о сроках.** Кернел-драйвер — самый долгий и рискованный кусок проекта.
> От нуля до стабильной подписанной версии — ориентировочно **6–10 недель** плюс
> время на сертификат и аттестацию Microsoft. До этого виртуальные шины работают
> в режиме эмуляции, а для реального звука можно временно использовать VB-CABLE.

---

## 1. Зачем свой драйвер

Готовые виртуальные кабели (VB-CABLE, VoiceMeeter) решают задачу, но:

- нельзя гарантировать совместимость и поведение при обновлениях;
- нельзя сделать 2/6/8-канальные endpoint'ы под конкретную матрицу;
- нельзя добавить собственные метрики, clock master и диагностику;
- лицензия и брендинг чужие.

Свой драйвер даёт полный контроль над топологией, задержкой и именованием.

---

## 2. Архитектура

### 2.1 Выбор технологии

| Вариант | Годится? | Комментарий |
| --- | --- | --- |
| **PortCls miniport (WaveRT)** | ✅ основной | штатный путь для аудиодрайверов, низкая задержка, sample SYSVAD |
| AVStream | ⚠️ | больше для видео/кастомных KS-фильтров |
| APO (Audio Processing Object) | ❌ | обрабатывает существующее устройство, не создаёт endpoint |
| User-mode WASAPI loopback | ❌ | не создаёт устройство, которое видят приложения |

Берём **PortCls + WaveRT**, за основу — Microsoft SYSVAD
(`Windows-driver-samples/audio/sysvad`, лицензия MIT).

### 2.2 Топология endpoint'ов

Одна виртуальная пара — это два endpoint'а:

```
Приложение (Discord/OBS)  ──play──►  [Nexus VAIO Input]   (render)
                                              │
                                              ▼  ring buffer
                                     Nexus-Mixer engine
                                              │
Приложение (OBS/игра)     ◄─record─  [Nexus VAIO Output]  (capture)
```

- **Nexus VAIO Input** — устройство воспроизведения. Приложения играют в него,
  движок это читает.
- **Nexus VAIO Output** — устройство записи. Движок пишет туда, приложения
  записывают оттуда.

Имена намеренно повторяют логику VoiceMeeter, чтобы пользователю было привычно.
Дополнительно создаётся пара **Nexus AUX Input/Output** для второго виртуального
канала (`aux`).

### 2.3 Что делает драйвер, а что движок

```
┌──────────────────────── kernel ────────────────────────┐
│  PortCls → Nexus VAIO miniport → WaveRT cyclic buffer  │
│  • создаёт endpoint'ы                                  │
│  • двигает позицию буфера по таймеру/прерыванию        │
│  • отдаёт события о заполнении                         │
└───────────────────────────┬────────────────────────────┘
                            │ shared memory + named events
┌───────────────────────────▼────────────────────────────┐
│  Nexus-Mixer engine (user mode)                        │
│  • читает render-буфер, пишет capture-буфер            │
│  • DSP, матрица, шины                                  │
│  • не знает, что endpoint виртуальный                  │
└────────────────────────────────────────────────────────┘
```

Драйвер **не делает DSP**. Он только транспортирует сэмплы между приложениями и
движком. Это резко упрощает отладку: любой щелчок либо в драйвере (позиция,
синхронизация), либо в движке (DSP), но не в обоих сразу.

### 2.4 Общая память

Два подхода:

1. **WaveRT-буфер, отображённый в user mode.** Штатный механизм: приложение/движок
   получает указатель на циклический буфер и позицию. Меньше кода, но буфер
   принадлежит конкретному stream.
2. **Собственная секция (`ZwCreateSection`) + IOCTL.** Драйвер создаёт раздел,
   user-mode движок маппит его через `MapViewOfFile`, события — `CreateEvent`.
   Гибче для нескольких клиентов и 6/8 каналов.

Рекомендация: начать с WaveRT (быстрее проверить), затем вынести общий микшер в
собственную секцию, когда появится multi-client.

Синхронизация: именованные события (`NexusVaioRenderReady`,
`NexusVaioCaptureReady`) + атомарные счётчики позиции. Никаких `KeWaitForSingleObject`
с бесконечным таймаутом в аудиопотоке.

---

## 3. Требования к окружению

| Компонент | Версия / примечание |
| --- | --- |
| Windows | 10 22H2 / 11, x64 (ARM64 — позже) |
| Visual Studio | 2022, workload **Desktop development with C++** |
| WDK | Windows Driver Kit, версия совпадает с Windows SDK |
| Windows SDK | 10.0.22621+ |
| Rust | ≥ 1.77 (для движка, не для драйвера) |
| Secure Boot | для test signing может потребоваться выключить |
| Тестовая машина | ВМ с чекпоинтами — обязательно |

Установка:

```powershell
winget install Microsoft.VisualStudio.2022.Community
# в Visual Studio Installer добавить:
#   Desktop development with C++
#   Windows Driver Kit (individual component)
#   Windows 10/11 SDK
```

Проверка:

```powershell
where signtool
where Inf2Cat
where MakeCert   # или New-SelfSignedCertificate в PowerShell
```

---

## 4. Этапы разработки

### Этап A — окружение и SYSVAD (1–2 недели)

- [ ] Собрать SYSVAD из `Windows-driver-samples` без изменений.
- [ ] Включить test signing и установить sample.
- [ ] Убедиться, что endpoint'ы видны в «Звук» и звук проходит.
- [ ] Настроить WinDbg (сеть или USB) и Driver Verifier.

```powershell
# администратор
bcdedit /set testsigning on
bcdedit /set nointegritychecks off
shutdown /r /t 0

# после перезагрузки
pnputil /add-driver .\sysvad.inf /install
```

Если Secure Boot включён, test signing может не примениться — либо выключить
Secure Boot на тестовой машине, либо сразу переходить к attestation-подписи.

### Этап B — собственные endpoint'ы (2–3 недели)

- [ ] Переименовать устройства в `Nexus VAIO Input/Output`, `Nexus AUX Input/Output`.
- [ ] Свои GUID'ы интерфейсов и `KSCATEGORY_AUDIO` / `KSCATEGORY_RENDER` / `KSCATEGORY_CAPTURE`.
- [ ] 2 канала по умолчанию, опционально 6/8.
- [ ] Частоты 44.1 / 48 / 96 кГц, формат float32.
- [ ] Стабильная установка/удаление через INF.

### Этап C — связь с движком (2–3 недели)

- [ ] Разделяемая память и события.
- [ ] Позиция буфера, обработка underrun/overrun.
- [ ] Проверка round-trip: тон 1 кГц, замер задержки.
- [ ] Стресс: 8 часов, sleep/resume, смена sample rate.

### Этап D — надёжность (2–4 недели)

- [ ] Multi-client (несколько приложений на один endpoint).
- [ ] Корректная работа при закрытии приложения-клиента.
- [ ] Driver Verifier, HLK-прогоны.
- [ ] Логи и ETW-трассировка.
- [ ] Обработка ошибок без BSOD.

### Этап E — подпись и релиз (4–8 недель, параллельно)

- [ ] EV code signing certificate (OV не подходит для новых kernel-драйверов).
- [ ] Аккаунт Partner Center, регистрация компании.
- [ ] Сборка пакета, `Inf2Cat`, `signtool`.
- [ ] Attestation signing через Partner Center (без WHQL).
- [ ] Опционально WHQL/HLK для максимального доверия.
- [ ] Подписанный установщик, проверка на чистой машине.

> Начиная с Windows 10 1607 новые kernel-mode драйверы должны быть подписаны
> Microsoft. Cross-signed сертификаты для новых драйверов не работают. Это
> означает, что финальный `.sys` проходит через Partner Center, а не только
> через ваш сертификат.

---

## 5. Структура драйвера

```
src-tauri/driver/
  nexusvaio.sln
  nexusvaio/
    nexusvaio.vcxproj
    adapter.cpp            # регистрация адаптера
    miniport.cpp           # IMiniportWaveRT
    miniportstream.cpp     # IMiniportWaveRTStream
    topology.cpp           # KS-топология, пины
    sharedmem.cpp          # раздел и события
    nexusvaio.inf
    nexusvaio.rc
  common/
    nexus_ioctl.h          # общие IOCTL и структуры
  install/
    install.ps1
    uninstall.ps1
```

Основные интерфейсы:

- `IMiniportWaveRT` — создание stream, свойства позиции.
- `IMiniportWaveRTStream` — выделение/освобождение буфера, `SetState`.
- `IMiniportAudioEngineNode` — опционально, для APO/громкости.
- `IKsControl` / KS properties — формат, интервалы, позиция.

---

## 6. Установка и отладка

```powershell
# сборка
msbuild nexusvaio.sln /p:Configuration=Release /p:Platform=x64

# подпись тестовым сертификатом
New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=Nexus Test" `
  -CertStoreLocation Cert:\LocalMachine\My
signtool sign /fd SHA256 /s My /n "Nexus Test" .\nexusvaio.sys
Inf2Cat /driver:. /os:10_X64
signtool sign /fd SHA256 /s My /n "Nexus Test" .\nexusvaio.cat

# установка
pnputil /add-driver .\nexusvaio.inf /install

# проверка
Get-PnpDevice -Class MEDIA | Where-Object FriendlyName -like "*Nexus*"
```

Отладка:

- WinDbg: `!drvobj nexusvaio 2`, `!irp`, `!ks.*`.
- `DbgView` + `DbgPrint` для быстрых сообщений.
- Driver Verifier: стандартные проверки + IRP logging.
- ETW-провайдер для позиции буфера и xrun.

---

## 7. Риски и меры

| Риск | Мера |
| --- | --- |
| BSOD на тестовой машине | ВМ + чекпоинты, Driver Verifier, поэтапное включение |
| Test signing не работает | выключить Secure Boot на тестовой машине |
| Долгая/дорогая подпись | начать оформление EV-сертификата на этапе B |
| Антивирус блокирует установку | подпись, понятный INF, документация |
| Sleep/resume ломает stream | обработка `IRP_MN_SET_POWER`, пересоздание буфера |
| Дрейф и щелчки | общий clock master, drift compensation в движке |
| Multi-client конфликты | отдельный stream на клиента, общий микс в user mode |
| Лицензия sample | SYSVAD под MIT, сохранить уведомление в `NOTICE` |

---

## 8. Временная альтернатива

Пока драйвер не готов, движок может работать через **VB-CABLE**:

- движок видит `CABLE Input` / `CABLE Output` как обычные WASAPI-endpoint'ы;
- в настройках показывается «внешний виртуальный кабель»;
- переключение на Nexus VAIO — смена `deviceId`, без изменений в DSP и UI.

Это позволяет тестировать маршрутизацию и AI уже на этапе 2, не блокируясь на
драйвере. Абстракция устройства в `engine::devices` для этого уже готова.

---

## 9. Критерии готовности

- [ ] `Nexus VAIO Input/Output` и `Nexus AUX Input/Output` видны без test mode.
- [ ] Установка/удаление через штатный установщик без перезагрузки.
- [ ] Задержка драйвера < 10 мс при 48 кГц / 256 кадрах.
- [ ] 8 часов непрерывной работы без xrun и утечек.
- [ ] Sleep/resume, смена default-устройства, hot-plug.
- [ ] Подпись Microsoft (attestation), установка на чистой Windows 11.
- [ ] Нет предупреждений Driver Verifier.
