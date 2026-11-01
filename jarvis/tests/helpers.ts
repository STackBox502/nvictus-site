import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationController, type ControllerDeps } from '../src/main/controller';
import { Logger } from '../src/main/log';
import type { LlmAdapter, LlmEvent, LlmRequest } from '../src/main/providers/types';
import { SecretStore, type SecretCrypto } from '../src/main/secrets';
import type { SttOptions, SttSession } from '../src/main/speech/stt';
import type { TtsClient, TtsRequest } from '../src/main/speech/tts';
import { HistoryStore, MemoryStore, SettingsStore, UsageStore, storePaths } from '../src/main/stores';
import type { WakeService } from '../src/main/wakeword';
import { ProviderError } from '../src/shared/errors';
import type { AppSnapshot, AudioCommand, WakeStatus } from '../src/shared/types';

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await tick(5);
  }
}

export const fakeCrypto = (available = true): SecretCrypto => ({
  available: async () => available,
  encrypt: async (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
  decrypt: async (b) => Buffer.from(b.toString().slice(4), 'base64').toString(),
});

export class ScriptedLlm implements LlmAdapter {
  readonly id = 'anthropic' as const;
  requests: LlmRequest[] = [];
  script: Array<() => LlmEvent[] | ProviderError> = [];
  delayMs = 2;
  async listModels() {
    return ['claude-haiku-5-5'];
  }
  async *stream(req: LlmRequest): AsyncGenerator<LlmEvent> {
    this.requests.push(req);
    const step = this.script.shift() ?? (() => [{ type: 'text', text: 'Default reply. ' } as LlmEvent]);
    const res = step();
    if (res instanceof ProviderError) throw res;
    for (const e of res) {
      if (req.signal.aborted) return;
      await tick(this.delayMs);
      if (req.signal.aborted) return;
      yield e;
    }
  }
}

export class FakeStt implements SttSession {
  static instances: FakeStt[] = [];
  sent: number[] = [];
  commits = 0;
  closed = false;
  constructor(readonly opts: SttOptions) {
    FakeStt.instances.push(this);
  }
  get audioSeconds() {
    return this.sent.reduce((a, b) => a + b, 0) / 32000;
  }
  async open() {}
  sendAudio(pcm: Uint8Array) {
    this.sent.push(pcm.byteLength);
  }
  commit() {
    this.commits++;
  }
  close() {
    this.closed = true;
  }
}

export class FakeTts implements TtsClient {
  readonly sampleRate = 24000;
  readonly live = true;
  texts: string[] = [];
  fail: ProviderError | null = null;
  delayMs = 2;
  async synthesize(req: TtsRequest, onAudio: (pcm: Uint8Array) => void) {
    this.texts.push(req.text);
    await tick(this.delayMs);
    if (this.fail) throw this.fail;
    if (req.signal.aborted) throw new DOMException('aborted', 'AbortError');
    onAudio(new Uint8Array(480));
    await tick(this.delayMs);
    if (req.signal.aborted) throw new DOMException('aborted', 'AbortError');
    onAudio(new Uint8Array(480));
    return { chars: req.text.length };
  }
}

export class FakeWake implements WakeService {
  fed = 0;
  private cb: ((s: number) => void) | null = null;
  st: WakeStatus = { state: 'ready', reason: 'test', selfTestPassed: true };
  status() {
    return this.st;
  }
  start() {}
  stop() {}
  feed(pcm: Uint8Array) {
    this.fed += pcm.byteLength;
  }
  async selfTest() {
    return { ok: true, detail: 'ok' };
  }
  onWake(cb: (s: number) => void) {
    this.cb = cb;
  }
  onStatus() {}
  configure() {}
  fire(score = 0.9) {
    this.cb?.(score);
  }
}

export async function makeController(opts: { keys?: Partial<Record<'anthropic' | 'openai' | 'elevenlabs', string>>; settings?: Record<string, unknown> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-test-'));
  const paths = storePaths(dir);
  const settings = new SettingsStore(paths.settings);
  settings.update({ provider: { anthropicModel: 'claude-haiku-5-5', openaiModel: 'gpt-test-mini' }, voice: { voiceId: 'abcdefghij1234567890' }, ...(opts.settings ?? {}) });
  const secrets = new SecretStore(paths.secrets, fakeCrypto(), opts.keys ?? { anthropic: 'sk-ant-test-0000000000', elevenlabs: 'sk_eleven_test_00000000' });
  await secrets.init();
  const memories = new MemoryStore(paths.memories);
  const usage = new UsageStore(paths.usage);
  const llm = new ScriptedLlm();
  const tts = new FakeTts();
  const wake = new FakeWake();
  const audio: AudioCommand[] = [];
  const snaps: AppSnapshot[] = [];
  FakeStt.instances = [];
  let overlayShown = true;
  const deps: ControllerDeps = {
    settings,
    secrets,
    memories,
    history: new HistoryStore(paths.history),
    usage,
    makeLlm: () => llm,
    makeStt: (o) => new FakeStt(o),
    makeTts: () => tts,
    listVoices: async () => [{ id: 'abcdefghij1234567890', name: 'Atlas' }],
    listTtsModels: async () => [],
    wake,
    audio: { send: (c) => audio.push(c) },
    ui: { broadcast: (s) => snaps.push(s), levels: () => undefined, revealOverlay: () => undefined, setOverlayShown: (v) => (overlayShown = v), overlayShown: () => overlayShown, usageChanged: () => undefined },
    log: new Logger(null),
    now: () => Date.now(),
    version: 'test',
    shortcuts: () => ({ talk: { accelerator: 'X', registered: true }, stop: { accelerator: 'Y', registered: true } }),
  };
  const c = new ConversationController(deps);
  return { c, llm, tts, wake, audio, settings, memories, usage, secrets, dir };
}
