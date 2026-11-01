import { ProviderError, classifyHttp, classifyThrown, userMessage } from '../../shared/errors';
import { readErrorText, type FetchFn } from '../providers/types';

export interface TtsRequest {
  text: string;
  signal: AbortSignal;
  previousText?: string;
  nextText?: string;
}

export interface TtsClient {
  readonly sampleRate: number;
  readonly live: boolean;
  /** Streams raw 16-bit little-endian mono PCM to `onAudio`. Resolves when the stream completes. */
  synthesize(req: TtsRequest, onAudio: (pcm: Uint8Array) => void): Promise<{ chars: number }>;
}

export interface TtsConfig {
  apiKey: string;
  voiceId: string;
  modelId: string;
  outputFormat: 'pcm_16000' | 'pcm_22050' | 'pcm_24000';
  stability: number;
  similarityBoost: number;
  style: number;
  speed: number;
  useSpeakerBoost: boolean;
  languageCode: string;
  canUseStyle: boolean;
  canUseSpeakerBoost: boolean;
}

export const sampleRateOf = (fmt: TtsConfig['outputFormat']): number => Number(fmt.split('_')[1]);

/**
 * ElevenLabs HTTP streaming TTS, one request per speech-sized chunk, raw PCM output.
 * PCM is decoded trivially in the renderer (Int16 → Float32 AudioBuffer), so no compressed-frame
 * boundary problems exist when chunks are scheduled back-to-back.
 */
export class ElevenLabsTts implements TtsClient {
  readonly live = true;
  constructor(
    private readonly cfg: TtsConfig,
    private readonly fetchFn: FetchFn,
  ) {}

  get sampleRate(): number {
    return sampleRateOf(this.cfg.outputFormat);
  }

  async synthesize(req: TtsRequest, onAudio: (pcm: Uint8Array) => void): Promise<{ chars: number }> {
    const c = this.cfg;
    if (!c.apiKey) throw new ProviderError('not_configured', userMessage('not_configured', 'elevenlabs'), 'elevenlabs');
    if (!c.voiceId) throw new ProviderError('invalid_voice', 'No ElevenLabs voice selected. Choose one in Setup.', 'elevenlabs');
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(c.voiceId)}/stream?output_format=${c.outputFormat}`;
    const voice_settings: Record<string, number | boolean> = { stability: c.stability, similarity_boost: c.similarityBoost, speed: c.speed };
    if (c.canUseStyle) voice_settings.style = c.style;
    if (c.canUseSpeakerBoost) voice_settings.use_speaker_boost = c.useSpeakerBoost;
    const body: Record<string, unknown> = { text: req.text, model_id: c.modelId, voice_settings };
    if (req.previousText) body.previous_text = req.previousText.slice(-500);
    if (req.nextText) body.next_text = req.nextText.slice(0, 500);
    if (c.languageCode) body.language_code = c.languageCode;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'xi-api-key': c.apiKey, 'content-type': 'application/json', accept: 'audio/pcm' },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      throw classifyThrown(err, 'elevenlabs');
    }
    if (!res.ok) throw classifyHttp(res.status, await readErrorText(res), 'elevenlabs');
    if (!res.body) throw new ProviderError('malformed', 'ElevenLabs returned no audio.', 'elevenlabs');
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value?.byteLength) onAudio(value);
      }
    } catch (err) {
      throw classifyThrown(err, 'elevenlabs');
    } finally {
      reader.cancel().catch(() => undefined);
    }
    return { chars: req.text.length };
  }
}

/**
 * Demo-mode TTS: a soft synthesized tone shaped like syllables so the speaking glow has real audio
 * to follow. Clearly not a voice. No network.
 */
export class DemoTts implements TtsClient {
  readonly live = false;
  readonly sampleRate = 24000;
  async synthesize(req: TtsRequest, onAudio: (pcm: Uint8Array) => void): Promise<{ chars: number }> {
    const seconds = Math.min(6, Math.max(0.5, req.text.length * 0.055));
    const total = Math.floor(seconds * this.sampleRate);
    const piece = Math.floor(this.sampleRate / 10);
    for (let start = 0; start < total; start += piece) {
      if (req.signal.aborted) throw new DOMException('aborted', 'AbortError');
      const n = Math.min(piece, total - start);
      const buf = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        const t = (start + i) / this.sampleRate;
        const syllable = Math.pow(Math.abs(Math.sin(Math.PI * 3.2 * t)), 1.5);
        const fade = Math.min(1, t / 0.05, (seconds - t) / 0.08);
        const v = (Math.sin(2 * Math.PI * 196 * t) * 0.6 + Math.sin(2 * Math.PI * 294 * t) * 0.25) * syllable * fade * 0.18;
        buf[i] = Math.max(-1, Math.min(1, v)) * 32767;
      }
      onAudio(new Uint8Array(buf.buffer));
      await new Promise((r) => setTimeout(r, 15));
    }
    return { chars: req.text.length };
  }
}
