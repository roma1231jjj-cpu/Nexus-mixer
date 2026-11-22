import {
  BookOpen,
  Cable,
  Disc3,
  Keyboard,
  Mic,
  Rocket,
  Route,
  SlidersHorizontal,
  Sparkles,
  Split,
  Wrench,
  X,
} from 'lucide-react'
import { useUi } from '../store/useUi'

const TOC = [
  { id: 'guide-start', label: 'Быстрый старт' },
  { id: 'guide-flow', label: 'Путь звука' },
  { id: 'guide-apps', label: 'Одно приложение' },
  { id: 'guide-buses', label: 'Шины' },
  { id: 'guide-strip', label: 'Канал' },
  { id: 'guide-fx', label: 'Эффекты и Voice' },
  { id: 'guide-extra', label: 'Запись и MIDI' },
  { id: 'guide-fix', label: 'Если не работает' },
  { id: 'guide-keys', label: 'Клавиши' },
]

const jump = (id: string) => {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

export function GuideSheet() {
  const open = useUi((s) => s.guideOpen)
  const setOpen = useUi((s) => s.setGuideOpen)
  if (!open) return null

  return (
    <>
      <div className="drawer-backdrop" onClick={() => setOpen(false)} />
      <aside className="guide-sheet glass-strong" role="dialog" aria-modal="true" aria-label="Инструкция Nexus-Mixer">
        <header className="drawer-head">
          <BookOpen size={16} className="accent" />
          <div>
            <h2>Инструкция</h2>
            <div className="sub">Nexus-Mixer · как пользоваться</div>
          </div>
          <button
            type="button"
            className="icon-btn"
            style={{ marginLeft: 'auto' }}
            onClick={() => setOpen(false)}
            aria-label="Закрыть инструкцию"
            data-tip="Закрыть (Esc)"
          >
            <X size={15} />
          </button>
        </header>

        <div className="guide-body">
          <section className="guide-hero">
            <span className="guide-kicker">Виртуальный микшер</span>
            <h3>Микрофон, обработка и виртуальные кабели в одном окне</h3>
            <p>
              Nexus-Mixer берёт звук с физических входов, обрабатывает его и отдаёт на выходные шины.
              Шины A1–A3 идут в колонки, наушники или сценический выход, а B1–B12 — в виртуальные кабели,
              которые приложения видят как обычный микрофон.
            </p>
            <div className="guide-pills">
              <span><Mic size={12} /> вход</span>
              <span><SlidersHorizontal size={12} /> обработка</span>
              <span><Cable size={12} /> виртуальный кабель</span>
            </div>
            <button type="button" className="guide-hero-link" onClick={() => jump('guide-apps')}>
              Как выключить ввод только в одном приложении →
            </button>
          </section>

          <nav className="guide-toc" aria-label="Разделы инструкции">
            {TOC.map((item) => (
              <button key={item.id} type="button" onClick={() => jump(item.id)}>
                {item.label}
              </button>
            ))}
          </nav>

          <section id="guide-start" className="guide-section">
            <h3><Rocket size={15} /> Быстрый старт</h3>
            <ol>
              <li>Проверьте индикатор <b>кабель</b> в строке состояния внизу. Если горит <b>нет кабеля</b> — установите Virtual Audio Cable (VAC) или VB-CABLE и перезагрузитесь.</li>
              <li>В канале <b>Микрофон</b> выберите свой микрофон в панели <b>FX → Вход</b>. Для остальных источников устройство выбирается там же.</li>
              <li>Внизу слева нажмите <b>START</b> — индикатор сменится на <b>RUNNING</b>. В браузерной демо-версии кнопка скрыта, работает симуляция.</li>
              <li>В Discord, OBS, Zoom или игре выберите микрофон <b>Nexus Cable B1 (Virtual Audio Cable)</b>.</li>
              <li>Говорите в микрофон — уровень должен появиться на канале и на шине. Если нет, проверьте кнопку <b>M</b> (Mute), маршрут <b>B1</b> и громкость.</li>
            </ol>
            <div className="guide-note">
              <b>Важно:</b> Nexus пишет в выход <b>Nexus Cable B1</b>, а приложение читает ту же линию как вход <b>Nexus Cable B1</b>.
              Это две стороны одного виртуального кабеля VAC, их не нужно выбирать в одном месте.
            </div>
          </section>

          <section id="guide-flow" className="guide-section">
            <h3><Route size={15} /> Как проходит звук</h3>
            <div className="guide-flow">
              <span>Микрофон</span>
              <i>→</i>
              <span>Канал: gain, EQ, FX</span>
              <i>→</i>
              <span>Маршрут A1 / B</span>
              <i>→</i>
              <span>Устройство вывода</span>
            </div>
            <p>
              Каждый канал можно отправить на несколько шин сразу. Кнопки <b>A1 A2 A3</b> и <b>B</b> под фейдером
              включают и выключают маршрут, а в матрице маршрутизации тот же маршрут можно сделать тоньше или громче.
              Шина суммирует все пришедшие в неё каналы и отправляет результат в выбранное устройство.
            </p>
            <p>
              <b>M</b> на канале глушит канал целиком — во всех шинах. <b>M</b> на шине глушит только эту шину.
              <b>S</b> (Solo) оставляет слышимыми только выбранные каналы.
            </p>
          </section>

          <section id="guide-apps" className="guide-section guide-key">
            <h3><Split size={15} /> Как выключить ввод только в одном приложении</h3>
            <p>
              Nexus-Mixer не перехватывает звук отдельных приложений и не умеет «мьютить» их по отдельности:
              он микширует <b>входы</b> (микрофоны, инструменты) и отдаёт один общий результат в шину.
              Поэтому если замьютить канал или шину, звук пропадёт у <b>всех</b> программ, которые слушают эту шину.
            </p>
            <p>
              <b>A1 — это выход</b> (колонки, наушники), а не отдельный вход для каждого приложения.
              Все приложения, слушающие A1, получают один и тот же микс с микрофона.
              Если несколько программ получают звук с одной шины (например B1), отключить ввод только одной
              из них средствами Nexus нельзя — нужен отдельный путь.
            </p>
            <div className="guide-grid">
              <div>
                <b>Вариант 1. Штатный mute приложения</b>
                <p>В самом Discord / Zoom / OBS нажмите их кнопку Mute. Остальные программы продолжат получать звук из Nexus.</p>
              </div>
              <div>
                <b>Вариант 2. Разные микрофоны</b>
                <p>Одной программе дайте физический микрофон напрямую, остальным — <b>Nexus Cable B1</b>. Тогда Nexus влияет только на вторую группу.</p>
              </div>
              <div>
                <b>Вариант 3. Отдельная шина</b>
                <p>Заведите программу на <b>B1</b>, а другую — на <b>B2</b>. В VAC 4.71 доступны 12 независимых линий, поэтому каждой программе можно дать свой кабель.</p>
              </div>
            </div>
            <div className="guide-note warn">
              <b>Коротко:</b> один виртуальный кабель = один общий микрофон для всех программ.
              Для независимого управления нужен отдельный кабель на каждую программу или её собственный mute.
            </div>
          </section>

          <section id="guide-buses" className="guide-section">
            <h3><Cable size={15} /> Выходы: куда идёт звук</h3>
            <p className="guide-arch-note">
              <b>A1 Наушники</b>, <b>A2 Наушники 2</b>, <b>A3 Колонки</b> — физические выходы.
              <b>B1 Discord | Стрим</b> — основная виртуальная шина, которую приложения видят как микрофон.
            </p>
            <ul>
              <li><b>A1 Наушники</b> — ваш основной выход. Сюда идёт то, что вы хотите слышать сами.</li>
              <li><b>A2 Наушники 2</b> — второй выход (если есть отдельная гарнитура).</li>
              <li><b>A3 Колонки</b> — на комнату, если колонки подключены отдельно.</li>
              <li><b>B1 Discord | Стрим</b> — виртуальная шина в <b>Nexus Cable B1</b>. Приложения видят её как микрофон.</li>
              <li><b>B2 Кабель 2</b> — вторая линия VAC; её можно отдать другой программе.</li>
              <li><b>B3–B12</b> — остальные линии VAC. Nexus подключает их автоматически; пока кабель не назначен, шина не активна.</li>
            </ul>
            <p>
              На каждой шине: ползунок громкости, <b>M</b> (Mute), <b>FX</b> (эквалайзер и лимитер).
              В строке под названием написано, какие источники сейчас играют в эту шину.
            </p>
          </section>

          <section id="guide-strip" className="guide-section">
            <h3><SlidersHorizontal size={15} /> Канал: что за что отвечает</h3>
            <ul>
              <li><b>Название</b> — кликните, чтобы переименовать. По умолчанию: Микрофон, Музыка, Браузер, Система, Игра.</li>
              <li><b>Ползунок</b> — громкость. Над ним — индикатор уровня (метер).</li>
              <li><b>PAN</b> — панорама: куда сместить звук (L / C / R).</li>
              <li><b>M / S</b> — Mute (выключить) и Solo (слышать только этот канал). <b>MONO</b> — свести стерео.</li>
              <li><b>FX</b> — открыть цепочку эффектов: гейт, компрессор, EQ, де-эссер, сатуратор.</li>
              <li><b>A1 / A2 / A3 и B</b> — маршрутизация: чипы включают выход, B открывает список кабелей B1–B12.</li>
            </ul>
            <p>
              Двойной клик по ползунку сбрасывает на 0 dB. Зажмите <b>Shift</b> для точной настройки.
            </p>
          </section>

          <section id="guide-fx" className="guide-section">
            <h3><Sparkles size={15} /> Эффекты и Voice</h3>
            <p>
              В панели <b>FX</b> собраны гейт, компрессор, эквалайзер, де-эссер и сатуратор. Их можно включать
              по отдельности и настраивать под свой голос. Пресеты в верхней панели применяют готовые цепочки.
            </p>
            <p>
              <b>Voice</b> — отдельный локальный модуль конверсии голоса. Он работает через Python-sidecar
              и не отправляет звук в интернет. Если sidecar не запущен, в панели будет состояние <b>offline</b>;
              остальной микшер при этом работает как обычно.
            </p>
            <p>
              <b>Macros</b> — кнопки, которые сразу меняют несколько параметров (mute, маршрут, пресет).
              <b>Groups</b> — VCA-группы: один фейдер управляет громкостью нескольких каналов.
            </p>
          </section>

          <section id="guide-extra" className="guide-section">
            <h3><Disc3 size={15} /> Запись, Pads и MIDI</h3>
            <ul>
              <li><b>Rec</b> — запись выбранных шин в WAV после обработки. Формат, битность и папка настраиваются в панели.</li>
              <li><b>Pads</b> — звуковая панель для быстрых эффектов и вставок.</li>
              <li><b>MIDI Learn</b> — подключите MIDI-контроллер, нажмите «Подключить» и назначьте CC на фейдеры, панораму или другие параметры.</li>
              <li><b>Пресеты</b> — сохраняйте свои настройки кнопкой с дискетой или <b>Ctrl+S</b>.</li>
            </ul>
          </section>

          <section id="guide-fix" className="guide-section">
            <h3><Wrench size={15} /> Если что-то не работает</h3>
            <ul>
              <li><b>нет кабеля</b> — не установлен Virtual Audio Cable. Установите VAC 4.71 или VB-CABLE, перезагрузите Windows и проверьте, что в системе есть <b>Nexus Cable B1</b>.</li>
              <li><b>Нет уровня на канале</b> — проверьте выбранное устройство, Mute, громкость Windows, приватность микрофона и кабель.</li>
              <li><b>Приложение не видит микрофон</b> — выберите <b>Nexus Cable B1</b> именно как устройство ввода, а не вывода.</li>
              <li><b>Треск и XRUN</b> — увеличьте буфер в настройках (например, 512 или 1024), закройте тяжёлые программы, смените WASAPI Shared на Exclusive только если устройство поддерживает.</li>
              <li><b>Нет звука в колонках</b> — проверьте, что шина A1 указывает на нужное устройство и не стоит Mute/DIM.</li>
              <li><b>Voice offline</b> — запустите sidecar командой <code>python tools/ai-sidecar/sidecar.py</code> или оставьте Voice выключенным.</li>
            </ul>
          </section>

          <section id="guide-keys" className="guide-section">
            <h3><Keyboard size={15} /> Горячие клавиши</h3>
            <div className="guide-keys">
              <span><kbd>F1</kbd> эта инструкция</span>
              <span><kbd>Ctrl+K</kbd> список клавиш</span>
              <span><kbd>Ctrl+S</kbd> сохранить пресет</span>
              <span><kbd>Ctrl+Z</kbd> отменить FX</span>
              <span><kbd>Ctrl+Shift+M</kbd> Mute all — заглушить всё</span>
              <span><kbd>C</kbd> матрица</span>
              <span><kbd>R</kbd> Voice</span>
              <span><kbd>Esc</kbd> закрыть панель</span>
              <span><kbd>Двойной клик</kbd> сброс</span>
            </div>
          </section>

          <footer className="guide-footer">
            Nexus-Mixer · виртуальный микшер для Windows · Virtual Audio Cable / VB-CABLE для виртуальных шин.
          </footer>
        </div>
      </aside>
    </>
  )
}
