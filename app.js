'use strict';

const STATE_KEY = 'blahbox.state.v1';
const LONG_PRESS_MS = 550;
const MOVE_TOLERANCE = 10;
const DRAG_THRESHOLD = 6;
const MAX_RECORD_SECONDS = 60;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
// Bigger files are streamed through an <audio> element instead of being decoded into
// memory — a decoded 10-minute track would need hundreds of MB of RAM.
const STREAM_MIN_BYTES = 2 * 1024 * 1024;
const PREVIEW_ID = '__preview__';

const COLORS = {
  rose: '#FFD8DD',
  peach: '#FFE0C7',
  lemon: '#FFF0B3',
  mint: '#CDEFD9',
  teal: '#C8ECEA',
  sky: '#D3E5FF',
  lavender: '#E2DAFF',
  lilac: '#F5D6F0',
  sand: '#EDE6DA',
  stone: '#E6E6E3',
};
const DEFAULT_COLOR = 'sky';
const EMOJI_PICKS = ['😂', '👏', '🎉', '💥', '🥁', '🔔', '📯', '🎺', '🐐', '🦆', '🤡', '😱', '🙄', '💨', '👋', '🚨', '❌', '✅'];

const $ = (sel) => document.querySelector(sel);
const grid = $('#grid');
const stopBtn = $('#stopBtn');
const arrangeBtn = $('#arrangeBtn');

/* ---------- Persistence ---------- */

// Button list and settings live in localStorage; user audio lives in IndexedDB.
let state = { cols: 3, buttons: [] };

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STATE_KEY));
    if (saved && Array.isArray(saved.buttons)) state = { ...state, ...saved };
  } catch { /* fresh start */ }
}

function saveState() {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

const db = (() => {
  let opening;
  const open = () => opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('blahbox', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('sounds');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  async function run(mode, fn) {
    const conn = await open();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction('sounds', mode);
      const req = fn(tx.objectStore('sounds'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  return {
    // Stored as { type, data: ArrayBuffer } — ArrayBuffers are more reliable than Blobs in Safari's IndexedDB.
    get: (id) => run('readonly', (s) => s.get(id)),
    put: (id, value) => run('readwrite', (s) => s.put(value, id)),
    delete: (id) => run('readwrite', (s) => s.delete(id)),
  };
})();

function requestPersistence() {
  navigator.storage?.persist?.().catch(() => {});
}

const findButton = (id) => state.buttons.find((b) => b.id === id);
const visibleButtons = () => state.buttons.filter((b) => !b.hidden);
const builtinUrl = (file) => 'sounds/' + encodeURIComponent(file);
const newId = () => 'u-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

async function syncBuiltins() {
  let list;
  try {
    list = await (await fetch('sounds/sounds.json')).json();
  } catch {
    return; // offline and not cached yet: keep whatever we had
  }
  const files = new Set(list.map((s) => s.file));
  state.buttons = state.buttons.filter((b) => b.kind !== 'builtin' || files.has(b.file));
  for (const s of list) {
    const id = 'builtin:' + s.file;
    if (findButton(id)) continue;
    state.buttons.push({
      id, kind: 'builtin', file: s.file,
      name: s.name || s.file.replace(/\.[^.]+$/, ''),
      emoji: s.emoji || '',
      color: COLORS[s.color] ? s.color : DEFAULT_COLOR,
      hidden: false,
    });
  }
  saveState();
}

async function readSound(button) {
  if (button.kind === 'builtin') {
    const res = await fetch(builtinUrl(button.file));
    if (!res.ok) throw new Error('missing sound');
    return { type: res.headers.get('Content-Type') || 'audio/mpeg', data: await res.arrayBuffer() };
  }
  const record = await db.get(button.id);
  if (!record) throw new Error('missing sound');
  return record;
}

/* ---------- Audio engine ---------- */

// Web Audio gives low-latency, overlapping playback for short sounds; they are decoded once
// and reused. Long sounds play through <audio> elements from a blob URL.
// A "sound" is { buffer } or { url }.
const player = {
  ctx: null,
  buffers: new Map(), // id -> Promise<sound>
  voices: new Map(),  // id -> Set<{ stop() }>

  context() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
    }
    return this.ctx;
  },

  // Must run inside a user gesture on iOS.
  unlock() {
    const ctx = this.context();
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    return ctx;
  },

  decode(data) {
    const ctx = this.context();
    return new Promise((resolve, reject) => ctx.decodeAudioData(data.slice(0), resolve, reject));
  },

  // Turns raw file data into a playable sound.
  async prepare({ type, data }) {
    if (data.byteLength < STREAM_MIN_BYTES) return { buffer: await this.decode(data) };
    return { url: URL.createObjectURL(new Blob([data], { type })) };
  },

  load(button) {
    let sound = this.buffers.get(button.id);
    if (!sound) {
      sound = readSound(button).then((record) => this.prepare(record));
      sound.catch(() => this.buffers.delete(button.id));
      this.buffers.set(button.id, sound);
    }
    return sound;
  },

  forget(id) {
    this.buffers.delete(id);
  },

  async play(button) {
    this.unlock();
    try {
      this.start(button.id, await this.load(button));
    } catch {
      toast(`Can't play “${button.name}” on this device`);
    }
  },

  start(id, sound) {
    let voices = this.voices.get(id);
    if (!voices) this.voices.set(id, voices = new Set());
    const ended = (voice) => {
      if (!voices.delete(voice)) return;
      if (!voices.size && this.voices.get(id) === voices) this.voices.delete(id);
      onVoicesChanged(id, null);
    };

    if (sound.buffer) {
      const ctx = this.unlock();
      const source = ctx.createBufferSource();
      source.buffer = sound.buffer;
      source.connect(ctx.destination);
      const voice = { stop: () => source.stop() };
      voices.add(voice);
      source.onended = () => ended(voice);
      source.start();
      onVoicesChanged(id, sound.buffer.duration);
      return;
    }

    const media = new Audio(sound.url);
    const voice = { stop: () => { media.pause(); ended(voice); } };
    voices.add(voice);
    media.addEventListener('ended', () => ended(voice));
    media.addEventListener('error', () => ended(voice));
    media.play().then(
      () => onVoicesChanged(id, media.duration),
      () => ended(voice),
    );
  },

  stopAll() {
    for (const voices of [...this.voices.values()]) {
      for (const voice of [...voices]) {
        try { voice.stop(); } catch { /* already stopped */ }
      }
    }
  },

  isPlaying: (id) => player.voices.has(id),
};

// Reads a streamed sound's duration; rejects if the format is unplayable. Resolves NaN when
// the browser won't load metadata up front (iOS ignores preload; background tabs defer it).
function probeMedia(url) {
  return new Promise((resolve, reject) => {
    const media = new Audio();
    media.preload = 'metadata';
    media.onloadedmetadata = () => resolve(media.duration);
    media.onerror = () => reject(new Error('unplayable'));
    setTimeout(() => resolve(NaN), 3000);
    media.src = url;
  });
}

function onVoicesChanged(id, startedDuration) {
  const pad = grid.querySelector(`.pad[data-id="${CSS.escape(id)}"]`);
  if (pad) {
    if (Number.isFinite(startedDuration)) {
      // Restart the progress bar on every trigger.
      pad.style.setProperty('--dur', startedDuration + 's');
      pad.classList.remove('playing');
      void pad.offsetWidth;
      pad.classList.add('playing');
    } else if (!player.isPlaying(id)) {
      pad.classList.remove('playing');
    }
  }
  stopBtn.hidden = player.voices.size === 0;
}

function setAudioSession(type) {
  // Safari 17+: 'playback' keeps sounds audible with the silent switch on.
  if (navigator.audioSession) {
    try { navigator.audioSession.type = type; } catch { /* unsupported */ }
  }
}

/* ---------- Rendering ---------- */

function fillPad(el, button) {
  el.style.setProperty('--pad', COLORS[button.color] || COLORS[DEFAULT_COLOR]);
  el.querySelector('.pad-emoji').textContent = button.emoji || '';
  el.querySelector('.pad-label').textContent = button.name || '';
  el.classList.toggle('no-emoji', !button.emoji);
}

function padElement(button) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'pad';
  el.dataset.id = button.id;
  el.innerHTML = '<span class="pad-emoji"></span><span class="pad-label"></span><span class="pad-progress"></span>';
  fillPad(el, button);
  if (player.isPlaying(button.id)) el.classList.add('playing');
  return el;
}

function render() {
  const buttons = visibleButtons();
  document.documentElement.style.setProperty('--cols', state.cols);
  grid.replaceChildren(...buttons.map(padElement));
  $('#empty').hidden = buttons.length > 0;
  arrangeBtn.hidden = buttons.length === 0 && !arranging;
}

function preloadAll() {
  for (const b of visibleButtons()) player.load(b).catch(() => {});
}

/* ---------- Toast ---------- */

let toastTimer;
function toast(message, action) {
  const el = $('#toast');
  const actionBtn = $('#toastAction');
  $('#toastText').textContent = message;
  actionBtn.hidden = !action;
  if (action) {
    actionBtn.textContent = action.label;
    actionBtn.onclick = () => { el.hidden = true; action.run(); };
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  if (!action?.sticky) toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

/* ---------- Pad interaction ---------- */

let press = null;       // pending long-press in play mode
let suppressClick = false;

function cancelPress() {
  if (press) clearTimeout(press.timer);
  press = null;
}

grid.addEventListener('pointerdown', (e) => {
  const pad = e.target.closest('.pad');
  if (!pad || e.button > 0) return;
  suppressClick = false;
  if (arranging) {
    beginArrangePress(pad, e);
    return;
  }
  cancelPress();
  press = {
    x: e.clientX,
    y: e.clientY,
    timer: setTimeout(() => {
      press = null;
      suppressClick = true;
      navigator.vibrate?.(12);
      openEditor(pad.dataset.id);
    }, LONG_PRESS_MS),
  };
});

grid.addEventListener('pointermove', (e) => {
  if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE) cancelPress();
});
grid.addEventListener('pointerup', cancelPress);
grid.addEventListener('pointercancel', cancelPress);
grid.addEventListener('contextmenu', (e) => e.preventDefault());

grid.addEventListener('click', (e) => {
  const pad = e.target.closest('.pad');
  if (!pad) return;
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  const button = findButton(pad.dataset.id);
  if (!button) return;
  if (arranging) openEditor(button.id);
  else player.play(button);
});

stopBtn.addEventListener('click', () => player.stopAll());

/* ---------- Arrange mode (drag to reorder) ---------- */

let arranging = false;
let drag = null;

function setArranging(on) {
  arranging = on;
  cancelPress();
  grid.classList.toggle('arranging', on);
  arrangeBtn.setAttribute('aria-pressed', String(on));
  arrangeBtn.textContent = on ? 'Done' : 'Edit';
  $('#arrangeHint').hidden = !on;
  render();
}

arrangeBtn.addEventListener('click', () => setArranging(!arranging));

function beginArrangePress(pad, e) {
  drag = { pad, pointerId: e.pointerId, x: e.clientX, y: e.clientY, active: false };
  window.addEventListener('pointermove', onDragMove, { passive: false });
  window.addEventListener('pointerup', onDragEnd);
  window.addEventListener('pointercancel', onDragEnd);
}

function onDragMove(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  if (!drag.active) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_THRESHOLD) return;
    const rect = drag.pad.getBoundingClientRect();
    const ghost = drag.pad.cloneNode(true);
    ghost.classList.add('ghost');
    Object.assign(ghost.style, { width: rect.width + 'px', height: rect.height + 'px' });
    document.body.append(ghost);
    Object.assign(drag, { active: true, ghost, offX: e.clientX - rect.left, offY: e.clientY - rect.top });
    drag.pad.classList.add('placeholder');
  }
  e.preventDefault();
  drag.ghost.style.left = e.clientX - drag.offX + 'px';
  drag.ghost.style.top = e.clientY - drag.offY + 'px';

  if (e.clientY < 90) window.scrollBy(0, -10);
  else if (e.clientY > window.innerHeight - 90) window.scrollBy(0, 10);

  const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.pad');
  if (target && target !== drag.pad && target.parentNode === grid) {
    const pads = [...grid.children];
    const before = pads.indexOf(drag.pad) > pads.indexOf(target);
    animateReflow(() => (before ? target.before(drag.pad) : target.after(drag.pad)));
  }
}

function onDragEnd(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('pointercancel', onDragEnd);
  if (drag.active) {
    drag.ghost.remove();
    drag.pad.classList.remove('placeholder');
    suppressClick = true;
    commitOrder();
  }
  drag = null;
}

// FLIP: slide neighbours into their new slots instead of jumping.
function animateReflow(mutate) {
  const pads = [...grid.children];
  const before = new Map(pads.map((p) => [p, p.getBoundingClientRect()]));
  mutate();
  for (const p of pads) {
    if (p === drag?.pad) continue;
    const a = before.get(p);
    const b = p.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (dx || dy) {
      p.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 180, easing: 'ease-out' });
    }
  }
}

function commitOrder() {
  const order = [...grid.children].map((p) => p.dataset.id);
  const byId = new Map(state.buttons.map((b) => [b.id, b]));
  state.buttons = [...order.map((id) => byId.get(id)), ...state.buttons.filter((b) => b.hidden)];
  saveState();
}

/* ---------- Editor ---------- */

const editorDlg = $('#editor');
const fName = $('#fName');
const fEmoji = $('#fEmoji');
const soundStatus = $('#soundStatus');
const previewBtn = $('#previewBtn');
const deleteBtn = $('#deleteBtn');
const recordBtn = $('#recordBtn');

let edit = null; // { id, builtin, color, sound: { type, data, sound } | null, armed }

function openEditor(id) {
  cancelPress();
  const button = id ? findButton(id) : null;
  const colorKeys = Object.keys(COLORS);
  edit = {
    id: button?.id ?? null,
    builtin: button?.kind === 'builtin',
    color: button?.color ?? colorKeys[Math.floor(Math.random() * colorKeys.length)],
    sound: null,
    armed: false,
  };
  $('#editorTitle').textContent = button ? 'Edit sound' : 'New sound';
  fName.value = button?.name ?? '';
  fEmoji.value = button?.emoji ?? '';
  $('#soundSource').hidden = edit.builtin;
  soundStatus.textContent = !button ? 'Choose an audio file or record one.'
    : edit.builtin ? 'Built-in sound' : 'Saved sound';
  previewBtn.disabled = !button;
  deleteBtn.hidden = !button;
  resetDeleteButton();
  updateRecordUi();
  renderSwatches();
  updateEditorPreview();
  editorDlg.showModal();
}

function closeEditor() {
  if (editorDlg.open) editorDlg.close();
}

editorDlg.addEventListener('close', () => {
  stopRecording(true);
  edit = null;
});
// Tap on the backdrop closes the sheet.
editorDlg.addEventListener('click', (e) => { if (e.target === editorDlg) closeEditor(); });
$('#cancelBtn').addEventListener('click', closeEditor);

function renderSwatches() {
  const wrap = $('#swatches');
  wrap.replaceChildren(...Object.entries(COLORS).map(([key, hex]) => {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'swatch';
    sw.style.setProperty('--c', hex);
    sw.setAttribute('role', 'radio');
    sw.setAttribute('aria-label', key);
    sw.setAttribute('aria-checked', String(key === edit.color));
    sw.addEventListener('click', () => {
      edit.color = key;
      renderSwatches();
      updateEditorPreview();
    });
    return sw;
  }));
}

function renderEmojiPicks() {
  $('#emojiPicks').replaceChildren(...EMOJI_PICKS.map((emoji) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = emoji;
    b.setAttribute('aria-label', 'Use ' + emoji);
    b.addEventListener('click', () => {
      fEmoji.value = emoji;
      updateEditorPreview();
    });
    return b;
  }));
}

function updateEditorPreview() {
  if (!edit) return;
  fillPad($('#editorPreview'), {
    name: fName.value.trim() || 'Name',
    emoji: fEmoji.value.trim(),
    color: edit.color,
  });
}

fName.addEventListener('input', updateEditorPreview);
fEmoji.addEventListener('input', updateEditorPreview);
fEmoji.addEventListener('focus', () => fEmoji.select());

const formatDuration = (s) => (s < 10 ? s.toFixed(1) + ' s'
  : s < 120 ? Math.round(s) + ' s'
  : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')} min`);
const prettyName = (filename) => filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim().slice(0, 40);

async function useSound(blob, label) {
  if (!edit) return;
  if (blob.size > MAX_FILE_BYTES) {
    toast('That file is too big (max 20 MB)');
    return;
  }
  const record = { type: blob.type || 'audio/mpeg', data: await blob.arrayBuffer() };
  let sound, duration;
  try {
    sound = await player.prepare(record);
    duration = sound.buffer ? sound.buffer.duration : await probeMedia(sound.url);
  } catch {
    if (sound?.url) URL.revokeObjectURL(sound.url);
    toast("Couldn't read that audio file");
    return;
  }
  if (!edit) return;
  edit.sound = { ...record, sound };
  soundStatus.textContent = Number.isFinite(duration) ? `${label} · ${formatDuration(duration)}` : label;
  previewBtn.disabled = false;
  if (!fName.value.trim() && blob.name) fName.value = prettyName(blob.name);
  updateEditorPreview();
}

$('#pickFileBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) useSound(file, file.name.length > 28 ? file.name.slice(0, 25) + '…' : file.name);
});

previewBtn.addEventListener('click', () => {
  if (!edit) return;
  if (edit.sound) player.start(PREVIEW_ID, edit.sound.sound);
  else if (edit.id) player.play(findButton(edit.id));
});

function resetDeleteButton() {
  if (!edit) return;
  edit.armed = false;
  deleteBtn.classList.remove('armed');
  deleteBtn.textContent = edit.builtin ? 'Hide' : 'Delete';
}

deleteBtn.addEventListener('click', async () => {
  const button = edit && findButton(edit.id);
  if (!button) return;
  if (button.kind === 'builtin') {
    button.hidden = true;
    saveState();
    render();
    closeEditor();
    toast(`Hid “${button.name}”`, { label: 'Undo', run: () => { button.hidden = false; saveState(); render(); } });
    return;
  }
  if (!edit.armed) {
    edit.armed = true;
    deleteBtn.classList.add('armed');
    deleteBtn.textContent = 'Tap to confirm';
    setTimeout(resetDeleteButton, 3000);
    return;
  }
  state.buttons = state.buttons.filter((b) => b !== button);
  saveState();
  player.forget(button.id);
  db.delete(button.id).catch(() => {});
  render();
  closeEditor();
  toast(`Deleted “${button.name}”`);
});

$('#editorForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!edit) return;
  const name = fName.value.trim();
  if (!name) {
    fName.focus();
    toast('Give the sound a name');
    return;
  }
  if (!edit.id && !edit.sound) {
    toast('Choose a file or record a sound first');
    return;
  }
  if (recorder) {
    toast('Stop the recording first');
    return;
  }
  const isNew = !edit.id;
  const button = isNew ? { id: newId(), kind: 'user', hidden: false } : findButton(edit.id);
  if (edit.sound) {
    try {
      await db.put(button.id, { type: edit.sound.type, data: edit.sound.data });
    } catch {
      toast("Couldn't save the sound — the phone may be out of space");
      return;
    }
    player.forget(button.id);
    player.buffers.set(button.id, Promise.resolve(edit.sound.sound));
    requestPersistence();
  }
  Object.assign(button, { name, emoji: fEmoji.value.trim(), color: edit.color });
  if (isNew) state.buttons.push(button);
  saveState();
  render();
  closeEditor();
  if (isNew) grid.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

$('#addBtn').addEventListener('click', () => openEditor(null));

/* ---------- Recording ---------- */

let recorder = null; // { mr, stream, chunks, started, timer, discard }

function pickRecordingType() {
  if (!window.MediaRecorder?.isTypeSupported) return '';
  // MP4/AAC first: it decodes on every platform, which keeps backups portable.
  return ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
    .find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    toast("Recording isn't supported on this device");
    return;
  }
  player.unlock();
  setAudioSession('play-and-record');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    });
  } catch {
    setAudioSession('playback');
    toast('Microphone access was blocked');
    return;
  }
  if (!edit) {
    stream.getTracks().forEach((t) => t.stop());
    setAudioSession('playback');
    return;
  }
  const mimeType = pickRecordingType();
  const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const session = { mr, stream, chunks: [], started: Date.now(), timer: 0, discard: false };
  recorder = session;
  mr.ondataavailable = (e) => { if (e.data.size) session.chunks.push(e.data); };
  mr.onstop = () => {
    clearInterval(session.timer);
    stream.getTracks().forEach((t) => t.stop());
    setAudioSession('playback');
    if (recorder === session) recorder = null;
    updateRecordUi();
    if (session.discard || !session.chunks.length) return;
    const blob = new Blob(session.chunks, { type: mr.mimeType || mimeType || 'audio/webm' });
    useSound(blob, 'Recording');
  };
  mr.start();
  session.timer = setInterval(() => {
    if (elapsed(session) >= MAX_RECORD_SECONDS) stopRecording();
    else updateRecordUi();
  }, 250);
  soundStatus.textContent = 'Recording…';
  updateRecordUi();
}

const elapsed = (session) => (Date.now() - session.started) / 1000;

function stopRecording(discard = false) {
  if (!recorder) return;
  recorder.discard = discard;
  if (recorder.mr.state !== 'inactive') recorder.mr.stop();
}

function updateRecordUi() {
  recordBtn.classList.toggle('recording', !!recorder);
  if (recorder) {
    const s = Math.floor(elapsed(recorder));
    recordBtn.textContent = `■ Stop  0:${String(s).padStart(2, '0')}`;
  } else {
    recordBtn.textContent = '● Record';
  }
}

recordBtn.addEventListener('click', () => (recorder ? stopRecording() : startRecording()));

/* ---------- Settings ---------- */

const settingsDlg = $('#settings');

function renderSettings() {
  for (const b of $('#colsSeg').children) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.cols) === state.cols));
  }
  const hidden = state.buttons.filter((b) => b.hidden);
  $('#hiddenSection').hidden = hidden.length === 0;
  $('#hiddenList').replaceChildren(...hidden.map((button) => {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${button.emoji ? button.emoji + ' ' : ''}${button.name}`;
    const show = document.createElement('button');
    show.type = 'button';
    show.className = 'btn btn-small';
    show.textContent = 'Show';
    show.addEventListener('click', () => {
      button.hidden = false;
      state.buttons = [...state.buttons.filter((b) => b !== button), button];
      saveState();
      render();
      renderSettings();
    });
    li.append(label, show);
    return li;
  }));
  const appUrl = new URL('./', location.href).href;
  Object.assign($('#appUrl'), { href: appUrl, textContent: appUrl.replace(/^https?:\/\//, '') });
  $('#installedNote').hidden = !isInstalled();
  $('#installBtn').hidden = !installPrompt;
  const own = state.buttons.filter((b) => b.kind === 'user').length;
  $('#storageInfo').textContent = `${own} sound${own === 1 ? '' : 's'} of your own · works offline`;
}

$('#menuBtn').addEventListener('click', () => {
  renderSettings();
  settingsDlg.showModal();
});
$('#settingsDone').addEventListener('click', () => settingsDlg.close());
settingsDlg.addEventListener('click', (e) => { if (e.target === settingsDlg) settingsDlg.close(); });

$('#colsSeg').addEventListener('click', (e) => {
  const cols = Number(e.target.closest('button')?.dataset.cols);
  if (!cols) return;
  state.cols = cols;
  saveState();
  render();
  renderSettings();
});

/* ---------- Install ---------- */

// Chrome on Android offers its own install prompt; keep it for the "Install now" button.
let installPrompt = null;
const isInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  if (settingsDlg.open) renderSettings();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  if (settingsDlg.open) renderSettings();
});
$('#installBtn').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  renderSettings();
});

/* ---------- Backup: export / import ---------- */

const bufferToDataUrl = (data, type) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(new Blob([data], { type }));
});
const dataUrlToBuffer = async (url) => (await fetch(url)).arrayBuffer();

async function exportBackup() {
  const sounds = {};
  for (const b of state.buttons.filter((b) => b.kind === 'user')) {
    const record = await db.get(b.id);
    if (record) sounds[b.id] = { type: record.type, data: await bufferToDataUrl(record.data, record.type) };
  }
  const payload = { app: 'blahbox', format: 1, exported: new Date().toISOString(), cols: state.cols, buttons: state.buttons, sounds };
  const filename = `blahbox-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([JSON.stringify(payload)], filename, { type: 'application/json' });

  // iOS standalone apps can't download files; the share sheet offers "Save to Files".
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Blahbox backup' });
    } catch { /* cancelled */ }
    return;
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const sanitize = (b) => ({
  name: String(b.name || 'Sound').slice(0, 40),
  emoji: String(b.emoji || '').slice(0, 8),
  color: COLORS[b.color] ? b.color : DEFAULT_COLOR,
  hidden: !!b.hidden,
});

// Merges a backup into the current setup: imported buttons come first, in their saved order.
async function importBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch { /* handled below */ }
  if (data?.app !== 'blahbox' || !Array.isArray(data.buttons)) {
    toast("That isn't a Blahbox backup file");
    return;
  }
  const remaining = new Map(state.buttons.map((b) => [b.id, b]));
  const merged = [];
  let imported = 0;
  for (const b of data.buttons) {
    if (!b || typeof b.id !== 'string') continue;
    if (b.kind === 'builtin') {
      const current = remaining.get(b.id);
      if (!current) continue;
      Object.assign(current, sanitize(b));
      merged.push(current);
      remaining.delete(b.id);
      continue;
    }
    const sound = data.sounds?.[b.id];
    if (!sound?.data) continue;
    try {
      await db.put(b.id, { type: sound.type || 'audio/mpeg', data: await dataUrlToBuffer(sound.data) });
    } catch {
      toast("Couldn't save all sounds — the phone may be out of space");
      break;
    }
    player.forget(b.id);
    merged.push({ id: b.id, kind: 'user', ...sanitize(b) });
    remaining.delete(b.id);
    imported++;
  }
  state.buttons = [...merged, ...remaining.values()];
  if ([2, 3, 4].includes(data.cols)) state.cols = data.cols;
  saveState();
  requestPersistence();
  render();
  renderSettings();
  preloadAll();
  toast(`Imported ${imported} sound${imported === 1 ? '' : 's'}`);
}

$('#exportBtn').addEventListener('click', () => exportBackup().catch(() => toast('Export failed')));
$('#importBtn').addEventListener('click', () => $('#importInput').click());
$('#importInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) importBackup(file);
});

/* ---------- Service worker (offline + updates) ---------- */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offerUpdate = () => toast('A new version is ready', {
      label: 'Update',
      sticky: true,
      run: () => reg.waiting?.postMessage('skipWaiting'),
    });
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate();
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate();
      });
    });
  }).catch(() => {});

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

/* ---------- Boot ---------- */

(async function boot() {
  setAudioSession('playback');
  loadState();
  renderEmojiPicks();
  render();
  await syncBuiltins();
  render();
  preloadAll();
  registerServiceWorker();
})();
