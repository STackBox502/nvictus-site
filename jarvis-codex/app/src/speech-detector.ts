// Local speech-aware detection for Conversation Mode (runs in the main process).
// Input: 16 kHz mono signed 16-bit PCM packets (80 ms from pcm-worklet.js), analysed in 20 ms subframes.
// A subframe counts as speech only if it is (a) louder than the adaptive noise floor by a margin,
// (b) voiced (periodic in the 80–400 Hz pitch range), and (c) not impulsive (keyboard clicks).
// While Jarvis is playing audio, it must ALSO exceed the predicted echo of Jarvis's own voice
// (playback level + learned speaker→mic coupling + margin). Coupling rises fast and falls slowly,
// so the detector errs toward NOT interrupting itself. Pure and deterministic for fixtures.

export type Sensitivity = 'low' | 'medium' | 'high';

export interface DetectorTuning {
  /** dB above the noise floor needed for speech. */
  marginDb: number;
  /** dB above predicted echo needed for speech while Jarvis is playing. */
  echoMarginDb: number;
  /** Voiced speech (ms, within a short window) needed to start a turn while idle. */
  onsetMs: number;
  /** Voiced speech (ms) needed to interrupt while Jarvis is playing (longer to skip brief sounds). */
  onsetPlaybackMs: number;
  /** Absolute floor: quieter than this is never speech. */
  minDbfs: number;
  /** Normalised autocorrelation needed to count as voiced. */
  voicing: number;
}

export const TUNING: Record<Sensitivity, DetectorTuning> = {
  low: { marginDb: 14, echoMarginDb: 12, onsetMs: 220, onsetPlaybackMs: 360, minDbfs: -44, voicing: 0.5 },
  medium: { marginDb: 11, echoMarginDb: 9, onsetMs: 180, onsetPlaybackMs: 280, minDbfs: -48, voicing: 0.45 },
  high: { marginDb: 8, echoMarginDb: 6, onsetMs: 140, onsetPlaybackMs: 220, minDbfs: -52, voicing: 0.4 },
};

export const SUBFRAME = 320; // 20 ms at 16 kHz
export const SUBFRAME_MS = 20;
const MIN_LAG = 40; // 400 Hz
const MAX_LAG = 200; // 80 Hz

export interface FrameFeatures {
  db: number;
  voiced: number;
  crest: number;
}

/** Energy (dBFS), voicing (max normalised autocorrelation over pitch lags) and crest factor. */
export function frameFeatures(current: Float32Array, analysis: Float32Array): FrameFeatures {
  let sum = 0;
  let peak = 0;
  for (const v of current) {
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sum / current.length);
  const db = 20 * Math.log10(rms + 1e-10);
  let mean = 0;
  for (const v of analysis) mean += v;
  mean /= analysis.length;
  let best = 0;
  for (let lag = MIN_LAG; lag <= MAX_LAG; lag++) {
    let xy = 0;
    let xx = 0;
    let yy = 0;
    for (let i = 0; i + lag < analysis.length; i++) {
      const x = analysis[i] - mean;
      const y = analysis[i + lag] - mean;
      xy += x * y;
      xx += x * x;
      yy += y * y;
    }
    const r = xy / Math.sqrt(xx * yy + 1e-12);
    if (r > best) best = r;
  }
  return { db, voiced: best, crest: peak / (rms + 1e-10) };
}

export type DetectorEvent =
  | { type: 'start'; onsetAt: number; detectedAt: number; duringPlayback: boolean }
  | { type: 'end'; endedAt: number; detectedAt: number };

export interface EchoLevel {
  playing: boolean;
  refDb: number;
}

export class SpeechDetector {
  noiseDb = -70;
  couplingDb: number;
  speaking = false;
  private history: Array<{ t: number; speech: boolean }> = [];
  private prev = new Float32Array(SUBFRAME);
  private lastActive = 0;
  private startedAt: number | null = null;
  private speechDbs: Array<{ t: number; db: number }> = [];
  /** First ms of a session: learn the room (fast floor adaptation), never start a turn. */
  static readonly CALIBRATION_MS = 600;
  /** A "turn" this flat for this long is stationary noise (fan, hum), not speech. */
  static readonly STATIONARY_MS = 3000;
  static readonly STATIONARY_STD_DB = 1.5;

  constructor(
    private readonly tune: DetectorTuning,
    private hangoverMs: number,
    /** Learned speaker→mic coupling carried between conversations; 0 dB is the safe (strict) start. */
    couplingDb = 0,
  ) {
    this.couplingDb = Math.min(6, Math.max(-60, couplingDb));
  }

  setHangover(ms: number): void {
    this.hangoverMs = ms;
  }

  /** Processes one packet whose LAST sample arrived at `now` (ms). Returns zero or more events. */
  process(pcm: Int16Array, now: number, echo: EchoLevel): DetectorEvent[] {
    const events: DetectorEvent[] = [];
    const frames = Math.floor(pcm.length / SUBFRAME);
    for (let k = 0; k < frames; k++) {
      const t = now - (frames - 1 - k) * SUBFRAME_MS;
      const current = new Float32Array(SUBFRAME);
      for (let i = 0; i < SUBFRAME; i++) current[i] = pcm[k * SUBFRAME + i] / 32768;
      const analysis = new Float32Array(SUBFRAME * 2);
      analysis.set(this.prev, 0);
      analysis.set(current, SUBFRAME);
      this.prev = current;
      const ev = this.step(frameFeatures(current, analysis), t, echo);
      if (ev) events.push(ev);
    }
    return events;
  }

  private threshold(echo: EchoLevel): number {
    const idle = Math.max(this.tune.minDbfs, this.noiseDb + this.tune.marginDb);
    if (!echo.playing || !Number.isFinite(echo.refDb)) return idle;
    return Math.max(idle, echo.refDb + this.couplingDb + this.tune.echoMarginDb);
  }

  private step(f: FrameFeatures, t: number, echo: EchoLevel): DetectorEvent | null {
    this.startedAt ??= t;
    const calibrating = t - this.startedAt < SpeechDetector.CALIBRATION_MS;
    if (calibrating) {
      // Learn the room quickly in both directions; a hum present at start becomes the floor.
      this.noiseDb = Math.min(-25, Math.max(-90, this.noiseDb + 0.25 * (f.db - this.noiseDb)));
      return null;
    }
    const thr = this.threshold(echo);
    const speech = f.db > thr && f.voiced >= this.tune.voicing && f.crest < 9;

    // Adaptive noise floor: falls quickly, rises slowly, never learns from speech.
    if (!this.speaking && !speech) {
      const rate = f.db < this.noiseDb ? 0.3 : 0.01;
      this.noiseDb = Math.min(-25, Math.max(-90, this.noiseDb + rate * (f.db - this.noiseDb)));
    }
    // Echo coupling: learn how loud Jarvis's own playback arrives at the mic (fast rise, slow fall).
    if (echo.playing && Number.isFinite(echo.refDb) && echo.refDb > -70 && !this.speaking && !speech) {
      const observed = Math.max(f.db, this.noiseDb) - echo.refDb;
      const delta = observed - this.couplingDb;
      const change = delta > 0 ? Math.min(1.5, 0.25 * delta) : 0.015 * delta;
      this.couplingDb = Math.min(6, Math.max(-60, this.couplingDb + change));
    }

    const need = echo.playing ? this.tune.onsetPlaybackMs : this.tune.onsetMs;
    const windowMs = need + 120;
    this.history.push({ t, speech });
    while (this.history.length && this.history[0].t <= t - windowMs) this.history.shift();

    if (!this.speaking) {
      const voicedMs = this.history.filter((h) => h.speech).length * SUBFRAME_MS;
      if (voicedMs >= need) {
        this.speaking = true;
        this.lastActive = t;
        this.speechDbs = [];
        const first = this.history.find((h) => h.speech)!;
        return { type: 'start', onsetAt: first.t - SUBFRAME_MS, detectedAt: t, duringPlayback: echo.playing };
      }
      return null;
    }
    // Stationary-noise guard: real speech rises and falls with syllables; a fan or hum does not.
    this.speechDbs.push({ t, db: f.db });
    while (this.speechDbs.length && this.speechDbs[0].t <= t - SpeechDetector.STATIONARY_MS) this.speechDbs.shift();
    if (this.speechDbs.length >= SpeechDetector.STATIONARY_MS / SUBFRAME_MS - 1) {
      const mean = this.speechDbs.reduce((a, b) => a + b.db, 0) / this.speechDbs.length;
      const std = Math.sqrt(this.speechDbs.reduce((a, b) => a + (b.db - mean) ** 2, 0) / this.speechDbs.length);
      if (std < SpeechDetector.STATIONARY_STD_DB) {
        this.noiseDb = Math.min(-25, mean);
        this.speaking = false;
        this.history = [];
        this.speechDbs = [];
        return { type: 'end', endedAt: t, detectedAt: t };
      }
    }
    // Continuation is energy-based (keeps unvoiced consonants and soft syllables in the turn).
    if (f.db > thr - 3) this.lastActive = t;
    else if (t - this.lastActive >= this.hangoverMs) {
      this.speaking = false;
      this.history = [];
      return { type: 'end', endedAt: this.lastActive, detectedAt: t };
    }
    return null;
  }
}

/** Levels of Jarvis's own playback, from main-side PCM RMS + renderer "started" acknowledgements. */
export class EchoReference {
  private items: Array<{ start: number; end: number; db: number }> = [];
  constructor(private readonly tailMs = 400) {}

  add(db: number, start: number, durationMs: number): void {
    this.items.push({ start, end: start + durationMs, db });
    const cutoff = start - 5000;
    this.items = this.items.filter((i) => i.end + this.tailMs >= cutoff).slice(-200);
  }

  level(now: number): EchoLevel {
    let ref = -Infinity;
    for (const i of this.items) if (i.start <= now && now <= i.end + this.tailMs) ref = Math.max(ref, i.db);
    return { playing: ref > -Infinity, refDb: ref };
  }

  /** After a local stop: audio ended now; keep only a short room-reverb tail. */
  truncate(now: number): void {
    this.items = this.items.filter((i) => i.start <= now).map((i) => ({ ...i, end: Math.min(i.end, now - this.tailMs + 150) }));
  }

  clear(): void {
    this.items = [];
  }
}

/** RMS level (dBFS) of 16-bit little-endian PCM bytes. */
export function pcmDb(bytes: Uint8Array): number {
  const n = Math.floor(bytes.byteLength / 2);
  if (!n) return -Infinity;
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = view.getInt16(i * 2, true) / 32768;
    sum += v * v;
  }
  return 20 * Math.log10(Math.sqrt(sum / n) + 1e-10);
}

const BACKCHANNELS = new Set([
  'yeah', 'yes', 'yep', 'yup', 'ok', 'okay', 'uh huh', 'uh-huh', 'mm hmm', 'mm-hmm', 'mhm', 'mmhmm', 'hmm', 'mm',
  'right', 'sure', 'got it', 'i see', 'cool', 'nice', 'gotcha', 'true', 'exactly', 'oh', 'ah',
]);

/** True for brief acknowledgements ("yeah", "mm-hmm") that should not start a new request after an interruption. */
export function isBackchannel(text: string): boolean {
  const n = text.toLowerCase().replace(/[^a-z\s-]/g, '').replace(/\s+/g, ' ').trim();
  return BACKCHANNELS.has(n);
}
