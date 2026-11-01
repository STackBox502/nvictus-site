import { classifyThrown, type ProviderError } from '../shared/errors';
import type { TtsClient } from './speech/tts';

export interface TtsSink {
  pcm(turnId: number, seq: number, data: Uint8Array, seqDone: boolean): void;
  end(turnId: number, totalSeqs: number): void;
}

export interface TtsQueueEvents {
  onFirstAudio(turnId: number): void;
  onFailed(turnId: number, seq: number, err: ProviderError): void;
  onChars(turnId: number, chars: number): void;
}

interface Chunk {
  seq: number;
  text: string;
  state: 'pending' | 'running' | 'done' | 'failed';
  buffered: Uint8Array[];
  carry: number | null;
  abort: AbortController;
}

/**
 * Ordered TTS for one turn. Up to `maxInFlight` chunk requests run concurrently (lookahead), but
 * audio is delivered strictly in order: the current chunk streams live; later chunks buffer until
 * their turn. Cancel aborts everything and guarantees no further sink calls.
 */
export class TtsQueue {
  private readonly chunks: Chunk[] = [];
  private current = 0;
  private finished = false;
  private cancelled = false;
  private failed = false;
  private ended = false;
  private firstAudio = false;
  private delivered = 0;

  constructor(
    readonly turnId: number,
    private readonly tts: TtsClient,
    private readonly sink: TtsSink,
    private readonly events: TtsQueueEvents,
    private readonly maxInFlight = 2,
  ) {}

  get sampleRate(): number {
    return this.tts.sampleRate;
  }

  enqueue(text: string): void {
    if (this.cancelled || this.failed || this.finished) return;
    this.chunks.push({ seq: this.chunks.length, text, state: 'pending', buffered: [], carry: null, abort: new AbortController() });
    this.pump();
  }

  finish(): void {
    this.finished = true;
    this.maybeEnd();
  }

  cancel(): void {
    this.cancelled = true;
    for (const c of this.chunks) c.abort.abort();
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  private pump(): void {
    if (this.cancelled || this.failed) return;
    let running = this.chunks.filter((c) => c.state === 'running').length;
    for (let i = this.current; i < this.chunks.length && i < this.current + this.maxInFlight; i++) {
      const c = this.chunks[i]!;
      if (c.state !== 'pending') continue;
      if (running >= this.maxInFlight) break;
      running++;
      c.state = 'running';
      void this.run(c);
    }
  }

  private async run(c: Chunk): Promise<void> {
    const prev = this.chunks[c.seq - 1]?.text;
    const next = this.chunks[c.seq + 1]?.text;
    try {
      const { chars } = await this.tts.synthesize({ text: c.text, signal: c.abort.signal, previousText: prev, nextText: next }, (data) => this.onAudio(c, data));
      if (this.cancelled) return;
      this.events.onChars(this.turnId, chars);
      c.state = 'done';
    } catch (err) {
      if (this.cancelled) return;
      c.state = 'failed';
      if (!this.failed) {
        this.failed = true;
        for (const other of this.chunks) if (other !== c) other.abort.abort();
        this.events.onFailed(this.turnId, c.seq, classifyThrown(err, this.tts.live ? 'elevenlabs' : 'demo'));
      }
    }
    this.advance();
  }

  private align(c: Chunk, data: Uint8Array): Uint8Array {
    let bytes = data;
    if (c.carry !== null) {
      const merged = new Uint8Array(bytes.byteLength + 1);
      merged[0] = c.carry;
      merged.set(bytes, 1);
      bytes = merged;
      c.carry = null;
    }
    if (bytes.byteLength % 2 === 1) {
      c.carry = bytes[bytes.byteLength - 1]!;
      bytes = bytes.subarray(0, bytes.byteLength - 1);
    }
    return bytes;
  }

  private onAudio(c: Chunk, raw: Uint8Array): void {
    if (this.cancelled) return;
    const data = this.align(c, raw);
    if (!data.byteLength) return;
    if (c.seq === this.current) this.emit(c, data, false);
    else c.buffered.push(data);
  }

  private emit(c: Chunk, data: Uint8Array, seqDone: boolean): void {
    if (this.cancelled) return;
    if (!this.firstAudio && data.byteLength) {
      this.firstAudio = true;
      this.events.onFirstAudio(this.turnId);
    }
    this.sink.pcm(this.turnId, c.seq, data, seqDone);
  }

  private advance(): void {
    if (this.cancelled) return;
    while (this.current < this.chunks.length) {
      const c = this.chunks[this.current]!;
      if (c.state !== 'done') break;
      this.emit(c, new Uint8Array(0), true);
      this.delivered++;
      this.current++;
      const nextChunk = this.chunks[this.current];
      if (nextChunk) {
        for (const b of nextChunk.buffered) this.emit(nextChunk, b, false);
        nextChunk.buffered = [];
      }
    }
    this.pump();
    this.maybeEnd();
  }

  private maybeEnd(): void {
    if (this.ended || this.cancelled) return;
    const allDone = this.finished && this.current >= this.chunks.length;
    if (allDone || this.failed) {
      if (this.failed && this.chunks.some((c) => c.state === 'running')) return;
      this.ended = true;
      this.sink.end(this.turnId, this.delivered);
    }
  }
}
