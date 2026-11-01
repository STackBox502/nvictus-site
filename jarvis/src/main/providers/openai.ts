import { ProviderError, classifyHttp, classifyThrown, userMessage } from '../../shared/errors';
import { readSSE } from '../../shared/sse';
import { getJson, linkedAbort, malformed, readErrorText, timeoutError, type FetchFn, type LlmAdapter, type LlmEvent, type LlmRequest } from './types';

const BASE = 'https://api.openai.com/v1';

/** OpenAI Responses API with SSE streaming. Uses store:false so responses are not retained for later retrieval. */
export class OpenAIAdapter implements LlmAdapter {
  readonly id = 'openai' as const;
  constructor(
    private readonly getKey: () => string | undefined,
    private readonly fetchFn: FetchFn,
  ) {}

  private headers(key: string): Record<string, string> {
    return { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const key = this.getKey();
    if (!key) throw new ProviderError('not_configured', userMessage('not_configured', 'openai'), 'openai');
    const json = (await getJson(this.fetchFn, `${BASE}/models`, this.headers(key), 'openai', signal)) as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(json.data)) throw malformed('openai', 'model list missing');
    return json.data
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string')
      .filter((id) => /^(gpt|o\d|chatgpt)/.test(id))
      .filter((id) => !/embedding|whisper|tts|dall-e|image|audio|realtime|transcribe|search|moderation|computer-use|sora|instruct/.test(id))
      .sort();
  }

  async *stream(req: LlmRequest): AsyncGenerator<LlmEvent> {
    const key = this.getKey();
    if (!key) throw new ProviderError('not_configured', userMessage('not_configured', 'openai'), 'openai');
    const ctl = linkedAbort(req.signal, req.idleTimeoutMs);
    try {
      const body: Record<string, unknown> = {
        model: req.model,
        instructions: req.system,
        input: req.messages.map((m) => ({ role: m.role, content: m.content })),
        max_output_tokens: req.maxTokens,
        stream: true,
        store: false,
      };
      if (req.reasoningEffort) body.reasoning = { effort: req.reasoningEffort };
      let res: Response;
      try {
        res = await this.fetchFn(`${BASE}/responses`, { method: 'POST', headers: this.headers(key), body: JSON.stringify(body), signal: ctl.signal });
      } catch (err) {
        if (req.signal.aborted) return;
        throw ctl.timedOut() ? timeoutError('openai') : classifyThrown(err, 'openai');
      }
      if (!res.ok) throw classifyHttp(res.status, await readErrorText(res), 'openai');
      if (!res.body) throw malformed('openai', 'empty body');
      let finished = false;
      try {
        for await (const ev of readSSE(res.body, ctl.signal)) {
          ctl.touch();
          if (ev.data === '[DONE]') break;
          let data: Record<string, any>;
          try {
            data = JSON.parse(ev.data) as Record<string, any>;
          } catch {
            throw malformed('openai', 'invalid event JSON');
          }
          switch (data.type) {
            case 'response.output_text.delta':
              if (typeof data.delta === 'string' && data.delta) yield { type: 'text', text: data.delta };
              break;
            case 'response.completed':
            case 'response.incomplete': {
              const u = data.response?.usage;
              if (u) yield { type: 'usage', inputTokens: u.input_tokens, outputTokens: u.output_tokens };
              const reason = data.type === 'response.incomplete' ? String(data.response?.incomplete_details?.reason ?? 'incomplete') : 'completed';
              yield { type: 'done', stopReason: reason };
              finished = true;
              break;
            }
            case 'response.failed': {
              const e = data.response?.error ?? {};
              throw classifyHttp(e.code === 'rate_limit_exceeded' ? 429 : e.code === 'server_error' ? 500 : 400, `${e.code ?? ''} ${e.message ?? ''}`, 'openai');
            }
            case 'error':
              throw classifyHttp(
                data.code === 'rate_limit_exceeded' ? 429 : /server/.test(String(data.code)) ? 500 : 400,
                `${data.code ?? ''} ${data.message ?? ''}`,
                'openai',
              );
            default:
              break;
          }
        }
      } catch (err) {
        if (req.signal.aborted) return;
        if (err instanceof ProviderError) throw err;
        throw ctl.timedOut() ? timeoutError('openai') : classifyThrown(err, 'openai');
      }
      if (req.signal.aborted) return;
      if (!finished) throw malformed('openai', 'stream ended before response.completed');
    } finally {
      ctl.dispose();
    }
  }
}

export function suggestOpenAIModel(ids: string[]): string {
  const mini = ids.filter((i) => /^gpt-[\d.]+-mini$/.test(i)).sort().reverse()[0];
  return mini ?? ids.find((i) => i.includes('mini')) ?? ids.find((i) => i.startsWith('gpt')) ?? ids[0] ?? '';
}
