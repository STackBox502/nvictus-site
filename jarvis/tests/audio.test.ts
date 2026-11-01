import { describe, expect, it } from 'vitest';
import { TtsQueue, type TtsSink } from '../src/main/ttsQueue';
import type { TtsClient, TtsRequest } from '../src/main/speech/tts';
import { PlaybackScheduler, int16leToFloat32, type PlaybackSink, type ScheduledSource } from '../src/renderer/src/audio/playback';
import { ProviderError } from '../src/shared/errors';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Fake TTS: each chunk yields 2 PCM pieces; per-text delays let later chunks finish first. */
class FakeTts implements TtsClient {
  readonly sampleRate = 24000;
  readonly live = true;
  calls: string[] = [];
  constructor(private readonly delays: Record<string, number> = {}, private readonly failOn?: string) {}
  async synthesize(req: TtsRequest, onAudio: (pcm: Uint8Array) => void) {
    this.calls.push(req.text);
    const id = req.text.charCodeAt(0);
    await tick(this.delays[req.text] ?? 1);
    if (req.signal.aborted) throw new DOMException('aborted', 'AbortError');
    if (req.text === this.failOn) throw new ProviderError('credits', 'no credits', 'elevenlabs');
    onAudio(new Uint8Array([id, 0, id, 0, id])); // odd length on purpose
    await tick(1);
    if (req.signal.aborted) throw new DOMException('aborted', 'AbortError');
    onAudio(new Uint8Array([0, id, 0]));
    return { chars: req.text.length };
  }
}

function recorder() {
  const log: Array<{ seq: number; bytes: number[]; done: boolean } | { end: number }> = [];
  const sink: TtsSink = {
    pcm: (_t, seq, data, done) => log.push({ seq, bytes: [...data], done }),
    end: (_t, total) => log.push({ end: total }),
  };
  return { log, sink };
}

const events = () => ({ firsts: 0, failed: [] as string[], chars: 0 });

describe('TTS queue', () => {
  it('delivers audio strictly in order even when later chunks finish first, with even byte alignment', async () => {
    const { log, sink } = recorder();
    const ev = events();
    const q = new TtsQueue(1, new FakeTts({ A: 30, B: 1, C: 1 }), sink, { onFirstAudio: () => ev.firsts++, onFailed: () => undefined, onChars: (_t, c) => (ev.chars += c) });
    q.enqueue('A');
    q.enqueue('B');
    q.enqueue('C');
    q.finish();
    for (let i = 0; i < 100 && !log.some((l) => 'end' in l); i++) await tick(5);
    const seqOrder = log.filter((l): l is { seq: number; bytes: number[]; done: boolean } => 'seq' in l).map((l) => l.seq);
    expect(seqOrder).toEqual([...seqOrder].sort((a, b) => a - b));
    expect(log.at(-1)).toEqual({ end: 3 });
    for (const l of log) if ('bytes' in l) expect(l.bytes.length % 2).toBe(0);
    const total = log.reduce((n, l) => n + ('bytes' in l ? l.bytes.length : 0), 0);
    expect(total).toBe(3 * 8);
    expect(ev.firsts).toBe(1);
    expect(ev.chars).toBe(3);
  });
  it('limits in-flight requests (bounded lookahead)', async () => {
    const tts = new FakeTts({ A: 40, B: 40, C: 40, D: 40 });
    const q = new TtsQueue(1, tts, recorder().sink, { onFirstAudio: () => undefined, onFailed: () => undefined, onChars: () => undefined }, 2);
    ['A', 'B', 'C', 'D'].forEach((t) => q.enqueue(t));
    await tick(5);
    expect(tts.calls).toEqual(['A', 'B']);
    q.cancel();
  });
  it('cancel guarantees no further sink calls', async () => {
    const { log, sink } = recorder();
    const q = new TtsQueue(1, new FakeTts({ A: 20 }), sink, { onFirstAudio: () => undefined, onFailed: () => undefined, onChars: () => undefined });
    q.enqueue('A');
    q.finish();
    q.cancel();
    await tick(60);
    expect(log).toEqual([]);
  });
  it('reports failure once, keeps delivered audio, and ends the stream', async () => {
    const { log, sink } = recorder();
    const failures: string[] = [];
    const q = new TtsQueue(1, new FakeTts({}, 'B'), sink, { onFirstAudio: () => undefined, onFailed: (_t, _s, e) => failures.push(e.code), onChars: () => undefined });
    q.enqueue('A');
    q.enqueue('B');
    q.enqueue('C');
    q.finish();
    for (let i = 0; i < 100 && !log.some((l) => 'end' in l); i++) await tick(5);
    expect(failures).toEqual(['credits']);
    expect(log.at(-1)).toMatchObject({ end: expect.any(Number) });
  });
});

/** Fake audio clock + sources for the renderer playback scheduler. */
class FakeSink implements PlaybackSink {
  t = 0;
  scheduled: Array<{ when: number; dur: number; src: ScheduledSource & { stopped: boolean } }> = [];
  now() {
    return this.t;
  }
  outputLatency() {
    return 0.02;
  }
  play(samples: Float32Array, rate: number, when: number) {
    const src = { stopped: false, onended: null as (() => void) | null, stop() { this.stopped = true; } };
    this.scheduled.push({ when, dur: samples.length / rate, src });
    return src;
  }
  advance(to: number) {
    this.t = to;
    for (const s of this.scheduled) {
      if (!s.src.stopped && s.when + s.dur <= to && s.src.onended) {
        const fn = s.src.onended;
        s.src.onended = null;
        fn();
      }
    }
  }
}

function pcm(samples: number) {
  return new Uint8Array(samples * 2);
}

describe('playback scheduler', () => {
  const setup = () => {
    const sink = new FakeSink();
    const ev = { started: [] as number[], played: [] as string[], drained: [] as number[] };
    const timers: Array<() => void> = [];
    const sched = new PlaybackScheduler(
      sink,
      { started: (t) => ev.started.push(t), chunkPlayed: (t, s) => ev.played.push(`${t}:${s}`), drained: (t) => ev.drained.push(t) },
      0.05,
      (fn) => timers.push(fn),
      () => undefined,
    );
    return { sink, ev, sched, fireTimers: () => timers.splice(0).forEach((f) => f()) };
  };

  it('schedules pieces back-to-back without gaps', () => {
    const { sink, sched } = setup();
    sched.push(1, 0, 24000, pcm(2400), false);
    sched.push(1, 0, 24000, pcm(2400), true);
    sched.push(1, 1, 24000, pcm(4800), true);
    const [a, b, c] = sink.scheduled;
    expect(a!.when).toBeCloseTo(0.05);
    expect(b!.when).toBeCloseTo(a!.when + 0.1);
    expect(c!.when).toBeCloseTo(b!.when + 0.1);
  });
  it('fires started, chunkPlayed per completed seq, and drained after end-of-stream', () => {
    const { sink, sched, ev, fireTimers } = setup();
    sched.push(1, 0, 24000, pcm(2400), true);
    sched.push(1, 1, 24000, pcm(2400), true);
    fireTimers();
    expect(ev.started).toEqual([1]);
    sink.advance(0.16);
    expect(ev.played).toEqual(['1:0']);
    sched.end(1, 2);
    expect(ev.drained).toEqual([]);
    sink.advance(1);
    expect(ev.played).toEqual(['1:0', '1:1']);
    expect(ev.drained).toEqual([1]);
  });
  it('stop silences immediately and late chunks from the stopped turn never play', () => {
    const { sink, sched, ev } = setup();
    sched.push(3, 0, 24000, pcm(24000), false);
    sched.stop(3);
    expect(sink.scheduled[0]!.src.stopped).toBe(true);
    sched.push(3, 0, 24000, pcm(2400), true);
    sched.push(2, 0, 24000, pcm(2400), true);
    expect(sink.scheduled).toHaveLength(1);
    sched.push(4, 0, 24000, pcm(2400), true);
    expect(sink.scheduled).toHaveLength(2);
    expect(ev.played).toEqual([]);
  });
  it('a newer turn replaces an older one', () => {
    const { sink, sched } = setup();
    sched.push(5, 0, 24000, pcm(24000), false);
    sched.push(6, 0, 24000, pcm(2400), false);
    expect(sink.scheduled[0]!.src.stopped).toBe(true);
    expect(sched.currentTurn).toBe(6);
  });
  it('end with no audio drains immediately', () => {
    const { sched, ev } = setup();
    sched.end(7, 0);
    expect(ev.drained).toEqual([7]);
  });
  it('decodes little-endian int16 PCM', () => {
    const f = int16leToFloat32(new Uint8Array([0x00, 0x40, 0x00, 0xc0, 0xff, 0x7f]));
    expect(f[0]).toBeCloseTo(0.5);
    expect(f[1]).toBeCloseTo(-0.5);
    expect(f[2]).toBeCloseTo(32767 / 32768);
  });
});
