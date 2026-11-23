/*
Hydra MIDI MultiValue
Version: 1.0.0

Usage in Hydra editor:
  await loadScript("https://link.beatmelab.com/hydra-midi-multivalue")
  await mvMidi.start()

  osc(mv(10, 20, 30))
    .rotate(mv(0, 0.5, 1))
    .scale(vv(3, [0.5, 2]))
    .out()

Author: @alt234vj | @beatmelab | https://www.beatmelab.com

*/
(function (root) {
  'use strict';

  if (root.mvMidi && typeof root.mvMidi.stop === 'function') root.mvMidi.stop();

  const DEFAULT_APC_NOTES = [2, 3, 4, 5, 6, 7];
  const DEFAULT_APC_INITIAL_NOTE = 1;
  const DEFAULT_APC_CC = Object.freeze(Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [i + 1, i + 48])
  ));
  const APC40_CC = Object.freeze({
    ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [i + 1, { cc: 7, channel: i + 1 }])),
    9: { cc: 14, channel: 'all' },      // Master fader
    10: { cc: 15, channel: 'all' },     // Crossfader
    ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [i + 11, { cc: 48 + i, channel: 'all' }])),
    ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [i + 19, { cc: 16 + i, channel: 'all' }]))
  });
  const RELATIVE_CC_DECODERS = Object.freeze({
    'twos-complement': value => value < 64 ? value : value - 128,
    'binary-offset': value => value - 64,
    'signed-bit': value => value < 64 ? value : 64 - value,
    'signed-bit-2': value => value < 64 ? -value : value - 64
  });
  const APC_EFFECTS = Object.freeze({
    pulse: { '1/24': 0x96, '1/16': 0x97, '1/8': 0x98, '1/4': 0x99, '1/2': 0x9a },
    blink: { '1/24': 0x9b, '1/16': 0x9c, '1/8': 0x9d, '1/4': 0x9e, '1/2': 0x9f }
  });
  const DEFAULT_COLORS = Object.freeze({ off: 0, available: 100, assigned: 21, active: 5 });
  const DEFAULT_MODE_COLORS = Object.freeze({ on: 53 });
  const DEFAULT_LED_VALUES = Object.freeze({ off: 0, available: 1, assigned: 2, active: 3, modeOn: 4, modeOff: 5 });
  const PROFILES = Object.freeze({
    'akai-apc-mini-mk2': Object.freeze({
      input: 'apc', output: 'apc', notes: [10, 18, 26, 34, 42, 50, 58], modeNote: 102,
      ccMap: DEFAULT_APC_CC, feedback: true, ledProtocol: 'apc-mini-mk2'
    }),
    'akai-apc40-mk2': Object.freeze({
      input: 'apc40', output: 'apc40', notes: DEFAULT_APC_NOTES, modeNote: 0,
      channel: 1, ccChannel: 'all', ccMap: APC40_CC,
      feedback: true, ledProtocol: 'apc40-mk2'
    }),
    generic: Object.freeze({
      input: null, output: null, notes: [], modeNote: null,
      ccMap: {}, feedback: false, ledProtocol: 'none'
    })
  });
  const DETECTORS = [
    { profile: 'akai-apc-mini-mk2', regex: /\bapc\s*mini\s*(?:mk\s*(?:2|ii)|mark\s*(?:2|ii))\b/i },
    { profile: 'akai-apc40-mk2', regex: /\bapc\s*40\s*(?:mk\s*(?:2|ii)|mark\s*(?:2|ii))\b/i }
  ];

  let config = resolveConfig({ profile: 'akai-apc-mini-mk2' });
  let startRequestId = 0;

  let access = null;
  let running = false;
  let timer = null;
  let input = null;
  let output = null;
  let noteMonitor = null;
  let modeType = 'piano';
  let selectedIndex = 0;
  let pianoCarry = false;
  let modeButtonDown = false;
  const held = new Set();
  const activity = new Map();
  const ccValues = new Map();
  const relativeCcPositions = new Map();
  const ccInputs = new Set();
  const ledCache = new Map();
  const editorFeedback = createEditorFeedback();
  let nextId = 1;
  let assigned = 0;

  const now = () => root.performance?.now?.() ?? Date.now();
  function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }
  const matches = (port, q) => port && port.state === 'connected' &&
    (q === null || (port.name || '').toLowerCase().includes(q));

  function rankPort(p) {
    const n = (p.name || '').toLowerCase();
    // Port 0 is the standard controller port on APC Mini Mk2; prefer it
    // over another listed MIDI output when both have matching names.
    return (/(port\s*0)/.test(n) ? 16 : 0) +
      (/(midi\s*(in|out)\s*1|midi(in|out)1|^apc mini mk2$)/.test(n) ? 4 : 0) -
      (/(port\s*1|midi\s*(in|out)\s*2|midi(in|out)2|notes)/.test(n) ? 8 : 0);
  }
  function pickPort(ports, query) {
    return ports.filter(p => matches(p, query)).sort((a, b) => rankPort(b) - rankPort(a))[0] || null;
  }
  function integerBetween(n, name, lo, hi) {
    if (!Number.isInteger(n) || n < lo || n > hi)
      throw new Error(`mvMidi: ${name} must be an integer ${lo}..${hi}.`);
  }
  function validNoteList(list, name) {
    if (!Array.isArray(list)) throw new Error(`mvMidi: ${name} must be an array.`);
    for (const n of list) integerBetween(n, name, 0, 127);
    if (new Set(list).size !== list.length)
      throw new Error(`mvMidi: ${name} cannot contain duplicates.`);
  }
  function queryName(v, name) {
    if (v !== null && typeof v !== 'string')
      throw new Error(`mvMidi: ${name} must be a MIDI port name fragment or null.`);
    return v === null ? null : v.toLowerCase();
  }
  function channelNumber(v, name) {
    if (v !== 'all') integerBetween(v, name, 1, 16);
  }
  function mapCC(base, extra = {}) {
    for (const map of [base, extra]) {
      if (!map || typeof map !== 'object' || Array.isArray(map))
        throw new Error('mvMidi: ccMap must be an object such as {1:21, 2:22}.');
    }
    const merged = { ...base, ...extra };
    for (const [id, cc] of Object.entries(merged)) {
      if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))
        throw new Error('mvMidi: ccMap keys must be positive integer control IDs.');
      if (Number.isInteger(cc)) {
        integerBetween(cc, `ccMap[${id}]`, 0, 127);
      } else if (cc && typeof cc === 'object' && !Array.isArray(cc)) {
        const { cc: number, channel, relative } = cc;
        integerBetween(number, `ccMap[${id}].cc`, 0, 127);
        channelNumber(channel, `ccMap[${id}].channel`);
        const mapping = { cc: number, channel };
        if (relative !== undefined) {
          if (typeof relative !== 'string' || !has(RELATIVE_CC_DECODERS, relative)) {
            const modes = Object.keys(RELATIVE_CC_DECODERS).join(', ');
            throw new Error(`mvMidi: ccMap[${id}].relative must be one of ${modes}.`);
          }
          mapping.relative = relative;
        }
        merged[id] = mapping;
      } else {
        throw new Error(`mvMidi: ccMap[${id}] must be CC number or {cc, channel}.`);
      }
    }
    return merged;
  }
  function palette(base, extra, keyName) {
    if (extra !== undefined && (!extra || typeof extra !== 'object' || Array.isArray(extra)))
      throw new Error(`mvMidi: ${keyName} must be an object.`);
    const result = { ...base, ...(extra || {}) };
    Object.entries(result).forEach(([k, v]) => integerBetween(v, `${keyName}.${k}`, 0, 127));
    return result;
  }
  function detectProfile(midiAccess) {
    const inputs = [...midiAccess.inputs.values()].filter(p => p.state === 'connected');
    const found = inputs.flatMap(p => DETECTORS.filter(d => d.regex.test(p.name || ''))
      .map(d => ({ profile: d.profile, portName: p.name })));
    const types = [...new Set(found.map(d => d.profile))];
    if (types.length > 1) throw new Error(
      'mvMidi: several supported controllers connected (' + types.join(', ') + '). Specify profile and input explicitly.'
    );
    if (!found.length) throw new Error(
      'mvMidi: auto could not identify a supported controller. Inputs: ' +
      (inputs.map(p => p.name).join(', ') || '(none)') +
      '. Use profile:"generic" with notes/ccMap, or specify a supported profile.'
    );
    if (found.length > 1) console.warn('[mvMidi] Multiple matching input ports; prioritizing port 0 / first MIDI port.');
    return found.sort((a, b) => rankPort({ name: b.portName }) - rankPort({ name: a.portName }))[0];
  }
  function profileConfig(which) {
    if (typeof which === 'string') {
      if (!has(PROFILES, which)) throw new Error(`mvMidi: unknown profile "${which}". Try "auto", "generic", "akai-apc-mini-mk2" or "akai-apc40-mk2".`);
      return { name: which, base: PROFILES[which] };
    }
    if (which && typeof which === 'object' && !Array.isArray(which))
      return { name: typeof which.name === 'string' ? which.name : 'custom', base: { ...PROFILES.generic, ...which } };
    throw new Error('mvMidi: profile must be a built-in name or a configuration object.');
  }

  function resolvePads(options) {
    const { notes, modeNote, ledProtocol } = options;
    const pads = options.pads === undefined ? notes : options.pads;
    const rgbFeedback = ledProtocol === 'apc-mini-mk2' || ledProtocol === 'apc40-mk2';
    function supportsPad(note) {
      if (ledProtocol === 'apc-mini-mk2') return note <= 63;
      if (ledProtocol === 'apc40-mk2') return note <= 39 || (note >= 82 && note <= 86);
      return ledProtocol === 'note-velocity';
    }
    function supportsModePad(note) {
      return supportsPad(note) || (ledProtocol === 'apc-mini-mk2' &&
        ((note >= 100 && note <= 107) || (note >= 112 && note <= 119)));
    }

    validNoteList(notes, 'notes');
    validNoteList(pads, 'pads');
    if (rgbFeedback && pads.some(pad => !supportsPad(pad)))
      throw new Error('mvMidi: pads must be RGB pads supported by the selected APC profile.');
    if (notes.length !== pads.length)
      throw new Error('mvMidi: notes and pads must have the same length.');
    if (modeNote !== null) {
      integerBetween(modeNote, 'modeNote', 0, 127);
      if (notes.includes(modeNote))
        throw new Error('mvMidi: modeNote cannot also appear in notes.');
    }

    const modePad = options.modePad === undefined
      ? (modeNote !== null && supportsModePad(modeNote) ? modeNote : null)
      : options.modePad;
    if (modePad !== null) {
      integerBetween(modePad, 'modePad', 0, 127);
      if (rgbFeedback && !supportsModePad(modePad))
        throw new Error('mvMidi: modePad must be a supported LED for the selected APC profile.');
      if (pads.includes(modePad))
        throw new Error('mvMidi: modePad cannot also appear in pads.');
      if (modeNote === null) throw new Error('mvMidi: modePad requires modeNote.');
    }

    const preferredInitialNote = ledProtocol === 'apc-mini-mk2' ? 2 : DEFAULT_APC_INITIAL_NOTE;
    const defaultInitialNote = rgbFeedback && modeNote !== preferredInitialNote &&
      !notes.includes(preferredInitialNote) ? preferredInitialNote : null;
    const initialNote = options.initialNote === undefined ? defaultInitialNote : options.initialNote;
    if (initialNote !== null) {
      integerBetween(initialNote, 'initialNote', 0, 127);
      if (notes.includes(initialNote) || initialNote === modeNote)
        throw new Error('mvMidi: initialNote must differ from notes and modeNote.');
    }
    const initialPad = options.initialPad === undefined
      ? (initialNote !== null && supportsPad(initialNote) && !pads.includes(initialNote) && initialNote !== modePad
        ? initialNote : null)
      : options.initialPad;
    if (initialPad !== null) {
      integerBetween(initialPad, 'initialPad', 0, 127);
      if (rgbFeedback && !supportsPad(initialPad))
        throw new Error('mvMidi: initialPad must be a supported RGB pad for the selected APC profile.');
      if (pads.includes(initialPad) || initialPad === modePad)
        throw new Error('mvMidi: initialPad must differ from pads and modePad.');
      if (initialNote === null) throw new Error('mvMidi: initialPad requires initialNote.');
    }

    return { notes: notes.slice(), pads: pads.slice(), modeNote, modePad, initialNote, initialPad };
  }

  function resolveLedConfig(options, outputQuery) {
    const feedback = options.feedback === true;
    const { ledProtocol } = options;
    if (!['none', 'apc-mini-mk2', 'apc40-mk2', 'note-velocity'].includes(ledProtocol))
      throw new Error('mvMidi: invalid ledProtocol. Use "none", "apc-mini-mk2", "apc40-mk2" or "note-velocity".');
    if (feedback && ledProtocol === 'none')
      throw new Error('mvMidi: LED feedback requires an explicit ledProtocol. Use "note-velocity" if supported.');
    if (feedback && ledProtocol === 'note-velocity' && outputQuery === null)
      throw new Error('mvMidi: generic LED feedback requires an explicit output device name.');

    const ledChannel = options.ledChannel ?? 1;
    const colors = palette(DEFAULT_COLORS, options.colors, 'colors');
    const modeColors = palette(DEFAULT_MODE_COLORS, options.modeColors, 'modeColors');
    modeColors.off ??= modeColors.on;
    const ledValues = palette(DEFAULT_LED_VALUES, options.ledValues, 'ledValues');
    const modeOnEffect = options.modeOnEffect ?? 'pulse';
    const ledBrightness = options.ledBrightness ?? 7;
    const modeOffBrightness = options.modeOffBrightness ?? (modeOnEffect === 'solid' ? ledBrightness : 7);
    integerBetween(ledChannel, 'ledChannel', 1, 16);
    integerBetween(ledBrightness, 'ledBrightness', 1, 7);
    integerBetween(modeOffBrightness, 'modeOffBrightness', 1, 7);

    const modeOnRate = options.modeOnRate ?? '1/8';
    let modeEffectStatus = null;
    if (modeOnEffect !== 'solid') {
      if (modeOnEffect !== 'pulse' && modeOnEffect !== 'blink')
        throw new Error('mvMidi: modeOnEffect must be "solid", "pulse" or "blink".');
      const rates = APC_EFFECTS[modeOnEffect];
      const supportedRate = modeOnEffect !== 'pulse' || modeOnRate !== '1/24' || ledProtocol === 'apc40-mk2';
      if (!supportedRate || !has(rates, modeOnRate))
        throw new Error(`mvMidi: invalid rate ${modeOnRate} for ${modeOnEffect}.`);
      modeEffectStatus = rates[modeOnRate];
    }

    return {
      feedback, ledProtocol, ledChannel, colors, modeColors, ledValues,
      ledBrightness, modeOffBrightness, modeEffectStatus
    };
  }

  function resolveConfig(options, midiAccess) {
    const { profile: choice = 'auto' } = options;
    const detected = choice === 'auto' ? detectProfile(midiAccess) : null;
    const { name, base } = profileConfig(detected?.profile ?? choice);
    const settings = { ...base, ...options };
    const pads = resolvePads(settings);

    const defaultMode = settings.defaultMode ?? 'piano';
    if (!['piano', 'toggle'].includes(defaultMode))
      throw new Error('mvMidi: defaultMode must be "piano" or "toggle".');
    const channel = settings.channel ?? 1;
    const ccChannel = settings.ccChannel ?? channel;
    channelNumber(channel, 'channel');
    channelNumber(ccChannel, 'ccChannel');

    const inputName = detected && options.input === undefined ? detected.portName : settings.input;
    const inputQuery = queryName(inputName, 'input');
    const outputQuery = queryName(settings.output, 'output');
    const ccFollowInput = settings.ccInput === undefined;
    const ccInputQuery = ccFollowInput ? inputQuery : queryName(settings.ccInput, 'ccInput');
    const ccMap = mapCC(base.ccMap ?? {}, options.ccMap);
    const leds = resolveLedConfig(settings, outputQuery);

    const activeWindowMs = settings.activeWindowMs ?? 1400;
    const scanMs = settings.scanMs ?? 200;
    if (!Number.isFinite(activeWindowMs) || activeWindowMs < 250)
      throw new Error('mvMidi: activeWindowMs must be >= 250.');
    if (!Number.isFinite(scanMs) || scanMs < 50)
      throw new Error('mvMidi: scanMs must be >= 50.');

    return {
      profile: name, autoDetected: Boolean(detected), defaultMode, ...pads,
      inputQuery, outputQuery, ccFollowInput, ccInputQuery, channel, ccChannel, ccMap,
      ...leds, activeWindowMs, scanMs, editorFeedback: settings.editorFeedback !== false
    };
  }

  function findEditorCall(editor, name, from, argumentCount) {
    const closingBracket = { '(': ')', '[': ']', '{': '}' };
    const args = [];
    const brackets = [];
    let readingName = true;
    let readingOpen = true;
    let argument = null;
    for (let line = from.line; line <= editor.lastLine(); line++) {
      for (const token of editor.getLineTokens(line, true)) {
        if (line === from.line && token.start < from.ch) continue;
        const { string, type } = token;
        if (!string.trim() || type === 'comment') continue;
        if (readingName) {
          if (line !== from.line || token.start !== from.ch || string !== name ||
            !/^(variable(?:-[23])?|property)$/.test(type)) return null;
          readingName = false;
          continue;
        }
        const punctuation = type === null ? string : '';
        if (readingOpen) {
          if (punctuation !== '(') return null;
          readingOpen = false;
          continue;
        }
        if (!brackets.length && (punctuation === ',' || punctuation === ')')) {
          if (argument) args.push(argument);
          argument = null;
          if (punctuation === ')') {
            return args.length === argumentCount ? { args, end: { line, ch: token.end } } : null;
          }
          continue;
        }
        if (has(closingBracket, punctuation)) brackets.push(closingBracket[punctuation]);
        else if (punctuation === ')' || punctuation === ']' || punctuation === '}') {
          if (brackets.pop() !== punctuation) return null;
        } else if (type === 'string-2') {
          // The JavaScript mode tokenizes template interpolation boundaries as string-2.
          if (string.endsWith('${')) brackets.push('template');
          else if (string === '}' && brackets.at(-1) === 'template') brackets.pop();
        }
        argument ??= { from: { line, ch: token.start } };
        argument.to = { line, ch: token.end };
      }
    }
    return null;
  }

  function createEditorFeedback() {
    const outlineCss = 'outline:2px solid #6ff4d0;border-radius:2px';
    let bindings = new Map();
    let editor = null;
    let desktop = false;
    let frame = null;
    let evaluation = null;

    function captureEvaluation(event) {
      if (event.key !== 'Enter' || (!desktop && !editor.getWrapperElement().contains(event.target))) return;
      const firstLine = editor.firstLine();
      let line = editor.getCursor().line;
      let ch = 0;
      if (event.ctrlKey && !event.altKey) {
        if (event.shiftKey) line = firstLine;
        else if (desktop && editor.somethingSelected()) ({ line, ch } = editor.getCursor('from'));
      } else if (event.altKey && !event.ctrlKey && !event.shiftKey) {
        if (desktop) line = root.getCodeBlockData().start;
        // Hydra web includes the empty line at the start of the block.
        else while (line > firstLine && editor.getLine(line) !== '') line--;
      } else return;
      evaluation = { event, line, ch };
    }

    function bind(name, argumentCount) {
      if (!editor) return null;
      const caller = new Error().stack?.split('\n')[3] || '';
      const location = /eval at .*<anonymous>:(\d+):(\d+)\)$/.exec(caller);
      if (!location) return null;
      const evalLine = Number(location[1]);
      // Both Hydra editors wrap evaluated text in an async function. Web adds four spaces.
      const origin = evaluation?.event.eventPhase ? evaluation : { line: editor.firstLine(), ch: 0 };
      const firstLineOffset = desktop ? origin.ch : -4;
      const from = {
        line: origin.line + evalLine - 2,
        ch: Number(location[2]) - 1 + (evalLine === 2 ? firstLineOffset : 0)
      };
      if (from.line < editor.firstLine() || from.ch < 0) return null;
      const key = `${from.line}:${from.ch}`;
      const existing = bindings.get(key);
      if (existing) return existing.args.length === argumentCount ? existing : null;
      const call = findEditorCall(editor, name, from, argumentCount);
      if (!call) return null;
      const start = editor.indexFromPos(from);
      const args = call.args.map(range => ({
        from: editor.indexFromPos(range.from) - start,
        to: editor.indexFromPos(range.to) - start
      }));
      const binding = {
        key, name, args, text: editor.getRange(from, call.end),
        anchor: editor.markText(from, call.end),
        lastSeen: -Infinity, value: undefined, rendered: undefined, marker: null
      };
      bindings.set(key, binding);
      return binding;
    }

    function clearMarker(binding) {
      binding.marker?.clear();
      binding.marker = null;
      binding.rendered = undefined;
    }

    function draw() {
      frame = null;
      const time = now();
      editor.operation(() => {
        for (const binding of bindings.values()) {
          const location = binding.anchor.find();
          if (!location) {
            clearMarker(binding);
            bindings.delete(binding.key);
            continue;
          }
          if (time - binding.lastSeen > config.activeWindowMs) {
            if (binding.marker) clearMarker(binding);
            continue;
          }
          if (binding.name === 'mv') {
            if (binding.rendered === binding.value) continue;
            clearMarker(binding);
            const { from, to } = binding.args[binding.value];
            const start = editor.indexFromPos(location.from);
            binding.marker = editor.markText(editor.posFromIndex(start + from), editor.posFromIndex(start + to), {
              className: 'mv-midi-active',
              css: outlineCss
            });
            binding.rendered = binding.value;
          } else {
            const label = `→ ${Number(binding.value.toPrecision(4))}`;
            if (binding.rendered === label) continue;
            if (!binding.marker) {
              binding.widget = root.document.createElement('span');
              binding.widget.className = 'mv-midi-reading';
              binding.widget.style.cssText = `${outlineCss};display:inline-block;margin-inline-start:.45em;padding:0 .3em;min-width:6ch;font-variant-numeric:tabular-nums;pointer-events:none`;
              binding.widget.textContent = label;
              binding.marker = editor.setBookmark(location.to, { widget: binding.widget });
            } else {
              binding.widget.textContent = label;
              binding.marker.changed();
            }
            binding.rendered = label;
          }
        }
      });
    }

    function schedule() {
      if (frame === null && bindings.size) frame = root.requestAnimationFrame(draw);
    }

    function track(binding, value, time) {
      if (!binding || bindings.get(binding.key) !== binding) return;
      time ??= now();
      if (binding.value !== value || time - binding.lastSeen > config.activeWindowMs) schedule();
      binding.value = value;
      binding.lastSeen = time;
    }

    function updateLocations() {
      evaluation = null;
      const currentBindings = new Map();
      editor.operation(() => {
        for (const binding of bindings.values()) {
          const range = binding.anchor.find();
          if (!range || editor.getRange(range.from, range.to) !== binding.text) {
            binding.anchor.clear();
            clearMarker(binding);
            continue;
          }
          binding.key = `${range.from.line}:${range.from.ch}`;
          currentBindings.set(binding.key, binding);
        }
      });
      bindings = currentBindings;
    }

    function start() {
      if (editor || !root.requestAnimationFrame) return;
      const doc = root.document;
      const element = doc?.querySelector('#editor-container .CodeMirror') || doc?.querySelector('.CodeMirror');
      const candidate = element?.CodeMirror;
      if (!candidate?.getLineTokens || !candidate.setBookmark) return;
      editor = candidate;
      desktop = typeof root.runLine === 'function' && typeof root.getCodeBlockData === 'function';
      editor.on('changes', updateLocations);
      doc.addEventListener('keydown', captureEvaluation, true);
    }

    function stop() {
      if (!editor) return;
      editor.off('changes', updateLocations);
      root.document.removeEventListener('keydown', captureEvaluation, true);
      if (frame !== null) root.cancelAnimationFrame(frame);
      frame = null;
      evaluation = null;
      editor.operation(() => {
        for (const binding of bindings.values()) {
          binding.anchor.clear();
          clearMarker(binding);
        }
      });
      bindings.clear();
      editor = null;
    }

    return { start, stop, bind, track, schedule };
  }

  function liveCount() {
    const t = now();
    let max = 1;
    for (const [id, entry] of activity) {
      if (t - entry.lastSeen > config.activeWindowMs) activity.delete(id);
      else max = Math.max(max, entry.length);
    }
    return Math.min(config.notes.length, max - 1);
  }
  function noteIndex(note) {
    if (config.initialNote !== null && note === config.initialNote) return 0;
    const index = config.notes.indexOf(note);
    return index < 0 ? index : index + 1;
  }
  function newestHeldIndex() {
    let newest = 0;
    for (const note of held) {
      const index = noteIndex(note);
      if (index >= 0 && index <= assigned) newest = index;
    }
    return newest;
  }
  // Return a list because APC40 needs separate primary/secondary color commands.
  function ledMessages(pad, key) {
    const { ledProtocol, ledChannel, colors, modeColors, ledValues,
      ledBrightness, modeOffBrightness, modeEffectStatus } = config;
    if (ledProtocol === 'none') return [];
    if (ledProtocol === 'note-velocity') return [[0x90 + ledChannel - 1, pad, ledValues[key]]];
    if (ledProtocol === 'apc-mini-mk2' && pad === config.modePad && pad >= 100) {
      const value = key === 'off' ? 0 : key === 'modeOn' && modeEffectStatus !== null ? 2 : 1;
      return [[0x90, pad, value]];
    }

    const color = key === 'modeOn' ? modeColors.on : key === 'modeOff' ? modeColors.off : colors[key];
    if (ledProtocol === 'apc-mini-mk2') {
      let status = 0x90 + ledBrightness - 1;
      if (key === 'modeOn' && modeEffectStatus !== null) status = modeEffectStatus;
      else if (key === 'modeOff') status = 0x90 + modeOffBrightness - 1;
      return [[status, pad, color]];
    }
    if (modeEffectStatus !== null && (key === 'modeOn' || key === 'modeOff')) {
      // A shared mode color needs a dark primary for the animation to be visible.
      const primary = key === 'modeOn' && modeColors.on === modeColors.off ? colors.off : modeColors.off;
      return [[0x90, pad, primary], [modeEffectStatus, pad, color]];
    }
    return [[0x90, pad, color]];
  }
  function sendLed(pad, key) {
    if (!output) return;
    const messages = ledMessages(pad, key);
    if (!messages.length) return;
    const cacheKey = messages.map(m => m.join(':')).join('|');
    if (ledCache.get(pad) === cacheKey) return;
    try { messages.forEach(message => output.send(message)); ledCache.set(pad, cacheKey); }
    catch (err) { console.warn('[mvMidi] LED send failed:', err); }
  }
  function blankManagedLeds(port) {
    const { feedback, ledProtocol, pads, initialPad, modePad, modeEffectStatus } = config;
    if (!port || !feedback || ledProtocol === 'none') return;
    for (const pad of [...pads, initialPad, modePad]) {
      if (pad === null) continue;
      const messages = ledMessages(pad, 'off');
      if (ledProtocol === 'apc40-mk2' && pad === modePad && modeEffectStatus !== null)
        messages.push([modeEffectStatus, pad, 0]);
      try { messages.forEach(message => port.send(message)); } catch (_) { /* port disconnected */ }
    }
  }
  function syncLeds() {
    const { pads, initialPad, modePad } = config;
    if (!output) return;
    for (let i = 0; i < pads.length; i++) {
      const key = i >= assigned ? 'available' : selectedIndex === i + 1 ? 'active' : 'assigned';
      sendLed(pads[i], key);
    }
    if (initialPad !== null) {
      const key = !activity.size ? 'available' : selectedIndex === 0 ? 'active' : 'assigned';
      sendLed(initialPad, key);
    }
    if (modePad !== null) sendLed(modePad, modeType === 'piano' ? 'modeOn' : 'modeOff');
  }
  function refresh() {
    assigned = liveCount();
    if (selectedIndex > assigned) { selectedIndex = 0; pianoCarry = false; }
    if (modeType === 'piano' && !pianoCarry) selectedIndex = newestHeldIndex();
    syncLeds();
    editorFeedback.schedule();
    return assigned + Number(config.initialNote !== null && activity.size > 0);
  }
  function state() {
    const assignedPads = running ? refresh() : 0;
    const { profile, autoDetected, notes, pads, modeNote, modePad, initialNote, initialPad, feedback,
      ledProtocol, channel, ccChannel, ccMap } = config;
    const activeNote = selectedIndex ? notes[selectedIndex - 1] : activity.size > 0 ? initialNote : null;
    return {
      running, profile, autoDetected, mode: modeType, selectedIndex,
      activeNote, heldNotes: [...held], assignedPads,
      notes: notes.slice(), pads: pads.slice(), modeNote, modePad, initialNote, initialPad,
      input: input?.name ?? null, output: output?.name ?? null,
      feedback, ledProtocol, liveParameters: activity.size,
      ccInputs: [...ccInputs].map(p => p.name), channel, ccChannel,
      ccMap: Object.fromEntries(Object.entries(ccMap).map(([id, mapping]) => [
        id, typeof mapping === 'number' ? mapping : { ...mapping }
      ])),
      ccValues: Object.fromEntries(ccValues)
    };
  }
  function setMode(next) {
    if (next !== 'piano' && next !== 'toggle') throw new Error('mvMidi: mode must be "piano" or "toggle".');
    if (modeType === next) return state();
    refresh();
    modeType = next;
    pianoCarry = next === 'piano' && selectedIndex > 0;
    syncLeds();
    return state();
  }
  function toggleMode() { return setMode(modeType === 'piano' ? 'toggle' : 'piano'); }
  function press(note) {
    if (note === config.modeNote) {
      if (modeButtonDown) return;
      modeButtonDown = true;
      toggleMode();
      return;
    }
    const index = noteIndex(note);
    if (index < 0 || held.has(note)) return;
    held.add(note);
    refresh();
    if (index > assigned) return;
    if (modeType === 'piano') {
      pianoCarry = false;
      selectedIndex = index;
    } else {
      selectedIndex = selectedIndex === index ? 0 : index;
    }
    syncLeds();
  }
  function release(note) {
    if (note === config.modeNote) { modeButtonDown = false; return; }
    if (!held.delete(note)) return;
    if (modeType === 'piano') {
      pianoCarry = false;
      selectedIndex = newestHeldIndex();
    }
    syncLeds();
  }
  function resetNoteMonitor() {
    if (!noteMonitor) return;
    noteMonitor.reading.textContent = input || ccInputs.size ? 'Press a pad or move a control' : 'No MIDI input';
    noteMonitor.device.textContent = input?.name ?? [...ccInputs].map(port => port.name).join(', ');
    noteMonitor.device.hidden = !noteMonitor.device.textContent;
  }
  function monitor(enabled = true) {
    if (!enabled) {
      noteMonitor?.panel.remove();
      noteMonitor = null;
      return;
    }
    if (!running) throw new Error('mvMidi: call start() before opening the MIDI monitor.');
    const doc = root.document;
    if (!doc?.body) throw new Error('mvMidi: the MIDI monitor requires a browser document.');
    if (noteMonitor?.panel.isConnected) return;

    const panel = doc.createElement('aside');
    panel.setAttribute('aria-label', 'MIDI monitor');
    panel.style.cssText = 'position:fixed;top:56px;right:16px;z-index:1000;display:grid;grid-template-columns:1fr auto;gap:4px 12px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:8px 12px;background:#14201e;color:#e3fff8;border:1px solid #45625c;border-radius:6px;box-shadow:0 4px 16px #0006;font:13px/1.4 ui-monospace,monospace';
    const title = doc.createElement('strong');
    title.textContent = 'MIDI monitor';
    const close = doc.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close MIDI monitor');
    close.style.cssText = 'color:inherit;background:transparent;border:0;padding:0 6px;cursor:pointer;font:inherit;font-size:16px';
    close.addEventListener('click', () => monitor(false));
    const reading = doc.createElement('output');
    reading.style.cssText = 'grid-column:1 / -1;color:#6ff4d0;font-weight:600';
    const device = doc.createElement('div');
    device.style.cssText = 'grid-column:1 / -1;color:#b8cac5;overflow-wrap:anywhere';
    panel.append(title, close, reading, device);
    noteMonitor = { panel, reading, device };
    resetNoteMonitor();
    (doc.getElementById('editor-container') || doc.body).append(panel);
  }
  function onMessage(event) {
    const d = event.data;
    if (!d || d.length < 3) return;
    const type = d[0] & 0xf0;
    const channel = (d[0] & 0x0f) + 1;
    const noteOn = type === 0x90 && d[2] > 0;
    if (noteMonitor && noteOn) {
      noteMonitor.reading.textContent = `Note ${d[1]} · CH ${channel}`;
      noteMonitor.device.textContent = event.currentTarget?.name ?? input?.name ?? '';
      noteMonitor.device.hidden = !noteMonitor.device.textContent;
    }
    if (config.channel !== 'all' && channel !== config.channel) return;
    if (noteOn) press(d[1]);
    else if (type === 0x80 || (type === 0x90 && d[2] === 0)) release(d[1]);
  }
  function onControlMessage(event) {
    const d = event.data;
    if (!d || d.length < 3 || (d[0] & 0xf0) !== 0xb0) return;
    const channel = (d[0] & 0x0f) + 1;
    const cc = d[1];
    const value = d[2];
    const { ccMap, ccChannel } = config;
    if (noteMonitor) {
      const controls = Object.entries(ccMap)
        .filter(([, mapping]) => {
          const mappedCC = typeof mapping === 'number' ? mapping : mapping.cc;
          const mappedChannel = typeof mapping === 'number' ? ccChannel : mapping.channel;
          return mappedCC === cc && (mappedChannel === 'all' || mappedChannel === channel);
        })
        .map(([id]) => `vv(${id})`);
      const label = controls.length ? controls.join(', ') : 'Unmapped';
      noteMonitor.reading.textContent = `${label} · CC ${cc} · CH ${channel} · Value ${value}`;
      noteMonitor.device.textContent = event.currentTarget?.name ?? '';
      noteMonitor.device.hidden = !noteMonitor.device.textContent;
    }
    let accepted = ccChannel === 'all' || ccChannel === channel;
    for (const mapping of Object.values(ccMap)) {
      if (typeof mapping === 'number' || mapping.cc !== cc ||
        (mapping.channel !== 'all' && mapping.channel !== channel)) continue;
      accepted = true;
      if (mapping.relative === undefined) continue;
      const delta = RELATIVE_CC_DECODERS[mapping.relative](value);
      const position = (relativeCcPositions.get(mapping) ?? 0) + delta;
      relativeCcPositions.set(mapping, Math.max(0, Math.min(127, position)));
    }
    if (!accepted) return;
    ccValues.set(`${channel}:${cc}`, value);
    ccValues.set(`*:${cc}`, value);
  }
  function syncControlPorts(inputs) {
    const { ccFollowInput, ccInputQuery } = config;
    const chosen = ccFollowInput ? [input].filter(Boolean)
      : ccInputQuery === null ? inputs.filter(p => matches(p, null))
      : [pickPort(inputs, ccInputQuery)].filter(Boolean);
    const next = new Set(chosen);
    let changed = false;
    for (const port of ccInputs) {
      if (!next.has(port)) {
        port.removeEventListener('midimessage', onControlMessage);
        ccInputs.delete(port);
        changed = true;
      }
    }
    for (const port of next) {
      if (!ccInputs.has(port)) {
        port.addEventListener('midimessage', onControlMessage);
        ccInputs.add(port);
        changed = true;
      }
    }
    if (changed) resetNoteMonitor();
  }
  function syncPorts() {
    if (!access || !running) return;
    const { inputQuery, outputQuery, feedback } = config;
    const inputs = [...access.inputs.values()];
    const nextInput = pickPort(inputs, inputQuery);
    if (nextInput !== input) {
      if (input) input.removeEventListener('midimessage', onMessage);
      input = nextInput;
      if (input) input.addEventListener('midimessage', onMessage);
      resetNoteMonitor();
      held.clear();
      modeButtonDown = false;
      if (modeType === 'piano' && !pianoCarry) selectedIndex = 0;
    }
    syncControlPorts(inputs);
    const nextOutput = feedback ? pickPort([...access.outputs.values()], outputQuery) : null;
    if (nextOutput !== output) {
      blankManagedLeds(output);
      output = nextOutput;
      ledCache.clear();
    }
    refresh();
  }
  function disconnect() {
    if (timer !== null) { clearInterval(timer); timer = null; }
    running = false;
    if (input) input.removeEventListener('midimessage', onMessage);
    for (const port of ccInputs) port.removeEventListener('midimessage', onControlMessage);
    ccInputs.clear();
    ccValues.clear();
    relativeCcPositions.clear();
    if (access) access.removeEventListener('statechange', syncPorts);
    blankManagedLeds(output);
    access = null; input = null; output = null;
    resetNoteMonitor();
    ledCache.clear(); held.clear();
    modeButtonDown = false; selectedIndex = 0;
    pianoCarry = false; assigned = 0; activity.clear();
  }
  function stop() {
    startRequestId++;
    disconnect();
    editorFeedback.stop();
    monitor(false);
  }
  function devices() {
    if (!access) return { inputs: [], outputs: [] };
    const view = p => ({ name: p.name, id: p.id, state: p.state });
    return { inputs: [...access.inputs.values()].map(view), outputs: [...access.outputs.values()].map(view) };
  }
  function profiles() {
    return {
      'akai-apc-mini-mk2': 'Notes 10, 18, 26, 34, 42, 50, 58; initial value 2; mode 102; vv(1-9) CC 48-56; LEDs',
      'akai-apc40-mk2': 'Notes 2-7, initial value 1, mode 0, track faders CC 7 CH1-8, master, crossfader, 16 knobs; RGB LEDs',
      generic: 'Unrestricted MIDI notes/CC; LEDs disabled unless configured'
    };
  }

  async function start(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throw new Error('mvMidi: start() expects a configuration object.');
    const nav = root.navigator || (typeof navigator !== 'undefined' ? navigator : null);
    if (!nav?.requestMIDIAccess)
      throw new Error('mvMidi: Web MIDI unavailable. Use Chrome/Chromium over HTTPS or localhost.');

    // A newer start or stop can supersede this request during the browser prompt.
    const requestId = ++startRequestId;
    const grantedAccess = await nav.requestMIDIAccess();
    if (requestId !== startRequestId)
      throw new DOMException('mvMidi: start() was superseded or stopped.', 'AbortError');

    // Keep the current session connected until the replacement is valid.
    const nextConfig = resolveConfig(options, grantedAccess);
    disconnect();
    config = nextConfig;
    modeType = config.defaultMode;
    try {
      access = grantedAccess;
      running = true;
      access.addEventListener('statechange', syncPorts);
      syncPorts();
      if (config.editorFeedback) editorFeedback.start();
      else editorFeedback.stop();
      timer = setInterval(refresh, config.scanMs);
      console.info(`[mvMidi] ${config.profile} | ${modeType} | notes: ${input?.name || 'none'} | CC: ${[...ccInputs].map(p => p.name).join(', ') || 'none'} | LEDs: ${output?.name || 'off'}`);
      if (config.notes.length && !input) console.warn('[mvMidi] No note input found. Check mvMidi.devices() and input.');
      if (Object.keys(config.ccMap).length && !ccInputs.size) console.warn('[mvMidi] No CC input found. Check mvMidi.devices() and ccInput.');
      if (config.feedback && !output) console.warn('[mvMidi] No LED output found. Check output.');
      return state();
    } catch (error) {
      disconnect();
      editorFeedback.stop();
      monitor(false);
      throw error;
    }
  }

  function mv(...values) {
    if (!values.length) throw new Error('mv: provide at least one value.');
    const id = nextId++;
    const entry = { length: values.length, lastSeen: 0 };
    const binding = editorFeedback.bind('mv', values.length);
    return function hydraMultiValue() {
      const index = selectedIndex < values.length ? selectedIndex : 0;
      if (running) {
        entry.lastSeen = now();
        activity.set(id, entry);
        editorFeedback.track(binding, index, entry.lastSeen);
      }
      return values[index];
    };
  }
  function vv(controlId, range, smoothing = 0) {
    if (!Number.isSafeInteger(controlId) || controlId < 1 || config.ccMap[controlId] === undefined)
      throw new Error(`vv: unknown control ${controlId}. Configure ccMap in mvMidi.start().`);
    if (!Array.isArray(range) || range.length !== 2 || !Number.isFinite(range[0]) || !Number.isFinite(range[1]))
      throw new Error('vv: expected [min,max] with two finite numbers.');
    if (!Number.isFinite(smoothing) || smoothing < 0)
      throw new Error('vv: smoothing must be a non-negative finite number of seconds.');
    const [min, max] = range;
    const span = max - min;
    const binding = editorFeedback.bind('vv', arguments.length);
    let smoothedPosition;
    let lastTime;
    return function hydraControlValue() {
      const mapping = config.ccMap[controlId];
      let position;
      if (mapping?.relative !== undefined) {
        position = relativeCcPositions.get(mapping);
      } else if (mapping !== undefined) {
        const cc = typeof mapping === 'number' ? mapping : mapping.cc;
        const channel = typeof mapping === 'number' ? config.ccChannel : mapping.channel;
        position = ccValues.get(`${channel === 'all' ? '*' : channel}:${cc}`);
      }
      let fraction = (position ?? 0) / 127;
      if (smoothing > 0) {
        const time = now();
        if (lastTime === undefined) {
          smoothedPosition = fraction;
        } else {
          const elapsedSeconds = Math.max(0, time - lastTime) / 1000;
          const alpha = -Math.expm1(-elapsedSeconds / smoothing);
          smoothedPosition += (fraction - smoothedPosition) * alpha;
        }
        lastTime = time;
        fraction = smoothedPosition;
      }
      let value = min;
      if (fraction === 1) value = max;
      else if (fraction !== 0) {
        value = Number.isFinite(span)
          ? min + span * fraction
          : min * (1 - fraction) + max * fraction;
      }
      editorFeedback.track(binding, value);
      return value;
    };
  }

  root.mv = mv;
  root.vv = vv;
  root.mvMidi = Object.freeze({ start, stop, state, devices, profiles, press, release, refresh, setMode, toggleMode, monitor });
})(typeof window !== 'undefined' ? window : globalThis);
