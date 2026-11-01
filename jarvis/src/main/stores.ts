import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readJson, writeJson } from './fsutil';
import { applySettingsPatch, loadSettings, resetSettingsKeepingSetup, type Settings, type SettingsResult } from '../shared/settings';
import type { ChatMessage, MemoryRecord, TurnRecord, UsageTotals } from '../shared/types';
import { addTurn, emptyTotals, localDate, summarizeLatency } from '../shared/usage';
import type { UsageSnapshot } from '../shared/types';

export class SettingsStore {
  private current: Settings;
  private listeners: Array<(next: Settings, prev: Settings) => void> = [];
  constructor(private readonly file: string) {
    this.current = loadSettings(readJson(file));
  }
  get(): Settings {
    return this.current;
  }
  update(patch: unknown): SettingsResult {
    const res = applySettingsPatch(this.current, patch);
    if (res.ok) this.commit(res.settings);
    return res;
  }
  reset(): Settings {
    this.commit(resetSettingsKeepingSetup(this.current));
    return this.current;
  }
  onChange(fn: (next: Settings, prev: Settings) => void): void {
    this.listeners.push(fn);
  }
  private commit(next: Settings): void {
    const prev = this.current;
    writeJson(this.file, next);
    this.current = next;
    for (const fn of this.listeners) fn(next, prev);
  }
}

/** Explicit, user-inspectable saved memories. Writes are synchronous so acknowledgement follows persistence. */
export class MemoryStore {
  private items: MemoryRecord[];
  constructor(private readonly file: string) {
    const raw = readJson(file);
    this.items = Array.isArray(raw)
      ? raw.filter((m): m is MemoryRecord => !!m && typeof m.id === 'string' && typeof m.text === 'string').slice(0, 500)
      : [];
  }
  list(): MemoryRecord[] {
    return [...this.items];
  }
  add(text: string): MemoryRecord {
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!clean) throw new Error('Memory text is empty.');
    const now = Date.now();
    const rec: MemoryRecord = { id: randomUUID(), text: clean, createdAt: now, updatedAt: now };
    this.persist([...this.items, rec]);
    return rec;
  }
  update(id: string, text: string): MemoryRecord {
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, 500);
    const idx = this.items.findIndex((m) => m.id === id);
    if (idx === -1 || !clean) throw new Error('Memory not found.');
    const next = [...this.items];
    next[idx] = { ...next[idx]!, text: clean, updatedAt: Date.now() };
    this.persist(next);
    return next[idx]!;
  }
  delete(ids: string[]): number {
    const next = this.items.filter((m) => !ids.includes(m.id));
    const removed = this.items.length - next.length;
    if (removed) this.persist(next);
    return removed;
  }
  clear(): void {
    this.persist([]);
  }
  find(query: string): MemoryRecord[] {
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    if (!words.length) return [];
    return this.items.filter((m) => {
      const t = m.text.toLowerCase();
      return words.every((w) => t.includes(w));
    });
  }
  private persist(next: MemoryRecord[]): void {
    writeJson(this.file, next);
    this.items = next;
  }
}

export interface StoredConversation {
  id: string;
  startedAt: number;
  messages: ChatMessage[];
}

/** Opt-in conversation history (plaintext JSON in the user-data folder; documented in PRIVACY.md). */
export class HistoryStore {
  constructor(private readonly file: string) {}
  load(): StoredConversation[] {
    const raw = readJson(this.file);
    return Array.isArray(raw) ? (raw as StoredConversation[]).filter((c) => c && Array.isArray(c.messages)) : [];
  }
  save(conv: StoredConversation): void {
    const all = this.load().filter((c) => c.id !== conv.id);
    all.push({ ...conv, messages: conv.messages.filter((m) => !m.pending) });
    writeJson(this.file, all.slice(-50));
  }
  clear(): void {
    writeJson(this.file, []);
  }
}

interface UsageFile {
  version: 1;
  days: Record<string, UsageTotals>;
  verification: { liveConversation: boolean; liveInterruption: boolean };
}

const STAGES: Array<[string, keyof TurnRecord['timings'], keyof TurnRecord['timings']]> = [
  ['End of speech → committed transcript', 'endOfSpeech', 'committed'],
  ['Committed transcript → first LLM text', 'committed', 'firstText'],
  ['First LLM text → first audio received', 'firstText', 'firstAudioReceived'],
  ['First audio received → audible playback', 'firstAudioReceived', 'firstPlayback'],
  ['End of speech → audible playback (end-to-end)', 'endOfSpeech', 'firstPlayback'],
];

/** App-side usage counters (not provider billing). Daily totals persist; no conversation content is stored. */
export class UsageStore {
  private data: UsageFile;
  private session = emptyTotals();
  private turns: TurnRecord[] = [];
  constructor(private readonly file: string) {
    const raw = readJson(file) as UsageFile | undefined;
    this.data =
      raw && raw.version === 1 && raw.days
        ? { ...raw, verification: raw.verification ?? { liveConversation: false, liveInterruption: false } }
        : { version: 1, days: {}, verification: { liveConversation: false, liveInterruption: false } };
  }
  sessionTotals(): UsageTotals {
    return this.session;
  }
  todayTotals(now = Date.now()): UsageTotals {
    return this.data.days[localDate(now)] ?? emptyTotals();
  }
  record(turn: TurnRecord): void {
    this.turns.push(turn);
    if (this.turns.length > 200) this.turns.shift();
    this.session = addTurn(this.session, turn);
    const key = localDate(turn.startedAt);
    this.data.days[key] = addTurn(this.data.days[key] ?? emptyTotals(), turn);
    const keys = Object.keys(this.data.days).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 90))) delete this.data.days[k];
    this.save();
  }
  /** Adds STT seconds for listening sessions that never became an LLM turn. */
  addListenOnly(seconds: number, live: boolean): void {
    if (!live || seconds <= 0) return;
    this.session = { ...this.session, sttSeconds: Math.round((this.session.sttSeconds + seconds) * 10) / 10 };
    const key = localDate(Date.now());
    const day = this.data.days[key] ?? emptyTotals();
    this.data.days[key] = { ...day, sttSeconds: Math.round((day.sttSeconds + seconds) * 10) / 10 };
    this.save();
  }
  verification(): UsageFile['verification'] {
    return { ...this.data.verification };
  }
  markVerified(kind: 'liveConversation' | 'liveInterruption'): void {
    if (this.data.verification[kind]) return;
    this.data.verification[kind] = true;
    this.save();
  }
  snapshot(now = Date.now()): UsageSnapshot {
    const live = this.turns.filter((t) => t.live);
    return {
      session: this.session,
      today: { ...this.todayTotals(now), date: localDate(now) },
      recentTurns: this.turns.slice(-15).reverse(),
      latency: STAGES.map(([label, a, b]) =>
        summarizeLatency(
          label,
          live.map((t) => (t.timings[a] !== undefined && t.timings[b] !== undefined ? t.timings[b]! - t.timings[a]! : NaN)),
        ),
      ),
    };
  }
  private save(): void {
    try {
      writeJson(this.file, this.data);
    } catch {
      /* usage counters are best-effort */
    }
  }
}

export function storePaths(userData: string) {
  return {
    settings: join(userData, 'settings.json'),
    secrets: join(userData, 'credentials.enc.json'),
    memories: join(userData, 'memories.json'),
    history: join(userData, 'history.json'),
    usage: join(userData, 'usage.json'),
    assets: join(userData, 'assets'),
    log: join(userData, 'logs', 'jarvis.log'),
  };
}
