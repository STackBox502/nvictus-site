import { randomUUID } from 'node:crypto';
import { buildHistory, buildSystemPrompt } from '../shared/context';
import { ProviderError, classifyThrown, userMessage, type ErrorCode } from '../shared/errors';
import { matchLocalCommand, type LocalCommand } from '../shared/localCommands';
import type { Settings } from '../shared/settings';
import { SpeechPipeline } from '../shared/speech';
import { isBusy, restState, transition, type ConvEvent } from '../shared/stateMachine';
import { TranscriptAssembler, stripWakePhrase } from '../shared/transcript';
import type {
  AppSnapshot,
  AudioCommand,
  AudioEvent,
  ChatMessage,
  ConnectionStatus,
  ConvState,
  PendingConfirmation,
  ProviderId,
  SecretName,
  ShortcutStatus,
  TtsModelInfo,
  TurnRecord,
  TurnTimings,
  VoiceInfo,
  WakeStatus,
} from '../shared/types';
import { checkBudget } from '../shared/usage';
import type { Logger } from './log';
import type { LlmAdapter } from './providers/types';
import type { SecretStore } from './secrets';
import type { SttOptions, SttSession } from './speech/stt';
import type { TtsClient } from './speech/tts';
import type { HistoryStore, MemoryStore, SettingsStore, UsageStore } from './stores';
import { TtsQueue } from './ttsQueue';
import type { WakeService } from './wakeword';

export interface ControllerUi {
  broadcast(snapshot: AppSnapshot): void;
  levels(input: number, output: number): void;
  revealOverlay(): void;
  setOverlayShown(shown: boolean): void;
  overlayShown(): boolean;
  usageChanged(): void;
}

export interface ControllerDeps {
  settings: SettingsStore;
  secrets: SecretStore;
  memories: MemoryStore;
  history: HistoryStore;
  usage: UsageStore;
  makeLlm(provider: ProviderId | 'demo'): LlmAdapter;
  makeStt(opts: SttOptions, demo: boolean): SttSession;
  makeTts(demo: boolean): TtsClient;
  listVoices(): Promise<VoiceInfo[]>;
  listTtsModels(): Promise<TtsModelInfo[]>;
  wake: WakeService | null;
  audio: { send(cmd: AudioCommand): void };
  ui: ControllerUi;
  log: Logger;
  now(): number;
  version: string;
  shortcuts(): ShortcutStatus;
}

type ListenSource = 'click' | 'hold' | 'hotkey' | 'wake' | 'followup';

interface ListenSession {
  id: number;
  stt: SttSession;
  assembler: TranscriptAssembler;
  source: ListenSource;
  manual: boolean;
  endRequested: boolean;
  startedAt: number;
  timers: Array<ReturnType<typeof setTimeout>>;
  endpointTimer: ReturnType<typeof setInterval> | null;
  finalizeTimer: ReturnType<typeof setTimeout> | null;
  timings: TurnTimings;
  live: boolean;
}

interface ActiveTurn {
  id: number;
  kind: 'conversation' | 'preview';
  abort: AbortController;
  assistantId: string | null;
  tts: TtsQueue | null;
  spoken: string[];
  heardSeq: number;
  llmDone: boolean;
  ttsEnded: boolean;
  ttsDelivered: number;
  audioStarted: boolean;
  drained: boolean;
  voiceFailed: boolean;
  gotText: boolean;
  record: TurnRecord;
}

const PREVIEW_LINE = 'Hello. This is a short voice preview for Jarvis.';

export class ConversationController {
  private state: ConvState = 'unconfigured';
  private armed = false;
  private muted = false;
  private armedBeforeMute = false;
  private messages: ChatMessage[] = [];
  private conversationId: string = randomUUID();
  private conversationStartedAt = Date.now();
  private partial = '';
  private error: AppSnapshot['error'] = null;
  private notice: string | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: PendingConfirmation | null = null;
  private pendingAction: (() => void) | null = null;
  private connections: Record<SecretName, ConnectionStatus>;
  private turnSeq = 0;
  private turn: ActiveTurn | null = null;
  private listen: ListenSession | null = null;
  private listenSeq = 0;
  private capture: { sessionId: number; levelTest: boolean } | null = null;
  private captureSeq = 0;
  private preRoll: Uint8Array[] = [];
  private preRollBytes = 0;
  private lastSubmit: { text: string; at: number } | null = null;
  private lastFailed: { text: string; source: 'voice' | 'typed' } | null = null;
  private micPermission: AppSnapshot['micPermission'] = 'unknown';
  private preview: AppSnapshot['preview'] = { active: false, state: 'idle' };
  private lastPlaybackEnd = 0;
  private voiceCache: VoiceInfo[] = [];
  private ttsModelCache: TtsModelInfo[] = [];
  private broadcastQueued = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private levelTestTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly d: ControllerDeps) {
    const status = d.secrets.status();
    const conn = (name: SecretName): ConnectionStatus => ({ state: status[name].configured ? 'untested' : 'missing' });
    this.connections = { anthropic: conn('anthropic'), openai: conn('openai'), elevenlabs: conn('elevenlabs') };
    if (this.s.memory.persistHistory) {
      const last = d.history.load().at(-1);
      if (last) {
        this.messages = last.messages;
        this.conversationId = last.id;
        this.conversationStartedAt = last.startedAt;
      }
    }
    this.state = restState(this.ctx());
    d.wake?.onWake((score) => this.onWake(score));
    d.wake?.onStatus(() => this.onWakeStatus());
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private get s(): Settings {
    return this.d.settings.get();
  }

  private ctx() {
    return { configured: this.isConfigured(), armed: this.armed };
  }

  isConfigured(): boolean {
    return this.s.demoMode || this.d.secrets.has(this.s.provider.active);
  }

  private sttAvailable(): boolean {
    return this.s.demoMode || this.d.secrets.has('elevenlabs');
  }

  private voiceAvailable(): boolean {
    if (!this.s.voice.enabled) return false;
    return this.s.demoMode || (this.d.secrets.has('elevenlabs') && !!this.s.voice.voiceId);
  }

  private activeModel(provider: ProviderId = this.s.provider.active): string {
    return provider === 'anthropic' ? this.s.provider.anthropicModel : this.s.provider.openaiModel;
  }

  private go(event: ConvEvent): boolean {
    const next = transition(this.state, event, this.ctx());
    if (next === null) return false;
    if (next !== this.state) {
      this.state = next;
      if (next !== 'error') this.error = next === 'muted' ? this.error : null;
    }
    this.queueBroadcast();
    return true;
  }

  private toRest(): void {
    if (this.state === 'muted') return;
    this.state = restState(this.ctx());
    this.queueBroadcast();
  }

  private setError(err: ProviderError): void {
    this.error = { code: err.code, message: err.message, retryable: err.retryable || err.code === 'timeout' };
    this.d.log.warn(`error.${err.service}.${err.code}`);
    if (this.state !== 'muted') this.state = 'error';
    this.queueBroadcast();
  }

  private flash(text: string, ms = 4000): void {
    this.notice = text;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.notice = null;
      this.queueBroadcast();
    }, ms);
    this.queueBroadcast();
  }

  private addMessage(m: Omit<ChatMessage, 'id' | 'createdAt'>): ChatMessage {
    const msg: ChatMessage = { id: randomUUID(), createdAt: this.d.now(), ...m };
    this.messages.push(msg);
    if (this.messages.length > 400) this.messages.splice(0, this.messages.length - 400);
    this.queueBroadcast();
    return msg;
  }

  private note(text: string): void {
    this.addMessage({ role: 'note', text, source: 'local' });
  }

  private findMessage(id: string | null): ChatMessage | undefined {
    return id ? this.messages.find((m) => m.id === id) : undefined;
  }

  private queueBroadcast(): void {
    if (this.broadcastQueued || this.disposed) return;
    this.broadcastQueued = true;
    setImmediate(() => {
      this.broadcastQueued = false;
      if (!this.disposed) this.d.ui.broadcast(this.snapshot());
    });
  }

  snapshot(): AppSnapshot {
    const status = this.d.secrets.status();
    const wake: WakeStatus = this.d.wake?.status() ?? { state: 'unavailable', reason: 'Wake word not available in this build', selfTestPassed: false };
    return {
      state: this.state,
      muted: this.muted,
      armed: this.armed,
      micActive: !!this.capture,
      micPermission: this.micPermission,
      provider: this.s.provider.active,
      model: this.s.demoMode ? 'demo (simulated)' : this.activeModel() || '(no model selected)',
      providerConfigured: { anthropic: status.anthropic.configured, openai: status.openai.configured },
      voiceConfigured: this.voiceAvailable(),
      demoMode: this.s.demoMode,
      messages: this.messages.slice(-200),
      partialTranscript: this.partial,
      error: this.error,
      pendingConfirmation: this.pending,
      overlayShown: this.d.ui.overlayShown(),
      wake,
      shortcuts: this.d.shortcuts(),
      connections: this.connections,
      secrets: status,
      encryptionAvailable: this.d.secrets.canPersist,
      preview: this.preview,
      canRetry: !!this.lastFailed,
      notice: this.notice,
      verification: this.d.usage.verification(),
      version: this.d.version,
    };
  }

  // ───────────────────────────── typed + voice input ─────────────────────────────

  async sendText(text: string): Promise<void> {
    const clean = text.trim();
    if (!clean) return;
    const now = this.d.now();
    if (this.lastSubmit && this.lastSubmit.text === clean && now - this.lastSubmit.at < 1000) return; // double-submit guard
    this.lastSubmit = { text: clean, at: now };
    await this.handleUserInput(clean, 'typed', {});
  }

  private async handleUserInput(text: string, source: 'voice' | 'typed', timings: TurnTimings): Promise<void> {
    const cmd = matchLocalCommand(text, this.s.personality.assistantName, !!this.pending);
    if (cmd) {
      this.addMessage({ role: 'user', text, source: 'local' });
      if (this.state === 'listening' || this.state === 'transcribing') this.toRest();
      await this.runLocalCommand(cmd);
      return;
    }
    await this.runTurn(text, source, timings, false);
  }

  private async runLocalCommand(cmd: LocalCommand): Promise<void> {
    switch (cmd.kind) {
      case 'stop':
        this.stop();
        return this.note('Stopped.');
      case 'mute':
        this.setMuted(true);
        return this.note('Muted. The microphone is off and wake-word detection is paused.');
      case 'stopListening':
        this.arm(false);
        return this.note('Stopped listening. Hands-free is disarmed.');
      case 'hide':
        this.d.ui.setOverlayShown(false);
        return this.note('Character hidden. Microphone state stays visible in the tray.');
      case 'show':
        this.d.ui.setOverlayShown(true);
        return this.note('Character shown.');
      case 'switchProvider':
        return this.switchProvider(cmd.provider);
      case 'newConversation':
        return this.newConversation(false);
      case 'listMemories': {
        const mems = this.d.memories.list();
        return this.note(mems.length ? `Saved memories:\n${mems.map((m) => `• ${m.text}`).join('\n')}` : 'No saved memories yet.');
      }
      case 'remember':
        try {
          const rec = this.d.memories.add(cmd.text);
          this.flash('Saved to memory');
          return this.note(`Saved to memory: "${rec.text}"`);
        } catch (err) {
          return this.note(`Could not save that memory: ${(err as Error).message}`);
        }
      case 'forget': {
        const matches = this.d.memories.find(cmd.query);
        if (!matches.length) return this.note(`No saved memory matches "${cmd.query}".`);
        const ids = matches.map((m) => m.id);
        return this.askConfirm(
          { kind: 'forget', label: `Forget ${matches.length} saved ${matches.length === 1 ? 'memory' : 'memories'} matching "${cmd.query}"?`, data: matches.map((m) => m.text).join(' | ') },
          () => {
            const n = this.d.memories.delete(ids);
            this.note(`Forgot ${n} ${n === 1 ? 'memory' : 'memories'}.`);
          },
        );
      }
      case 'changeVoice':
        return this.changeVoiceByName(cmd.name);
      case 'confirm':
        if (this.pending) this.confirm(this.pending.id, cmd.accept);
        return;
    }
  }

  private askConfirm(p: Omit<PendingConfirmation, 'id'>, action: () => void): void {
    this.pending = { id: randomUUID().replace(/-/g, '').slice(0, 16), ...p };
    this.pendingAction = action;
    this.note(`${p.label} Confirm in the chat window (or say "yes" / "no").`);
  }

  confirm(id: string, accept: boolean): void {
    if (!this.pending || this.pending.id !== id) return;
    const action = this.pendingAction;
    this.pending = null;
    this.pendingAction = null;
    if (accept && action) action();
    else this.note('Cancelled.');
    this.queueBroadcast();
  }

  private async changeVoiceByName(name: string): Promise<void> {
    if (!this.voiceCache.length && !this.s.demoMode && this.d.secrets.has('elevenlabs')) {
      try {
        this.voiceCache = await this.d.listVoices();
      } catch {
        /* handled below */
      }
    }
    const q = name.toLowerCase().trim();
    const exact = this.voiceCache.filter((v) => v.name.toLowerCase() === q);
    const partial = exact.length ? exact : this.voiceCache.filter((v) => v.name.toLowerCase().includes(q));
    if (partial.length !== 1) {
      return this.note(partial.length ? `Several voices match "${name}". Choose one in Settings → Voice.` : `No voice named "${name}" was found. Choose one in Settings → Voice.`);
    }
    const v = partial[0]!;
    const res = this.d.settings.update({ voice: { voiceId: v.id, voiceName: v.name } });
    this.note(res.ok ? `Voice changed to ${v.name}. It applies from the next reply.` : `Could not change voice: ${res.error}`);
  }

  // ───────────────────────────── listening ─────────────────────────────

  talk(action: 'toggle' | 'start' | 'end', source: 'click' | 'hold' | 'hotkey'): void {
    if (this.preview.active) this.setPreview(false);
    if (action === 'end') return this.endUtterance();
    if (action === 'toggle' && this.listen && this.state === 'listening') return this.endUtterance();
    if (action === 'toggle' && this.listen) return;
    this.startListening(source);
  }

  private startListening(source: ListenSource): void {
    if (this.muted) return this.flash('Muted — unmute to talk.');
    if (!this.isConfigured()) {
      this.setError(new ProviderError('not_configured', 'Add an Anthropic or OpenAI key in Setup (or turn on Demo mode).', 'app'));
      return;
    }
    if (!this.sttAvailable()) {
      this.setError(new ProviderError('not_configured', 'Voice input needs an ElevenLabs key. Typed chat still works.', 'elevenlabs'));
      return;
    }
    if (this.listen) return;
    if (isBusy(this.state) || this.turn) this.interrupt('barge-in');
    const live = !this.s.demoMode;
    if (live) {
      const b = checkBudget(this.d.usage.sessionTotals(), this.d.usage.todayTotals(), this.s.budget);
      if (!b.ok) return this.setError(new ProviderError('budget', `${b.reason} ${userMessage('budget', 'app')}`, 'app'));
    }
    if (!this.go('START_LISTEN')) return;
    this.lastFailed = null;
    this.ensureCapture();
    const id = ++this.listenSeq;
    const manual = source === 'hold';
    const a = this.s.activation;
    const guard = () => this.listen?.id === id;
    const stt = this.d.makeStt(
      {
        modelId: this.s.voice.sttModel,
        commitStrategy: manual ? 'manual' : 'vad',
        vadSilenceSecs: a.vadSilenceSecs,
        languageCode: this.s.voice.languageCode,
        handlers: {
          onPartial: (t) => guard() && this.onPartial(t),
          onCommitted: (t) => guard() && this.onCommitted(t),
          onNoSpeech: () => guard() && this.finishListening(),
          onError: (e) => guard() && this.onSttError(e),
          onClosed: () => undefined,
        },
      },
      !live,
    );
    const session: ListenSession = {
      id,
      stt,
      assembler: new TranscriptAssembler(a.endpointMs),
      source,
      manual,
      endRequested: false,
      startedAt: this.d.now(),
      timers: [],
      endpointTimer: null,
      finalizeTimer: null,
      timings: {},
      live,
    };
    this.listen = session;
    this.partial = '';
    this.d.ui.revealOverlay();
    stt.open().catch((e) => guard() && this.onSttError(classifyThrown(e, live ? 'elevenlabs' : 'demo')));
    if (source === 'wake' && a.preRollMs > 0) {
      const maxBytes = Math.floor((a.preRollMs / 1000) * 32000);
      let bytes = 0;
      const frames: Uint8Array[] = [];
      for (let i = this.preRoll.length - 1; i >= 0 && bytes < maxBytes; i--) {
        frames.unshift(this.preRoll[i]!);
        bytes += this.preRoll[i]!.byteLength;
      }
      for (const f of frames) stt.sendAudio(f);
    }
    const noSpeechMs = source === 'followup' ? Math.max(1500, a.followUpWindowMs) : a.noSpeechTimeoutMs;
    session.timers.push(
      setTimeout(() => guard() && !session.assembler.hasSpeech() && this.finishListening(), noSpeechMs),
      setTimeout(() => guard() && this.endUtterance(), a.maxUtteranceMs),
      setTimeout(() => guard() && this.endUtterance(), this.s.budget.maxListenSessionMs),
    );
    if (!manual) {
      session.endpointTimer = setInterval(() => {
        if (guard() && !session.endRequested && session.assembler.shouldFinalize(this.d.now())) {
          session.timings.endOfSpeech = this.d.now() - a.endpointMs;
          this.finishListening();
        }
      }, 100);
    }
  }

  private onPartial(text: string): void {
    const l = this.listen!;
    l.assembler.onPartial(text, this.d.now());
    this.partial = l.assembler.displayText();
    this.queueBroadcast();
  }

  private onCommitted(text: string): void {
    const l = this.listen!;
    l.assembler.onCommitted(text, this.d.now());
    this.partial = l.assembler.displayText();
    if (l.endRequested) {
      if (l.finalizeTimer) clearTimeout(l.finalizeTimer);
      l.finalizeTimer = setTimeout(() => this.listen === l && this.finishListening(), 300);
    }
    this.queueBroadcast();
  }

  /** Push-to-talk release, second click, hotkey toggle, or length limit. */
  endUtterance(): void {
    const l = this.listen;
    if (!l || l.endRequested) return;
    l.endRequested = true;
    l.timings.endOfSpeech = this.d.now();
    l.stt.commit();
    this.go('END_UTTERANCE');
    if (l.finalizeTimer) clearTimeout(l.finalizeTimer);
    l.finalizeTimer = setTimeout(() => this.listen === l && this.finishListening(), 2500);
  }

  private closeListen(): ListenSession | null {
    const l = this.listen;
    if (!l) return null;
    this.listen = null;
    for (const t of l.timers) clearTimeout(t);
    if (l.endpointTimer) clearInterval(l.endpointTimer);
    if (l.finalizeTimer) clearTimeout(l.finalizeTimer);
    l.stt.close();
    return l;
  }

  private finishListening(): void {
    const l = this.closeListen();
    if (!l) return;
    const raw = l.assembler.text();
    const text = l.source === 'wake' ? stripWakePhrase(raw, this.s.personality.assistantName) : raw;
    const sttSeconds = Math.round(l.stt.audioSeconds * 10) / 10;
    this.partial = '';
    this.releaseCaptureIfIdle();
    if (!text) {
      this.d.usage.addListenOnly(sttSeconds, l.live);
      this.go('NO_SPEECH');
      if (l.source !== 'followup') this.flash("Didn't catch that.");
      return;
    }
    l.timings.committed = this.d.now();
    void this.runTurn(text, 'voice', l.timings, false, sttSeconds);
  }

  private cancelListening(): void {
    const l = this.closeListen();
    if (!l) return;
    this.d.usage.addListenOnly(Math.round(l.stt.audioSeconds * 10) / 10, l.live);
    this.partial = '';
    this.releaseCaptureIfIdle();
  }

  private onSttError(err: ProviderError): void {
    this.cancelListening();
    this.setError(new ProviderError(err.code, `${err.message} Typed chat still works.`, err.service, err.status));
  }

  // ───────────────────────────── microphone capture ─────────────────────────────

  private ensureCapture(): void {
    if (this.capture) return;
    const a = this.s.audio;
    this.capture = { sessionId: ++this.captureSeq, levelTest: false };
    this.preRoll = [];
    this.preRollBytes = 0;
    this.d.audio.send({
      type: 'startCapture',
      sessionId: this.capture.sessionId,
      deviceId: a.inputDeviceId,
      echoCancellation: a.echoCancellation,
      noiseSuppression: a.noiseSuppression,
      autoGainControl: a.autoGainControl,
    });
    this.queueBroadcast();
  }

  private releaseCapture(): void {
    if (!this.capture) return;
    this.capture = null;
    this.preRoll = [];
    this.preRollBytes = 0;
    this.d.audio.send({ type: 'stopCapture' });
    this.queueBroadcast();
  }

  private releaseCaptureIfIdle(): void {
    if (this.capture && !this.armed && !this.listen && !this.capture.levelTest) this.releaseCapture();
  }

  private wakeSuppressed(): boolean {
    if (this.muted || this.listen) return true;
    if (this.d.now() - this.lastPlaybackEnd < this.s.activation.refractoryMs) return true;
    if ((this.state === 'speaking' || this.state === 'thinking') && this.s.activation.duplex === 'half') return true;
    return false;
  }

  /**
   * Routes a microphone frame. Transport boundary: frames reach the cloud STT session only while a
   * listening session exists. While merely armed, frames go to the local wake detector only.
   */
  onAudioFrame(sessionId: number, data: Uint8Array): void {
    if (!this.capture || sessionId !== this.capture.sessionId || this.muted) return;
    this.preRoll.push(data);
    this.preRollBytes += data.byteLength;
    const maxPre = Math.ceil((this.s.activation.preRollMs / 1000) * 32000) + 3200;
    while (this.preRollBytes > maxPre && this.preRoll.length) this.preRollBytes -= this.preRoll.shift()!.byteLength;
    if (this.listen && (this.state === 'listening' || this.state === 'transcribing')) {
      this.listen.stt.sendAudio(data);
      return;
    }
    if (this.armed && this.d.wake && !this.wakeSuppressed()) this.d.wake.feed(data);
    else if (this.armed && this.d.wake && this.s.activation.duplex === 'wakeBargeIn' && this.state === 'speaking') this.d.wake.feed(data);
  }

  onAudioEvent(ev: AudioEvent): void {
    switch (ev.type) {
      case 'captureStarted':
        this.micPermission = 'granted';
        this.queueBroadcast();
        return;
      case 'captureStopped':
        return;
      case 'captureError': {
        this.capture = null;
        this.cancelListening();
        this.armed = false;
        const code: ErrorCode = ev.code === 'mic_denied' ? 'mic_denied' : ev.code === 'mic_missing' ? 'mic_missing' : 'unknown';
        if (ev.code === 'mic_denied') this.micPermission = 'denied';
        this.setError(new ProviderError(code, code === 'unknown' ? `Microphone error: ${ev.message}` : userMessage(code, 'app'), 'app'));
        return;
      }
      case 'deviceLost':
        this.capture = null;
        this.cancelListening();
        this.armed = false;
        this.setError(new ProviderError('device_lost', userMessage('device_lost', 'app'), 'app'));
        return;
      case 'level':
        this.d.ui.levels(ev.input, ev.output);
        return;
      case 'playbackStarted': {
        const t = this.turn;
        if (!t || t.id !== ev.turnId) return;
        t.audioStarted = true;
        if (t.kind === 'conversation') {
          t.record.timings.firstPlayback ??= this.d.now();
          this.go('FIRST_AUDIO');
        }
        return;
      }
      case 'chunkPlayed': {
        const t = this.turn;
        if (t && t.id === ev.turnId) t.heardSeq = Math.max(t.heardSeq, ev.seq);
        return;
      }
      case 'playbackDrained': {
        const t = this.turn;
        if (!t || t.id !== ev.turnId) return;
        t.drained = true;
        this.maybeComplete(t);
        return;
      }
      case 'outputError':
        this.flash(`Audio output problem: ${ev.message}`);
        return;
    }
  }

  // ───────────────────────────── LLM turn ─────────────────────────────

  async retry(): Promise<void> {
    const f = this.lastFailed;
    if (!f) return;
    await this.runTurn(f.text, f.source, {}, true);
  }

  private async runTurn(userText: string, source: 'voice' | 'typed', timings: TurnTimings, isRetry: boolean, sttSeconds = 0): Promise<void> {
    const demo = this.s.demoMode;
    const provider: ProviderId = this.s.provider.active;
    const model = demo ? 'demo' : this.activeModel(provider);
    const fail = (err: ProviderError) => {
      this.lastFailed = { text: userText, source };
      if (!isRetry) this.addMessage({ role: 'user', text: userText, source, error: err.message });
      if (this.state === 'listening' || this.state === 'transcribing') this.toRest();
      this.setError(err);
    };
    if (!demo && !this.d.secrets.has(provider)) return fail(new ProviderError('not_configured', userMessage('not_configured', provider), provider));
    if (!demo && !model) return fail(new ProviderError('invalid_model', 'No model selected. Test the connection in Setup to load your available models.', provider));
    if (!demo) {
      const b = checkBudget(this.d.usage.sessionTotals(), this.d.usage.todayTotals(), this.s.budget);
      if (!b.ok) return fail(new ProviderError('budget', `${b.reason} ${userMessage('budget', 'app')}`, 'app'));
    }
    if (this.turn) this.interrupt('new-turn');
    if (this.listen && source === 'typed') this.cancelListening();

    if (isRetry) {
      const lastUser = [...this.messages].reverse().find((m) => m.role === 'user');
      if (lastUser) delete lastUser.error;
    } else {
      this.addMessage({ role: 'user', text: userText, source });
    }
    const history = buildHistory(this.messages, {
      maxMessages: this.s.memory.maxHistoryMessages,
      maxChars: this.s.memory.maxContextChars,
      ownerName: this.s.personality.ownerName,
    });
    const system = buildSystemPrompt(this.s.personality, this.d.memories.list(), this.s.memory.includeMemories);
    const assistant = this.addMessage({ role: 'assistant', text: '', provider, model, pending: true, demo });
    const turn: ActiveTurn = {
      id: ++this.turnSeq,
      kind: 'conversation',
      abort: new AbortController(),
      assistantId: assistant.id,
      tts: null,
      spoken: [],
      heardSeq: -1,
      llmDone: false,
      ttsEnded: false,
      ttsDelivered: 0,
      audioStarted: false,
      drained: false,
      voiceFailed: false,
      gotText: false,
      record: {
        turnId: 0,
        provider: demo ? 'demo' : provider,
        model,
        startedAt: this.d.now(),
        ttsChars: 0,
        sttSeconds,
        timings: { ...timings },
        outcome: 'running',
        live: !demo,
      },
    };
    turn.record.turnId = turn.id;
    this.turn = turn;
    this.lastFailed = null;
    if (!this.go(this.state === 'listening' || this.state === 'transcribing' ? 'TRANSCRIPT_FINAL' : 'SUBMIT_TEXT')) {
      this.state = 'thinking';
      this.queueBroadcast();
    }
    this.d.ui.revealOverlay();
    if (this.voiceAvailable()) turn.tts = this.makeQueue(turn, demo);
    const speech = new SpeechPipeline();
    const speak = (chunks: string[]) => {
      for (const c of chunks) {
        turn.spoken.push(c);
        turn.tts?.enqueue(c);
      }
    };

    let current: ProviderId | 'demo' = demo ? 'demo' : provider;
    let attempt = 0;
    let usedFallback = false;
    for (;;) {
      try {
        const adapter = this.d.makeLlm(current);
        const stream = adapter.stream({
          model: current === 'demo' ? 'demo' : this.activeModel(current),
          system,
          messages: history,
          maxTokens: this.s.provider.maxOutputTokens,
          signal: turn.abort.signal,
          idleTimeoutMs: this.s.provider.requestTimeoutMs,
          reasoningEffort: current === 'openai' && this.s.provider.openaiReasoningEffort !== 'unset' ? this.s.provider.openaiReasoningEffort : undefined,
        });
        for await (const ev of stream) {
          if (this.turn !== turn) return;
          if (ev.type === 'text') {
            if (!turn.gotText) turn.record.timings.firstText = this.d.now();
            turn.gotText = true;
            assistant.text += ev.text;
            speak(speech.push(ev.text));
            this.queueBroadcast();
          } else if (ev.type === 'usage') {
            if (ev.inputTokens !== undefined) turn.record.inputTokens = ev.inputTokens;
            if (ev.outputTokens !== undefined) turn.record.outputTokens = ev.outputTokens;
          }
        }
        break;
      } catch (raw) {
        if (this.turn !== turn || turn.abort.signal.aborted) return;
        const err = classifyThrown(raw, current === 'demo' ? 'demo' : current);
        if (!turn.gotText && err.retryable && attempt < 2) {
          attempt++;
          this.d.log.info('llm.retry', { attempt, code: err.code });
          await new Promise((r) => setTimeout(r, attempt === 1 ? 800 : 2500));
          if (this.turn !== turn) return;
          continue;
        }
        const alt: ProviderId = current === 'anthropic' ? 'openai' : 'anthropic';
        if (!turn.gotText && !demo && !usedFallback && this.s.provider.fallbackEnabled && ['outage', 'rate_limit', 'network', 'timeout'].includes(err.code) && this.d.secrets.has(alt) && this.activeModel(alt)) {
          usedFallback = true;
          attempt = 0;
          current = alt;
          assistant.provider = alt;
          assistant.model = this.activeModel(alt);
          this.note(`${err.message} Fallback is on, so this turn is going to ${alt === 'openai' ? 'OpenAI' : 'Anthropic'} instead.`);
          continue;
        }
        assistant.pending = false;
        assistant.error = turn.gotText ? `Reply cut off: ${err.message}` : err.message;
        turn.llmDone = true;
        turn.record.outcome = 'error';
        this.lastFailed = { text: userText, source };
        if (!turn.gotText) {
          turn.tts?.cancel();
          this.finishTurn(turn);
          this.setError(err);
        } else {
          speak(speech.flush());
          turn.tts?.finish();
          this.error = { code: err.code, message: err.message, retryable: err.retryable };
          this.maybeComplete(turn);
        }
        return;
      }
    }
    if (this.turn !== turn) return;
    speak(speech.flush());
    assistant.pending = false;
    turn.llmDone = true;
    turn.tts?.finish();
    this.queueBroadcast();
    this.maybeComplete(turn);
  }

  private makeQueue(turn: ActiveTurn, demo: boolean): TtsQueue {
    return new TtsQueue(
      turn.id,
      this.d.makeTts(demo),
      {
        pcm: (turnId, seq, data, seqDone) => {
          if (this.turn?.id !== turnId) return;
          this.d.audio.send({ type: 'pcm', turnId, seq, sampleRate: turn.tts?.sampleRate ?? 24000, data, seqDone });
        },
        end: (turnId, total) => {
          if (this.turn?.id !== turnId) return;
          turn.ttsEnded = true;
          turn.ttsDelivered = total;
          this.d.audio.send({ type: 'endOfStream', turnId, totalSeqs: total });
          this.maybeComplete(turn);
        },
      },
      {
        onFirstAudio: () => {
          turn.record.timings.firstAudioReceived ??= this.d.now();
        },
        onChars: (_id, chars) => {
          turn.record.ttsChars += chars;
        },
        onFailed: (_id, _seq, err) => {
          if (this.turn !== turn) return;
          turn.voiceFailed = true;
          const msg = this.findMessage(turn.assistantId);
          if (msg) msg.voiceUnavailable = true;
          this.flash('Voice unavailable');
          this.d.log.warn(`tts.failed.${err.code}`);
          if (['auth', 'credits', 'invalid_voice', 'invalid_model', 'not_configured'].includes(err.code)) this.note(`Voice unavailable: ${err.message}`);
          this.maybeComplete(turn);
        },
      },
    );
  }

  private maybeComplete(turn: ActiveTurn): void {
    if (this.turn !== turn || !turn.llmDone) return;
    if (turn.tts) {
      if (!turn.ttsEnded) return;
      if (turn.ttsDelivered > 0 || turn.audioStarted) {
        if (!turn.drained) return;
      }
    }
    if (turn.record.outcome === 'running') turn.record.outcome = 'completed';
    if (turn.record.live && turn.audioStarted && turn.drained && turn.record.outcome === 'completed') this.d.usage.markVerified('liveConversation');
    this.finishTurn(turn);
    this.lastPlaybackEnd = this.d.now();
    if (this.error && this.state !== 'error') {
      this.state = 'error';
      this.queueBroadcast();
    } else {
      this.go('REPLY_DONE');
    }
    if (this.armed && this.s.activation.mode === 'handsfree' && this.s.activation.followUpWindowMs > 0 && turn.audioStarted && !this.muted) {
      setTimeout(() => {
        if (!this.turn && !this.listen && this.armed && !this.muted && (this.state === 'armed' || this.state === 'idle')) this.startListening('followup');
      }, 250);
    }
  }

  private finishTurn(turn: ActiveTurn): void {
    if (this.turn === turn) this.turn = null;
    if (turn.kind === 'conversation') {
      this.d.usage.record({ ...turn.record, timings: { ...turn.record.timings } });
      this.d.ui.usageChanged();
      this.persistHistory();
    }
    this.queueBroadcast();
  }

  private persistHistory(): void {
    if (!this.s.memory.persistHistory || !this.messages.length) return;
    try {
      this.d.history.save({ id: this.conversationId, startedAt: this.conversationStartedAt, messages: this.messages });
    } catch (err) {
      this.d.log.warn('history.save_failed', err);
    }
  }

  // ───────────────────────────── stop / interrupt / mute ─────────────────────────────

  /** Stops audible output immediately, aborts LLM/TTS, discards late chunks, keeps heard text. */
  interrupt(reason: string): void {
    const t = this.turn;
    if (t) {
      this.turn = null;
      t.abort.abort();
      t.tts?.cancel();
      this.d.audio.send({ type: 'stopPlayback', turnId: t.id });
      const wasSpeaking = this.state === 'speaking' && t.audioStarted;
      const msg = this.findMessage(t.assistantId);
      if (msg) {
        msg.pending = false;
        const unfinished = !t.llmDone || (!!t.tts && !t.drained && !t.voiceFailed);
        if (unfinished) {
          msg.interrupted = true;
          msg.heardText = t.tts && !t.voiceFailed ? t.spoken.slice(0, t.heardSeq + 1).join(' ') : msg.text;
        }
        if (!msg.text.trim() && !msg.error) this.messages = this.messages.filter((m) => m !== msg);
      }
      if (t.kind === 'conversation') {
        t.record.outcome = 'interrupted';
        if (t.record.live && wasSpeaking) this.d.usage.markVerified('liveInterruption');
        this.d.usage.record({ ...t.record, timings: { ...t.record.timings } });
        this.d.ui.usageChanged();
        this.persistHistory();
      }
      this.lastPlaybackEnd = this.d.now();
      this.d.log.info('turn.interrupted', { reason });
    }
    if (this.listen) this.cancelListening();
    if (this.go('INTERRUPT')) {
      if (this.settleTimer) clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => this.go('SETTLE'), 400);
    }
  }

  /** Stop button / Stop hotkey / "stop": immediate, local, never waits for an LLM. */
  stop(): void {
    if (this.preview.active) this.setPreview(false);
    this.interrupt('stop');
    if (this.state === 'error') this.go('CLEAR_ERROR');
  }

  setMuted(muted: boolean): void {
    if (muted === this.muted) return;
    if (muted) {
      this.armedBeforeMute = this.armed;
      this.interrupt('mute');
      this.cancelListening();
      this.armed = false;
      this.muted = true;
      if (this.capture) this.capture.levelTest = false;
      this.releaseCapture();
      this.go('MUTE');
    } else {
      this.muted = false;
      this.go('UNMUTE');
      if (this.armedBeforeMute) this.arm(true);
    }
    this.queueBroadcast();
  }

  // ───────────────────────────── wake word ─────────────────────────────

  arm(armed: boolean): void {
    if (armed) {
      if (this.muted) return this.flash('Muted — unmute first.');
      if (this.s.activation.mode !== 'handsfree') return this.flash('Choose Hands-free in Settings → Activation first.');
      const st = this.d.wake?.status();
      if (!st || st.state !== 'ready') return this.flash(st?.reason ?? 'Wake word unavailable.');
      this.armed = true;
      this.ensureCapture();
      this.go('ARM');
    } else {
      this.armed = false;
      this.cancelListening();
      this.releaseCaptureIfIdle();
      this.go('DISARM');
    }
    this.queueBroadcast();
  }

  private onWake(score: number): void {
    if (!this.armed || this.muted) return;
    const bargeIn = this.s.activation.duplex === 'wakeBargeIn' && (this.state === 'speaking' || this.state === 'thinking');
    if (!bargeIn && this.wakeSuppressed()) return;
    this.d.log.info('wake.detected', { score });
    if (bargeIn) this.interrupt('wake-barge-in');
    if (this.s.activation.wakeCue) this.d.audio.send({ type: 'cue' });
    this.startListening('wake');
  }

  private onWakeStatus(): void {
    const st = this.d.wake?.status();
    if (this.armed && st && st.state !== 'ready') {
      this.armed = false;
      this.releaseCaptureIfIdle();
      this.go('DISARM');
      this.flash(`Hands-free disarmed: ${st.reason}`);
    }
    this.queueBroadcast();
  }

  async wakeSelfTest(): Promise<{ ok: boolean; detail: string }> {
    if (!this.d.wake) return { ok: false, detail: 'Wake word not available in this build.' };
    const r = await this.d.wake.selfTest();
    if (r.ok && this.s.activation.mode === 'handsfree') this.d.wake.start();
    this.queueBroadcast();
    return r;
  }

  // ───────────────────────────── conversation management ─────────────────────────────

  switchProvider(p: ProviderId): void {
    if (p === this.s.provider.active) return this.note(`Already using ${p === 'openai' ? 'OpenAI' : 'Claude'}.`);
    if (!this.s.demoMode && !this.d.secrets.has(p)) return this.note(`${p === 'openai' ? 'OpenAI' : 'Anthropic'} is not configured. Add its key in Setup first.`);
    if (this.turn) this.interrupt('provider-switch');
    const res = this.d.settings.update({ provider: { active: p } });
    if (!res.ok) return this.note(`Could not switch: ${res.error}`);
    const label = p === 'openai' ? 'OpenAI' : 'Claude (Anthropic)';
    const model = this.activeModel(p) || 'no model selected yet';
    const count = this.messages.filter((m) => m.role !== 'note').length;
    this.note(
      count
        ? `Switched to ${label} · ${model}. The existing conversation context (${count} messages, bounded by your context limit) will be sent to ${label} with your next message. Start a new conversation to avoid that.`
        : `Switched to ${label} · ${model}.`,
    );
  }

  newConversation(confirmed: boolean): void {
    const unsaved = !this.s.memory.persistHistory && this.messages.some((m) => m.role !== 'note');
    if (unsaved && !confirmed) {
      return this.askConfirm({ kind: 'newConversation', label: 'Start a new conversation? The current one is not saved (history persistence is off).' }, () => this.newConversation(true));
    }
    this.interrupt('new-conversation');
    this.persistHistory();
    this.messages = [];
    this.conversationId = randomUUID();
    this.conversationStartedAt = this.d.now();
    this.lastFailed = null;
    this.error = null;
    this.toRest();
    this.note('New conversation started.');
  }

  clearHistory(): void {
    this.d.history.clear();
    this.messages = [];
    this.conversationId = randomUUID();
    this.note('Saved conversation history deleted and the current session cleared.');
  }

  conversationExport(): { messages: ChatMessage[]; startedAt: number } {
    return { messages: this.messages.filter((m) => !m.pending), startedAt: this.conversationStartedAt };
  }

  // ───────────────────────────── setup / connections ─────────────────────────────

  async testConnection(target: SecretName): Promise<ConnectionStatus> {
    if (!this.d.secrets.has(target)) {
      this.connections[target] = { state: 'missing' };
      this.queueBroadcast();
      return this.connections[target];
    }
    this.connections[target] = { state: 'testing' };
    this.queueBroadcast();
    try {
      if (target === 'elevenlabs') {
        this.voiceCache = await this.d.listVoices();
        try {
          this.ttsModelCache = await this.d.listTtsModels();
        } catch {
          /* model metadata is optional for the connection test */
        }
        this.connections[target] = { state: 'ok', detail: `${this.voiceCache.length} voices available`, checkedAt: this.d.now() };
      } else {
        const ids = await this.d.makeLlm(target).listModels();
        this.connections[target] = { state: 'ok', detail: `${ids.length} models available`, checkedAt: this.d.now() };
      }
    } catch (raw) {
      const err = classifyThrown(raw, target);
      this.connections[target] = {
        state: err.code === 'auth' ? 'auth_error' : err.code === 'network' || err.code === 'timeout' ? 'network_error' : 'error',
        detail: err.message,
        checkedAt: this.d.now(),
      };
    }
    this.queueBroadcast();
    return this.connections[target];
  }

  cachedTtsModels(): TtsModelInfo[] {
    return this.ttsModelCache;
  }
  cacheVoices(v: VoiceInfo[]): void {
    this.voiceCache = v;
  }
  cacheTtsModels(m: TtsModelInfo[]): void {
    this.ttsModelCache = m;
  }

  secretsChanged(name: SecretName): void {
    this.connections[name] = { state: this.d.secrets.has(name) ? 'untested' : 'missing' };
    const active = this.s.provider.active;
    if (name !== 'elevenlabs' && !this.d.secrets.has(active)) {
      const other: ProviderId = active === 'anthropic' ? 'openai' : 'anthropic';
      if (this.d.secrets.has(other)) this.d.settings.update({ provider: { active: other } });
    }
    this.go('CONFIG_CHANGED');
    this.queueBroadcast();
  }

  /** Plays a short fixed line through the real TTS path. Uses ElevenLabs characters; UI labels it first. */
  previewVoice(): void {
    if (!this.voiceAvailable()) return this.flash('Choose an ElevenLabs voice first.');
    if (this.turn) this.interrupt('voice-preview');
    const t: ActiveTurn = {
      id: ++this.turnSeq,
      kind: 'preview',
      abort: new AbortController(),
      assistantId: null,
      tts: null,
      spoken: [PREVIEW_LINE],
      heardSeq: -1,
      llmDone: true,
      ttsEnded: false,
      ttsDelivered: 0,
      audioStarted: false,
      drained: false,
      voiceFailed: false,
      gotText: true,
      record: { turnId: 0, provider: 'demo', model: '', startedAt: this.d.now(), ttsChars: 0, sttSeconds: 0, timings: {}, outcome: 'running', live: false },
    };
    this.turn = t;
    t.tts = this.makeQueue(t, this.s.demoMode);
    t.tts.enqueue(PREVIEW_LINE);
    t.tts.finish();
  }

  levelTest(active: boolean): void {
    if (this.levelTestTimer) clearTimeout(this.levelTestTimer);
    if (active) {
      if (this.muted) return this.flash('Muted — unmute to test the microphone.');
      this.ensureCapture();
      if (this.capture) this.capture.levelTest = true;
      this.levelTestTimer = setTimeout(() => this.levelTest(false), 60000);
    } else if (this.capture) {
      this.capture.levelTest = false;
      this.releaseCaptureIfIdle();
    }
    this.queueBroadcast();
  }

  setPreview(active: boolean, state?: ConvState): void {
    this.preview = { active, state: state ?? this.preview.state };
    if (active) this.d.ui.revealOverlay();
    this.queueBroadcast();
  }

  /** Applies settings changes that affect live behaviour. */
  settingsChanged(next: Settings, prev: Settings): void {
    if (next.demoMode !== prev.demoMode) {
      this.interrupt('demo-toggle');
      this.note(next.demoMode ? 'Demo mode on: simulated brain, speech, and voice. No network, no charges.' : 'Demo mode off: real providers will be used.');
    }
    if (next.activation.mode !== 'handsfree' && this.armed) this.arm(false);
    if (next.activation.mode === 'handsfree' && prev.activation.mode !== 'handsfree') this.d.wake?.start();
    if (next.activation.mode !== 'handsfree' && prev.activation.mode === 'handsfree') this.d.wake?.stop();
    if (this.listen) this.listen.assembler.setEndpoint(next.activation.endpointMs);
    this.go('CONFIG_CHANGED');
    this.queueBroadcast();
  }

  /** Windows lock/sleep: stop everything and release the microphone; it stays off on resume. */
  suspend(): void {
    this.stop();
    this.armed = false;
    this.cancelListening();
    if (this.capture) this.capture.levelTest = false;
    this.releaseCapture();
    this.toRest();
  }

  shutdown(): void {
    this.interrupt('quit');
    this.cancelListening();
    this.releaseCapture();
    this.d.wake?.stop();
    this.persistHistory();
    this.disposed = true;
    for (const t of [this.noticeTimer, this.settleTimer, this.levelTestTimer]) if (t) clearTimeout(t);
  }
}
