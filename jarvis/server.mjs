#!/usr/bin/env node
// JARVIS — Claude edition. Local HUD server: browser <-> this process <-> Claude Code + ElevenLabs.
// Zero npm dependencies. Listens on 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { ROOT, DATA_DIR, loadConfig, saveEnv, ensureDirs, readState, writeState } from './lib/config.mjs';
import { Brain } from './lib/brain.mjs';
import { createMcp } from './lib/mcp.mjs';
import { Policy } from './lib/policy.mjs';
import { createVoice, SentenceStream, speakable } from './lib/voice.mjs';
import { Vault, isImagePath } from './lib/vault.mjs';

let cfg = loadConfig();
ensureDirs(cfg);
const getCfg = () => cfg;
const TOKEN = randomBytes(18).toString('hex');
const PUBLIC = path.join(ROOT, 'public');
const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

const state = readState();
const voice = createVoice(getCfg);
const vault = new Vault(getCfg, log);
const policy = new Policy(getCfg);

// ---------------------------------------------------------------- HUD hub (SSE + request/reply)
const sse = new Set();
const pendingHud = new Map();
const pendingApprovals = new Map();
const served = new Map();
let seq = 0;

const hub = {
  screen: { on: false, frame: null, at: 0, width: 0, height: 0, waiters: new Map() },
  clients: () => sse.size,
  broadcast(type, data = {}) {
    const line = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sse) { try { res.write(line); } catch { /* dropped client */ } }
  },
  request(type, data, timeout = 10000) {
    return new Promise((resolve) => {
      const id = `h${++seq}`;
      const timer = setTimeout(() => { pendingHud.delete(id); resolve({ ok: false, error: 'The HUD did not answer in time.' }); }, timeout);
      pendingHud.set(id, { resolve, timer });
      hub.broadcast(type, { ...data, id });
    });
  },
  async freshFrame() {
    const s = hub.screen;
    if (!s.on) return null;
    const got = await new Promise((resolve) => {
      const id = `f${++seq}`;
      const timer = setTimeout(() => { s.waiters.delete(id); resolve(false); }, 2500);
      s.waiters.set(id, () => { clearTimeout(timer); resolve(true); });
      hub.broadcast('need_frame', { id });
    });
    if (!s.frame || (!got && Date.now() - s.at > 20000)) return null;
    return { data: s.frame, mime: 'image/jpeg', at: s.at, width: s.width, height: s.height };
  },
  askApproval(req) {
    return new Promise((resolve) => {
      const id = `a${++seq}`;
      const timer = setTimeout(() => {
        pendingApprovals.delete(id);
        hub.broadcast('approval_done', { id });
        resolve({ allow: false, reason: 'The user did not answer the approval request within three minutes. Tell them it is waiting and do not retry on your own.' });
      }, 180000);
      pendingApprovals.set(id, { resolve, timer, req });
      hub.broadcast('approval', { id, ...req });
      sayDirect(`I need your approval. ${speakable(req.summary).slice(0, 160)}`);
    });
  },
  registerFile(abs) {
    const p = path.resolve(String(abs));
    if (!isImagePath(p) || !fs.existsSync(p)) return null;
    const id = randomBytes(8).toString('hex');
    served.set(id, p);
    if (served.size > 200) served.delete(served.keys().next().value);
    return id;
  },
  queueModel(m) { pendingModel = m; },
};
let pendingModel = null;

// ---------------------------------------------------------------- speech pipeline
const ttsJobs = new Map();
let voiceDown = null;        // { code, message, at } when ElevenLabs is failing hard (bad key, no credit)
let muted = false;           // true after an interrupt until the next user message

function makeJob(text) {
  const id = `s${++seq}`;
  const job = { id, text, chunks: [], done: false, error: null, waiters: [], ctrl: new AbortController() };
  ttsJobs.set(id, job);
  setTimeout(() => ttsJobs.delete(id), 180000);
  const wake = () => { for (const w of job.waiters.splice(0)) w(); };
  (async () => {
    try {
      const res = await voice.speak(text, { signal: job.ctrl.signal });
      for await (const chunk of res.body) { job.chunks.push(Buffer.from(chunk)); wake(); }
      voiceDown = null;
    } catch (e) {
      if (e.name !== 'AbortError') {
        job.error = { code: e.code || 'voice_error', message: e.message };
        if (['bad_key', 'quota', 'bad_voice', 'no_key'].includes(job.error.code)) voiceDown = { ...job.error, at: Date.now() };
        hub.broadcast('voice_error', job.error);
        log(`[voice] ${e.message}`);
      } else {
        job.error = { code: 'aborted', message: 'stopped' };
      }
    } finally { job.done = true; wake(); }
  })();
  return job;
}

function say(text) {
  if (muted || !text) return;
  if (voiceDown && Date.now() - voiceDown.at > 5 * 60000) voiceDown = null;
  if (voice.enabled() && !voiceDown) {
    const job = makeJob(text);
    hub.broadcast('say', { id: job.id, text, engine: 'eleven' });
  } else {
    hub.broadcast('say', { id: `s${++seq}`, text, engine: 'browser' });
  }
}
// Lines Jarvis says without involving Claude (status, approvals).
function sayDirect(text) { const m = muted; muted = false; say(text); muted = m; }

function hush() {
  for (const job of ttsJobs.values()) { try { job.ctrl.abort(); } catch { /* ignore */ } }
  ttsJobs.clear();
  hub.broadcast('hush', {});
}

const speech = new SentenceStream((sentence) => say(sentence));

// ---------------------------------------------------------------- brain (Claude Code)
const personaFile = path.join(DATA_DIR, 'persona.rendered.md');
const mcpFile = path.join(DATA_DIR, 'mcp.json');

function renderRuntimeFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const persona = fs.readFileSync(path.join(ROOT, 'persona.md'), 'utf8')
    .replaceAll('{{NAME}}', cfg.name).replaceAll('{{ADDRESS}}', cfg.address)
    .replaceAll('{{BRAIN_DIR}}', cfg.brainDir).replaceAll('{{HOME}}', cfg.home);
  fs.writeFileSync(personaFile, persona);
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { jarvis: { type: 'http', url: `http://127.0.0.1:${cfg.port}/mcp/${TOKEN}`, alwaysLoad: true } } }));
  return persona;
}
let personaText = renderRuntimeFiles();

const brain = new Brain({
  getCfg,
  log,
  getArgs: ({ resume, model }) => [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--append-system-prompt-file', personaFile,
    '--mcp-config', mcpFile,
    '--permission-prompt-tool', 'mcp__jarvis__approve',
    ...(fs.existsSync(cfg.brainDir) && cfg.brainDir !== cfg.home ? ['--add-dir', cfg.brainDir] : []),
    ...(model ? ['--model', model] : []),
    ...(cfg.effort ? ['--effort', cfg.effort] : []),
    ...(cfg.chrome ? ['--chrome'] : []),
    ...(resume ? ['--resume', resume] : []),
  ],
});
brain.sessionId = state.personaHash === hash(personaText) ? state.sessionId || null : null;
brain.wantModel = state.model || null;

function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return String(h); }
function persist() { writeState({ sessionId: brain.sessionId, model: brain.wantModel, personaHash: hash(personaText) }); }

let fatal = null;
let lastUsage = null;
let interrupted = false;
const toolNames = new Map();

brain.on('state', (s) => hub.broadcast('state', { brain: s }));
brain.on('init', (i) => {
  fatal = null;
  persist();
  hub.broadcast('init', { model: i.model, version: i.version, connectors: connectorList() });
});
brain.on('thinking', () => hub.broadcast('state', { brain: 'thinking' }));
brain.on('text_start', () => hub.broadcast('state', { brain: 'answering' }));
brain.on('text', (t) => { if (!muted) { hub.broadcast('delta', { text: t }); speech.push(t); } });
brain.on('block_stop', () => { speech.flush(); hub.broadcast('delta_end', {}); });
brain.on('tool_start', (t) => {
  speech.flush();
  toolNames.set(t.id, t.name);
  if (t.name !== 'mcp__jarvis__approve') hub.broadcast('tool', { id: t.id, name: t.name, phase: 'start' });
});
brain.on('tool_end', (t) => {
  const name = toolNames.get(t.id) || '';
  toolNames.delete(t.id);
  if (name !== 'mcp__jarvis__approve') hub.broadcast('tool', { id: t.id, name, phase: t.isError ? 'error' : 'done' });
});
brain.on('usage', (u) => { lastUsage = u; hub.broadcast('usage', u); });
brain.on('notice', (m) => hub.broadcast('notice', { message: m }));
brain.on('result', (r) => {
  speech.flush();
  const wasInterrupted = interrupted;
  interrupted = false;
  if (r.isError && !wasInterrupted) {
    const msg = friendlyError(r.text || r.subtype || 'Something went wrong.');
    hub.broadcast('turn_error', { message: msg.detail, code: msg.code });
    sayDirect(msg.spoken);
  }
  hub.broadcast('turn_end', { costUsd: r.costUsd, durationMs: r.durationMs, interrupted: wasInterrupted });
  persist();
  if (pendingModel) {
    const m = pendingModel; pendingModel = null;
    brain.restart({ model: m });
    persist();
    hub.broadcast('notice', { message: `Brain switching to ${m}.` });
  }
});
brain.on('turn_error', (e) => {
  speech.flush();
  const msg = friendlyError(e.message);
  hub.broadcast('turn_error', { message: msg.detail, code: msg.code });
  hub.broadcast('turn_end', {});
});
brain.on('fatal', (f) => {
  fatal = f;
  log(`[brain] FATAL ${f.code}: ${f.message}`);
  hub.broadcast('fatal', f);
});

function friendlyError(raw) {
  const t = String(raw);
  if (/please run \/login|not logged in|invalid api key|authentication|oauth/i.test(t)) {
    return { code: 'login', detail: 'Claude Code is not logged in on this computer. Open a terminal, run "claude", complete the login, then press Reconnect.', spoken: 'Claude Code is not logged in on this computer. Run claude in a terminal and log in, then reconnect me.' };
  }
  if (/usage limit|rate limit|limit reached|out of (extra )?usage|credit/i.test(t)) {
    return { code: 'limit', detail: `Claude usage limit reached. ${t.slice(0, 300)}`, spoken: 'I have hit your Claude usage limit for now. The details are on screen.' };
  }
  if (/overloaded|529|503|timeout|network|ECONN|fetch failed/i.test(t)) {
    return { code: 'network', detail: `Claude is unreachable or overloaded. ${t.slice(0, 300)}`, spoken: 'I could not reach Claude just then. Try me again in a moment.' };
  }
  return { code: 'error', detail: t.slice(0, 600), spoken: 'I ran into a problem with that. The details are on screen.' };
}

// "plugin:small-business:gmail" and "claude.ai Gmail" are the same app to the user: show one tidy name each.
function tidyConnectors(list) {
  const seen = new Map();
  for (const c of list) {
    const name = String(c.name).replace(/^claude\.ai /i, '').split(':').pop().replace(/[-_]/g, ' ').trim();
    const key = name.toLowerCase();
    if (!name || key === 'jarvis') continue;
    const prev = seen.get(key);
    if (!prev || (prev.status !== 'connected' && c.status === 'connected')) seen.set(key, { name: name.replace(/\b\w/g, (ch) => ch.toUpperCase()), status: c.status });
  }
  return [...seen.values()].sort((a, b) => (a.status === 'connected' ? 0 : 1) - (b.status === 'connected' ? 0 : 1) || a.name.localeCompare(b.name));
}
function connectorList() {
  const fromInit = (brain.info.mcp || []).filter((s) => s.name !== 'jarvis');
  return tidyConnectors(fromInit.length ? fromInit : mcpListCache);
}

// Best-effort early look at connectors (the CLI only reports them after the first message).
let mcpListCache = [];
function probeConnectors() {
  execFile(cfg.claudeBin, ['mcp', 'list'], { timeout: 45000, shell: process.platform === 'win32', cwd: cfg.home }, (err, stdout) => {
    if (!stdout) return;
    const out = [];
    for (const line of stdout.split('\n')) {
      const m = line.match(/^\s*([^:]+?):\s+.*?\s-\s+(.*)$/);
      if (!m) continue;
      const status = /connected/i.test(m[2]) && !/fail|not/i.test(m[2]) ? 'connected' : /auth/i.test(m[2]) ? 'needs-auth' : 'failed';
      out.push({ name: m[1].trim(), status });
    }
    if (out.length) { mcpListCache = out; hub.broadcast('connectors', { connectors: connectorList() }); }
  });
}

let claudeVersion = '';
function probeClaude() {
  return new Promise((resolve) => {
    execFile(cfg.claudeBin, ['--version'], { timeout: 15000, shell: process.platform === 'win32' }, (err, stdout) => {
      claudeVersion = err ? '' : String(stdout).trim().split('\n')[0];
      resolve(claudeVersion);
    });
  });
}

// ---------------------------------------------------------------- user turns
let screenNote = null;

// Stops whatever Jarvis is doing and resolves once Claude Code has closed that turn.
function stopCurrentTurn() {
  if (!brain.busy) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 4500);
    brain.once('result', () => { clearTimeout(timer); resolve(); });
    interruptAll();
  });
}

async function userTurn({ text, attachments = [] }) {
  const blocks = [];
  let body = String(text || '').trim();
  const notes = [];
  if (screenNote) { notes.push(screenNote); screenNote = null; }
  for (const a of attachments) {
    const abs = path.resolve(String(a));
    if (!abs.startsWith(path.join(cfg.home, 'inbox') + path.sep) || !fs.existsSync(abs)) continue;
    const ext = path.extname(abs).toLowerCase();
    const media = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ext];
    const size = fs.statSync(abs).size;
    if (media && size < 4.5 * 1024 * 1024) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: media, data: fs.readFileSync(abs).toString('base64') } });
      notes.push(`[HUD: the user dropped an image, shown above and saved at ${abs}]`);
    } else {
      notes.push(`[HUD: the user dropped a file saved at ${abs} — read it if relevant]`);
    }
  }
  if (!body && !blocks.length && !notes.length) return false;
  if (!body) body = attachments.length ? 'Have a look at what I just dropped in.' : '';
  blocks.push({ type: 'text', text: [notes.join('\n'), body].filter(Boolean).join('\n\n') });
  // A new request while Jarvis is mid-task replaces that task rather than queueing behind it.
  await stopCurrentTurn();
  muted = false;
  interrupted = false;
  hub.broadcast('heard', { text: body });
  if (fatal && fatal.code !== 'crash_loop') fatal = null;
  brain.crashes = [];
  brain.send(blocks);
  return true;
}

function interruptAll() {
  muted = true;
  speech.flush();
  hush();
  if (brain.busy) { interrupted = true; brain.interrupt(); }
  for (const [id, a] of pendingApprovals) {
    clearTimeout(a.timer); pendingApprovals.delete(id);
    a.resolve({ allow: false, reason: 'The user told you to stop.' });
    hub.broadcast('approval_done', { id });
  }
}

// ---------------------------------------------------------------- http helpers
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.bmp': 'image/bmp' };

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const json = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
async function jsonBody(req) { const b = await readBody(req, 4 * 1024 * 1024); return b.length ? JSON.parse(b.toString('utf8')) : {}; }

function statusPayload() {
  return {
    name: cfg.name,
    address: cfg.address,
    claude: { found: !!claudeVersion, version: claudeVersion || brain.info.version || '', bin: cfg.claudeBin },
    brain: { state: brain.status || 'stopped', model: brain.model || brain.wantModel || cfg.model || '', pinned: brain.wantModel || cfg.model || '', ready: brain.ready, session: !!brain.sessionId, fatal },
    connectors: connectorList(),
    voice: { keySet: !!cfg.elevenKey, keyHint: cfg.elevenKey ? '••••' + cfg.elevenKey.slice(-4) : '', voiceId: cfg.elevenVoice, model: cfg.elevenModel, down: voiceDown },
    vault: { root: cfg.brainDir, count: vault.graph.nodes.length, truncated: vault.graph.truncated, missing: !!vault.graph.missing },
    workspace: cfg.home,
    screen: hub.screen.on,
    chrome: cfg.chrome,
    effort: cfg.effort,
    usage: lastUsage,
  };
}

// ---------------------------------------------------------------- routes
const mcp = createMcp({ hub, policy, vault, getCfg, log });

const server = http.createServer(async (req, res) => {
  try {
    // Only answer requests addressed to this machine by name (blocks DNS-rebinding from web pages).
    const host = String(req.headers.host || '').toLowerCase();
    if (host !== `127.0.0.1:${cfg.port}` && host !== `localhost:${cfg.port}`) { res.writeHead(403).end('forbidden'); return; }
    const url = new URL(req.url, `http://${host}`);
    const p = url.pathname;

    if (p === `/mcp/${TOKEN}`) {
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return; }
      const out = await mcp(JSON.parse((await readBody(req, 8 * 1024 * 1024)).toString('utf8')));
      if (!out.body) { res.writeHead(out.status).end(); return; }
      return json(res, 200, out.body);
    }

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replace('__JARVIS_TOKEN__', TOKEN);
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      return res.end(html);
    }

    if (p.startsWith('/api/') || p === '/events') {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${host}`) { res.writeHead(403).end('forbidden'); return; }
      const tok = req.headers['x-jarvis-token'] || url.searchParams.get('t');
      if (tok !== TOKEN) { res.writeHead(401).end('unauthorized'); return; }
      return await api(req, res, url, p);
    }

    if (req.method === 'GET') {
      const file = path.normalize(path.join(PUBLIC, decodeURIComponent(p)));
      if (file.startsWith(PUBLIC + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': p.startsWith('/vendor/') ? 'max-age=86400' : 'no-store' });
        return fs.createReadStream(file).pipe(res);
      }
    }
    res.writeHead(404).end('not found');
  } catch (e) {
    log(`[http] ${req.method} ${req.url} -> ${e.message}`);
    if (!res.headersSent) json(res, e.status || 500, { error: e.message });
    else res.end();
  }
});

async function api(req, res, url, p) {
  const m = req.method;

  if (p === '/events' && m === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`event: hello\ndata: ${JSON.stringify(statusPayload())}\n\n`);
    sse.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 20000);
    req.on('close', () => {
      clearInterval(ping); sse.delete(res);
      if (!sse.size && hub.screen.on) { hub.screen.on = false; hub.screen.frame = null; }
    });
    return;
  }

  if (p === '/api/status' && m === 'GET') return json(res, 200, statusPayload());

  if (p === '/api/say' && m === 'POST') {
    const b = await jsonBody(req);
    const ok = await userTurn({ text: b.text, attachments: Array.isArray(b.attachments) ? b.attachments : [] });
    return json(res, ok ? 200 : 400, { ok });
  }

  if (p === '/api/interrupt' && m === 'POST') { interruptAll(); return json(res, 200, { ok: true }); }

  if (p === '/api/speak' && m === 'POST') { const b = await jsonBody(req); sayDirect(speakable(b.text || '').slice(0, 400)); return json(res, 200, { ok: true }); }

  if (p === '/api/new-session' && m === 'POST') {
    interruptAll();
    brain.restart({ fresh: true });
    persist();
    hub.broadcast('notice', { message: 'Started a new conversation.' });
    return json(res, 200, { ok: true });
  }

  if (p === '/api/reconnect' && m === 'POST') {
    fatal = null; brain.crashes = [];
    await probeClaude();
    brain.restart({});
    probeConnectors();
    return json(res, 200, statusPayload());
  }

  if (p.startsWith('/api/tts/') && m === 'GET') {
    const job = ttsJobs.get(p.slice('/api/tts/'.length));
    if (!job) return json(res, 404, { error: 'expired' });
    if (!job.chunks.length && !job.done) await new Promise((r) => job.waiters.push(r));
    if (!job.chunks.length) return json(res, 502, job.error || { code: 'voice_error', message: 'no audio' });
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' });
    let i = 0;
    for (;;) {
      while (i < job.chunks.length) res.write(job.chunks[i++]);
      if (job.done || res.destroyed) break;
      await new Promise((r) => job.waiters.push(r));
    }
    return res.end();
  }

  if (p === '/api/stt' && m === 'POST') {
    const audio = await readBody(req, 25 * 1024 * 1024);
    if (audio.length < 800) return json(res, 200, { text: '' });
    try { return json(res, 200, { text: await voice.transcribe(audio, req.headers['content-type'] || 'audio/webm') }); }
    catch (e) { return json(res, 502, { error: e.message, code: e.code }); }
  }

  if (p === '/api/voices' && m === 'GET') {
    try { return json(res, 200, { voices: await voice.voices(), current: cfg.elevenVoice }); }
    catch (e) { return json(res, 502, { error: e.message, code: e.code }); }
  }

  if (p === '/api/voice-test' && m === 'POST') {
    voiceDown = null;
    const r = await voice.check();
    if (r.ok) sayDirect(`Voice check complete. ${cfg.name} online and at your service.`);
    return json(res, 200, r);
  }

  if (p === '/api/settings' && m === 'POST') {
    const b = await jsonBody(req);
    const before = { ...cfg };
    const up = {};
    if (typeof b.elevenKey === 'string' && b.elevenKey.trim()) up.ELEVENLABS_API_KEY = b.elevenKey.trim();
    if (typeof b.voiceId === 'string' && b.voiceId.trim()) up.ELEVENLABS_VOICE_ID = b.voiceId.trim();
    if (typeof b.address === 'string' && b.address.trim()) up.JARVIS_ADDRESS = b.address.trim().slice(0, 40);
    if (typeof b.name === 'string' && b.name.trim()) up.JARVIS_NAME = b.name.trim().slice(0, 40);
    if (typeof b.brainDir === 'string' && b.brainDir.trim()) up.JARVIS_BRAIN_DIR = b.brainDir.trim();
    if (typeof b.model === 'string') up.JARVIS_MODEL = b.model.trim();
    if (typeof b.effort === 'string') up.JARVIS_EFFORT = b.effort.trim();
    if (typeof b.chrome === 'boolean') up.JARVIS_CHROME = b.chrome ? '1' : '0';
    if (up.JARVIS_BRAIN_DIR) {
      const probe = loadConfigWith(up.JARVIS_BRAIN_DIR);
      if (!fs.existsSync(probe)) return json(res, 400, { error: `Folder not found: ${probe}` });
    }
    cfg = saveEnv(up);
    ensureDirs(cfg);
    voiceDown = null;
    let voiceCheck = null;
    if (up.ELEVENLABS_API_KEY || up.ELEVENLABS_VOICE_ID) voiceCheck = await voice.check();
    if (cfg.brainDir !== before.brainDir) { vault.scan(); hub.broadcast('graph_changed', {}); }
    const newPersona = renderRuntimeFiles();
    const personaChanged = newPersona !== personaText;
    personaText = newPersona;
    if (typeof b.model === 'string') brain.wantModel = cfg.model || null;
    const needsRestart = personaChanged || cfg.model !== before.model || cfg.effort !== before.effort || cfg.chrome !== before.chrome || cfg.brainDir !== before.brainDir;
    if (needsRestart) { brain.restart({ fresh: personaChanged }); persist(); }
    hub.broadcast('settings', statusPayload());
    return json(res, 200, { ok: true, voiceCheck, status: statusPayload() });
  }

  if (p === '/api/permissions/reset' && m === 'POST') { policy.reset(); return json(res, 200, { ok: true }); }

  if (p === '/api/graph' && m === 'GET') return json(res, 200, vault.publicGraph());
  if (p === '/api/rescan' && m === 'POST') { vault.scan(); hub.broadcast('graph_changed', {}); return json(res, 200, { count: vault.graph.nodes.length }); }

  if (p === '/api/file' && m === 'GET') {
    const id = url.searchParams.get('id');
    const info = vault.preview(id !== null ? Number(id) : url.searchParams.get('path') || '');
    if (info.kind === 'image') { const sid = hub.registerFile(info.path); if (sid) info.url = `/api/served/${sid}`; }
    return json(res, info.error ? 404 : 200, info);
  }

  if (p.startsWith('/api/served/') && m === 'GET') {
    const file = served.get(p.slice('/api/served/'.length));
    if (!file || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    return fs.createReadStream(file).pipe(res);
  }

  if (p === '/api/screen/state' && m === 'POST') {
    const b = await jsonBody(req);
    const on = !!b.on;
    if (on !== hub.screen.on) {
      hub.screen.on = on;
      if (!on) hub.screen.frame = null;
      screenNote = on
        ? '[HUD: the user just turned screen sharing ON. Call look_at_screen whenever they refer to what is on their screen.]'
        : '[HUD: the user turned screen sharing OFF. You can no longer see their screen.]';
      if (b.announce !== false) sayDirect(on ? `I can see your screen now, ${cfg.address}. Ask me to look any time.` : 'Screen sharing stopped.');
    }
    return json(res, 200, { ok: true });
  }

  if (p === '/api/screen' && m === 'POST') {
    const frame = await readBody(req, 12 * 1024 * 1024);
    if (hub.screen.on && frame.length > 500) {
      hub.screen.frame = frame;
      hub.screen.at = Date.now();
      hub.screen.width = Number(url.searchParams.get('w')) || 0;
      hub.screen.height = Number(url.searchParams.get('h')) || 0;
      const waiter = hub.screen.waiters.get(url.searchParams.get('id') || '');
      if (waiter) { hub.screen.waiters.delete(url.searchParams.get('id')); waiter(); }
    }
    return json(res, 200, { ok: true });
  }

  if (p === '/api/hud-reply' && m === 'POST') {
    const b = JSON.parse((await readBody(req, 30 * 1024 * 1024)).toString('utf8'));
    const pend = pendingHud.get(b.id);
    if (pend) { clearTimeout(pend.timer); pendingHud.delete(b.id); pend.resolve({ ok: !!b.ok, data: b.data, error: b.error }); }
    return json(res, 200, { ok: true });
  }

  if (p === '/api/approve' && m === 'POST') {
    const b = await jsonBody(req);
    const pend = pendingApprovals.get(b.id);
    if (!pend) return json(res, 404, { error: 'expired' });
    clearTimeout(pend.timer); pendingApprovals.delete(b.id);
    pend.resolve({ allow: !!b.allow, always: !!b.always });
    hub.broadcast('approval_done', { id: b.id });
    return json(res, 200, { ok: true });
  }

  if (p === '/api/upload' && m === 'POST') {
    const data = await readBody(req, 30 * 1024 * 1024);
    const raw = path.basename(String(url.searchParams.get('name') || 'file')).replace(/[^\w.\- ()]/g, '_').slice(-80) || 'file';
    const dir = path.join(cfg.home, 'inbox');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${raw}`);
    fs.writeFileSync(file, data);
    return json(res, 200, { path: file, name: raw });
  }

  json(res, 404, { error: 'unknown endpoint' });
}

function loadConfigWith(dir) {
  const d = dir.startsWith('~') ? path.join(process.env.HOME || process.env.USERPROFILE || '', dir.slice(1)) : dir;
  return path.resolve(d);
}

// ---------------------------------------------------------------- start-up
function openBrowser(url) {
  if (cfg.noOpen) return;
  const run = (cmd, args) => new Promise((resolve) => {
    try { const c = spawn(cmd, args, { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }); c.on('error', () => resolve(false)); c.on('exit', (code) => resolve(code === 0)); c.unref(); }
    catch { resolve(false); }
  });
  (async () => {
    // Chrome or Edge first: they have the speech recognition the hands-free mode uses.
    if (process.platform === 'darwin') { if (!(await run('open', ['-a', 'Google Chrome', url]))) await run('open', [url]); }
    else if (process.platform === 'win32') { if (!(await run('start', ['""', 'chrome', url]))) await run('start', ['""', url]); }
    else await run('xdg-open', [url]);
  })();
}

async function doctor() {
  const ok = (b) => (b ? '  OK  ' : ' FAIL ');
  console.log(`\n${cfg.name} — system check\n`);
  const major = Number(process.versions.node.split('.')[0]);
  console.log(`${ok(major >= 18)} Node.js ${process.versions.node}${major >= 18 ? '' : '  (need 18 or newer: https://nodejs.org)'}`);
  await probeClaude();
  console.log(`${ok(!!claudeVersion)} Claude Code ${claudeVersion || 'not found — install from https://claude.com/claude-code and run "claude" once to log in'}`);
  console.log(`${cfg.elevenKey ? ok(true) : ' TODO '} ElevenLabs key ${cfg.elevenKey ? 'saved (' + '••••' + cfg.elevenKey.slice(-4) + ')' : 'not set — add it in the HUD settings (Jarvis uses the browser voice until then)'}`);
  if (cfg.elevenKey) { const r = await voice.check(); console.log(`${ok(r.ok)} ElevenLabs voice: ${r.message}`); }
  console.log(`${ok(fs.existsSync(cfg.brainDir))} Second brain folder: ${cfg.brainDir}`);
  console.log(`  --   Workspace: ${cfg.home}`);
  console.log(`  --   HUD: http://localhost:${cfg.port}\n`);
  process.exit(major >= 18 && claudeVersion ? 0 : 1);
}

if (process.argv.includes('--doctor')) {
  await doctor();
} else {
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\nPort ${cfg.port} is already in use — ${cfg.name} is probably already running.\nOpen http://localhost:${cfg.port} or close the other window first.\n`);
      openBrowser(`http://localhost:${cfg.port}`);
      setTimeout(() => process.exit(1), 500);
    } else { console.error(e); process.exit(1); }
  });
  server.listen(cfg.port, '127.0.0.1', async () => {
    const url = `http://localhost:${cfg.port}`;
    console.log(`\n  ${cfg.name.toUpperCase()} is online  →  ${url}\n  Keep this window open. Press Ctrl+C to shut down.\n`);
    vault.scan();
    await probeClaude();
    if (!claudeVersion) {
      fatal = { code: 'claude_not_found', message: `Claude Code was not found (looked for "${cfg.claudeBin}"). Install it from https://claude.com/claude-code, run "claude" once to log in, then press Reconnect.` };
      log('[brain] Claude Code not found on PATH');
    } else {
      log(`[brain] Claude Code ${claudeVersion}`);
      brain.start();
      probeConnectors();
    }
    openBrowser(url);
  });
  const bye = () => { brain.stop(); for (const r of sse) { try { r.end(); } catch { /* ignore */ } } server.close(); setTimeout(() => process.exit(0), 600); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
