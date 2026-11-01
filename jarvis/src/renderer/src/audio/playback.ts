// Gap-free, cancellable PCM playback scheduling. Pure logic over an injectable sink so it can be
// tested with a fake audio clock.

export interface ScheduledSource {
  stop(): void;
  onended: (() => void) | null;
}

export interface PlaybackSink {
  now(): number;
  outputLatency(): number;
  play(samples: Float32Array, sampleRate: number, when: number): ScheduledSource;
}

export interface PlaybackEvents {
  started(turnId: number): void;
  chunkPlayed(turnId: number, seq: number): void;
  drained(turnId: number): void;
}

export function int16leToFloat32(data: Uint8Array): Float32Array {
  const n = Math.floor(data.byteLength / 2);
  const view = new DataView(data.buffer, data.byteOffset, n * 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

type TimerFn = (fn: () => void, ms: number) => unknown;
type ClearFn = (id: unknown) => void;

export class PlaybackScheduler {
  private turnId = -1;
  private minTurn = 0;
  private nextTime = 0;
  private readonly active = new Set<ScheduledSource>();
  private readonly lastSourceOfSeq = new Map<number, ScheduledSource>();
  private readonly doneSeqs = new Set<number>();
  private readonly playedSeqs = new Set<number>();
  private startedFired = false;
  private drainedFired = false;
  private endOfStream = false;
  private timers: unknown[] = [];

  constructor(
    private readonly sink: PlaybackSink,
    private readonly events: PlaybackEvents,
    private readonly leadSec = 0.06,
    private readonly setTimer: TimerFn = (fn, ms) => setTimeout(fn, ms),
    private readonly clearTimer: ClearFn = (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  ) {}

  get currentTurn(): number {
    return this.turnId;
  }

  /** Accepts PCM for a turn. Data for stopped/older turns is discarded (late chunks never resume). */
  push(turnId: number, seq: number, sampleRate: number, data: Uint8Array, seqDone: boolean): void {
    if (turnId < this.minTurn || turnId < this.turnId) return;
    if (turnId !== this.turnId) this.reset(turnId);
    if (data.byteLength >= 2) {
      const samples = int16leToFloat32(data);
      const now = this.sink.now();
      const when = Math.max(this.nextTime, now + this.leadSec);
      const src = this.sink.play(samples, sampleRate, when);
      this.nextTime = when + samples.length / sampleRate;
      this.active.add(src);
      this.lastSourceOfSeq.set(seq, src);
      src.onended = () => {
        this.active.delete(src);
        this.onEnded(turnId, seq, src);
      };
      if (!this.startedFired) {
        this.startedFired = true;
        const delayMs = Math.max(0, (when - now + this.sink.outputLatency()) * 1000);
        this.timers.push(
          this.setTimer(() => {
            if (this.turnId === turnId) this.events.started(turnId);
          }, delayMs),
        );
      }
    }
    if (seqDone) {
      this.doneSeqs.add(seq);
      const last = this.lastSourceOfSeq.get(seq);
      if (!last || !this.active.has(last)) this.markPlayed(turnId, seq);
    }
  }

  end(turnId: number, _totalSeqs: number): void {
    if (turnId < this.minTurn || turnId < this.turnId) return;
    if (turnId !== this.turnId) this.reset(turnId);
    this.endOfStream = true;
    this.checkDrained();
  }

  /** Immediately silences everything at or before `turnId` and rejects its late chunks. */
  stop(turnId: number): void {
    this.minTurn = Math.max(this.minTurn, turnId + 1);
    if (this.turnId <= turnId) this.silence();
  }

  isPlaying(): boolean {
    return this.active.size > 0;
  }

  private markPlayed(turnId: number, seq: number): void {
    if (this.playedSeqs.has(seq)) return;
    this.playedSeqs.add(seq);
    this.events.chunkPlayed(turnId, seq);
  }

  private onEnded(turnId: number, seq: number, src: ScheduledSource): void {
    if (turnId !== this.turnId) return;
    if (this.doneSeqs.has(seq) && this.lastSourceOfSeq.get(seq) === src) this.markPlayed(turnId, seq);
    this.checkDrained();
  }

  private checkDrained(): void {
    if (this.endOfStream && this.active.size === 0 && !this.drainedFired) {
      this.drainedFired = true;
      this.events.drained(this.turnId);
    }
  }

  private silence(): void {
    for (const src of this.active) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
    }
    this.active.clear();
    for (const t of this.timers) this.clearTimer(t);
    this.timers = [];
    this.nextTime = 0;
  }

  private reset(turnId: number): void {
    this.silence();
    this.turnId = turnId;
    this.lastSourceOfSeq.clear();
    this.doneSeqs.clear();
    this.playedSeqs.clear();
    this.startedFired = false;
    this.drainedFired = false;
    this.endOfStream = false;
  }
}
