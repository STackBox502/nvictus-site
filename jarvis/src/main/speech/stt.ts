import WebSocket from 'ws';
import { assertAllowedUrl } from '../../shared/endpoints';
import { ProviderError, classifyHttp, classifyThrown, userMessage, type ErrorCode } from '../../shared/errors';

export interface SttHandlers {
  onPartial(text: string): void;
  onCommitted(text: string): void;
  /** Server reported too little speech; treat as "no speech", not an error. */
  onNoSpeech(): void;
  onError(err: ProviderError): void;
  onClosed(): void;
}

export interface SttOptions {
  modelId: string;
  commitStrategy: 'manual' | 'vad';
  vadSilenceSecs: number;
  languageCode: string;
  handlers: SttHandlers;
}

export interface SttSession {
  open(): Promise<void>;
  sendAudio(pcm16k: Uint8Array): void;
  commit(): void;
  close(): void;
  readonly audioSeconds: number;
}

const ERROR_MAP: Record<string, ErrorCode> = {
  auth_error: 'auth',
  unaccepted_terms: 'auth',
  quota_exceeded: 'credits',
  rate_limited: 'rate_limit',
  queue_overflow: 'rate_limit',
  resource_exhausted: 'rate_limit',
  session_time_limit_exceeded: 'timeout',
  input_error: 'bad_request',
  invalid_request: 'bad_request',
  chunk_size_exceeded: 'bad_request',
  transcriber_error: 'outage',
  error: 'outage',
};

const SAMPLE_RATE = 16000;
const MAX_PENDING = 60; // ~6 s of 100 ms frames buffered before session_started
const MAX_BUFFERED_BYTES = 512 * 1024;

/**
 * ElevenLabs realtime speech-to-text over WebSocket, opened from the main process with the API key
 * in the `xi-api-key` header (never in the URL, never in the renderer).
 * Protocol verified against @elevenlabs/elevenlabs-js 2.75.0 (wrapper/realtime).
 */
export class ElevenLabsStt implements SttSession {
  private ws: WebSocket | null = null;
  private pending: string[] = [];
  private ready = false;
  private closedByUs = false;
  private failed = false;
  private bytes = 0;

  constructor(
    private readonly apiKey: string,
    private readonly opts: SttOptions,
    private readonly WS: typeof WebSocket = WebSocket,
  ) {}

  get audioSeconds(): number {
    return this.bytes / 2 / SAMPLE_RATE;
  }

  open(): Promise<void> {
    const url = new URL('wss://api.elevenlabs.io/v1/speech-to-text/realtime');
    url.searchParams.set('model_id', this.opts.modelId);
    url.searchParams.set('audio_format', 'pcm_16000');
    url.searchParams.set('commit_strategy', this.opts.commitStrategy);
    if (this.opts.commitStrategy === 'vad') url.searchParams.set('vad_silence_threshold_secs', String(this.opts.vadSilenceSecs));
    if (this.opts.languageCode) url.searchParams.set('language_code', this.opts.languageCode);
    assertAllowedUrl(url.toString(), ['wss:']);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (err?: ProviderError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => {
        const err = new ProviderError('timeout', userMessage('timeout', 'elevenlabs'), 'elevenlabs');
        this.fail(err);
        settle(err);
      }, 10000);

      const ws = new this.WS(url, { headers: { 'xi-api-key': this.apiKey }, handshakeTimeout: 8000, maxPayload: 4 * 1024 * 1024 });
      this.ws = ws;
      ws.on('unexpected-response', (_req, res) => {
        let body = '';
        res.on('data', (d: Buffer) => {
          if (body.length < 2000) body += d.toString('utf8');
        });
        res.on('end', () => {
          const err = classifyHttp(res.statusCode ?? 0, body, 'elevenlabs');
          this.fail(err);
          settle(err);
        });
      });
      ws.on('error', (e) => {
        const err = classifyThrown(e, 'elevenlabs');
        this.fail(err);
        settle(err);
      });
      ws.on('close', () => {
        this.ready = false;
        if (!settled) settle(new ProviderError('network', userMessage('network', 'elevenlabs'), 'elevenlabs'));
        if (!this.closedByUs && !this.failed) this.opts.handlers.onError(new ProviderError('network', 'Speech recognition connection closed unexpectedly.', 'elevenlabs'));
        this.opts.handlers.onClosed();
      });
      ws.on('message', (raw) => {
        let msg: { message_type?: string; text?: string; error?: string };
        try {
          msg = JSON.parse(raw.toString()) as typeof msg;
        } catch {
          return;
        }
        const type = msg.message_type ?? '';
        if (type === 'session_started') {
          this.ready = true;
          for (const m of this.pending) this.rawSend(m);
          this.pending = [];
          settle();
          return;
        }
        if (type === 'partial_transcript') return this.opts.handlers.onPartial(msg.text ?? '');
        if (type === 'committed_transcript') return this.opts.handlers.onCommitted(msg.text ?? '');
        if (type === 'insufficient_audio_activity') return this.opts.handlers.onNoSpeech();
        if (type === 'commit_throttled' || type.endsWith('_with_timestamps') || type === 'committed_transcript_entities') return;
        const code = ERROR_MAP[type];
        if (code) {
          const err = new ProviderError(code, type === 'unaccepted_terms' ? 'Accept the ElevenLabs speech-to-text terms in your ElevenLabs dashboard, then retry.' : userMessage(code, 'elevenlabs'), 'elevenlabs');
          this.fail(err);
          settle(err);
        }
      });
    });
  }

  sendAudio(pcm: Uint8Array): void {
    if (this.closedByUs || this.failed) return;
    this.bytes += pcm.byteLength;
    const msg = JSON.stringify({
      message_type: 'input_audio_chunk',
      audio_base_64: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64'),
      commit: false,
      sample_rate: SAMPLE_RATE,
    });
    if (!this.ready) {
      this.pending.push(msg);
      if (this.pending.length > MAX_PENDING) this.pending.shift();
      return;
    }
    this.rawSend(msg);
  }

  commit(): void {
    const msg = JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: '', commit: true, sample_rate: SAMPLE_RATE });
    if (!this.ready) this.pending.push(msg);
    else this.rawSend(msg);
  }

  close(): void {
    this.closedByUs = true;
    this.pending = [];
    const ws = this.ws;
    this.ws = null;
    if (ws && (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING)) {
      try {
        ws.close(1000);
      } catch {
        ws.terminate();
      }
    }
  }

  private rawSend(msg: string): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) return; // drop under backpressure rather than grow unbounded
    ws.send(msg);
  }

  private fail(err: ProviderError): void {
    if (this.failed || this.closedByUs) return;
    this.failed = true;
    this.opts.handlers.onError(err);
    this.close();
  }
}

/** Demo-mode STT: emits a canned transcript locally. Microphone audio never leaves the computer. */
export class DemoStt implements SttSession {
  private bytes = 0;
  private open_ = false;
  private committed = false;
  private partialSent = false;
  constructor(private readonly opts: SttOptions) {}
  get audioSeconds(): number {
    return this.bytes / 2 / SAMPLE_RATE;
  }
  async open(): Promise<void> {
    this.open_ = true;
  }
  sendAudio(pcm: Uint8Array): void {
    if (!this.open_ || this.committed) return;
    this.bytes += pcm.byteLength;
    if (!this.partialSent && this.audioSeconds > 0.6) {
      this.partialSent = true;
      this.opts.handlers.onPartial('(demo) hearing you');
    }
    if (this.opts.commitStrategy === 'vad' && this.audioSeconds > 3) this.commit();
  }
  commit(): void {
    if (this.committed) return;
    this.committed = true;
    setTimeout(() => this.opts.handlers.onCommitted('This is a demo transcript, no audio left this computer.'), 150);
  }
  close(): void {
    this.open_ = false;
  }
}
