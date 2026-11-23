import type { Guide } from '../ru/guide'

export const guide: Guide = {
  'guide.title': 'Guide',
  'guide.sub': 'Nexus-Mixer · how to use it',
  'guide.aria': 'Nexus-Mixer guide',
  'guide.tocAria': 'Guide sections',
  'guide.closeAria': 'Close the guide',
  'guide.closeTip': 'Close (Esc)',
  'guide.hero.kicker': 'Virtual mixer',
  'guide.hero.title': 'Microphone, processing and virtual cables in one window',
  'guide.hero.p1':
    'Nexus-Mixer takes audio from physical inputs, processes it and sends it to output buses. Buses A1–A3 feed speakers, headphones or a stage output, while B1–B12 feed virtual cables that apps see as a regular microphone.',
  'guide.hero.pill.in': 'input',
  'guide.hero.pill.fx': 'processing',
  'guide.hero.pill.cable': 'virtual cable',
  'guide.hero.link': 'How to mute input in a single app only →',

  'guide.toc.start': 'Quick start',
  'guide.toc.flow': 'Signal path',
  'guide.toc.apps': 'One app only',
  'guide.toc.buses': 'Buses',
  'guide.toc.strip': 'Channel',
  'guide.toc.fx': 'FX and Voice',
  'guide.toc.extra': 'Recording and MIDI',
  'guide.toc.fix': 'If it does not work',
  'guide.toc.keys': 'Keys',

  'guide.start.title': 'Quick start',
  'guide.start.li1':
    'Check the **cable** indicator in the status bar at the bottom. If it reads **no cable**, install Virtual Audio Cable (VAC) or VB-CABLE and reboot.',
  'guide.start.li2':
    'On the **Microphone** channel pick your microphone in the **FX → Input** panel. Other sources are assigned in the same place.',
  'guide.start.li3':
    'Press **START** in the bottom left corner — the indicator switches to **RUNNING**. In the browser demo the button is hidden and the simulation runs instead.',
  'guide.start.li4':
    'In Discord, OBS, Zoom or a game select the **Nexus Cable B1 (Virtual Audio Cable)** microphone.',
  'guide.start.li5':
    'Speak into the microphone — level should appear on both the channel and the bus. If it does not, check the **M** (Mute) button, the **B1** route and the volume.',
  'guide.start.note':
    '**Important:** Nexus writes to the **Nexus Cable B1** output, and the app reads the same line as the **Nexus Cable B1** input. These are two sides of one VAC virtual cable, so you never pick them in the same place.',

  'guide.flow.title': 'How the signal travels',
  'guide.flow.step1': 'Microphone',
  'guide.flow.step2': 'Channel: gain, EQ, FX',
  'guide.flow.step3': 'Route A1 / B',
  'guide.flow.step4': 'Output device',
  'guide.flow.p1':
    'Every channel can feed several buses at once. The **A1 A2 A3** and **B** buttons under the fader switch the route on and off, and the routing matrix lets the same route be quieter or louder. A bus sums every channel sent to it and sends the result to the chosen device.',
  'guide.flow.p2':
    '**M** on a channel silences that channel everywhere. **M** on a bus silences only that bus. **S** (Solo) leaves only the selected channels audible.',

  'guide.apps.title': 'How to mute input in a single app only',
  'guide.apps.p1':
    'Nexus-Mixer does not capture individual apps and cannot mute them separately: it mixes **inputs** (microphones, instruments) and sends one shared result to a bus. So muting a channel or a bus removes the sound from **every** app listening to that bus.',
  'guide.apps.p2':
    '**A1 is an output** (speakers, headphones), not a separate input for each app. Every app listening to A1 receives the same microphone mix. If several apps get audio from one bus (B1 for example), Nexus alone cannot disable the input for just one of them — that needs a separate path.',
  'guide.apps.opt1.t': 'Option 1. The app own mute',
  'guide.apps.opt1.p':
    'Use the Mute button inside Discord / Zoom / OBS itself. The other apps keep receiving audio from Nexus.',
  'guide.apps.opt2.t': 'Option 2. Different microphones',
  'guide.apps.opt2.p':
    'Give one app the physical microphone directly and the rest **Nexus Cable B1**. Then Nexus only affects the second group.',
  'guide.apps.opt3.t': 'Option 3. A separate bus',
  'guide.apps.opt3.p':
    'Put one app on **B1** and another on **B2**. VAC 4.71 provides 12 independent lines, so every app can get its own cable.',
  'guide.apps.note':
    '**In short:** one virtual cable is one shared microphone for all apps. Independent control needs a separate cable per app or the app own mute.',

  'guide.buses.title': 'Outputs: where the sound goes',
  'guide.buses.arch':
    '**A1 Headphones**, **A2 Headphones 2**, **A3 Speakers** are physical outputs. **B1 Discord | Stream** is the main virtual bus that apps see as a microphone.',
  'guide.buses.li1': '**A1 Headphones** — your main output. This is what you want to hear yourself.',
  'guide.buses.li2': '**A2 Headphones 2** — a second output (for a spare headset).',
  'guide.buses.li3': '**A3 Speakers** — for the room, when speakers are connected separately.',
  'guide.buses.li4':
    '**B1 Discord | Stream** — a virtual bus on **Nexus Cable B1**. Apps see it as a microphone.',
  'guide.buses.li5': '**B2 Cable 2** — the second VAC line; it can be given to another app.',
  'guide.buses.li6':
    '**B3–B12** — the remaining VAC lines. Nexus connects them automatically; a bus stays inactive until a cable is assigned.',
  'guide.buses.p1':
    'Each bus has a volume slider, **M** (Mute) and **FX** (equalizer and limiter). The line under the name shows which sources currently play into that bus.',

  'guide.strip.title': 'Channel: what does what',
  'guide.strip.li1':
    '**Name** — click it to rename. Defaults: Microphone, Music, Browser, System, Game.',
  'guide.strip.li2': '**Slider** — volume. The level meter sits above it.',
  'guide.strip.li3': '**PAN** — panorama: where to place the sound (L / C / R).',
  'guide.strip.li4':
    '**M / S** — Mute and Solo (hear only this channel). **MONO** — fold stereo to mono.',
  'guide.strip.li5':
    '**FX** — open the effects chain: gate, compressor, EQ, de-esser, saturator.',
  'guide.strip.li6':
    '**A1 / A2 / A3 and B** — routing: the chips toggle an output, B opens the list of cables B1–B12.',
  'guide.strip.p1': 'Double click a slider to reset it to 0 dB. Hold **Shift** for fine adjustment.',

  'guide.fx.title': 'FX and Voice',
  'guide.fx.p1':
    'The **FX** panel holds the gate, compressor, equalizer, de-esser and saturator. Each one can be enabled separately and tuned to your voice. The presets in the top bar apply ready-made chains.',
  'guide.fx.p2':
    '**Voice** is a separate local voice conversion module. It runs through a Python sidecar and never sends audio to the internet. When the sidecar is not running the panel shows **offline**; the rest of the mixer keeps working as usual.',
  'guide.fx.p3':
    '**Macros** are buttons that change several parameters at once (mute, route, preset). **Groups** are VCA groups: one fader controls the volume of several channels.',

  'guide.extra.title': 'Recording, Pads and MIDI',
  'guide.extra.li1':
    '**Rec** records the selected buses to WAV after processing. Format, bit depth and folder are configured in the panel.',
  'guide.extra.li2': '**Pads** is a sound board for quick effects and stingers.',
  'guide.extra.li3':
    '**MIDI Learn** — connect a MIDI controller, press Connect and map CC messages to faders, panorama or other parameters.',
  'guide.extra.li4': '**Presets** — store your settings with the floppy button or **Ctrl+S**.',

  'guide.fix.title': 'If something does not work',
  'guide.fix.li1':
    '**no cable** — Virtual Audio Cable is not installed. Install VAC 4.71 or VB-CABLE, reboot Windows and make sure **Nexus Cable B1** exists in the system.',
  'guide.fix.li2':
    '**No level on the channel** — check the selected device, Mute, the Windows volume, microphone privacy settings and the cable.',
  'guide.fix.li3':
    '**The app does not see the microphone** — select **Nexus Cable B1** as an input device, not as an output.',
  'guide.fix.li4':
    '**Crackles and XRUN** — raise the buffer in settings (512 or 1024 for example), close heavy apps and switch WASAPI Shared to Exclusive only if the device supports it.',
  'guide.fix.li5':
    '**No sound in the speakers** — check that bus A1 points to the right device and that Mute/DIM is off.',
  'guide.fix.li6':
    '**Voice offline** — start the sidecar with `python tools/ai-sidecar/sidecar.py` or leave Voice disabled.',

  'guide.keys.title': 'Keyboard shortcuts',
  'guide.keys.f1': 'this guide',
  'guide.keys.ctrlK': 'shortcut list',
  'guide.keys.ctrlS': 'save a preset',
  'guide.keys.ctrlZ': 'undo FX',
  'guide.keys.muteAll': 'Mute all — silence everything',
  'guide.keys.c': 'matrix',
  'guide.keys.r': 'Voice',
  'guide.keys.esc': 'close the panel',
  'guide.keys.dbl': 'Double click',
  'guide.keys.dblValue': 'reset',
  'guide.footer':
    'Nexus-Mixer · virtual mixer for Windows · Virtual Audio Cable / VB-CABLE for virtual buses.',
}
