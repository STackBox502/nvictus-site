import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { WakeStatus } from '../shared/types';

/** openWakeWord expects 80 ms frames: 1280 samples of 16 kHz int16 = 2560 bytes. */
export const WAKE_FRAME_BYTES = 2560;
export const MAX_HELPER_LINE = 4096;

/** Length-prefixed binary frame: 4-byte little-endian length + PCM bytes. Length 0 = shutdown. */
export function encodeFrame(pcm: Uint8Array): Buffer {
  const out = Buffer.alloc(4 + pcm.byteLength);
  out.writeUInt32LE(pcm.byteLength, 0);
  out.set(pcm, 4);
  return out;
}

/** Re-frames arbitrary PCM pieces into exact 2560-byte frames. */
export class Reframer {
  private buf = Buffer.alloc(0);
  push(pcm: Uint8Array): Buffer[] {
    this.buf = Buffer.concat([this.buf, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
    const frames: Buffer[] = [];
    while (this.buf.byteLength >= WAKE_FRAME_BYTES) {
      frames.push(this.buf.subarray(0, WAKE_FRAME_BYTES));
      this.buf = this.buf.subarray(WAKE_FRAME_BYTES);
    }
    return frames;
  }
  reset(): void {
    this.buf = Buffer.alloc(0);
  }
}

export type HelperMessage =
  | { type: 'ready'; models: string[] }
  | { type: 'detect'; model: string; score: number }
  | { type: 'selftest'; ok: boolean; max_score_silence?: number; models?: string[] }
  | { type: 'error'; message: string };

/** Strictly parses one JSON line from the helper; anything unexpected is ignored. */
export function parseHelperLine(line: string): HelperMessage | null {
  if (!line || line.length > MAX_HELPER_LINE) return null;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (v.type) {
    case 'ready':
      return { type: 'ready', models: Array.isArray(v.models) ? v.models.filter((m): m is string => typeof m === 'string') : [] };
    case 'detect':
      return typeof v.score === 'number' && v.score >= 0 && v.score <= 1
        ? { type: 'detect', model: String(v.model ?? ''), score: v.score }
        : null;
    case 'selftest':
      return { type: 'selftest', ok: v.ok === true, max_score_silence: typeof v.max_score_silence === 'number' ? v.max_score_silence : undefined };
    case 'error':
      return { type: 'error', message: String(v.message ?? 'unknown').slice(0, 300) };
    default:
      return null;
  }
}

export interface WakeService {
  status(): WakeStatus;
  start(): void;
  stop(): void;
  feed(pcm: Uint8Array): void;
  selfTest(): Promise<{ ok: boolean; detail: string }>;
  onWake(cb: (score: number) => void): void;
  onStatus(cb: (s: WakeStatus) => void): void;
  configure(opts: Partial<WakeOptions>): void;
}

export interface WakeOptions {
  pythonPath: string;
  helperPath: string;
  threshold: number;
  model: string;
}

type SpawnFn = (cmd: string, args: string[], opts: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

/**
 * Supervises the isolated Python wake-word helper. Microphone PCM goes to its stdin only; it can
 * reply only with whitelisted JSON lines. No shell, bounded buffers, bounded restarts.
 */
export class PythonWakeService implements WakeService {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private st: WakeStatus = { state: 'stopped', reason: 'Not started', selfTestPassed: false };
  private wakeCbs: Array<(score: number) => void> = [];
  private statusCbs: Array<(s: WakeStatus) => void> = [];
  private reframer = new Reframer();
  private stdoutBuf = '';
  private stopping = false;
  private restarts: number[] = [];
  private backpressured = false;
  dropped = 0;

  constructor(
    private opts: WakeOptions,
    private readonly log: (code: string, meta?: unknown) => void,
    private readonly spawnFn: SpawnFn = nodeSpawn as unknown as SpawnFn,
    private readonly fileExists: (p: string) => boolean = existsSync,
  ) {
    this.refreshAvailability();
  }

  configure(opts: Partial<WakeOptions>): void {
    const restart = !!this.proc && (opts.pythonPath !== undefined || opts.threshold !== undefined || opts.model !== undefined);
    this.opts = { ...this.opts, ...opts };
    if (restart) {
      this.stop();
      this.start();
    } else if (!this.proc) this.refreshAvailability();
  }

  status(): WakeStatus {
    return { ...this.st };
  }
  onWake(cb: (score: number) => void): void {
    this.wakeCbs.push(cb);
  }
  onStatus(cb: (s: WakeStatus) => void): void {
    this.statusCbs.push(cb);
  }

  private setStatus(next: Partial<WakeStatus>): void {
    this.st = { ...this.st, ...next };
    for (const cb of this.statusCbs) cb(this.status());
  }

  private refreshAvailability(): void {
    if (!this.opts.pythonPath || !this.fileExists(this.opts.pythonPath)) {
      this.setStatus({ state: 'unavailable', reason: 'Wake-word runtime not installed. See SETUP_WINDOWS.md → Hands-free.' });
    } else if (!this.fileExists(this.opts.helperPath)) {
      this.setStatus({ state: 'unavailable', reason: 'Wake-word helper script is missing from the app folder.' });
    } else if (this.st.state === 'unavailable') {
      this.setStatus({ state: 'stopped', reason: 'Ready to start' });
    }
  }

  private args(extra: string[] = []): string[] {
    return [this.opts.helperPath, '--threshold', String(this.opts.threshold), '--model', this.opts.model, ...extra];
  }

  start(): void {
    if (this.proc) return;
    this.refreshAvailability();
    if (this.st.state === 'unavailable') return;
    this.stopping = false;
    this.reframer.reset();
    this.setStatus({ state: 'starting', reason: 'Loading local wake-word model…' });
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = this.spawnFn(this.opts.pythonPath, this.args(), { stdio: 'pipe', windowsHide: true, shell: false, env: { PYTHONUNBUFFERED: '1', PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '' } });
    } catch (err) {
      this.setStatus({ state: 'error', reason: `Could not start helper: ${(err as Error).message}` });
      return;
    }
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    proc.stderr.on('data', (d: Buffer) => this.log('wake.stderr', d.toString('utf8').slice(0, 300)));
    proc.stdin.on('error', () => undefined);
    proc.stdin.on('drain', () => {
      this.backpressured = false;
    });
    proc.on('error', (err) => this.setStatus({ state: 'error', reason: `Helper failed: ${err.message}` }));
    proc.on('exit', (code) => {
      this.proc = null;
      if (this.stopping) {
        this.setStatus({ state: 'stopped', reason: 'Stopped' });
        return;
      }
      const now = Date.now();
      this.restarts = this.restarts.filter((t) => now - t < 60000);
      if (this.restarts.length >= 3) {
        this.setStatus({ state: 'error', reason: `Wake helper exited repeatedly (code ${code}). Hands-free disabled; check SETUP_WINDOWS.md.` });
        return;
      }
      this.restarts.push(now);
      this.log('wake.restart', { code });
      setTimeout(() => this.start(), 1000 * this.restarts.length);
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    if (this.stdoutBuf.length > MAX_HELPER_LINE * 4) this.stdoutBuf = '';
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) !== -1) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      const msg = parseHelperLine(line);
      if (!msg) continue;
      if (msg.type === 'ready') this.setStatus({ state: 'ready', reason: `Local model loaded (${msg.models.join(', ') || this.opts.model})` });
      else if (msg.type === 'detect') for (const cb of this.wakeCbs) cb(msg.score);
      else if (msg.type === 'error') this.setStatus({ state: 'error', reason: msg.message });
    }
  }

  feed(pcm: Uint8Array): void {
    const proc = this.proc;
    if (!proc || this.st.state !== 'ready' || !proc.stdin.writable) return;
    for (const frame of this.reframer.push(pcm)) {
      if (this.backpressured) {
        this.dropped++;
        continue;
      }
      if (!proc.stdin.write(encodeFrame(frame))) this.backpressured = true;
    }
  }

  stop(): void {
    const proc = this.proc;
    if (!proc) return;
    this.stopping = true;
    try {
      proc.stdin.write(encodeFrame(new Uint8Array(0)));
      proc.stdin.end();
    } catch {
      /* ignore */
    }
    const killTimer = setTimeout(() => {
      if (this.proc === proc) proc.kill();
    }, 1500);
    proc.once('exit', () => clearTimeout(killTimer));
  }

  selfTest(): Promise<{ ok: boolean; detail: string }> {
    this.refreshAvailability();
    if (this.st.state === 'unavailable') return Promise.resolve({ ok: false, detail: this.st.reason });
    return new Promise((resolve) => {
      let out = '';
      let done = false;
      const finish = (r: { ok: boolean; detail: string }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.setStatus({ selfTestPassed: r.ok });
        resolve(r);
      };
      let proc: ChildProcessWithoutNullStreams;
      try {
        proc = this.spawnFn(this.opts.pythonPath, this.args(['--self-test']), { stdio: 'pipe', windowsHide: true, shell: false, env: { PYTHONUNBUFFERED: '1', PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '' } });
      } catch (err) {
        finish({ ok: false, detail: (err as Error).message });
        return;
      }
      const timer = setTimeout(() => {
        proc.kill();
        finish({ ok: false, detail: 'Self-test timed out after 60 s.' });
      }, 60000);
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (c: string) => {
        out += c;
        if (out.length > 20000) out = out.slice(-5000);
      });
      proc.stderr.on('data', () => undefined);
      proc.on('error', (err) => finish({ ok: false, detail: err.message }));
      proc.on('exit', () => {
        for (const line of out.split('\n')) {
          const msg = parseHelperLine(line.trim());
          if (msg?.type === 'selftest')
            return finish({
              ok: msg.ok,
              detail: msg.ok ? `Model loaded; silence peak score ${msg.max_score_silence?.toFixed(3) ?? '?'} (should be near 0).` : 'Self-test reported failure.',
            });
          if (msg?.type === 'error') return finish({ ok: false, detail: msg.message });
        }
        finish({ ok: false, detail: 'Helper exited without a self-test result.' });
      });
    });
  }
}
