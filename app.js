const get = id => document.getElementById(id);
const modes = ['HI-LO', 'YELP', 'WAIL', 'STANDBY', 'PA', 'RADIO'];
const modeButtons = [...document.querySelectorAll('[data-mode]')];
const alternateTones = { 'HI-LO': 'WAIL', YELP: 'PULSAR', WAIL: 'YELP' };
const files = ['horn-hardware', 'manual-hardware', ...['hi-lo', 'wail', 'pulsar', 'yelp', 'pa', 'radio'].map(tone => `client-${tone}`)];
const assets = new Map(files.map(name => [
  name,
  fetch(`audio/${name}.wav`).then(response => {
    if (!response.ok) throw new Error(name);
    return response.arrayBuffer();
  }).catch(() => null),
]));
const buffers = new Map();
const telegram = window.Telegram?.WebApp;
if (['ios', 'android', 'android_x'].includes(telegram?.platform)) {
  document.documentElement.dataset.telegramMobile = '';
}
telegram?.ready();
telegram?.expand();

const playing = new Map();
const requests = new Map();
let context, master;
let powered = false;
let mode = 'STANDBY';
let volume = 45;

function status(message = '') {
  get('status').textContent = message;
}

function display() {
  const signals = [
    playing.get('manual')?.label || (playing.has('siren') && mode),
    playing.has('horn') && 'HORN',
  ].filter(Boolean);
  get('signal').value = powered ? signals.join(' + ') || mode : 'OFF';
  get('meter').classList.toggle('active', signals.length > 0);
  get('mode-name').textContent = mode;
  get('dial').style.transform = `rotate(${modes.indexOf(mode) * 48 - 120}deg)`;
  modeButtons.forEach(button => button.setAttribute('aria-pressed', button.dataset.mode === mode));
  get('man').classList.toggle('is-held', playing.has('manual'));
  get('power').setAttribute('aria-pressed', powered);
  get('power-state').textContent = powered ? 'ПИТАНИЕ ВКЛЮЧЕНО' : 'ПИТАНИЕ ВЫКЛЮЧЕНО';
  get('man').disabled = !powered;
  get('horn').disabled = !powered;
  get('horn').classList.toggle('is-held', playing.has('horn'));
}

async function unlock() {
  if (!context) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    context = new AudioContext();
    master = context.createGain();
    master.gain.value = (volume / 100) ** 1.4;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -5;
    compressor.knee.value = 3;
    compressor.ratio.value = 12;
    compressor.attack.value = .003;
    master.connect(compressor).connect(context.destination);
  }
  if (context.state !== 'running') await context.resume();
}

async function load(name) {
  if (!buffers.has(name)) {
    buffers.set(name, assets.get(name).then(data => {
      if (!data) throw new Error(name);
      return context.decodeAudioData(data.slice(0));
    }).catch(error => {
      buffers.delete(name);
      throw error;
    }));
  }
  return buffers.get(name);
}

function crossfadeLoop(source) {
  const raw = source.getChannelData(0);
  const blend = Math.round(source.sampleRate * .025);
  const length = raw.length - blend;
  const loop = context.createBuffer(1, length, source.sampleRate);
  const data = loop.getChannelData(0);
  data.set(raw.subarray(blend));
  for (let index = 0; index < blend; index++) {
    const mix = index / blend;
    data[length - blend + index] = raw[length + index] * (1 - mix) + raw[index] * mix;
  }
  return loop;
}

function play(channel, buffer, { loop = false, loopStart = 0, loopEnd = 0, level = .8, label } = {}) {
  const source = context.createBufferSource();
  const gain = context.createGain();
  const now = context.currentTime;
  source.buffer = buffer;
  source.loop = loop;
  source.loopStart = loopStart;
  source.loopEnd = loopEnd;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(level, now + .015);
  source.connect(gain).connect(master);
  const playback = { source, gain, label };
  playing.set(channel, playback);
  source.onended = () => {
    source.disconnect();
    gain.disconnect();
    if (playing.get(channel) === playback) {
      playing.delete(channel);
      display();
    }
  };
  source.start();
  display();
}

function stopPlayback(channel) {
  requests.delete(channel);
  const playback = playing.get(channel);
  if (!playback) return;
  playing.delete(channel);
  const { source, gain } = playback;
  const now = context.currentTime;
  if (gain.gain.cancelAndHoldAtTime) gain.gain.cancelAndHoldAtTime(now);
  else gain.gain.cancelScheduledValues(now);
  gain.gain.setTargetAtTime(0, now, .008);
  source.stop(now + .045);
}

async function select(next, restart = false) {
  if (mode === next && !restart) return;
  stopPlayback('manual');
  stopPlayback('siren');
  mode = next;
  display();
  if (!powered || !alternateTones[mode]) return;
  const request = Symbol();
  requests.set('siren', request);
  try {
    await unlock();
    const buffer = await load(`client-${next.toLowerCase()}`);
    if (requests.get('siren') !== request) return;
    play('siren', crossfadeLoop(buffer), { loop: true, level: playing.has('manual') ? 0 : .68 });
  } catch {
    if (requests.get('siren') === request) status('Сирена не запустилась. Попробуй ещё раз.');
  }
}

async function trigger(channel, loop = false) {
  if (!powered) return;
  stopPlayback(channel);
  display();
  const request = Symbol();
  requests.set(channel, request);
  try {
    await unlock();
    const buffer = await load('horn-hardware');
    if (requests.get(channel) !== request) return;
    play(channel, loop ? crossfadeLoop(buffer) : buffer, { loop });
  } catch {
    if (requests.get(channel) === request) status('Звук не загрузился. Попробуй ещё раз.');
  }
}

function setBaseToneLevel(level) {
  playing.get('siren')?.gain.gain.setTargetAtTime(level, context.currentTime, .012);
}

function releaseManual() {
  if (alternateTones[mode]) return;
  requests.delete('manual');
  const manual = playing.get('manual');
  if (mode === 'STANDBY' && manual) {
    manual.source.loop = false;
    return;
  }
  stopPlayback('manual');
  display();
}

async function startManual() {
  if (!powered) return;
  const alternate = alternateTones[mode];
  if (alternate && (playing.has('manual') || requests.has('manual'))) {
    stopPlayback('manual');
    setBaseToneLevel(.68);
    display();
    return;
  }
  stopPlayback('manual');
  const standby = mode === 'STANDBY';
  const tone = alternate || (standby ? 'WAIL' : mode);
  const request = Symbol();
  requests.set('manual', request);
  try {
    await unlock();
    const buffer = await load(standby ? 'manual-hardware' : `client-${tone.toLowerCase()}`);
    if (requests.get('manual') !== request) return;
    requests.delete('manual');
    if (alternate) setBaseToneLevel(0);
    play('manual', standby ? buffer : crossfadeLoop(buffer), {
      loop: true,
      loopStart: standby ? .58 : 0,
      loopEnd: standby ? 1.4975 : 0,
      level: standby ? .72 : .58,
      label: tone,
    });
  } catch {
    if (requests.get('manual') === request) requests.delete('manual');
    status('Ручной сигнал не запустился. Попробуй ещё раз.');
  }
}

function hold(button, start, release) {
  let active;
  function end(event) {
    if (active !== event.pointerId && !(active === 'keyboard' && event.type === 'keyup')) return;
    active = undefined;
    release();
  }
  button.addEventListener('pointerdown', event => {
    if (event.button !== 0 || active !== undefined) return;
    event.preventDefault();
    active = event.pointerId;
    button.setPointerCapture(event.pointerId);
    start();
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(event, end);
  button.addEventListener('keydown', event => {
    if (![' ', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    if (active !== undefined) return;
    active = 'keyboard';
    start();
  });
  button.addEventListener('keyup', event => {
    if ([' ', 'Enter'].includes(event.key)) end(event);
  });
  button.addEventListener('blur', () => {
    if (active === 'keyboard') {
      active = undefined;
      release();
    }
  });
}

modeButtons.forEach(button => button.addEventListener('click', () => select(button.dataset.mode)));
function drag(control, begin, move) {
  let gesture;
  control.addEventListener('pointerdown', event => {
    if (event.button !== 0 || gesture) return;
    gesture = { pointer: event.pointerId, origin: begin(event) };
    control.setPointerCapture(event.pointerId);
  });
  control.addEventListener('pointermove', event => {
    if (gesture?.pointer === event.pointerId) move(event, gesture.origin);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    control.addEventListener(type, event => {
      if (gesture?.pointer === event.pointerId) gesture = undefined;
    });
  }
}

const selector = get('selector');
let rotated = false;
let selectedStep;
function knobAngle(event) {
  const box = get('dial').getBoundingClientRect();
  return Math.atan2(event.clientY - box.top - box.height / 2, event.clientX - box.left - box.width / 2);
}
drag(selector, event => {
  rotated = false;
  selectedStep = 0;
  return { index: modes.indexOf(mode), angle: knobAngle(event), turn: 0 };
}, (event, origin) => {
  const angle = knobAngle(event);
  const difference = angle - origin.angle;
  origin.turn += Math.atan2(Math.sin(difference), Math.cos(difference));
  origin.angle = angle;
  const step = Math.round(origin.turn / (Math.PI * 48 / 180));
  if (step === selectedStep) return;
  selectedStep = step;
  rotated = true;
  select(modes[Math.max(0, Math.min(modes.length - 1, origin.index + step))]);
});
selector.addEventListener('click', event => {
  if (!rotated || event.detail === 0) select(modes[(modes.indexOf(mode) + 1) % modes.length]);
  rotated = false;
});
selector.addEventListener('keydown', event => {
  const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[event.key];
  if (!step) return;
  event.preventDefault();
  select(modes[(modes.indexOf(mode) + step + modes.length) % modes.length]);
});

const volumeInput = get('volume');
function setVolume(value) {
  volume = Math.round(Math.max(0, Math.min(100, value)));
  volumeInput.value = volume;
  get('level').value = `${volume}%`;
  get('volume-dial').style.transform = `rotate(${volume * 2.7 - 135}deg)`;
  master?.gain.setTargetAtTime((volume / 100) ** 1.4, context.currentTime, .02);
}
drag(volumeInput, event => {
  event.preventDefault();
  volumeInput.focus({ preventScroll: true });
  return { y: event.clientY, volume };
}, (event, origin) => setVolume(origin.volume + (origin.y - event.clientY) * 1.2));
volumeInput.addEventListener('input', event => setVolume(Number(event.target.value)));
setVolume(volume);
hold(get('man'), startManual, releaseManual);
hold(get('horn'), () => trigger('horn', true), () => {
  stopPlayback('horn');
  display();
});
function silence() {
  requests.clear();
  for (const channel of playing.keys()) stopPlayback(channel);
  status();
  display();
}

get('power').addEventListener('click', () => {
  powered = !powered;
  if (powered) select(mode, true);
  else silence();
});

const stop = () => {
  mode = 'STANDBY';
  silence();
};
get('stop').addEventListener('click', stop);
document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
window.addEventListener('pagehide', stop);
telegram?.onEvent?.('deactivated', stop);
display();
