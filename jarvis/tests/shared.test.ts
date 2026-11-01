import { describe, expect, it } from 'vitest';
import { transition, restState } from '../src/shared/stateMachine';
import { SentenceChunker, FenceFilter, cleanForSpeech, SpeechPipeline, findBoundary } from '../src/shared/speech';
import { SSEParser } from '../src/shared/sse';
import { redact, maskSecret } from '../src/shared/redact';
import { assertAllowedUrl } from '../src/shared/endpoints';
import { classifyHttp, classifyThrown } from '../src/shared/errors';
import { matchLocalCommand } from '../src/shared/localCommands';
import { TranscriptAssembler, stripWakePhrase, joinSegments } from '../src/shared/transcript';
import { buildHistory, buildSystemPrompt } from '../src/shared/context';
import { clampMotion, motionAt, envelope, stateVisual, levelToEnergy } from '../src/shared/motion';
import { summarizeLatency, checkBudget, emptyTotals, addTurn } from '../src/shared/usage';
import { checkImage } from '../src/shared/imageCheck';
import { DEFAULT_SETTINGS, applySettingsPatch, loadSettings, deepMerge, resetSettingsKeepingSetup } from '../src/shared/settings';
import { computeOverlayBounds, clampToArea, dockFor } from '../src/shared/geometry';
import { INVOKE_SCHEMAS, isTrustedOrigin, validateFrame } from '../src/shared/ipcSchemas';
import type { ChatMessage } from '../src/shared/types';

const ctx = { configured: true, armed: false };

describe('state machine', () => {
  it('runs a full voice turn', () => {
    let s = transition('idle', 'START_LISTEN', ctx)!;
    expect(s).toBe('listening');
    s = transition(s, 'END_UTTERANCE', ctx)!;
    expect(s).toBe('transcribing');
    s = transition(s, 'TRANSCRIPT_FINAL', ctx)!;
    expect(s).toBe('thinking');
    s = transition(s, 'FIRST_AUDIO', ctx)!;
    expect(s).toBe('speaking');
    expect(transition(s, 'REPLY_DONE', ctx)).toBe('idle');
  });
  it('returns to armed when hands-free is armed', () => {
    expect(transition('speaking', 'REPLY_DONE', { configured: true, armed: true })).toBe('armed');
    expect(restState({ configured: false, armed: true })).toBe('unconfigured');
  });
  it('rejects invalid transitions instead of corrupting state', () => {
    expect(transition('idle', 'FIRST_AUDIO', ctx)).toBeNull();
    expect(transition('idle', 'END_UTTERANCE', ctx)).toBeNull();
    expect(transition('unconfigured', 'START_LISTEN', { configured: false, armed: false })).toBeNull();
    expect(transition('muted', 'START_LISTEN', ctx)).toBeNull();
  });
  it('mute wins from any state; only unmute leaves it', () => {
    for (const st of ['idle', 'listening', 'speaking', 'error'] as const) expect(transition(st, 'MUTE', ctx)).toBe('muted');
    expect(transition('muted', 'ERROR', ctx)).toBeNull();
    expect(transition('muted', 'UNMUTE', ctx)).toBe('idle');
  });
  it('interrupt only from active states, then settles', () => {
    expect(transition('idle', 'INTERRUPT', ctx)).toBeNull();
    expect(transition('speaking', 'INTERRUPT', ctx)).toBe('interrupted');
    expect(transition('interrupted', 'SETTLE', ctx)).toBe('idle');
    expect(transition('interrupted', 'START_LISTEN', ctx)).toBe('listening');
  });
});

describe('speech chunking', () => {
  it('splits sentences but not abbreviations, decimals, or domains', () => {
    const c = new SentenceChunker({ firstMinChars: 1, minChars: 1, maxChars: 300 });
    const out = [...c.push('Dr. Smith paid $3.50 at example.com today. Then he left! '), ...c.flush()];
    expect(out).toEqual(['Dr. Smith paid $3.50 at example.com today.', 'Then he left!']);
  });
  it('streams token by token with the same result as all-at-once', () => {
    const text = 'First sentence here. Second one is a bit longer, with a clause. Third? Yes, e.g. this one. Done';
    const whole = new SentenceChunker();
    const a = [...whole.push(text), ...whole.flush()];
    const streamed = new SentenceChunker();
    const b: string[] = [];
    for (const ch of text) b.push(...streamed.push(ch));
    b.push(...streamed.flush());
    expect(b).toEqual(a);
    expect(b.join(' ')).toContain('Done');
  });
  it('emits the first sentence quickly, merges short later ones', () => {
    const c = new SentenceChunker({ firstMinChars: 1, minChars: 40, maxChars: 260 });
    expect(c.push('Hi.')).toEqual([]); // needs lookahead past the period
    expect(c.push(' Ok. ')).toEqual(['Hi.']);
    const rest = [...c.push('Yes. No. This sentence is long enough to stand alone. '), ...c.flush()];
    expect(rest[0]).toBe('Ok. Yes. No. This sentence is long enough to stand alone.');
  });
  it('soft-splits overly long runs and always flushes the last sentence', () => {
    const c = new SentenceChunker({ firstMinChars: 1, minChars: 1, maxChars: 50 });
    const long = 'word, '.repeat(30);
    const out = [...c.push(long), ...c.flush()];
    expect(out.every((s) => s.length <= 50)).toBe(true);
    expect(out.join(' ').replace(/\s+/g, ' ')).toBe(long.trim().replace(/\s+/g, ' '));
  });
  it('does not trust a trailing period without lookahead', () => {
    expect(findBoundary('Version 3.')).toBe(-1);
    expect(findBoundary('Version 3. Next')).toBe(10);
  });
  it('drops fenced code across stream boundaries', () => {
    const f = new FenceFilter('[code]');
    const out = f.push('Here: `') + f.push('``js\nconst a = 1;\n`') + f.push('`` after.') + f.flush();
    expect(out).toBe('Here: [code] after.');
  });
  it('cleans markdown and URLs for speech', () => {
    expect(cleanForSpeech('## Title\n- **Bold** item with [a link](https://x.y/z) and https://evil.example/path')).toBe(
      'Title Bold item with a link and the link in the chat',
    );
    expect(cleanForSpeech('Use `npm test` now')).toBe('Use npm test now');
  });
  it('pipeline yields speakable chunks with final flush', () => {
    const p = new SpeechPipeline();
    const chunks = [...p.push('**Hello** there. '), ...p.push('```\ncode\n``` Bye')];
    chunks.push(...p.flush());
    expect(chunks.join(' ')).toMatch(/Hello there\./);
    expect(chunks.join(' ')).toMatch(/code in the chat/);
    expect(chunks.at(-1)).toMatch(/Bye$/);
  });
});

describe('SSE parser', () => {
  it('parses events split across chunks, CRLF, comments, multi-line data', () => {
    const p = new SSEParser();
    const evs = [...p.push('event: a\r\ndata: {"x"'), ...p.push(':1}\r\n\r\n: comment\n'), ...p.push('data: l1\ndata: l2\n\n')];
    expect(evs).toEqual([
      { event: 'a', data: '{"x":1}' },
      { event: 'message', data: 'l1\nl2' },
    ]);
  });
  it('flushes a final event without trailing blank line', () => {
    const p = new SSEParser();
    expect(p.push('data: tail')).toEqual([]);
    expect(p.end()).toEqual([{ event: 'message', data: 'tail' }]);
  });
});

describe('redaction and endpoints', () => {
  it('redacts provider keys, headers, bearer tokens, query tokens, and known secrets', () => {
    const s = redact('x-api-key: sk-ant-api03-abcdefghijklmnop Authorization: Bearer abc.def https://h/?token=zzz sk-proj-ABCDEFGHIJKLMNOPQRSTU sk_0123456789abcdef0123456789 mysecretvalue123', ['mysecretvalue123']);
    expect(s).not.toMatch(/abcdefghijklmnop|abc\.def|zzz|ABCDEFGHIJKLMNOPQRSTU|0123456789abcdef0123456789|mysecretvalue123/);
    expect(maskSecret('sk-ant-123456789wxyz')).toBe('••••wxyz');
  });
  it('allows only provider hosts over https/wss', () => {
    expect(() => assertAllowedUrl('https://api.anthropic.com/v1/messages')).not.toThrow();
    expect(() => assertAllowedUrl('wss://api.elevenlabs.io/v1/speech-to-text/realtime', ['wss:'])).not.toThrow();
    expect(() => assertAllowedUrl('http://api.openai.com/v1')).toThrow();
    expect(() => assertAllowedUrl('https://evil.com/api.openai.com')).toThrow();
    expect(() => assertAllowedUrl('https://user:pw@api.openai.com/')).toThrow();
    expect(() => assertAllowedUrl('https://api.openai.com:8443/')).toThrow();
  });
});

describe('error classification', () => {
  it('maps statuses and bodies to stable codes', () => {
    expect(classifyHttp(401, '', 'anthropic').code).toBe('auth');
    expect(classifyHttp(400, '{"error":{"message":"Your credit balance is too low"}}', 'anthropic').code).toBe('credits');
    expect(classifyHttp(429, '{"error":{"code":"insufficient_quota"}}', 'openai').code).toBe('credits');
    expect(classifyHttp(429, 'slow down', 'openai').code).toBe('rate_limit');
    expect(classifyHttp(529, 'overloaded', 'anthropic').code).toBe('outage');
    expect(classifyHttp(404, 'model not found', 'openai').code).toBe('invalid_model');
    expect(classifyHttp(400, 'voice_id does not exist', 'elevenlabs').code).toBe('invalid_voice');
    expect(classifyHttp(429, 'x', 'openai').retryable).toBe(true);
    expect(classifyHttp(401, 'x', 'openai').retryable).toBe(false);
  });
  it('classifies thrown network/abort/timeout errors', () => {
    expect(classifyThrown(new TypeError('fetch failed'), 'openai').code).toBe('network');
    expect(classifyThrown(new DOMException('x', 'AbortError'), 'openai').code).toBe('cancelled');
    expect(classifyThrown(new DOMException('x', 'TimeoutError'), 'openai').code).toBe('timeout');
  });
});

describe('local commands', () => {
  it('matches exact app commands, including wake prefix', () => {
    expect(matchLocalCommand('Stop')).toEqual({ kind: 'stop' });
    expect(matchLocalCommand('Hey Jarvis, mute.')).toEqual({ kind: 'mute' });
    expect(matchLocalCommand('switch to OpenAI')).toEqual({ kind: 'switchProvider', provider: 'openai' });
    expect(matchLocalCommand('please switch to claude')).toEqual({ kind: 'switchProvider', provider: 'anthropic' });
    expect(matchLocalCommand('Remember that my workshop is on Thursday.')).toEqual({ kind: 'remember', text: 'my workshop is on Thursday' });
    expect(matchLocalCommand('forget the workshop')).toEqual({ kind: 'forget', query: 'the workshop' });
    expect(matchLocalCommand('start a new conversation')).toEqual({ kind: 'newConversation' });
    expect(matchLocalCommand('change your voice to Adam')).toEqual({ kind: 'changeVoice', name: 'adam' });
  });
  it('never hijacks ordinary questions', () => {
    expect(matchLocalCommand('How do I stop my dog from barking?')).toBeNull();
    expect(matchLocalCommand('remember when we talked about pricing')).toBeNull();
    expect(matchLocalCommand('Do you remember my name?')).toBeNull();
    expect(matchLocalCommand('stop the presses and tell me a joke')).toBeNull();
  });
  it('yes/no only count while a confirmation is pending', () => {
    expect(matchLocalCommand('yes')).toBeNull();
    expect(matchLocalCommand('yes', 'Jarvis', true)).toEqual({ kind: 'confirm', accept: true });
    expect(matchLocalCommand('never mind', 'Jarvis', true)).toEqual({ kind: 'confirm', accept: false });
  });
});

describe('transcript assembly', () => {
  it('submits committed segments only, after explicit endpoint silence', () => {
    const a = new TranscriptAssembler(1000);
    a.onPartial('hello wor', 0);
    expect(a.shouldFinalize(5000)).toBe(false); // no committed segment yet
    a.onCommitted('Hello world.', 100);
    a.onPartial('and more', 300);
    expect(a.shouldFinalize(2000)).toBe(false); // partial pending
    a.onCommitted('And more.', 400);
    expect(a.shouldFinalize(1300)).toBe(false);
    expect(a.shouldFinalize(1400)).toBe(true);
    expect(a.text()).toBe('Hello world. And more.');
  });
  it('strips the wake phrase from pre-roll transcripts', () => {
    expect(stripWakePhrase('Hey Jarvis, what time is it?')).toBe('what time is it?');
    expect(stripWakePhrase('Jarvis. Remind me')).toBe('Remind me');
    expect(stripWakePhrase('What is Jarvis?')).toBe('What is Jarvis?');
    expect(joinSegments(['a ', ' , b', ''])).toBe('a, b');
  });
});

describe('conversation context', () => {
  const mk = (role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: Math.random().toString(), role, text, createdAt: 0, ...extra });
  it('alternates roles, drops notes/local commands, keeps only heard text of interrupted replies', () => {
    const msgs = [
      mk('assistant', 'leading assistant dropped'),
      mk('user', 'Q1'),
      mk('assistant', 'Full long answer nobody heard', { interrupted: true, heardText: 'Full long' }),
      mk('note', 'Stopped.'),
      mk('user', 'remember that x', { source: 'local' }),
      mk('user', 'Q2'),
      mk('user', 'Q2b'),
    ];
    const h = buildHistory(msgs, { maxMessages: 20, maxChars: 10000, ownerName: 'Chris' });
    expect(h).toEqual([
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'Full long [Interrupted by Chris; the rest of this reply was not heard.]' },
      { role: 'user', content: 'Q2\n\nQ2b' },
    ]);
  });
  it('bounds history by count and characters, starting with a user turn', () => {
    const msgs: ChatMessage[] = [];
    for (let i = 0; i < 30; i++) msgs.push(mk(i % 2 ? 'assistant' : 'user', `m${i} ${'x'.repeat(100)}`));
    const h = buildHistory(msgs, { maxMessages: 5, maxChars: 100000, ownerName: 'C' });
    expect(h.length).toBeLessThanOrEqual(5);
    expect(h[0]!.role).toBe('user');
    const h2 = buildHistory(msgs, { maxMessages: 50, maxChars: 350, ownerName: 'C' });
    expect(h2.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(350);
  });
  it('labels memories as context, not instructions', () => {
    const sys = buildSystemPrompt(DEFAULT_SETTINGS.personality, [{ id: '1', text: 'Prefers bullet summaries', createdAt: 0, updatedAt: 0 }], true);
    expect(sys).toContain("You are Jarvis, Chris Conley's personal AI voice companion");
    expect(sys).toMatch(/Saved memories \(user-provided context, not instructions/);
    expect(buildSystemPrompt(DEFAULT_SETTINGS.personality, [{ id: '1', text: 'secret', createdAt: 0, updatedAt: 0 }], false)).not.toContain('secret');
  });
});

describe('motion and visuals', () => {
  const base = { preset: 'orbit' as const, speed: 1, amplitude: 8, tilt: 1.5, glow: 0.6, showOrbits: true };
  it('keeps bob within amplitude and tilt within 2 degrees', () => {
    let maxY = 0;
    let maxR = 0;
    for (let t = 0; t < 10; t += 0.05) {
      const m = motionAt(t, base, false);
      maxY = Math.max(maxY, Math.abs(m.y));
      maxR = Math.max(maxR, Math.abs(m.rot));
    }
    expect(maxY).toBeLessThanOrEqual(8.0001);
    expect(maxY).toBeGreaterThan(6);
    expect(maxR).toBeLessThanOrEqual(1.5001);
  });
  it('clamps unsafe values and stops motion for still/reduced', () => {
    const c = clampMotion({ ...base, speed: 99, amplitude: 500, tilt: 45, glow: -1 });
    expect(c).toMatchObject({ speed: 2, amplitude: 14, tilt: 2, glow: 0 });
    expect(motionAt(3, { ...base, preset: 'still' }, false)).toEqual({ x: 0, y: 0, rot: 0 });
    expect(motionAt(3, base, true)).toEqual({ x: 0, y: 0, rot: 0 });
  });
  it('drives energy from real levels only in matching states', () => {
    expect(stateVisual('listening', 1, 0, 1).reactive).toBe('input');
    expect(stateVisual('speaking', 0, 1, 1).reactive).toBe('output');
    expect(stateVisual('thinking', 1, 1, 1)).toMatchObject({ reactive: 'none', sweep: true });
    expect(stateVisual('idle', 1, 1, 1).energy).toBeCloseTo(0.15);
    expect(stateVisual('muted', 1, 1, 1).accent).toBe('dim');
    expect(stateVisual('error', 0, 0, 1).accent).toBe('amber');
    expect(envelope(0, 1, 1)).toBeLessThanOrEqual(1);
    expect(levelToEnergy(0)).toBe(0);
    expect(levelToEnergy(1)).toBe(1);
  });
});

describe('usage and budget', () => {
  it('reports percentiles only with enough samples', () => {
    expect(summarizeLatency('x', [100, 200]).p50).toBeUndefined();
    const s = summarizeLatency('x', Array.from({ length: 20 }, (_, i) => (i + 1) * 10));
    expect(s).toMatchObject({ count: 20, p50: 100, p95: 190 });
  });
  it('blocks new requests at local limits', () => {
    const limits = { maxTurnsPerSession: 2, maxOutputTokensPerDay: 100, maxTtsCharsPerDay: 0, maxSttSecondsPerDay: 0 };
    let t = emptyTotals();
    expect(checkBudget(t, t, limits).ok).toBe(true);
    t = addTurn(addTurn(t, { ttsChars: 1, sttSeconds: 0, live: true, outputTokens: 10, inputTokens: 1 }), { ttsChars: 1, sttSeconds: 0, live: true });
    expect(checkBudget(t, emptyTotals(), limits).ok).toBe(false);
    expect(t.incomplete).toBe(true);
    expect(checkBudget(emptyTotals(), { ...emptyTotals(), outputTokens: 100 }, limits).ok).toBe(false);
  });
});

describe('image validation', () => {
  const png = (w: number, h: number, colorType: number, extra: number[] = []) => {
    const b = new Uint8Array(33 + extra.length);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(b.buffer).setUint32(16, w);
    new DataView(b.buffer).setUint32(20, h);
    b[24] = 8;
    b[25] = colorType;
    b.set(extra, 33);
    return b;
  };
  it('accepts RGBA PNG and reports alpha; flags RGB PNG without alpha', () => {
    expect(checkImage(png(1024, 1024, 6))).toMatchObject({ ok: true, info: { width: 1024, height: 1024, hasAlphaChannel: true } });
    expect(checkImage(png(1024, 1024, 2))).toMatchObject({ ok: true, info: { hasAlphaChannel: false } });
    const trns = [0, 0, 0, 1, 0x74, 0x52, 0x4e, 0x53, 0, 0, 0, 0, 0];
    expect(checkImage(png(512, 512, 3, trns))).toMatchObject({ ok: true, info: { hasAlphaChannel: true } });
  });
  it('rejects bad signatures and out-of-range dimensions', () => {
    expect(checkImage(new TextEncoder().encode('GIF89a not an image')).ok).toBe(false);
    expect(checkImage(png(10, 10, 6)).ok).toBe(false);
    expect(checkImage(png(9000, 100, 6)).ok).toBe(false);
  });
  it('parses WebP VP8X alpha flag', () => {
    const b = new Uint8Array(32);
    b.set(new TextEncoder().encode('RIFF'), 0);
    b.set(new TextEncoder().encode('WEBPVP8X'), 8);
    b[20] = 0x10;
    b[24] = 255; // width-1 = 255 → 256
    b[27] = 127; // height-1 = 127 → 128
    expect(checkImage(b)).toMatchObject({ ok: true, info: { format: 'webp', width: 256, height: 128, hasAlphaChannel: true } });
  });
});

describe('settings', () => {
  it('rejects out-of-range patches whole and accepts valid ones', () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, { motion: { amplitude: 99 } }).ok).toBe(false);
    expect(applySettingsPatch(DEFAULT_SETTINGS, { voice: { voiceId: 'bad id!' } }).ok).toBe(false);
    const r = applySettingsPatch(DEFAULT_SETTINGS, { voice: { speed: 1.1 } });
    expect(r.ok && r.settings.voice.speed).toBe(1.1);
  });
  it('drops prototype-pollution keys', () => {
    const merged = deepMerge({ a: 1 }, JSON.parse('{"__proto__":{"polluted":true},"a":2}')) as Record<string, unknown>;
    expect(merged.a).toBe(2);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it('repairs invalid stored sections individually', () => {
    const s = loadSettings({ motion: { amplitude: 9999 }, personality: { ownerName: 'Chris C' } });
    expect(s.motion.amplitude).toBe(DEFAULT_SETTINGS.motion.amplitude);
    expect(s.personality.ownerName).toBe('Chris C');
  });
  it('defaults are privacy-safe and reset keeps setup state', () => {
    expect(DEFAULT_SETTINGS.memory.persistHistory).toBe(false);
    expect(DEFAULT_SETTINGS.provider.fallbackEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.app.launchAtLogin).toBe(false);
    expect(DEFAULT_SETTINGS.activation.duplex).toBe('half');
    const reset = resetSettingsKeepingSetup({ ...DEFAULT_SETTINGS, demoMode: true, app: { ...DEFAULT_SETTINGS.app, setupComplete: true } });
    expect(reset.demoMode).toBe(false);
    expect(reset.app.setupComplete).toBe(true);
  });
});

describe('overlay geometry', () => {
  const displays = [
    { id: 1, primary: true, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 1024 } },
  ];
  it('docks right inside the work area by default', () => {
    const { bounds } = computeOverlayBounds({ scale: 1, dock: 'right', displayId: null, position: null }, displays);
    expect(bounds.x + bounds.width).toBe(1920 - 16);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(1040);
  });
  it('recovers when the saved monitor is gone', () => {
    const { bounds, displayId } = computeOverlayBounds({ scale: 1, dock: 'right', displayId: 3, position: { x: 5000, y: 200 } }, displays);
    expect(displayId).toBe(1);
    expect(bounds.x).toBeLessThan(1920);
  });
  it('keeps a saved position on a second monitor and clamps partial overflow', () => {
    const { bounds, displayId } = computeOverlayBounds({ scale: 1, dock: 'right', displayId: 2, position: { x: 3100, y: 900 } }, displays);
    expect(displayId).toBe(2);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(1920 + 1280);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(1024);
    expect(clampToArea({ x: -50, y: -50, width: 100, height: 100 }, displays[0]!.workArea)).toMatchObject({ x: 0, y: 0 });
    expect(dockFor({ x: 10, y: 0, width: 100, height: 100 }, displays[0]!.workArea)).toBe('left');
  });
});

describe('IPC validation', () => {
  it('rejects malformed payloads and unknown keys', () => {
    expect(INVOKE_SCHEMAS['conv:sendText'].safeParse({ text: 'hi' }).success).toBe(true);
    expect(INVOKE_SCHEMAS['conv:sendText'].safeParse({ text: '' }).success).toBe(false);
    expect(INVOKE_SCHEMAS['conv:sendText'].safeParse({ text: 'hi', extra: 1 }).success).toBe(false);
    expect(INVOKE_SCHEMAS['secrets:set'].safeParse({ name: 'github', value: 'x'.repeat(20), persist: true }).success).toBe(false);
    expect(INVOKE_SCHEMAS['external:open'].safeParse({ key: 'https://evil.example' }).success).toBe(false);
    expect(INVOKE_SCHEMAS['memory:clear'].safeParse({}).success).toBe(false);
    expect(INVOKE_SCHEMAS['memory:clear'].safeParse({ confirm: true }).success).toBe(true);
  });
  it('trusts only the packaged origin or the exact dev server', () => {
    expect(isTrustedOrigin('app://jarvis/chat.html', undefined)).toBe(true);
    expect(isTrustedOrigin('app://other/chat.html', undefined)).toBe(false);
    expect(isTrustedOrigin('http://localhost:5173/chat.html', undefined)).toBe(false);
    expect(isTrustedOrigin('http://localhost:5173/chat.html', 'http://localhost:5173')).toBe(true);
    expect(isTrustedOrigin('https://evil.example/', 'http://localhost:5173')).toBe(false);
  });
  it('validates audio frames strictly', () => {
    expect(validateFrame(1, new Uint8Array(3200))).toBe(true);
    expect(validateFrame(1, new Uint8Array(3201))).toBe(false);
    expect(validateFrame('1', new Uint8Array(3200))).toBe(false);
    expect(validateFrame(1, new Uint8Array(20000))).toBe(false);
  });
});
