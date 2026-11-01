import type { AudioCommand, AudioEvent } from '../../../shared/types';
import { rmsFloat } from '../../../shared/motion';
import { PlaybackScheduler, type PlaybackSink, type ScheduledSource } from './playback';
import workletUrl from './capture-worklet.js?url';

/**
 * The app's single audio engine (lives in the overlay renderer). Captures the microphone only on
 * main's command (audio only, video false), plays PCM through one ordered scheduler, and exposes
 * real input/output levels for animation.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserBuf: Float32Array<ArrayBuffer> | null = null;
  private scheduler: PlaybackScheduler | null = null;
  private workletLoaded = false;
  private capture: { sessionId: number; stream: MediaStream; node: AudioWorkletNode; source: MediaStreamAudioSourceNode; sink: GainNode; deviceId: string } | null = null;
  private pendingCaptureSession = 0;
  private inputRms = 0;
  private lastLevelSent = 0;
  private outputDevice = '';
  private volume = 0.9;

  constructor() {
    navigator.mediaDevices?.addEventListener?.('devicechange', () => void this.checkDevice());
  }

  private emit(ev: AudioEvent): void {
    window.jarvis.send('audio:event', ev);
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.gain = ctx.createGain();
      this.gain.gain.value = this.volume;
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyserBuf = new Float32Array(this.analyser.fftSize);
      this.gain.connect(this.analyser);
      this.analyser.connect(ctx.destination);
      const sink: PlaybackSink = {
        now: () => ctx.currentTime,
        outputLatency: () => (ctx.outputLatency || ctx.baseLatency || 0),
        play: (samples, sampleRate, when): ScheduledSource => {
          const buf = ctx.createBuffer(1, samples.length, sampleRate);
          buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(this.gain!);
          const handle: ScheduledSource = { stop: () => src.stop(), onended: null };
          src.onended = () => handle.onended?.();
          src.start(when);
          return handle;
        },
      };
      this.scheduler = new PlaybackScheduler(sink, {
        started: (turnId) => this.emit({ type: 'playbackStarted', turnId }),
        chunkPlayed: (turnId, seq) => this.emit({ type: 'chunkPlayed', turnId, seq }),
        drained: (turnId) => this.emit({ type: 'playbackDrained', turnId }),
      });
      this.ctx = ctx;
      if (this.outputDevice) void this.applySink();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  handle(cmd: AudioCommand): void {
    switch (cmd.type) {
      case 'startCapture':
        void this.startCapture(cmd);
        return;
      case 'stopCapture':
        this.stopCapture(true);
        return;
      case 'pcm':
        this.ensureCtx();
        this.scheduler!.push(cmd.turnId, cmd.seq, cmd.sampleRate, cmd.data, cmd.seqDone);
        return;
      case 'endOfStream':
        this.ensureCtx();
        this.scheduler!.end(cmd.turnId, cmd.totalSeqs);
        return;
      case 'stopPlayback':
        this.scheduler?.stop(cmd.turnId);
        return;
      case 'setOutput':
        this.volume = cmd.volume;
        if (this.gain) this.gain.gain.value = cmd.volume;
        this.outputDevice = cmd.deviceId;
        if (this.ctx) void this.applySink();
        return;
      case 'cue':
        this.tone([880, 1320], 0.09, 0.08);
        return;
      case 'testTone':
        this.tone([440], 0.6, 0.15);
        return;
    }
  }

  private async applySink(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    if (typeof ctx.setSinkId !== 'function') {
      if (this.outputDevice) this.emit({ type: 'outputError', message: 'Per-app output selection is not supported here; using the Windows default output.' });
      return;
    }
    try {
      await ctx.setSinkId(this.outputDevice || '');
    } catch (err) {
      this.emit({ type: 'outputError', message: `Could not use the selected output (${(err as Error).name}); using the system default.` });
    }
  }

  private tone(freqs: number[], dur: number, amp: number): void {
    const ctx = this.ensureCtx();
    const t0 = ctx.currentTime + 0.02;
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.frequency.value = f;
      const start = t0 + i * dur;
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(amp, start + 0.01);
      g.gain.linearRampToValueAtTime(0, start + dur);
      osc.connect(g).connect(this.gain!);
      osc.start(start);
      osc.stop(start + dur + 0.02);
    });
  }

  private async startCapture(cmd: Extract<AudioCommand, { type: 'startCapture' }>): Promise<void> {
    this.pendingCaptureSession = cmd.sessionId;
    this.stopCapture(false);
    let stream: MediaStream;
    try {
      const ctx = this.ensureCtx();
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: cmd.deviceId ? { exact: cmd.deviceId } : undefined,
          echoCancellation: cmd.echoCancellation,
          noiseSuppression: cmd.noiseSuppression,
          autoGainControl: cmd.autoGainControl,
          channelCount: 1,
        },
        video: false,
      });
      if (this.pendingCaptureSession !== cmd.sessionId) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      if (!this.workletLoaded) {
        await ctx.audioWorklet.addModule(workletUrl);
        this.workletLoaded = true;
      }
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'jarvis-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        processorOptions: { targetRate: 16000, frameSamples: 1600 },
      });
      const silent = ctx.createGain();
      silent.gain.value = 0;
      node.connect(silent).connect(ctx.destination);
      const sessionId = cmd.sessionId;
      node.port.onmessage = (e: MessageEvent<{ type: string; pcm?: ArrayBuffer; rms?: number }>) => {
        if (e.data.type === 'frame' && e.data.pcm) window.jarvis.sendFrame(sessionId, new Uint8Array(e.data.pcm));
        else if (e.data.type === 'level') {
          this.inputRms = e.data.rms ?? 0;
          this.maybeSendLevels();
        }
      };
      source.connect(node);
      const track = stream.getAudioTracks()[0];
      if (track) track.onended = () => this.lost();
      this.capture = { sessionId, stream, node, source, sink: silent, deviceId: track?.getSettings().deviceId ?? cmd.deviceId };
      this.emit({ type: 'captureStarted', sessionId, sampleRate: ctx.sampleRate });
    } catch (err) {
      const name = (err as Error)?.name ?? '';
      const code = name === 'NotAllowedError' || name === 'SecurityError' ? 'mic_denied' : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'mic_missing' : 'mic_error';
      this.emit({ type: 'captureError', code, message: `${name}: ${(err as Error)?.message ?? ''}`.slice(0, 300) });
    }
  }

  private stopCapture(notify: boolean): void {
    const c = this.capture;
    this.capture = null;
    this.inputRms = 0;
    if (!c) return;
    c.node.port.onmessage = null;
    try {
      c.source.disconnect();
      c.node.disconnect();
      c.sink.disconnect();
    } catch {
      /* ignore */
    }
    c.stream.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    if (notify) this.emit({ type: 'captureStopped' });
  }

  private lost(): void {
    if (!this.capture) return;
    this.stopCapture(false);
    this.emit({ type: 'deviceLost' });
  }

  private async checkDevice(): Promise<void> {
    const c = this.capture;
    if (!c || !c.deviceId) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (!devices.some((d) => d.kind === 'audioinput' && d.deviceId === c.deviceId)) this.lost();
  }

  private maybeSendLevels(): void {
    const now = performance.now();
    if (now - this.lastLevelSent < 80) return;
    this.lastLevelSent = now;
    this.emit({ type: 'level', input: Math.min(1, this.inputRms), output: Math.min(1, this.outputRms()) });
  }

  /** Real input level (RMS of captured mic audio). */
  inputLevel(): number {
    return this.capture ? this.inputRms : 0;
  }

  /** Real output level (RMS of audio actually being played), from a Web Audio analyser. */
  outputRms(): number {
    if (!this.analyser || !this.analyserBuf || !this.scheduler?.isPlaying()) return 0;
    this.analyser.getFloatTimeDomainData(this.analyserBuf);
    return rmsFloat(this.analyserBuf);
  }

  isCapturing(): boolean {
    return !!this.capture;
  }
}
