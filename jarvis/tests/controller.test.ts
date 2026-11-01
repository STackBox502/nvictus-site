import { describe, expect, it } from 'vitest';
import { ProviderError } from '../src/shared/errors';
import type { AudioCommand } from '../src/shared/types';
import { FakeStt, makeController, tick, waitFor } from './helpers';

const text = (t: string) => ({ type: 'text' as const, text: t });
const pcmCmds = (a: AudioCommand[]) => a.filter((x): x is Extract<AudioCommand, { type: 'pcm' }> => x.type === 'pcm');
const frame = () => new Uint8Array(3200);

describe('conversation controller', () => {
  it('runs a typed turn: streams text, speaks ordered chunks, completes after playback drains', async () => {
    const { c, llm, tts, audio, usage } = await makeController();
    llm.script.push(() => [text('Hello Chris. '), text('Here is the second sentence, a bit longer than the first one. '), { type: 'usage', inputTokens: 10, outputTokens: 20 }, text('Done.')]);
    await c.sendText('Hi there');
    await waitFor(() => audio.some((x) => x.type === 'endOfStream'));
    const s1 = c.snapshot();
    const reply = s1.messages.find((m) => m.role === 'assistant')!;
    expect(reply.text).toBe('Hello Chris. Here is the second sentence, a bit longer than the first one. Done.');
    expect(tts.texts[0]).toBe('Hello Chris.');
    expect(tts.texts.at(-1)).toMatch(/Done\.$/);
    const seqs = pcmCmds(audio).map((p) => p.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(s1.state).toBe('thinking'); // audio not yet audible
    const turnId = pcmCmds(audio)[0]!.turnId;
    c.onAudioEvent({ type: 'playbackStarted', turnId });
    expect(c.snapshot().state).toBe('speaking');
    c.onAudioEvent({ type: 'playbackDrained', turnId });
    expect(c.snapshot().state).toBe('idle');
    expect(usage.sessionTotals()).toMatchObject({ turns: 1, inputTokens: 10, outputTokens: 20 });
    expect(usage.verification().liveConversation).toBe(true);
    expect(llm.requests[0]!.messages.at(-1)).toEqual({ role: 'user', content: 'Hi there' });
  });

  it('Stop interrupts immediately, discards late chunks, and keeps only heard text as context', async () => {
    const { c, llm, tts, audio, usage } = await makeController();
    tts.delayMs = 15;
    llm.script.push(() => [text('First sentence is heard. '), text('Second sentence never gets heard by anyone at all. '), text('Third.')]);
    await c.sendText('Tell me something');
    await waitFor(() => pcmCmds(audio).length > 0);
    const turnId = pcmCmds(audio)[0]!.turnId;
    c.onAudioEvent({ type: 'playbackStarted', turnId });
    c.onAudioEvent({ type: 'chunkPlayed', turnId, seq: 0 });
    c.stop();
    const stopIdx = audio.findIndex((x) => x.type === 'stopPlayback');
    expect(audio[stopIdx]).toEqual({ type: 'stopPlayback', turnId });
    await tick(80);
    expect(audio.slice(stopIdx + 1).filter((x) => x.type === 'pcm' && x.turnId === turnId)).toEqual([]);
    const reply = c.snapshot().messages.find((m) => m.role === 'assistant')!;
    expect(reply.interrupted).toBe(true);
    expect(reply.heardText).toBe('First sentence is heard.');
    expect(usage.verification().liveInterruption).toBe(true);
    await waitFor(() => c.snapshot().state === 'idle');
    llm.script.push(() => [text('Ok.')]);
    await c.sendText('Follow up');
    await waitFor(() => llm.requests.length === 2);
    const ctx = llm.requests[1]!.messages;
    expect(ctx[1]!.content).toBe('First sentence is heard. [Interrupted by Chris; the rest of this reply was not heard.]');
  });

  it('ignores a rapid duplicate submission', async () => {
    const { c, llm } = await makeController();
    await Promise.all([c.sendText('same'), c.sendText('same')]);
    await waitFor(() => !c.snapshot().messages.some((m) => m.pending));
    expect(c.snapshot().messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(llm.requests).toHaveLength(1);
  });

  it('push-to-talk: audio reaches STT only while listening; release commits; committed text becomes one turn', async () => {
    const { c, llm, audio } = await makeController();
    c.onAudioFrame(1, frame()); // no capture yet → dropped
    c.talk('start', 'hold');
    const start = audio.find((x) => x.type === 'startCapture') as Extract<AudioCommand, { type: 'startCapture' }>;
    expect(start).toBeTruthy();
    const stt = FakeStt.instances[0]!;
    expect(stt.opts.commitStrategy).toBe('manual');
    c.onAudioFrame(start.sessionId, frame());
    c.onAudioFrame(start.sessionId + 99, frame()); // stale session → dropped
    expect(stt.sent).toEqual([3200]);
    stt.opts.handlers.onPartial('what is');
    expect(c.snapshot().partialTranscript).toBe('what is');
    c.talk('end', 'hold');
    expect(stt.commits).toBe(1);
    expect(c.snapshot().state).toBe('transcribing');
    stt.opts.handlers.onCommitted('What is the plan?');
    await waitFor(() => llm.requests.length === 1);
    expect(stt.closed).toBe(true);
    expect(audio.some((x) => x.type === 'stopCapture')).toBe(true); // mic released (not armed)
    const user = c.snapshot().messages.find((m) => m.role === 'user')!;
    expect(user).toMatchObject({ text: 'What is the plan?', source: 'voice' });
  });

  it('transport boundary: while armed, frames go only to the local wake detector; after wake, to STT with pre-roll', async () => {
    const { c, wake, audio } = await makeController({ settings: { activation: { mode: 'handsfree' } } });
    c.arm(true);
    const start = audio.find((x) => x.type === 'startCapture') as Extract<AudioCommand, { type: 'startCapture' }>;
    for (let i = 0; i < 10; i++) c.onAudioFrame(start.sessionId, frame());
    expect(FakeStt.instances).toHaveLength(0);
    expect(wake.fed).toBe(32000);
    expect(c.snapshot()).toMatchObject({ state: 'armed', armed: true, micActive: true });
    wake.fire();
    const stt = FakeStt.instances[0]!;
    expect(stt.opts.commitStrategy).toBe('vad');
    expect(stt.sent.reduce((a, b) => a + b, 0)).toBeGreaterThan(0); // pre-roll
    expect(stt.sent.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(Math.ceil(0.6 * 32000) + 3200);
    const before = wake.fed;
    c.onAudioFrame(start.sessionId, frame());
    expect(wake.fed).toBe(before); // not fed to wake while listening
    expect(audio.some((x) => x.type === 'cue')).toBe(true);
    c.arm(false); // "stop listening": disarm and close cloud audio immediately
    expect(stt.closed).toBe(true);
    expect(audio.at(-1)).toEqual({ type: 'stopCapture' });
    expect(c.snapshot().armed).toBe(false);
  });

  it('wake detection is suppressed during speech in half-duplex mode', async () => {
    const { c, wake, llm, audio } = await makeController({ settings: { activation: { mode: 'handsfree' } } });
    c.arm(true);
    llm.delayMs = 30;
    llm.script.push(() => [text('A long reply. '), text('More.')]);
    void c.sendText('hello');
    await waitFor(() => c.snapshot().state === 'thinking');
    const start = audio.find((x) => x.type === 'startCapture') as Extract<AudioCommand, { type: 'startCapture' }>;
    const fedBefore = wake.fed;
    c.onAudioFrame(start.sessionId, frame());
    expect(wake.fed).toBe(fedBefore);
    wake.fire();
    expect(FakeStt.instances).toHaveLength(0);
  });

  it('mute stops capture, ignores frames, and blocks talking until unmuted', async () => {
    const { c, audio } = await makeController();
    c.talk('toggle', 'click');
    const start = audio.find((x) => x.type === 'startCapture') as Extract<AudioCommand, { type: 'startCapture' }>;
    c.setMuted(true);
    expect(audio.at(-1)).toEqual({ type: 'stopCapture' });
    expect(FakeStt.instances[0]!.closed).toBe(true);
    c.onAudioFrame(start.sessionId, frame());
    expect(FakeStt.instances[0]!.sent).toEqual([]);
    c.talk('toggle', 'click');
    expect(FakeStt.instances).toHaveLength(1);
    expect(c.snapshot()).toMatchObject({ state: 'muted', muted: true, micActive: false });
    c.setMuted(false);
    expect(c.snapshot().state).toBe('idle');
  });

  it('handles local commands without calling the LLM; memory acknowledgement follows persistence', async () => {
    const { c, llm, memories } = await makeController();
    await c.sendText('Remember that my workshop runs on Thursdays');
    expect(memories.list().map((m) => m.text)).toEqual(['my workshop runs on Thursdays']);
    expect(c.snapshot().messages.at(-1)!.text).toBe('Saved to memory: "my workshop runs on Thursdays"');
    await c.sendText('forget workshop');
    const pending = c.snapshot().pendingConfirmation!;
    expect(pending.kind).toBe('forget');
    expect(memories.list()).toHaveLength(1); // destructive: waits for confirmation
    await c.sendText('yes');
    expect(memories.list()).toHaveLength(0);
    await c.sendText('stop');
    expect(llm.requests).toHaveLength(0);
  });

  it('surfaces provider errors, preserves input for retry, and retries successfully', async () => {
    const { c, llm } = await makeController();
    llm.script.push(() => new ProviderError('auth', 'Anthropic rejected the API key.', 'anthropic', 401));
    await c.sendText('Question one');
    const s = c.snapshot();
    expect(s.state).toBe('error');
    expect(s.error?.code).toBe('auth');
    expect(s.canRetry).toBe(true);
    expect(s.messages.some((m) => m.role === 'assistant' && m.text)).toBe(false);
    llm.script.push(() => [text('Recovered.')]);
    await c.retry();
    await waitFor(() => c.snapshot().messages.some((m) => m.text === 'Recovered.'));
    expect(c.snapshot().messages.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('retries transient errors only before any text arrives (no duplicate output)', async () => {
    const { c, llm } = await makeController();
    llm.script.push(() => new ProviderError('rate_limit', 'slow', 'anthropic', 429));
    llm.script.push(() => [text('Second try worked.')]);
    await c.sendText('hi');
    await waitFor(() => c.snapshot().messages.some((m) => m.text === 'Second try worked.'), 4000);
    expect(llm.requests).toHaveLength(2);
  });

  it('keeps the text answer and flags "Voice unavailable" when TTS fails', async () => {
    const { c, llm, tts, audio } = await makeController();
    tts.fail = new ProviderError('credits', 'ElevenLabs reports insufficient credits or quota.', 'elevenlabs', 401);
    llm.script.push(() => [text('Text still arrives.')]);
    await c.sendText('hi');
    await waitFor(() => c.snapshot().state === 'idle');
    const reply = c.snapshot().messages.find((m) => m.role === 'assistant')!;
    expect(reply.text).toBe('Text still arrives.');
    expect(reply.voiceUnavailable).toBe(true);
    expect(audio.filter((x) => x.type === 'pcm')).toHaveLength(0);
  });

  it('enforces the local budget guard before calling the provider', async () => {
    const { c, llm, audio } = await makeController({ settings: { budget: { maxTurnsPerSession: 1 } } });
    llm.script.push(() => [text('One.')]);
    await c.sendText('first');
    await waitFor(() => audio.some((x) => x.type === 'endOfStream'));
    const turnId = pcmCmds(audio)[0]!.turnId;
    c.onAudioEvent({ type: 'playbackStarted', turnId });
    c.onAudioEvent({ type: 'playbackDrained', turnId });
    expect(c.snapshot().state).toBe('idle');
    await c.sendText('second');
    expect(c.snapshot().error?.code).toBe('budget');
    expect(llm.requests).toHaveLength(1);
  });

  it('refuses to switch to an unconfigured provider and notes context transfer when switching', async () => {
    const a = await makeController();
    a.c.switchProvider('openai');
    expect(a.settings.get().provider.active).toBe('anthropic');
    expect(a.c.snapshot().messages.at(-1)!.text).toMatch(/not configured/);
    const b = await makeController({ keys: { anthropic: 'sk-ant-test-0000000000', openai: 'sk-openai-test-000000000000', elevenlabs: 'sk_eleven_test_00000000' } });
    await b.c.sendText('hello');
    await waitFor(() => !b.c.snapshot().messages.some((m) => m.pending));
    b.c.switchProvider('openai');
    expect(b.settings.get().provider.active).toBe('openai');
    expect(b.c.snapshot().messages.at(-1)!.text).toMatch(/existing conversation context .* will be sent to OpenAI/);
  });

  it('is unconfigured without an LLM key and says so instead of failing silently', async () => {
    const { c } = await makeController({ keys: { elevenlabs: 'sk_eleven_test_00000000' } });
    expect(c.snapshot().state).toBe('unconfigured');
    c.talk('toggle', 'click');
    expect(c.snapshot().error?.code).toBe('not_configured');
  });

  it('demo mode works with no keys and never marks live verification', async () => {
    const { c, usage, audio } = await makeController({ keys: {}, settings: { demoMode: true } });
    expect(c.snapshot().state).toBe('idle');
    await c.sendText('demo please');
    await waitFor(() => audio.some((x) => x.type === 'endOfStream'), 5000);
    const turnId = pcmCmds(audio)[0]!.turnId;
    c.onAudioEvent({ type: 'playbackStarted', turnId });
    c.onAudioEvent({ type: 'playbackDrained', turnId });
    expect(usage.verification().liveConversation).toBe(false);
  });

  it('suspend (sleep/lock) stops everything and leaves the mic off', async () => {
    const { c, audio } = await makeController({ settings: { activation: { mode: 'handsfree' } } });
    c.arm(true);
    c.suspend();
    expect(audio.at(-1)).toEqual({ type: 'stopCapture' });
    expect(c.snapshot()).toMatchObject({ armed: false, micActive: false, state: 'idle' });
  });
});
