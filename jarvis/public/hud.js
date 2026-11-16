// HUD controller: voice in (wake word / hold-to-talk), voice out (ElevenLabs stream with browser fallback),
// screen sharing, approvals, panels, settings. Talks to the local server only.
import { Orb } from '/orb.js';
import { Galaxy } from '/galaxy.js';
import { Workshop } from '/workshop.js';
import { renderMarkdown, escapeHtml } from '/md.js';

const TOKEN = window.JARVIS_TOKEN;
const $ = (id) => document.getElementById(id);
const prefs = {
  get: (k, d) => { try { const v = localStorage.getItem('jarvis.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('jarvis.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

async function api(path, { method = 'GET', json, body, headers = {}, raw = false } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'x-jarvis-token': TOKEN, ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : body,
  });
  if (raw) return res;
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw Object.assign(new Error(data.error || data.message || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}

// ------------------------------------------------------------------ state
const S = {
  status: null,
  brain: 'offline',        // server-reported brain state
  speaking: false,
  handsFree: false,
  holding: false,
  followUntil: 0,
  approval: null,
  attachments: [],
  spoken: [],              // recent sentences Jarvis said (echo guard)
  busy: false,
  wakeNames: ['jarvis'],
};

const orb = new Orb($('orb'));
const galaxy = new Galaxy($('galaxy'), $('galaxy-labels'));
const workshop = new Workshop({ canvas: $('ws-canvas'), labelsLayer: $('ws-labels-layer'), partsList: $('ws-parts'), emptyEl: $('ws-empty'), busyEl: $('ws-busy'), titleEl: $('ws-title') });

const LABELS = { offline: 'Offline', idle: 'Standing by', listening: 'Listening for your call', hearing: 'Go ahead', thinking: 'Thinking', working: 'Working', speaking: 'Speaking', error: 'Needs attention' };
function refreshState() {
  let s = 'idle';
  if (S.status?.brain?.fatal || S.brain === 'down') s = 'error';
  else if (!S.status) s = 'offline';
  else if (S.holding) s = 'hearing';
  else if (S.speaking) s = 'speaking';
  else if (S.busy) s = S.toolsActive ? 'working' : 'thinking';
  else if (S.handsFree || Date.now() < S.followUntil) s = Date.now() < S.followUntil ? 'hearing' : 'listening';
  document.body.dataset.state = s;
  orb.set(s);
  $('state-label').textContent = S.approval ? 'Waiting for your approval' : s === 'listening' ? `Say “${cap(S.wakeNames[0])}”` : LABELS[s];
  $('ask-stop').hidden = !(S.busy || S.speaking);
  $('ask-send').hidden = S.busy || S.speaking;
}

let toastTimer;
function toast(msg, ms = 3800) {
  const el = $('toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}
function banner(msg, action) {
  const el = $('banner');
  if (!msg) { el.hidden = true; return; }
  el.innerHTML = `<span>${escapeHtml(msg)}</span>`;
  if (action) { const b = document.createElement('button'); b.className = 'ghost'; b.textContent = action.label; b.onclick = action.run; el.appendChild(b); }
  const x = document.createElement('button'); x.className = 'icon'; x.textContent = '✕'; x.setAttribute('aria-label', 'Dismiss'); x.onclick = () => { el.hidden = true; };
  el.appendChild(x);
  el.hidden = false;
}

// ------------------------------------------------------------------ voice out
let audioCtx = null, analyser = null, levelData = null;
let speechNow = null;      // what is being spoken right now
let micLevel = null;       // () => 0..1 while holding to talk
function ensureAudio() {
  if (audioCtx) { if (audioCtx.state === 'suspended') audioCtx.resume(); return; }
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.connect(audioCtx.destination);
    levelData = new Uint8Array(analyser.frequencyBinCount);
  } catch { audioCtx = null; }
}
(function meter() {
  let level = 0;
  if (S.speaking && analyser && speechNow?.kind === 'eleven') {
    analyser.getByteFrequencyData(levelData);
    let sum = 0; for (let i = 2; i < 48; i++) sum += levelData[i];
    level = Math.min(1, sum / (46 * 150));
  } else if (S.speaking) level = 0.35 + 0.3 * Math.abs(Math.sin(performance.now() / 130));
  else if (S.holding && micLevel) level = micLevel();
  orb.setLevel(level);
  galaxy.setEnergy(S.speaking ? level : 0);
  requestAnimationFrame(meter);
})();

const sayQueue = [];
let captionText = '';

function setCaption(t) { captionText = t; $('caption').textContent = t.length > 420 ? '…' + t.slice(-420) : t; }

function enqueueSay(item) {
  sayQueue.push(item);
  S.lastSaid = item.text;
  S.spoken.push({ t: item.text.toLowerCase(), at: Date.now() });
  if (S.spoken.length > 24) S.spoken.shift();
  if (!speechNow) nextSay();
}

function nextSay() {
  const item = sayQueue.shift();
  if (!item) {
    speechNow = null;
    if (S.speaking) {
      S.speaking = false;
      // Conversation mode: if Jarvis just asked a question, you can answer without the wake word.
      if (S.handsFree && prefs.get('convo', true) && !S.busy && /\?["')\]]?\s*$/.test(S.lastSaid || '')) { S.followUntil = Date.now() + 9000; setTimeout(refreshState, 9100); }
    }
    refreshState();
    return;
  }
  S.speaking = true;
  refreshState();
  if (item.engine === 'eleven') playEleven(item); else playBrowser(item);
}

function playEleven(item) {
  ensureAudio();
  const audio = new Audio();
  audio.crossOrigin = 'anonymous';
  audio.src = `/api/tts/${item.id}?t=${TOKEN}`;
  audio.preload = 'auto';
  let done = false;
  const finish = (failed) => {
    if (done) return; done = true;
    try { audio.pause(); } catch { /* ignore */ }
    if (failed && speechNow?.item === item) { playBrowser(item); return; }
    if (speechNow?.item === item) nextSay();
  };
  speechNow = { kind: 'eleven', item, stop: () => { done = true; try { audio.pause(); audio.src = ''; } catch { /* ignore */ } } };
  if (audioCtx) { try { audioCtx.createMediaElementSource(audio).connect(analyser); } catch { /* plays direct */ } }
  audio.onended = () => finish(false);
  audio.onerror = () => finish(true);
  audio.play().catch(() => finish(true));
}

function playBrowser(item) {
  if (!('speechSynthesis' in window)) { speechNow = { kind: 'none', item, stop() {} }; setTimeout(() => { if (speechNow?.item === item) nextSay(); }, 600); return; }
  const u = new SpeechSynthesisUtterance(item.text);
  const voices = speechSynthesis.getVoices();
  u.voice = voices.find((v) => /en-GB/i.test(v.lang) && /daniel|george|male|uk english/i.test(v.name)) || voices.find((v) => /en-GB/i.test(v.lang)) || voices.find((v) => /^en/i.test(v.lang)) || null;
  u.rate = 1.04;
  let done = false;
  const finish = () => { if (done) return; done = true; if (speechNow?.item === item) nextSay(); };
  speechNow = { kind: 'browser', item, stop: () => { done = true; speechSynthesis.cancel(); } };
  u.onend = finish; u.onerror = finish;
  speechSynthesis.speak(u);
  setTimeout(finish, Math.max(4000, item.text.length * 110)); // some browsers never fire onend
}

function hush() {
  sayQueue.length = 0;
  if (speechNow) { speechNow.stop(); speechNow = null; }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  S.speaking = false;
  refreshState();
}

// ------------------------------------------------------------------ talking to Jarvis
async function sendText(text) {
  text = String(text || '').trim();
  const attachments = S.attachments.map((a) => a.path);
  if (!text && !attachments.length) return;
  hush();
  S.followUntil = 0;
  S.busy = true;
  setCaption('');
  $('heard').classList.remove('live');
  $('heard').textContent = text ? `“${text}”` : '';
  S.attachments = []; renderAttachments();
  refreshState();
  try { await api('/api/say', { method: 'POST', json: { text, attachments } }); }
  catch (e) { S.busy = false; refreshState(); toast(`Could not reach Jarvis: ${e.message}`); }
}

async function stopEverything() {
  hush();
  S.followUntil = 0;
  try { await api('/api/interrupt', { method: 'POST' }); } catch { /* ignore */ }
}

$('ask').addEventListener('submit', (e) => { e.preventDefault(); const v = $('ask-input').value; $('ask-input').value = ''; sendText(v); });
$('ask-stop').addEventListener('click', stopEverything);
$('orb-wrap').addEventListener('click', () => {
  if (S.speaking || S.busy) return stopEverything();
  if (!S.handsFree) setHandsFree(true); else { S.followUntil = Date.now() + 8000; refreshState(); toast('Listening…', 1500); }
});

// ------------------------------------------------------------------ voice in: wake word (browser speech recognition)
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, recRunning = false, recBlockedUntil = 0;

function wakeRegex() {
  const names = S.wakeNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`(?:^|[\\s,.!?])(?:(?:hey|hi|ok|okay|yo)[\\s,]+)?(?:${names})(?=$|[\\s,.!?:;'’-])[\\s,.!?:;-]*`, 'i');
}
function namesFor(name) {
  const n = String(name || 'jarvis').toLowerCase().trim();
  // Common mis-hearings of "Jarvis" by speech recognition.
  return n === 'jarvis' ? ['jarvis', 'jarvus', 'jervis', 'javis', 'jarvas', 'jarves', 'jarviss', 'jar vis', 'travis'] : [n];
}

function isEcho(heard) {
  const words = heard.toLowerCase().replace(/[^\w\s']/g, '').split(/\s+/).filter((w) => w.length > 2);
  if (words.length < 3) return false;
  const recent = S.spoken.filter((s) => Date.now() - s.at < 25000).map((s) => s.t).join(' ');
  if (!recent) return false;
  const hits = words.filter((w) => recent.includes(w)).length;
  return hits / words.length >= 0.7;
}

const STOP_RE = /^(stop|that'?s enough|that is enough|enough|cancel( that)?|never ?mind|quiet|be quiet|shut up|hold on|pause)\b/i;
const YES_RE = /^(yes|yeah|yep|yup|approve[d]?|approved|go ahead|do it|allow( it)?|confirm(ed)?|proceed|sure|send it)\b/i;
const NO_RE = /^(no|nope|deny|denied|don'?t|do not|cancel|stop|reject|never ?mind)\b/i;

function handleTranscript(raw, { forced = false } = {}) {
  const text = String(raw || '').trim();
  if (!text) return;
  const re = wakeRegex();
  const m = re.exec(text);
  let cmd = null;
  if (m) {
    const before = text.slice(0, m.index).trim(), after = text.slice(m.index + m[0].length).trim();
    cmd = after || before;
    if (after && before && before.split(/\s+/).length > 4) cmd = `${before} ${after}`;
  }
  const inFollow = Date.now() < S.followUntil;

  // 1. A pending approval takes priority.
  if (S.approval) {
    const body = (cmd ?? text).replace(/^[\s,]+/, '');
    if (NO_RE.test(body)) return answerApproval(false);
    if (YES_RE.test(body) && (m || forced || !S.approval.hard)) return answerApproval(true);
    if (YES_RE.test(body) && S.approval.hard) { toast(`For this one say “${S.wakeNames[0]}, approve”, or click Approve.`); return; }
  }
  // 2. While Jarvis is talking or working, only the wake word (or hold-to-talk) gets through.
  if ((S.speaking || S.busy) && !forced) {
    if (!m || isEcho(text)) return;
    if (!cmd || STOP_RE.test(cmd)) { stopEverything(); return; }
    return sendText(cmd);
  }
  if (forced) return sendText(m && cmd ? cmd : text);
  if (m) {
    if (isEcho(text)) return;
    if (!cmd) { S.followUntil = Date.now() + 8000; chirp(); $('heard').textContent = '…'; $('heard').classList.add('live'); refreshState(); setTimeout(refreshState, 8100); return; }
    if (STOP_RE.test(cmd) && cmd.split(/\s+/).length <= 5) { stopEverything(); return; }
    return sendText(cmd);
  }
  if (inFollow && !isEcho(text)) {
    if (STOP_RE.test(text) && text.split(/\s+/).length <= 4) { S.followUntil = 0; refreshState(); return; }
    return sendText(text);
  }
}

function chirp() {
  ensureAudio();
  if (!audioCtx) return;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.frequency.setValueAtTime(880, audioCtx.currentTime);
  o.frequency.exponentialRampToValueAtTime(1320, audioCtx.currentTime + 0.09);
  g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.08, audioCtx.currentTime + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.16);
  o.connect(g).connect(audioCtx.destination);
  o.start(); o.stop(audioCtx.currentTime + 0.18);
}

function startRec() {
  if (!SR || recRunning) return;
  if (!rec) {
    rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = prefs.get('lang', navigator.language || 'en-US');
    rec.onstart = () => { recRunning = true; };
    rec.onresult = (e) => {
      if (Date.now() < recBlockedUntil) return;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i], t = r[0].transcript;
        if (r.isFinal) { if (!S.speaking) $('heard').classList.remove('live'); handleTranscript(t, { forced: S.srForced }); }
        else if (!S.speaking && !S.busy && (Date.now() < S.followUntil || wakeRegex().test(t) || S.srForced)) { $('heard').textContent = t; $('heard').classList.add('live'); }
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setHandsFree(false, { silent: true });
        banner('The browser blocked the microphone. Click the lock icon in the address bar, allow the microphone, then turn Hands-free back on.');
      } else if (e.error === 'audio-capture') {
        setHandsFree(false, { silent: true });
        banner('No microphone was found. Plug one in or pick one in your system sound settings.');
      }
    };
    rec.onend = () => { recRunning = false; if (S.handsFree || S.srForced) setTimeout(startRec, 250); };
  }
  try { rec.start(); } catch { /* already starting */ }
}
function stopRec() { if (rec && recRunning) { try { rec.stop(); } catch { /* ignore */ } } }

function setHandsFree(on, { silent = false } = {}) {
  if (on && !SR) {
    toast('Hands-free needs Chrome or Edge. Hold-to-talk and typing work in this browser.', 6000);
    on = false;
  }
  S.handsFree = on;
  prefs.set('handsFree', on);
  $('btn-ear').setAttribute('aria-pressed', String(on));
  if (on) { ensureAudio(); startRec(); if (!silent) toast(`Hands-free on — say “${cap(S.wakeNames[0])}, …”`); }
  else { stopRec(); S.followUntil = 0; }
  refreshState();
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
$('btn-ear').addEventListener('click', () => setHandsFree(!S.handsFree));

// ------------------------------------------------------------------ voice in: hold to talk (ElevenLabs transcription)
let micStream = null, recorder = null, chunks = [], holdStart = 0;

async function holdStartFn() {
  if (S.holding) return;
  hush();
  ensureAudio();
  S.holding = true; holdStart = Date.now();
  $('btn-mic').classList.add('holding');
  $('heard').textContent = 'Listening…'; $('heard').classList.add('live');
  refreshState();
  const useEleven = !!S.status?.voice?.keySet && !S.status?.voice?.down && !!window.MediaRecorder;
  if (!useEleven) {
    if (!SR) { toast('Hold-to-talk needs an ElevenLabs key (Settings) or Chrome/Edge.'); return holdEnd(true); }
    S.srForced = true; startRec(); return;
  }
  try {
    recBlockedUntil = Date.now() + 60000; // ignore the wake-word recogniser while recording
    micStream = micStream || await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    if (audioCtx && !micLevel) {
      const src = audioCtx.createMediaStreamSource(micStream), an = audioCtx.createAnalyser();
      an.fftSize = 256; src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      micLevel = () => { an.getByteTimeDomainData(buf); let s = 0; for (const v of buf) s += (v - 128) ** 2; return Math.min(1, Math.sqrt(s / buf.length) / 28); };
    }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
    chunks = [];
    recorder = new MediaRecorder(micStream, mime ? { mimeType: mime } : undefined);
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      const type = recorder.mimeType || 'audio/webm';
      const blob = new Blob(chunks, { type });
      recorder = null;
      recBlockedUntil = Date.now() + 700;
      if (Date.now() - holdStart < 350 || blob.size < 1200) { $('heard').textContent = ''; $('heard').classList.remove('live'); toast('Hold the button while you speak.', 2200); return; }
      $('heard').textContent = 'Transcribing…';
      try {
        const { text } = await api('/api/stt', { method: 'POST', body: blob, headers: { 'content-type': type.split(';')[0] } });
        $('heard').classList.remove('live');
        if (!text) { $('heard').textContent = ''; toast('I did not catch that.', 2200); return; }
        handleTranscript(text, { forced: true });
      } catch (e) { $('heard').textContent = ''; $('heard').classList.remove('live'); toast(`Transcription failed: ${e.message}`, 6000); }
    };
    recorder.start();
    if (!S.holding) recorder.stop(); // released before the mic was ready
  } catch (e) {
    recBlockedUntil = 0;
    holdEnd(true);
    banner(e.name === 'NotAllowedError' ? 'The browser blocked the microphone. Click the lock icon in the address bar and allow it.' : `Microphone problem: ${e.message}`);
  }
}
function holdEnd(cancel = false) {
  if (!S.holding) return;
  S.holding = false;
  $('btn-mic').classList.remove('holding');
  if (recorder && recorder.state === 'recording') recorder.stop();
  if (S.srForced) { setTimeout(() => { S.srForced = false; if (!S.handsFree) stopRec(); }, 1400); }
  if (cancel) { $('heard').textContent = ''; $('heard').classList.remove('live'); }
  refreshState();
}
const mic = $('btn-mic');
mic.addEventListener('pointerdown', (e) => { e.preventDefault(); mic.setPointerCapture(e.pointerId); holdStartFn(); });
mic.addEventListener('pointerup', () => holdEnd());
mic.addEventListener('pointercancel', () => holdEnd(true));
mic.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); holdStartFn(); } });
mic.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') holdEnd(); });

const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || $('settings').open;
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('settings').open) { if (S.speaking || S.busy) stopEverything(); else if (!$('panel').hidden) closePanel(); return; }
  if (typing() || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'Space' && !e.repeat && document.activeElement?.tagName !== 'BUTTON') { e.preventDefault(); holdStartFn(); }
  else if (e.key === '/') { e.preventDefault(); $('ask-input').focus(); }
  else if (e.key.toLowerCase() === 'h') setHandsFree(!S.handsFree);
});
addEventListener('keyup', (e) => { if (e.code === 'Space' && S.holding && document.activeElement !== mic) holdEnd(); });
addEventListener('blur', () => holdEnd(true));

// ------------------------------------------------------------------ screen sharing
const screen = { stream: null, track: null, capture: null, timer: 0, busy: false };
const video = $('screen-video');

async function grabFrame(id) {
  if (!screen.track || screen.track.readyState !== 'live' || screen.busy) return;
  screen.busy = true;
  try {
    let bmp = null;
    if (screen.capture) { try { bmp = await screen.capture.grabFrame(); } catch { bmp = null; } }
    const sw = bmp ? bmp.width : video.videoWidth, sh = bmp ? bmp.height : video.videoHeight;
    if (!sw || !sh) return;
    const k = Math.min(1, 1568 / Math.max(sw, sh));
    const c = document.createElement('canvas');
    c.width = Math.round(sw * k); c.height = Math.round(sh * k);
    c.getContext('2d').drawImage(bmp || video, 0, 0, c.width, c.height);
    bmp?.close?.();
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
    if (blob) await api(`/api/screen?w=${c.width}&h=${c.height}${id ? `&id=${id}` : ''}`, { method: 'POST', body: blob, headers: { 'content-type': 'image/jpeg' } });
  } catch { /* next tick retries */ } finally { screen.busy = false; }
}

async function startScreen() {
  if (!navigator.mediaDevices?.getDisplayMedia) { toast('This browser cannot share the screen. Use Chrome or Edge.'); return; }
  try {
    screen.stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 5, max: 10 } }, audio: false });
  } catch (e) { if (e.name !== 'NotAllowedError') toast(`Screen share failed: ${e.message}`); return; }
  screen.track = screen.stream.getVideoTracks()[0];
  screen.capture = 'ImageCapture' in window ? new ImageCapture(screen.track) : null;
  video.srcObject = screen.stream;
  try { await video.play(); } catch { /* muted autoplay normally fine */ }
  screen.track.addEventListener('ended', () => stopScreen());
  $('screen-pip').hidden = false;
  $('btn-screen').setAttribute('aria-pressed', 'true');
  $('btn-screen').querySelector('span').textContent = 'Stop sharing';
  await api('/api/screen/state', { method: 'POST', json: { on: true } });
  await new Promise((r) => setTimeout(r, 400));
  grabFrame();
  screen.timer = setInterval(() => grabFrame(), 4000);
}
async function stopScreen() {
  if (!screen.stream) return;
  clearInterval(screen.timer);
  for (const t of screen.stream.getTracks()) t.stop();
  screen.stream = screen.track = screen.capture = null;
  video.srcObject = null;
  $('screen-pip').hidden = true; $('screen-pip').classList.remove('big'); $('pointer').hidden = true;
  $('btn-screen').setAttribute('aria-pressed', 'false');
  $('btn-screen').querySelector('span').textContent = 'Share screen';
  try { await api('/api/screen/state', { method: 'POST', json: { on: false } }); } catch { /* ignore */ }
}
$('btn-screen').addEventListener('click', () => (screen.stream ? stopScreen() : startScreen()));
$('pip-size').addEventListener('click', () => $('screen-pip').classList.toggle('big'));
let pointerTimer;
function showPointer({ x, y, label }) {
  if (!screen.stream) return;
  const p = $('pointer');
  $('screen-pip').classList.add('big');
  p.style.left = `${x * 100}%`; p.style.top = `${y * 100}%`;
  p.querySelector('b').textContent = label || ''; p.querySelector('b').hidden = !label;
  p.hidden = false;
  clearTimeout(pointerTimer);
  pointerTimer = setTimeout(() => { p.hidden = true; $('screen-pip').classList.remove('big'); }, 14000);
}

// ------------------------------------------------------------------ panels
function openPanel(title, html, { speakText = '' } = {}) {
  if (!$('workshop').hidden) return openPanelOverWorkshop(title, html, speakText);
  $('panel-title').textContent = title;
  $('panel-body').innerHTML = html;
  $('panel-body').scrollTop = 0;
  $('panel').hidden = false;
  $('panel').dataset.speak = speakText;
  $('panel-read').hidden = !speakText;
  document.body.classList.add('with-left');
  syncInset();
}
function syncInset() {
  const el = !$('workshop').hidden ? $('workshop') : !$('panel').hidden ? $('panel') : null;
  galaxy.setInset(el ? el.getBoundingClientRect().right : 0);
}
addEventListener('resize', syncInset);
function openPanelOverWorkshop(title, html, speakText) { setWorkshop(false); openPanel(title, html, { speakText }); }
function closePanel() {
  $('panel').hidden = true;
  if ($('workshop').hidden) document.body.classList.remove('with-left');
  syncInset();
  galaxy.focus(null);
}
$('panel-close').addEventListener('click', closePanel);
$('panel-read').addEventListener('click', () => { const t = $('panel').dataset.speak; if (t) api('/api/speak', { method: 'POST', json: { text: t.slice(0, 380) } }); });

async function showFile(node) {
  try {
    const f = await api(`/api/file?id=${node.id}`);
    let html = `<div class="file-meta">${escapeHtml(f.path)}${f.size ? ` · ${fmtSize(f.size)}` : ''}</div>`;
    if (f.kind === 'markdown') html += renderMarkdown(f.text);
    else if (f.kind === 'text') html += `<pre><code>${escapeHtml(f.text)}</code></pre>`;
    else if (f.kind === 'image') html += `<img src="${f.url}?t=${TOKEN}" alt="${escapeHtml(f.name)}">`;
    else if (f.kind === 'dir') html += `<ul>${f.children.map((c) => `<li>${c.dir ? '📁 ' : ''}${escapeHtml(c.name)}</li>`).join('') || '<li>Empty folder</li>'}</ul>`;
    else html += `<p>No preview for this file type. Ask Jarvis: “open ${escapeHtml(f.name)}” or “summarise ${escapeHtml(f.name)}”.</p>`;
    if (f.clipped) html += '<p class="hint">Preview shortened. Ask Jarvis for the rest.</p>';
    openPanel(f.name, html, { speakText: f.kind === 'markdown' || f.kind === 'text' ? f.text : '' });
    galaxy.focus([node.id]);
  } catch (e) { toast(e.message); }
}
const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
galaxy.onPick = (node) => { if (node && node.kind !== 'root') showFile(node); };

function showFocus({ query, ids, items }) {
  galaxy.focus(ids);
  if (!items?.length) return;
  const list = items.map((it) => `<li><button data-id="${it.id}"><span>${it.type === 'dir' ? '📁 ' : ''}${escapeHtml(it.name)}</span><small>${escapeHtml(it.where || '')}</small></button></li>`).join('');
  openPanel(query ? `“${query}”` : 'Pulled up', `<ul class="file-list">${list}</ul>`);
  $('panel-body').querySelectorAll('button[data-id]').forEach((b) => b.addEventListener('click', () => showFile({ id: Number(b.dataset.id) })));
}

// ------------------------------------------------------------------ workshop
function setWorkshop(on) {
  $('workshop').hidden = !on;
  $('btn-workshop').setAttribute('aria-pressed', String(on));
  if (on) { $('panel').hidden = true; document.body.classList.add('with-left'); }
  else if ($('panel').hidden) document.body.classList.remove('with-left');
  workshop.setActive(on);
  syncInset();
}
$('btn-workshop').addEventListener('click', () => setWorkshop($('workshop').hidden));
$('ws-close').addEventListener('click', () => setWorkshop(false));
const wsToggle = (btn, on, off, flag) => btn.addEventListener('click', () => {
  try { workshop.control(workshop[flag] ? off : on); } catch (e) { toast(e.message); }
  syncWsButtons();
});
function syncWsButtons() {
  $('ws-explode').textContent = workshop.exploded ? 'Put together' : 'Pull apart';
  $('ws-explode').setAttribute('aria-pressed', String(workshop.exploded));
  $('ws-labels').setAttribute('aria-pressed', String(workshop.showLabels));
  $('ws-spin').setAttribute('aria-pressed', String(workshop.spin));
}
wsToggle($('ws-explode'), 'explode', 'assemble', 'exploded');
wsToggle($('ws-labels'), 'labels_on', 'labels_off', 'showLabels');
wsToggle($('ws-spin'), 'spin_on', 'spin_off', 'spin');
$('ws-save').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = workshop.snapshot(1920);
  a.download = `${($('ws-title').textContent || 'workshop').replace(/[^\w-]+/g, '-').toLowerCase()}.png`;
  a.click();
});

const hudReply = (id, ok, data, error) => api('/api/hud-reply', { method: 'POST', json: { id, ok, data, error } }).catch(() => {});
const hudHandlers = {
  workshop_build(d) {
    setWorkshop(true);
    $('ws-busy').hidden = false;
    // Let the panel lay out before building so the camera frames against the real canvas size.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try { hudReply(d.id, true, workshop.build(d)); }
      catch (e) { hudReply(d.id, false, null, e.message); }
      finally { $('ws-busy').hidden = true; syncWsButtons(); }
    }));
  },
  workshop_control(d) {
    try {
      if (d.action === 'open') { setWorkshop(true); return hudReply(d.id, true, { message: 'Workshop open.' }); }
      if (d.action === 'close') { setWorkshop(false); return hudReply(d.id, true, { message: 'Workshop closed.' }); }
      setWorkshop(true);
      const message = workshop.control(d.action, d.part);
      syncWsButtons();
      hudReply(d.id, true, { message });
    } catch (e) { hudReply(d.id, false, null, e.message); }
  },
  workshop_snapshot(d) {
    if (!workshop.parts.size) return hudReply(d.id, false, null, 'Nothing has been built on the bench yet.');
    setWorkshop(true);
    setTimeout(() => { try { hudReply(d.id, true, { png: workshop.snapshot() }); } catch (e) { hudReply(d.id, false, null, e.message); } }, 350);
  },
};

// ------------------------------------------------------------------ approvals
function showApproval(a) {
  S.approval = a;
  const el = $('approval');
  el.classList.toggle('hard', !!a.hard);
  $('ap-kind').textContent = a.hard ? 'Approval needed — sends, spends, publishes or deletes' : 'Approval needed';
  $('ap-title').textContent = a.label;
  $('ap-summary').textContent = a.summary;
  $('ap-detail').textContent = a.detail;
  $('ap-always').hidden = !!a.hard;
  $('ap-hint').textContent = a.hard ? `Click Approve, or say “${cap(S.wakeNames[0])}, approve”. Saying “no” denies it.` : 'Click, or just say “yes” or “no”.';
  el.hidden = false;
  if (S.handsFree) { S.followUntil = Date.now() + 60000; }
  refreshState();
}
async function answerApproval(allow, always = false) {
  const a = S.approval;
  if (!a) return;
  S.approval = null; $('approval').hidden = true; S.followUntil = 0;
  hush();
  refreshState();
  try { await api('/api/approve', { method: 'POST', json: { id: a.id, allow, always } }); } catch { /* expired */ }
}
$('ap-allow').addEventListener('click', () => answerApproval(true));
$('ap-always').addEventListener('click', () => answerApproval(true, true));
$('ap-deny').addEventListener('click', () => answerApproval(false));

// ------------------------------------------------------------------ tool chips
const chips = new Map();
function prettyTool(name) {
  if (!name.startsWith('mcp__')) return { app: 'Claude', action: name.replace(/([a-z])([A-Z])/g, '$1 $2') };
  const parts = name.split('__');
  const app = parts[1].replace(/^claude_ai_/i, '').replace(/^plugin_[^_]+_/i, '').replace(/_/g, ' ');
  return { app: app === 'jarvis' ? 'HUD' : app, action: parts.slice(2).join(' ').replace(/[_-]/g, ' ') };
}
function toolEvent({ id, name, phase }) {
  if (phase === 'start') {
    const { app, action } = prettyTool(name);
    const el = document.createElement('div');
    el.className = 'tool';
    el.innerHTML = `<i></i><small>${escapeHtml(app)}</small><span>${escapeHtml(action)}</span>`;
    $('tools').appendChild(el);
    chips.set(id, el);
    while ($('tools').children.length > 6) $('tools').firstChild.remove();
  } else {
    const el = chips.get(id);
    if (!el) return;
    chips.delete(id);
    el.classList.add(phase === 'error' ? 'error' : 'done');
    setTimeout(() => el.classList.add('leaving'), 5000);
    setTimeout(() => el.remove(), 5700);
  }
  S.toolsActive = chips.size > 0;
  refreshState();
}

// ------------------------------------------------------------------ attachments / drop
function renderAttachments() {
  $('attachments').innerHTML = '';
  S.attachments.forEach((a, i) => {
    const s = document.createElement('span');
    s.textContent = a.name;
    const x = document.createElement('button'); x.type = 'button'; x.textContent = '✕'; x.setAttribute('aria-label', `Remove ${a.name}`);
    x.onclick = () => { S.attachments.splice(i, 1); renderAttachments(); };
    s.appendChild(x);
    $('attachments').appendChild(s);
  });
}
async function addFiles(files, { autoSend = false } = {}) {
  for (const f of files) {
    if (f.size > 28 * 1024 * 1024) { toast(`${f.name} is too large (28 MB max).`); continue; }
    try {
      const r = await api(`/api/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f, headers: { 'content-type': 'application/octet-stream' } });
      S.attachments.push(r);
    } catch (e) { toast(`Could not add ${f.name}: ${e.message}`); }
  }
  renderAttachments();
  if (autoSend && S.attachments.length) {
    // Dropped on the open workshop: build it straight away, like the bench in the video.
    sendText(!$('workshop').hidden && S.attachments.every((a) => /\.(png|jpe?g|webp|gif)$/i.test(a.name)) ? 'Build this in the workshop.' : '');
  } else if (S.attachments.length) { $('ask-input').focus(); toast('Attached. Tell Jarvis what to do with it.', 2600); }
}
$('btn-attach').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
let dragDepth = 0;
addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; $('drop').hidden = false; } });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; $('drop').hidden = true; if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files], { autoSend: !$('workshop').hidden }); });
addEventListener('paste', (e) => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); addFiles(files); } });

$('btn-new').addEventListener('click', async () => { await api('/api/new-session', { method: 'POST' }); setCaption(''); $('heard').textContent = ''; });

// ------------------------------------------------------------------ status + settings
function applyStatus(st) {
  S.status = st;
  S.wakeNames = namesFor(st.name);
  $('brand-name').textContent = String(st.name || 'Jarvis').toUpperCase();
  document.title = String(st.name || 'Jarvis').toUpperCase();
  $('ask-input').placeholder = `Type to ${st.name}, or say “${st.name}…”`;
  $('model-chip').textContent = prettyModel(st.brain.model) || 'Claude';
  const live = (st.connectors || []).filter((c) => c.status === 'connected');
  const cc = $('connectors-chip');
  cc.textContent = st.connectors?.length ? `${live.length} connector${live.length === 1 ? '' : 's'}` : 'connectors —';
  cc.classList.toggle('ok', live.length > 0);
  const vc = $('voice-chip');
  const elevenOn = st.voice.keySet && !st.voice.down;
  vc.textContent = elevenOn ? 'voice · ElevenLabs' : st.voice.keySet ? 'voice · ElevenLabs error' : 'voice · browser (add ElevenLabs key)';
  vc.classList.toggle('ok', elevenOn); vc.classList.toggle('bad', st.voice.keySet && !!st.voice.down);
  if (st.usage) showUsage(st.usage);
  if (st.brain.fatal) banner(st.brain.fatal.message, { label: 'Reconnect', run: reconnect });
  S.brain = st.brain.state;
  refreshState();
}
function prettyModel(m) {
  if (!m) return '';
  const x = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(m);
  return x ? `${cap(x[1])} ${x[2]}${x[3] && x[3].length < 3 ? '.' + x[3] : ''}` : cap(m);
}
function showUsage(u) {
  const w = u.unifiedWindows?.five_hour;
  const el = $('usage-chip');
  if (!w || typeof w.utilization !== 'number') { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = `usage ${Math.round(w.utilization * 100)}%`;
  el.classList.toggle('bad', w.utilization > 0.85 || u.status !== 'allowed');
}
async function reconnect() {
  banner('');
  toast('Reconnecting to Claude…');
  try { applyStatus(await api('/api/reconnect', { method: 'POST' })); } catch (e) { toast(e.message); }
}

function renderChecks(st) {
  const row = (cls, tag, title, sub) => `<li class="${cls}"><b>${tag}</b><span>${escapeHtml(title)}${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</span></li>`;
  const live = (st.connectors || []).filter((c) => c.status === 'connected');
  const other = (st.connectors || []).filter((c) => c.status !== 'connected');
  const otherText = other.length ? `${other.length} more set up but not connected right now: ${other.slice(0, 8).map((c) => c.name).join(', ')}${other.length > 8 ? '…' : ''}` : '';
  const rows = [];
  rows.push(st.claude.found
    ? row(st.brain.fatal ? 'bad' : 'ok', st.brain.fatal ? 'FIX' : 'OK', `Claude Code ${st.claude.version}`, st.brain.fatal ? st.brain.fatal.message : `Brain: ${prettyModel(st.brain.model) || 'Claude Code default'} · using your Claude login, connectors, skills and memory`)
    : row('bad', 'FIX', 'Claude Code not found', 'Install it from claude.com/claude-code, run “claude” in a terminal once to log in, then press Reconnect Claude.'));
  rows.push(st.connectors?.length
    ? row(live.length ? 'ok' : 'warn', live.length ? 'OK' : 'CHECK', `${live.length} connected app${live.length === 1 ? '' : 's'}: ${live.map((c) => c.name).join(', ') || 'none'}`, otherText)
    : row('warn', 'WAIT', 'Connected apps appear after the first message', 'Jarvis uses whatever connectors your Claude Code has (Gmail, Calendar, Drive…). Manage them in Claude’s connector settings.'));
  rows.push(st.voice.keySet
    ? row(st.voice.down ? 'bad' : 'ok', st.voice.down ? 'FIX' : 'OK', `ElevenLabs key saved (${st.voice.keyHint})`, st.voice.down ? st.voice.down.message : `Voice model ${st.voice.model}`)
    : row('warn', 'ADD', 'ElevenLabs key not added yet', 'Jarvis is using the built-in browser voice. Paste your key below for the real voice.'));
  rows.push(SR ? row('ok', 'OK', 'Hands-free wake word available', 'Uses this browser’s speech recognition.') : row('warn', 'NOTE', 'Hands-free needs Chrome or Edge', 'Hold-to-talk and typing still work here.'));
  rows.push(st.vault.missing ? row('bad', 'FIX', 'Second brain folder not found', st.vault.root) : row('ok', 'OK', `Second brain: ${st.vault.count} items${st.vault.truncated ? ' (largest folders capped)' : ''}`, st.vault.root));
  $('checks').innerHTML = rows.join('');
}

async function loadVoices(current) {
  const sel = $('set-voice');
  try {
    const { voices } = await api('/api/voices');
    sel.innerHTML = voices.map((v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.name)}${v.accent || v.gender ? ` — ${escapeHtml([v.accent, v.gender].filter(Boolean).join(', '))}` : ''}${v.category ? ` (${escapeHtml(v.category)})` : ''}</option>`).join('');
    if (![...sel.options].some((o) => o.value === current)) sel.insertAdjacentHTML('afterbegin', `<option value="${escapeHtml(current)}">Current voice (${escapeHtml(current.slice(0, 8))}…)</option>`);
    sel.value = current;
  } catch (e) {
    sel.innerHTML = `<option value="${escapeHtml(current)}">${escapeHtml(e.data?.code === 'no_key' ? 'Save a key to load your voices' : `Default voice — list unavailable (${e.message})`)}</option>`;
  }
}

async function openSettings() {
  const st = await api('/api/status');
  applyStatus(st);
  renderChecks(st);
  $('set-key').value = '';
  $('set-key').placeholder = st.voice.keySet ? `Saved (${st.voice.keyHint}) — paste a new key to replace it` : 'Paste your ElevenLabs API key';
  $('set-address').value = st.address;
  $('set-name').value = st.name;
  $('set-brain').value = st.vault.root;
  const pinned = st.brain.pinned || '';
  if (pinned && ![...$('set-model').options].some((o) => o.value === pinned)) $('set-model').insertAdjacentHTML('beforeend', `<option value="${escapeHtml(pinned)}">${escapeHtml(pinned)}</option>`);
  $('set-model').value = pinned;
  $('set-effort').value = st.effort || '';
  $('set-convo').checked = prefs.get('convo', true);
  $('set-chrome').checked = !!st.chrome;
  $('set-status').textContent = '';
  $('set-voice-result').textContent = '';
  if (!$('settings').open) $('settings').showModal();
  loadVoices(st.voice.voiceId);
}
$('btn-settings').addEventListener('click', openSettings);
$('connectors-chip').addEventListener('click', openSettings);

$('set-save').addEventListener('click', async () => {
  const btn = $('set-save');
  btn.disabled = true; $('set-status').textContent = 'Saving…';
  prefs.set('convo', $('set-convo').checked);
  try {
    const r = await api('/api/settings', { method: 'POST', json: {
      elevenKey: $('set-key').value, voiceId: $('set-voice').value, address: $('set-address').value, name: $('set-name').value,
      brainDir: $('set-brain').value, model: $('set-model').value, effort: $('set-effort').value, chrome: $('set-chrome').checked,
    } });
    applyStatus(r.status); renderChecks(r.status);
    $('set-key').value = '';
    if (r.voiceCheck) {
      $('set-voice-result').textContent = r.voiceCheck.message;
      if (r.voiceCheck.ok) { loadVoices(r.status.voice.voiceId); banner(''); }
    }
    $('set-status').textContent = r.voiceCheck && !r.voiceCheck.ok ? 'Saved, but the voice check failed — see above.' : 'Saved.';
  } catch (e) { $('set-status').textContent = e.message; }
  btn.disabled = false;
});
$('set-voice-test').addEventListener('click', async () => {
  ensureAudio();
  $('set-voice-result').textContent = 'Testing…';
  try {
    const sel = $('set-voice').value;
    if (sel && sel !== S.status.voice.voiceId) await api('/api/settings', { method: 'POST', json: { voiceId: sel } });
    const r = await api('/api/voice-test', { method: 'POST' });
    $('set-voice-result').textContent = r.message;
    applyStatus(await api('/api/status'));
  } catch (e) { $('set-voice-result').textContent = e.message; }
});
$('set-reconnect').addEventListener('click', async () => { await reconnect(); renderChecks(S.status); });
$('set-reset-perms').addEventListener('click', async () => { await api('/api/permissions/reset', { method: 'POST' }); $('set-status').textContent = 'Jarvis will ask again for everything.'; });

// ------------------------------------------------------------------ server events
function connect() {
  const es = new EventSource(`/events?t=${TOKEN}`);
  const on = (type, fn) => es.addEventListener(type, (e) => { try { fn(JSON.parse(e.data)); } catch (err) { console.error(type, err); } });
  on('hello', (st) => { applyStatus(st); if (S.wasDown) { S.wasDown = false; toast('Reconnected.'); } loadGraph(); if (st.screen && !screen.stream) api('/api/screen/state', { method: 'POST', json: { on: false, announce: false } }); });
  on('state', (d) => { S.brain = d.brain; if (d.brain === 'idle' || d.brain === 'stopped') S.busy = false; if (d.brain === 'thinking' || d.brain === 'answering') S.busy = true; refreshState(); });
  on('init', (d) => { if (S.status) { S.status.brain.model = d.model; S.status.connectors = d.connectors; S.status.brain.fatal = null; applyStatus(S.status); } });
  on('connectors', (d) => { if (S.status) { S.status.connectors = d.connectors; applyStatus(S.status); } });
  on('settings', applyStatus);
  on('heard', (d) => { $('heard').classList.remove('live'); $('heard').textContent = d.text ? `“${d.text}”` : ''; S.busy = true; setCaption(''); refreshState(); });
  on('delta', (d) => setCaption(captionText + d.text));
  on('delta_end', () => { if (captionText && !/\s$/.test(captionText)) captionText += ' '; });
  on('say', enqueueSay);
  on('hush', hush);
  on('tool', toolEvent);
  on('usage', (u) => { if (S.status) S.status.usage = u; showUsage(u); });
  on('turn_end', () => { S.busy = false; for (const el of chips.values()) el.remove(); chips.clear(); S.toolsActive = false; refreshState(); });
  on('turn_error', (d) => { S.busy = false; refreshState(); banner(d.message, d.code === 'login' ? { label: 'Reconnect', run: reconnect } : null); });
  on('fatal', (f) => { if (S.status) S.status.brain.fatal = f; S.busy = false; banner(f.message, { label: 'Reconnect', run: reconnect }); refreshState(); });
  on('notice', (d) => toast(d.message));
  on('voice_error', (d) => { if (S.status) { S.status.voice.down = d; applyStatus(S.status); } banner(`${d.message} Using the browser voice for now.`, { label: 'Open settings', run: openSettings }); });
  on('panel', (d) => openPanel(d.title, (d.image ? `<p><img src="${d.image}?t=${TOKEN}" alt=""></p>` : '') + renderMarkdown(d.markdown), { speakText: d.markdown }));
  on('focus', showFocus);
  on('graph_changed', loadGraph);
  on('need_frame', (d) => grabFrame(d.id));
  on('pointer', showPointer);
  on('approval', showApproval);
  on('approval_done', (d) => { if (S.approval?.id === d.id) { S.approval = null; $('approval').hidden = true; refreshState(); } });
  for (const [type, fn] of Object.entries(hudHandlers)) on(type, fn);
  es.onerror = () => {
    if (!S.wasDown) { S.wasDown = true; S.status = null; S.busy = false; refreshState(); $('state-label').textContent = 'Server stopped — restart Jarvis'; }
  };
}

async function loadGraph() {
  try { galaxy.setGraph(await api('/api/graph')); } catch (e) { console.error(e); }
}

// ------------------------------------------------------------------ boot
function boot() {
  connect();
  refreshState();
  // Browsers only allow sound and the microphone after a click, so the first visit shows one Start button.
  $('wake').hidden = false;
  $('wake-go').focus();
  $('wake-go').addEventListener('click', async () => {
    $('wake').hidden = true;
    ensureAudio();
    if ('speechSynthesis' in window) speechSynthesis.getVoices();
    if (prefs.get('handsFree', true) && SR) setHandsFree(true, { silent: true });
    let st = S.status;
    try { st = await api('/api/status'); applyStatus(st); } catch { /* shown by SSE */ }
    if (st && !st.voice.keySet && !prefs.get('setupSeen', false)) { prefs.set('setupSeen', true); openSettings(); }
    else if (st && !st.brain.fatal) api('/api/speak', { method: 'POST', json: { text: `${st.name} online. Standing by, ${st.address}.` } }).catch(() => {});
  }, { once: true });
}
boot();
window.__jarvis = { S, galaxy, workshop, handleTranscript, prefs }; // handy in the browser console and for tests
