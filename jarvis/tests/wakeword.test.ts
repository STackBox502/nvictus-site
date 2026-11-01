import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { PythonWakeService, Reframer, WAKE_FRAME_BYTES, encodeFrame, parseHelperLine } from '../src/main/wakeword';

describe('wake-word protocol', () => {
  it('encodes length-prefixed frames and re-frames to 80 ms', () => {
    const f = encodeFrame(new Uint8Array([1, 2, 3, 4]));
    expect([...f]).toEqual([4, 0, 0, 0, 1, 2, 3, 4]);
    const r = new Reframer();
    expect(r.push(new Uint8Array(3200))).toHaveLength(1);
    expect(r.push(new Uint8Array(3200))).toHaveLength(1);
    expect(r.push(new Uint8Array(WAKE_FRAME_BYTES))[0]!.byteLength).toBe(WAKE_FRAME_BYTES);
  });
  it('parses only whitelisted helper messages', () => {
    expect(parseHelperLine('{"type":"detect","model":"hey_jarvis","score":0.91}')).toEqual({ type: 'detect', model: 'hey_jarvis', score: 0.91 });
    expect(parseHelperLine('{"type":"detect","score":7}')).toBeNull();
    expect(parseHelperLine('{"type":"exec","cmd":"rm -rf /"}')).toBeNull();
    expect(parseHelperLine('not json')).toBeNull();
    expect(parseHelperLine('x'.repeat(5000))).toBeNull();
  });
});

class FakeProc extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  written: Buffer[] = [];
  killed = false;
  constructor() {
    super();
    this.stdin.on('data', (d: Buffer) => this.written.push(d));
  }
  kill() {
    this.killed = true;
    this.emit('exit', null);
    return true;
  }
}

describe('wake-word supervisor', () => {
  it('reports unavailable when the runtime is missing', () => {
    const svc = new PythonWakeService({ pythonPath: 'C:/missing/python.exe', helperPath: 'helper.py', threshold: 0.5, model: 'hey_jarvis' }, () => undefined, undefined, () => false);
    expect(svc.status().state).toBe('unavailable');
    svc.start();
    expect(svc.status().state).toBe('unavailable');
  });
  it('spawns without a shell, becomes ready, forwards detections, and feeds framed PCM', async () => {
    const procs: FakeProc[] = [];
    const calls: Array<{ cmd: string; args: string[]; opts: { shell?: boolean } }> = [];
    const svc = new PythonWakeService(
      { pythonPath: '/py', helperPath: '/helper.py', threshold: 0.6, model: 'hey_jarvis' },
      () => undefined,
      ((cmd: string, args: string[], opts: { shell?: boolean }) => {
        calls.push({ cmd, args, opts });
        const p = new FakeProc();
        procs.push(p);
        return p;
      }) as never,
      () => true,
    );
    const wakes: number[] = [];
    svc.onWake((s) => wakes.push(s));
    svc.start();
    expect(calls[0]).toMatchObject({ cmd: '/py', args: ['/helper.py', '--threshold', '0.6', '--model', 'hey_jarvis'], opts: { shell: false } });
    svc.feed(new Uint8Array(3200)); // not ready yet → ignored
    procs[0]!.stdout.write('{"type":"ready","models":["hey_jarvis"]}\n');
    await new Promise((r) => setTimeout(r, 5));
    expect(svc.status().state).toBe('ready');
    svc.feed(new Uint8Array(3200));
    await new Promise((r) => setTimeout(r, 5));
    const total = procs[0]!.written.reduce((n, b) => n + b.byteLength, 0);
    expect(total).toBe(4 + WAKE_FRAME_BYTES);
    procs[0]!.stdout.write('{"type":"detect","model":"hey_jarvis","score":0.8}\n{"type":"bogus"}\n');
    await new Promise((r) => setTimeout(r, 5));
    expect(wakes).toEqual([0.8]);
    svc.stop();
    procs[0]!.emit('exit', 0);
    expect(svc.status().state).toBe('stopped');
  });
});
