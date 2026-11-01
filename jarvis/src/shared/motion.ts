import type { ConvState, MotionPreset } from './types';

export interface MotionParams {
  preset: MotionPreset;
  speed: number;
  amplitude: number;
  tilt: number;
  glow: number;
  showOrbits: boolean;
}

export const MOTION_LIMITS = {
  speed: [0.25, 2],
  amplitude: [0, 14],
  tilt: [0, 2],
  glow: [0, 1],
} as const;

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

export function clampMotion(p: MotionParams): MotionParams {
  return {
    preset: p.preset === 'drift' || p.preset === 'still' ? p.preset : 'orbit',
    speed: clamp(p.speed, ...MOTION_LIMITS.speed),
    amplitude: clamp(p.amplitude, ...MOTION_LIMITS.amplitude),
    tilt: clamp(p.tilt, ...MOTION_LIMITS.tilt),
    glow: clamp(p.glow, ...MOTION_LIMITS.glow),
    showOrbits: !!p.showOrbits,
  };
}

/** Base bob period in seconds at speed 1 (brief: 4–6 s). */
export const BASE_PERIOD_S = 5;

export interface MotionFrame {
  x: number;
  y: number;
  rot: number;
}

/** Deterministic floating offsets for a given time. Reduced motion or "still" returns zeros. */
export function motionAt(tSec: number, params: MotionParams, reduced: boolean): MotionFrame {
  const p = clampMotion(params);
  if (reduced || p.preset === 'still') return { x: 0, y: 0, rot: 0 };
  const period = BASE_PERIOD_S / p.speed;
  const w = (2 * Math.PI) / period;
  if (p.preset === 'drift') {
    return {
      x: p.amplitude * 0.8 * Math.sin(w * 0.62 * tSec),
      y: p.amplitude * 0.35 * Math.sin(w * tSec + 0.6),
      rot: p.tilt * 0.6 * Math.sin(w * 0.62 * tSec + Math.PI / 2),
    };
  }
  return {
    x: 0,
    y: -p.amplitude * Math.sin(w * tSec),
    rot: p.tilt * Math.sin(w * tSec + Math.PI / 2),
  };
}

/** One-pole envelope follower with separate attack and release times. */
export function envelope(prev: number, target: number, dtSec: number, attackSec = 0.04, releaseSec = 0.22): number {
  const tau = target > prev ? attackSec : releaseSec;
  const a = 1 - Math.exp(-Math.max(0, dtSec) / Math.max(1e-4, tau));
  return clamp(prev + (target - prev) * a, 0, 1);
}

export function rmsFloat(buf: ArrayLike<number>): number {
  if (!buf.length) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
  return Math.sqrt(sum / buf.length);
}

export function rmsInt16(buf: Int16Array): number {
  if (!buf.length) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i]! / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / buf.length);
}

/** Maps an RMS level (speech typically 0.01–0.3) into a perceptual 0..1 energy. */
export function levelToEnergy(rms: number): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return clamp((db + 55) / 45, 0, 1);
}

export type Accent = 'normal' | 'dim' | 'amber';

export interface StateVisual {
  /** 0..1 intensity for glow and trails. */
  energy: number;
  accent: Accent;
  /** Thinking: orderly trail sweep. */
  sweep: boolean;
  /** Whether energy should follow live input/output levels. */
  reactive: 'input' | 'output' | 'none';
}

/**
 * Visual behaviour per state. Input-driven only while listening; output-driven only while speaking.
 * Thinking never uses microphone levels; idle never fakes speech.
 */
export function stateVisual(state: ConvState, inputEnergy: number, outputEnergy: number, glow: number): StateVisual {
  const g = clamp(glow, 0, 1);
  switch (state) {
    case 'listening':
      return { energy: clamp(0.2 + inputEnergy * 0.8, 0, 1) * g, accent: 'normal', sweep: false, reactive: 'input' };
    case 'transcribing':
      return { energy: 0.35 * g, accent: 'normal', sweep: true, reactive: 'none' };
    case 'thinking':
      return { energy: 0.4 * g, accent: 'normal', sweep: true, reactive: 'none' };
    case 'speaking':
      return { energy: clamp(0.15 + outputEnergy * 0.85, 0, 1) * g, accent: 'normal', sweep: false, reactive: 'output' };
    case 'muted':
      return { energy: 0.05, accent: 'dim', sweep: false, reactive: 'none' };
    case 'error':
      return { energy: 0.25 * g, accent: 'amber', sweep: false, reactive: 'none' };
    case 'unconfigured':
      return { energy: 0.1 * g, accent: 'dim', sweep: false, reactive: 'none' };
    default:
      return { energy: 0.15 * g, accent: 'normal', sweep: false, reactive: 'none' };
  }
}
