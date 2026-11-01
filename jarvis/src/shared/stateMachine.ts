import type { ConvState } from './types';

export type ConvEvent =
  | 'START_LISTEN'
  | 'END_UTTERANCE'
  | 'TRANSCRIPT_FINAL'
  | 'SUBMIT_TEXT'
  | 'NO_SPEECH'
  | 'FIRST_AUDIO'
  | 'REPLY_DONE'
  | 'INTERRUPT'
  | 'SETTLE'
  | 'MUTE'
  | 'UNMUTE'
  | 'ARM'
  | 'DISARM'
  | 'ERROR'
  | 'CLEAR_ERROR'
  | 'CONFIG_CHANGED';

export interface MachineContext {
  /** At least one LLM provider (or demo mode) is usable. */
  configured: boolean;
  /** Local wake-word detection is armed. */
  armed: boolean;
}

/** The state the app returns to when nothing is happening. */
export function restState(ctx: MachineContext): ConvState {
  if (!ctx.configured) return 'unconfigured';
  return ctx.armed ? 'armed' : 'idle';
}

const REST: ReadonlySet<ConvState> = new Set(['unconfigured', 'idle', 'armed']);
const ACTIVE: ReadonlySet<ConvState> = new Set(['listening', 'transcribing', 'thinking', 'speaking']);

/**
 * Pure transition function. Returns the next state, or null when the event is not valid
 * in the current state (callers ignore invalid events instead of corrupting state).
 */
export function transition(state: ConvState, event: ConvEvent, ctx: MachineContext): ConvState | null {
  if (event === 'MUTE') return 'muted';
  if (state === 'muted') return event === 'UNMUTE' ? restState(ctx) : null;

  switch (event) {
    case 'ERROR':
      return 'error';
    case 'CLEAR_ERROR':
      return state === 'error' ? restState(ctx) : null;
    case 'CONFIG_CHANGED':
    case 'ARM':
    case 'DISARM':
      return REST.has(state) ? restState(ctx) : null;
    case 'START_LISTEN':
      if (!ctx.configured) return null;
      return REST.has(state) || state === 'interrupted' || state === 'error' ? 'listening' : null;
    case 'END_UTTERANCE':
      return state === 'listening' ? 'transcribing' : null;
    case 'TRANSCRIPT_FINAL':
      return state === 'listening' || state === 'transcribing' ? 'thinking' : null;
    case 'SUBMIT_TEXT':
      if (!ctx.configured) return null;
      return REST.has(state) || state === 'interrupted' || state === 'error' ? 'thinking' : null;
    case 'NO_SPEECH':
      return state === 'listening' || state === 'transcribing' ? restState(ctx) : null;
    case 'FIRST_AUDIO':
      return state === 'thinking' ? 'speaking' : null;
    case 'REPLY_DONE':
      return state === 'thinking' || state === 'speaking' ? restState(ctx) : null;
    case 'INTERRUPT':
      return ACTIVE.has(state) ? 'interrupted' : null;
    case 'SETTLE':
      return state === 'interrupted' ? restState(ctx) : null;
    case 'UNMUTE':
      return null;
    default:
      return null;
  }
}

export function isBusy(state: ConvState): boolean {
  return ACTIVE.has(state);
}

export const STATE_LABELS: Record<ConvState, string> = {
  unconfigured: 'Setup needed',
  idle: 'Ready',
  armed: 'Hands-free armed',
  listening: 'Listening…',
  transcribing: 'Transcribing…',
  thinking: 'Thinking…',
  speaking: 'Speaking',
  interrupted: 'Stopped',
  muted: 'Muted (mic off)',
  error: 'Error',
};
