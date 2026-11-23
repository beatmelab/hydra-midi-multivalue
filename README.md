# Hydra MIDI MultiValue

MIDI control for [Hydra](https://hydra.ojack.xyz/). Use pads to switch several shader parameters together and use faders or knobs to move through numeric ranges.

## Quick Start

Connect an APC Mini MK2 or APC40 MK2 and host `hydra-midi-multivalue.js` at an HTTPS URL. Paste this at the top of the Hydra editor in Chrome or Chromium, replace the URL with yours, and grant MIDI access when prompted.

```js
await loadScript("https://link.beatmelab.com/hydra-midi-multivalue")
await mvMidi.start()

osc(mv(10, 20, 30))
  .rotate(mv(0, 0.5, 1))
  .scale(vv(3, [0.5, 2]))
  .out()
```

On the APC Mini MK2, pads on notes 10 and 18 switch the oscillator frequency and rotation together. Note 2 selects the initial values. The fader sending CC 50 controls scale. For other MIDI devices, use the generic profile below.

## Why Use It

- Switch several parts of a patch together from one pad during a performance
- Adjust a parameter by feel while keeping it inside the range you set in the sketch

## Features

- Two pad modes for momentary or latched selection
- Shared pad selection across all `mv()` calls
- Absolute faders and relative encoders with negative and inverted ranges
- Active values highlighted in the editor, with inline readouts for faders and encoders
- RGB feedback for supported Akai pads
- Built-in controller profiles and configurable MIDI notes, channels, and CC mappings

## Pad and Fader Helpers

```js
mv(10, 20, 30)  // 10 by default, 20 and 30 on the first two alternate pads
vv(1, [0, 10])  // Map logical control 1 from MIDI CC 0–127 to 0–10
vv(1, [0, 10], 0.1)  // Smooth changes with a 100 ms time constant
vv(1, [0, 10], 0.5)  // Smooth changes with a 500 ms time constant
```

A pad selects the same position in every `mv()` call. If a call has no value at that position, it uses its first value.

| Pad mode | Behavior |
| -------- | -------- |
| Piano | Hold a pad to select its value. The most recently pressed assigned pad wins. Releasing the held pads restores the default. |
| Toggle | Press a pad to keep its value selected. Press it again to restore the default, or press another pad to switch. |

The default APC Mini MK2 mappings are:

| Control | MIDI note or CC |
| ------- | --------------- |
| Switch mode | Note 102 |
| Value 1 (initial) | Note 2 |
| Value 2 | Note 10 |
| Value 3 | Note 18 |
| Value 4 | Note 26 |
| Value 5 | Note 34 |
| Value 6 | Note 42 |
| Value 7 | Note 50 |
| Value 8 | Note 58 |
| `vv(3)` | CC 50 |

> [!NOTE]
> This default layout uses the third column of pads, which becomes the third row from the top when the APC Mini MK2 is turned vertically.

The APC40 MK2 profile uses note 1 for the initial value, notes 2–7 for alternate values, and note 0 to switch modes. In Piano mode, hold the initial pad to select the first value even while another pad is held. In Toggle mode, press the initial pad to return to the first value. The default mode is Piano.

Set `initialNote` to choose another note, or use `null` to disable the initial pad. Choose an `initialPad` if the LED uses a separate note. By default the LED follows `initialNote` when that pad supports LED feedback and is free. If the profile's initial note is used in `notes` or `modeNote`, set `initialNote` to a free note to enable it.

`vv()` reads absolute or relative 7-bit MIDI CC values. Absolute is the default. Set the endpoints in reverse order to invert the control, for example `vv(1, [2, 0.5])`.

The optional third argument sets exponential smoothing in seconds. Each `vv()` callback maintains its own smoothed value, including callbacks driven by the same control. After one time constant, it has covered about 63% of the distance to a constant target. Omitting the argument or passing `0` applies changes immediately. A new callback starts at the current MIDI value, so creating or re-evaluating a sketch does not reset it to the range's first endpoint. Its first evaluation initializes that value.

## Live Feedback in the Editor

Run a sketch with MIDI active and look at the arguments to `mv()` in the editor. An outline marks the first value by default. As you select a pad, it follows the value used by each call. If a call falls back to its first value, its outline does too.

An outlined readout next to each running `vv()` call shows the value in the range used by the sketch. For example, `vv(1, [0.5, 2])` can show `→ 1.25`. When one MIDI control drives several parameters, each readout uses its own range.

Feedback is enabled by default for direct `mv()` and `vv()` calls in Hydra's CodeMirror 5 editor on Chromium. Edits outside a call move its marker with the code. If you edit a call, run it again to restore its feedback. Feedback clears when Hydra stops evaluating a call or when you call `mvMidi.stop()`. Set `editorFeedback: false` in `mvMidi.start()` to hide it.

## Controller Profiles

| Profile | Default controls |
| ------- | ---------------- |
| `akai-apc-mini-mk2` | `vv(1)`–`vv(8)` follow faders 1–8 on CC 48–55. `vv(9)` uses the ninth fader on CC 56. The quick-start example uses fader 3, CC 50. RGB pad feedback is enabled. |
| `akai-apc40-mk2` | `vv(1)`–`vv(8)` use track faders on CC 7, MIDI channels 1–8. `vv(9)` uses master (CC 14), `vv(10)` uses crossfader (CC 15), `vv(11)`–`vv(18)` use track knobs (CC 48–55), and `vv(19)`–`vv(26)` use device knobs (CC 16–23). RGB pad feedback is enabled. |
| `generic` | Set your own notes and CC mappings. LED feedback defaults to off. |

The default `auto` profile detects the controller when exactly one of the two supported models is connected. If both are connected, choose the Akai profile and input explicitly. For other controllers, use `generic`.

```js
await mvMidi.start({
  profile: "generic",
  input: "My MIDI controller",
  notes: [36, 37, 38],
  modeNote: 39,
  initialNote: 40,
  ccMap: { 1: 21, 2: { cc: 7, channel: 2 } }
})
```

A numeric `ccMap` entry uses the configured CC channel. An object can specify its own channel or use `channel: "all"`. On the APC40 MK2, device knob messages can arrive on different channels as you change tracks in the controller's Generic mode.

## Relative Encoders

Set `relative` on each `ccMap` entry that receives increments. Choose the mode that matches your encoder and replace the CC number and channel with the ones it sends.

```js
await mvMidi.start({
  profile: "generic",
  input: "My MIDI controller",
  ccMap: { 1: { cc: 21, channel: 1, relative: "twos-complement" } }
})

osc().scale(vv(1, [0.5, 2])).out()
```

| `relative` mode | Byte for +1 | Byte for −1 |
| --------------- | ----------- | ----------- |
| `twos-complement` | 1 | 127 |
| `binary-offset` | 65 | 63 |
| `signed-bit` | 1 | 65 |
| `signed-bit-2` | 65 | 1 |

Each control starts at the first endpoint when you call `start()`. A one-step increment moves it by 1/127 of the range toward the second endpoint, and larger increments move it farther. The value stops at the endpoints. Calls to `vv()` using the same control ID share that position and can map it to different ranges.

## How it works internally

Hydra evaluates the callbacks returned by `mv()` and `vv()` as the sketch runs. The extension uses recently evaluated `mv()` callbacks to decide how many pads are assigned. If a callback stops running, its assignment expires after 1.4 seconds by default.

On supported RGB pads, dim yellow means configured but unused, green means assigned in the sketch, and red means active. The APC Mini MK2 uses the red single-color LED on button 102 for mode. It blinks in Piano mode and stays lit in Toggle mode. On the APC40 MK2, the mode pad pulses magenta in Piano mode and glows steadily in Toggle mode.

The extension uses the controller's standard MIDI LED messages and leaves its operating mode as configured.

## Programmatic API

The controller API is available through `window.mvMidi`.

```js
mvMidi.devices()
mvMidi.profiles()
mvMidi.state()
mvMidi.setMode("toggle")
mvMidi.setMode("piano")
mvMidi.stop()
```

`devices()` lists MIDI inputs and outputs after access is granted. `profiles()` lists built-in profiles. `state()` shows the selected profile, devices, mode, pads, and CC mappings.

Call `await mvMidi.start(options)` to switch profiles or devices. The current session stays active while the new request obtains MIDI access and validates its configuration. A newer start or a stop supersedes a pending start, which rejects with `AbortError` if MIDI access arrives afterward. Existing `vv()` callbacks use the new CC map and return the first endpoint of their range if their control is no longer mapped.

`stop()` removes the MIDI listeners and clears the managed LEDs. To add a built-in controller profile, edit `PROFILES` in `hydra-midi-multivalue.js` and add a `DETECTORS` entry if it supports automatic detection.

## MIDI Monitor

After calling `mvMidi.start()`, run `mvMidi.monitor()`. Press a pad or key to see its note number and MIDI channel, for example `Note 36 · CH 1`. Move a fader or encoder to see its `vv()` ID, CC number, channel and raw value, for example `vv(3) · CC 50 · CH 1 · Value 64`. Unmapped controls are labeled `Unmapped`. If a CC is mapped to multiple IDs, the monitor shows all of them. Relative encoders show the MIDI value they send. The monitor listens to the configured note and CC inputs, including notes and CCs outside the configured map or channel.

The latest message stays visible until another arrives. Use the close button or run `mvMidi.monitor(false)` to hide the HUD.

## Author

Gonzalo Ovejero · [@alt234vj](https://www.instagram.com/alt234vj) · [@beatmelab](https://www.instagram.com/beatmelab) · [beatmelab.com](https://www.beatmelab.com)
