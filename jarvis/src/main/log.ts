import { appendFileSync, mkdirSync, renameSync, statSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { redact } from '../shared/redact';

export interface LogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  code: string;
}

/**
 * Local, redacted log. Convention: log event codes and metadata only — never conversation text,
 * transcripts, or audio. Telemetry/crash upload does not exist in this app.
 */
export class Logger {
  private readonly recentEntries: LogEntry[] = [];
  constructor(
    private readonly file: string | null,
    private readonly secrets: () => readonly string[] = () => [],
    private readonly maxBytes = 1_000_000,
  ) {
    if (file) mkdirSync(dirname(file), { recursive: true });
  }

  info(code: string, meta?: unknown): void {
    this.write('info', code, meta);
  }
  warn(code: string, meta?: unknown): void {
    this.write('warn', code, meta);
  }
  error(code: string, meta?: unknown): void {
    this.write('error', code, meta);
  }

  recent(): LogEntry[] {
    return [...this.recentEntries];
  }

  private write(level: LogEntry['level'], code: string, meta?: unknown): void {
    const ts = Date.now();
    this.recentEntries.push({ ts, level, code });
    if (this.recentEntries.length > 100) this.recentEntries.shift();
    if (!this.file) return;
    const line = `${new Date(ts).toISOString()} ${level.toUpperCase()} ${code}${meta === undefined ? '' : ' ' + redact(meta, this.secrets()).slice(0, 600)}\n`;
    try {
      if (existsSync(this.file) && statSync(this.file).size > this.maxBytes) renameSync(this.file, `${this.file}.1`);
      appendFileSync(this.file, line);
    } catch {
      /* logging must never crash the app */
    }
  }
}
