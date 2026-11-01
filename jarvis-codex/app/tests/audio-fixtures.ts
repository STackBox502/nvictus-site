// Deterministic synthetic audio for detector/controller fixtures (16 kHz mono Int16). Never real recordings.
export const RATE = 16000;
export const PACKET = 1280; // 80 ms, matches pcm-worklet.js
const amp = (dbfs: number) => 10 ** (dbfs / 20);

function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}

function scaleTo(x: Float32Array, dbfs: number): Float32Array {
  let sum = 0;
  for (const v of x) sum += v * v;
  const rms = Math.sqrt(sum / x.length) || 1;
  const k = amp(dbfs) / rms;
  return x.map((v) => v * k);
}

/** Voiced, speech-like signal: harmonic source with pitch drift and syllable-rate loudness changes. */
export function voiced(ms: number, dbfs: number, f0 = 140, phase0 = 0): Float32Array {
  const n = Math.round((ms / 1000) * RATE);
  const out = new Float32Array(n);
  let phase = phase0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const f = f0 * (1 + 0.04 * Math.sin(2 * Math.PI * 4.5 * t));
    phase += (2 * Math.PI * f) / RATE;
    let s = 0;
    for (let k = 1; k <= 12; k++) s += Math.sin(k * phase) / k;
    const syllable = 0.55 + 0.45 * Math.abs(Math.sin(2 * Math.PI * 2.6 * t));
    out[i] = s * syllable;
  }
  return scaleTo(out, dbfs);
}

export function noise(ms: number, dbfs: number, seed = 7): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(Math.round((ms / 1000) * RATE)).map(() => r());
  return scaleTo(out, dbfs);
}

export function silence(ms: number): Float32Array {
  return noise(ms, -78, 3);
}

/** Keyboard-like clicks: short broadband bursts every `everyMs`. */
export function clicks(ms: number, peak = 0.5, everyMs = 150): Float32Array {
  const out = silence(ms);
  const r = rng(11);
  const every = Math.round((everyMs / 1000) * RATE);
  for (let start = 0; start < out.length; start += every) {
    for (let i = 0; i < 64 && start + i < out.length; i++) out[start + i] += r() * peak * Math.exp(-i / 12);
  }
  return out;
}

/** Mains/fan hum: periodic (voiced-looking) but perfectly steady. */
export function hum(ms: number, dbfs: number): Float32Array {
  const n = Math.round((ms / 1000) * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    out[i] = Math.sin(2 * Math.PI * 120 * t) + 0.5 * Math.sin(2 * Math.PI * 240 * t) + 0.25 * Math.sin(2 * Math.PI * 360 * t);
  }
  return scaleTo(out, dbfs);
}

export function mix(...parts: Float32Array[]): Float32Array {
  const n = Math.max(...parts.map((p) => p.length));
  const out = new Float32Array(n);
  for (const p of parts) for (let i = 0; i < p.length; i++) out[i] += p[i];
  return out;
}

export function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function toInt16(x: Float32Array): Int16Array {
  return Int16Array.from(x, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767))));
}

export function packets(x: Float32Array): Int16Array[] {
  const pcm = toInt16(x);
  const out: Int16Array[] = [];
  for (let i = 0; i + PACKET <= pcm.length; i += PACKET) out.push(pcm.slice(i, i + PACKET));
  return out;
}

/** 24 kHz output PCM chunk (100 ms, 4800 bytes) at a given level — what TTS would return. */
export function ttsChunk(dbfs = -20): Uint8Array {
  const n = 2400;
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = Math.sin((2 * Math.PI * 180 * i) / 24000);
  const pcm = toInt16(scaleTo(f, dbfs));
  return new Uint8Array(pcm.buffer);
}
