// Shared, dependency-free types used by main, preload, renderer, and tests.

export type ProviderId = 'anthropic' | 'openai';
export type SecretName = 'anthropic' | 'openai' | 'elevenlabs';
export const SECRET_NAMES: readonly SecretName[] = ['anthropic', 'openai', 'elevenlabs'];

export type ConvState =
  | 'unconfigured'
  | 'idle'
  | 'armed'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'interrupted'
  | 'muted'
  | 'error';

export type ActivationMode = 'click' | 'push' | 'handsfree';
export type MotionPreset = 'orbit' | 'drift' | 'still';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'note';
  text: string;
  /** For interrupted assistant replies: the portion whose audio actually finished playing. */
  heardText?: string;
  interrupted?: boolean;
  provider?: ProviderId;
  model?: string;
  source?: 'voice' | 'typed' | 'local';
  createdAt: number;
  error?: string;
  voiceUnavailable?: boolean;
  demo?: boolean;
  pending?: boolean;
}

export interface MemoryRecord {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

export type ConnectionState =
  | 'missing'
  | 'untested'
  | 'testing'
  | 'ok'
  | 'auth_error'
  | 'network_error'
  | 'error';

export interface ConnectionStatus {
  state: ConnectionState;
  detail?: string;
  checkedAt?: number;
}

export interface SecretStatus {
  configured: boolean;
  persisted: boolean;
  masked: string;
  source: 'stored' | 'session' | 'dev-env' | 'none';
}

export interface PendingConfirmation {
  id: string;
  kind: 'forget' | 'newConversation' | 'clearMemories' | 'clearHistory' | 'changeVoice';
  label: string;
  data?: string;
}

export interface WakeStatus {
  state: 'unavailable' | 'stopped' | 'starting' | 'ready' | 'error';
  reason: string;
  selfTestPassed: boolean;
}

export interface ShortcutStatus {
  talk: { accelerator: string; registered: boolean };
  stop: { accelerator: string; registered: boolean };
}

export interface TurnTimings {
  endOfSpeech?: number;
  committed?: number;
  firstText?: number;
  firstAudioReceived?: number;
  firstPlayback?: number;
}

export interface TurnRecord {
  turnId: number;
  provider: ProviderId | 'demo';
  model: string;
  startedAt: number;
  inputTokens?: number;
  outputTokens?: number;
  ttsChars: number;
  sttSeconds: number;
  timings: TurnTimings;
  outcome: 'completed' | 'interrupted' | 'error' | 'running';
  live: boolean;
}

export interface UsageTotals {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  ttsChars: number;
  sttSeconds: number;
  /** True when some turns lacked provider-reported token usage. */
  incomplete: boolean;
}

export interface LatencySummary {
  stage: string;
  count: number;
  recentMs: number[];
  p50?: number;
  p95?: number;
}

export interface UsageSnapshot {
  session: UsageTotals;
  today: UsageTotals & { date: string };
  recentTurns: TurnRecord[];
  latency: LatencySummary[];
}

export interface PreviewState {
  active: boolean;
  state: ConvState;
}

export interface AppSnapshot {
  state: ConvState;
  muted: boolean;
  armed: boolean;
  micActive: boolean;
  micPermission: 'unknown' | 'granted' | 'denied';
  provider: ProviderId;
  model: string;
  providerConfigured: Record<ProviderId, boolean>;
  voiceConfigured: boolean;
  demoMode: boolean;
  messages: ChatMessage[];
  partialTranscript: string;
  error: { code: string; message: string; retryable: boolean } | null;
  pendingConfirmation: PendingConfirmation | null;
  overlayShown: boolean;
  wake: WakeStatus;
  shortcuts: ShortcutStatus;
  connections: Record<SecretName, ConnectionStatus>;
  secrets: Record<SecretName, SecretStatus>;
  encryptionAvailable: boolean;
  preview: PreviewState;
  canRetry: boolean;
  notice: string | null;
  verification: { liveConversation: boolean; liveInterruption: boolean };
  version: string;
}

export interface VoiceInfo {
  id: string;
  name: string;
  category?: string;
}

export interface TtsModelInfo {
  id: string;
  name: string;
  canUseStyle: boolean;
  canUseSpeakerBoost: boolean;
}

export interface DisplayInfo {
  id: number;
  label: string;
  primary: boolean;
  workArea: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
}

export interface CharacterAsset {
  isPlaceholder: boolean;
  mime: string;
  bytes: Uint8Array | null;
  name: string;
}

/** Commands from main to the overlay audio engine. */
export type AudioCommand =
  | {
      type: 'startCapture';
      sessionId: number;
      deviceId: string;
      echoCancellation: boolean;
      noiseSuppression: boolean;
      autoGainControl: boolean;
    }
  | { type: 'stopCapture' }
  | { type: 'pcm'; turnId: number; seq: number; sampleRate: number; data: Uint8Array; seqDone: boolean }
  | { type: 'endOfStream'; turnId: number; totalSeqs: number }
  | { type: 'stopPlayback'; turnId: number }
  | { type: 'setOutput'; deviceId: string; volume: number }
  | { type: 'cue' }
  | { type: 'testTone' };

/** Events from the overlay audio engine to main. */
export type AudioEvent =
  | { type: 'captureStarted'; sessionId: number; sampleRate: number }
  | { type: 'captureStopped' }
  | { type: 'captureError'; code: 'mic_denied' | 'mic_missing' | 'mic_error'; message: string }
  | { type: 'deviceLost' }
  | { type: 'level'; input: number; output: number }
  | { type: 'playbackStarted'; turnId: number }
  | { type: 'chunkPlayed'; turnId: number; seq: number }
  | { type: 'playbackDrained'; turnId: number }
  | { type: 'outputError'; message: string };
