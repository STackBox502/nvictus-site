// Configuration: reads jarvis/.env (never committed) and exposes typed settings.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Overridable so tests never touch the real settings.
export const ENV_PATH = process.env.JARVIS_ENV_FILE || path.join(ROOT, '.env');
export const DATA_DIR = process.env.JARVIS_DATA_DIR || path.join(ROOT, 'data');

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[line.slice(0, eq).trim()] = val;
  }
  return out;
}

function readEnvFile() {
  try { return parseEnv(fs.readFileSync(ENV_PATH, 'utf8')); } catch { return {}; }
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function defaultBrainDir() {
  const docs = path.join(os.homedir(), 'Documents');
  return fs.existsSync(docs) ? docs : os.homedir();
}

let fileEnv = readEnvFile();

// Precedence: real environment variables win over .env, so a launcher can override.
function get(key, fallback = '') {
  const v = process.env[key] ?? fileEnv[key];
  return v === undefined || v === '' ? fallback : v;
}

export function loadConfig() {
  fileEnv = readEnvFile();
  return {
    port: Number(get('JARVIS_PORT', '4747')),
    name: get('JARVIS_NAME', 'Jarvis'),
    address: get('JARVIS_ADDRESS', 'boss'),
    home: path.resolve(expandHome(get('JARVIS_HOME', path.join(os.homedir(), 'Jarvis')))),
    brainDir: path.resolve(expandHome(get('JARVIS_BRAIN_DIR', defaultBrainDir()))),
    model: get('JARVIS_MODEL', ''),          // blank = whatever Claude Code defaults to
    effort: get('JARVIS_EFFORT', ''),        // blank = Claude Code default
    chrome: /^(1|true|yes|on)$/i.test(get('JARVIS_CHROME', '0')),
    claudeBin: get('CLAUDE_BIN', 'claude'),
    elevenKey: get('ELEVENLABS_API_KEY', ''),
    elevenVoice: get('ELEVENLABS_VOICE_ID', 'JBFqnCBsd6RMkjVDRZzb'), // "George", a default ElevenLabs voice
    elevenModel: get('ELEVENLABS_MODEL', 'eleven_flash_v2_5'),
    elevenSttModel: get('ELEVENLABS_STT_MODEL', 'scribe_v2'),
    elevenBase: get('ELEVENLABS_BASE_URL', 'https://api.elevenlabs.io').replace(/\/+$/, ''),
    noOpen: /^(1|true|yes|on)$/i.test(get('JARVIS_NO_OPEN', '0')),
  };
}

const WRITABLE = new Set([
  'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID', 'ELEVENLABS_MODEL', 'ELEVENLABS_STT_MODEL',
  'JARVIS_NAME', 'JARVIS_ADDRESS', 'JARVIS_HOME', 'JARVIS_BRAIN_DIR', 'JARVIS_MODEL',
  'JARVIS_EFFORT', 'JARVIS_CHROME', 'JARVIS_PORT', 'CLAUDE_BIN',
]);

// Merge updates into .env, preserving comments and unknown keys. File is owner-only.
export function saveEnv(updates) {
  let lines = [];
  try { lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/); } catch { /* new file */ }
  const pending = new Map();
  for (const [k, v] of Object.entries(updates)) {
    if (!WRITABLE.has(k) || v === undefined || v === null) continue;
    const clean = String(v).replace(/[\r\n]/g, '').trim();
    pending.set(k, clean);
  }
  lines = lines.map((raw) => {
    const m = raw.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && pending.has(m[1])) {
      const v = pending.get(m[1]);
      pending.delete(m[1]);
      return `${m[1]}=${v}`;
    }
    return raw;
  });
  for (const [k, v] of pending) lines.push(`${k}=${v}`);
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n');
  fs.writeFileSync(ENV_PATH, text, { mode: 0o600 });
  try { fs.chmodSync(ENV_PATH, 0o600); } catch { /* Windows */ }
  return loadConfig();
}

export function ensureDirs(cfg) {
  for (const d of [DATA_DIR, cfg.home, path.join(cfg.home, 'inbox'), path.join(cfg.home, 'renders')]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export function readState() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'state.json'), 'utf8')); } catch { return {}; }
}

export function writeState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'state.json'), JSON.stringify(state, null, 2));
}
