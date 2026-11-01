import { describe, expect, it } from 'vitest';
import { AnthropicAdapter, suggestAnthropicModel } from '../src/main/providers/anthropic';
import { OpenAIAdapter, suggestOpenAIModel } from '../src/main/providers/openai';
import { guardedFetch, type FetchFn, type LlmEvent } from '../src/main/providers/types';
import { ProviderError } from '../src/shared/errors';

const enc = new TextEncoder();

function sse(lines: string[], opts: { delayMs?: number; signalHold?: boolean } = {}): Response {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (i < lines.length) ctrl.enqueue(enc.encode(lines[i++]!));
      else if (!opts.signalHold) ctrl.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const ev = (data: unknown, event?: string) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;

async function collect(gen: AsyncGenerator<LlmEvent>): Promise<LlmEvent[]> {
  const out: LlmEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const req = (signal = new AbortController().signal) => ({ model: 'm', system: 's', messages: [{ role: 'user' as const, content: 'hi' }], maxTokens: 100, signal, idleTimeoutMs: 2000 });

describe('Anthropic adapter', () => {
  it('streams normalized text and usage from Messages SSE', async () => {
    let sent: { url: string; init: RequestInit } | null = null;
    const fetchFn: FetchFn = async (url, init) => {
      sent = { url, init };
      return sse([
        ev({ type: 'message_start', message: { usage: { input_tokens: 12 } } }, 'message_start'),
        ev({ type: 'content_block_start', index: 0 }),
        ev({ type: 'ping' }),
        ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } }),
        ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: ' there.' } }),
        ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }),
        ev({ type: 'message_stop' }),
      ]);
    };
    const events = await collect(new AnthropicAdapter(() => 'sk-ant-test-key', fetchFn).stream(req()));
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe('Hello there.');
    expect(events).toContainEqual({ type: 'usage', inputTokens: 12 });
    expect(events).toContainEqual({ type: 'usage', outputTokens: 5 });
    const headers = sent!.init.headers as Record<string, string>;
    expect(sent!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(headers['x-api-key']).toBe('sk-ant-test-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(JSON.parse(sent!.init.body as string)).toMatchObject({ stream: true, system: 's', max_tokens: 100 });
  });
  it('maps HTTP errors (credits) and mid-stream overload errors', async () => {
    const credits: FetchFn = async () => new Response('{"error":{"message":"Your credit balance is too low"}}', { status: 400 });
    await expect(collect(new AnthropicAdapter(() => 'k'.repeat(20), credits).stream(req()))).rejects.toMatchObject({ code: 'credits' });
    const overloaded: FetchFn = async () => sse([ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } }), ev({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })]);
    await expect(collect(new AnthropicAdapter(() => 'k'.repeat(20), overloaded).stream(req()))).rejects.toMatchObject({ code: 'outage', retryable: true });
  });
  it('treats a stream without message_stop as malformed', async () => {
    const f: FetchFn = async () => sse([ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } })]);
    await expect(collect(new AnthropicAdapter(() => 'k'.repeat(20), f).stream(req()))).rejects.toMatchObject({ code: 'malformed' });
  });
  it('stops quietly on cancellation with no further events', async () => {
    const ctl = new AbortController();
    const f: FetchFn = async (_u, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'one' } })));
          init.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(body, { status: 200 });
    };
    const got: LlmEvent[] = [];
    for await (const e of new AnthropicAdapter(() => 'k'.repeat(20), f).stream(req(ctl.signal))) {
      got.push(e);
      ctl.abort();
    }
    expect(got).toEqual([{ type: 'text', text: 'one' }]);
  });
  it('times out an idle stream', async () => {
    const f: FetchFn = async (_u, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          init.signal?.addEventListener('abort', () => c.error(init.signal!.reason));
        },
      });
      return new Response(body, { status: 200 });
    };
    await expect(collect(new AnthropicAdapter(() => 'k'.repeat(20), f).stream({ ...req(), idleTimeoutMs: 50 }))).rejects.toMatchObject({ code: 'timeout' });
  });
  it('requires a key and suggests only models that exist', async () => {
    await expect(collect(new AnthropicAdapter(() => undefined, async () => new Response('')).stream(req()))).rejects.toBeInstanceOf(ProviderError);
    expect(suggestAnthropicModel(['claude-opus-5-5', 'claude-haiku-5-5'])).toBe('claude-haiku-5-5');
    expect(suggestAnthropicModel(['claude-x'])).toBe('claude-x');
    expect(suggestAnthropicModel([])).toBe('');
  });
});

describe('OpenAI adapter', () => {
  it('streams Responses API deltas with store:false and usage', async () => {
    let body: Record<string, unknown> = {};
    const f: FetchFn = async (url, init) => {
      expect(url).toBe('https://api.openai.com/v1/responses');
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test-openai-key');
      body = JSON.parse(init.body as string);
      return sse([
        ev({ type: 'response.created' }, 'response.created'),
        ev({ type: 'response.output_text.delta', delta: 'Hi ' }, 'response.output_text.delta'),
        ev({ type: 'response.output_text.delta', delta: 'Chris.' }, 'response.output_text.delta'),
        ev({ type: 'response.completed', response: { usage: { input_tokens: 9, output_tokens: 3 } } }, 'response.completed'),
      ]);
    };
    const events = await collect(new OpenAIAdapter(() => 'sk-test-openai-key', f).stream(req()));
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe('Hi Chris.');
    expect(events).toContainEqual({ type: 'usage', inputTokens: 9, outputTokens: 3 });
    expect(body).toMatchObject({ stream: true, store: false, instructions: 's', max_output_tokens: 100 });
    expect(body.reasoning).toBeUndefined();
  });
  it('maps insufficient_quota and response.failed', async () => {
    const q: FetchFn = async () => new Response('{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}', { status: 429 });
    await expect(collect(new OpenAIAdapter(() => 'k'.repeat(20), q).stream(req()))).rejects.toMatchObject({ code: 'credits' });
    const failed: FetchFn = async () => sse([ev({ type: 'response.failed', response: { error: { code: 'server_error', message: 'boom' } } })]);
    await expect(collect(new OpenAIAdapter(() => 'k'.repeat(20), failed).stream(req()))).rejects.toMatchObject({ code: 'outage' });
  });
  it('filters model lists to text models and suggests a mini model', async () => {
    const f: FetchFn = async () => new Response(JSON.stringify({ data: [{ id: 'gpt-5-mini' }, { id: 'text-embedding-3-small' }, { id: 'gpt-5' }, { id: 'whisper-1' }, { id: 'gpt-realtime' }] }), { status: 200 });
    const ids = await new OpenAIAdapter(() => 'k'.repeat(20), f).listModels();
    expect(ids).toEqual(['gpt-5', 'gpt-5-mini']);
    expect(suggestOpenAIModel(ids)).toBe('gpt-5-mini');
  });
});

describe('guarded fetch', () => {
  it('blocks non-allowlisted hosts before any request is made', async () => {
    let called = false;
    const g = guardedFetch(async () => {
      called = true;
      return new Response('');
    });
    expect(() => g('https://example.com/steal', {})).toThrow(/allowlist/);
    expect(called).toBe(false);
    await g('https://api.openai.com/v1/models', {});
    expect(called).toBe(true);
  });
});
