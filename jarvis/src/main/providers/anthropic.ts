import { ProviderError, classifyHttp, classifyThrown, userMessage } from '../../shared/errors';
import { readSSE } from '../../shared/sse';
import { getJson, linkedAbort, malformed, readErrorText, timeoutError, type FetchFn, type LlmAdapter, type LlmEvent, type LlmRequest } from './types';

const BASE = 'https://api.anthropic.com/v1';
const VERSION = '2023-06-01';

function mapStreamError(type: string, message: string): ProviderError {
  switch (type) {
    case 'overloaded_error':
    case 'api_error':
      return new ProviderError('outage', userMessage('outage', 'anthropic'), 'anthropic');
    case 'rate_limit_error':
      return new ProviderError('rate_limit', userMessage('rate_limit', 'anthropic'), 'anthropic');
    case 'authentication_error':
    case 'permission_error':
      return new ProviderError('auth', userMessage('auth', 'anthropic'), 'anthropic');
    case 'billing_error':
      return new ProviderError('credits', userMessage('credits', 'anthropic'), 'anthropic');
    default:
      return classifyHttp(400, message, 'anthropic');
  }
}

/** Anthropic Messages API with SSE streaming (raw fetch; no SDK dependency). */
export class AnthropicAdapter implements LlmAdapter {
  readonly id = 'anthropic' as const;
  constructor(
    private readonly getKey: () => string | undefined,
    private readonly fetchFn: FetchFn,
  ) {}

  private headers(key: string): Record<string, string> {
    return { 'x-api-key': key, 'anthropic-version': VERSION, 'content-type': 'application/json' };
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const key = this.getKey();
    if (!key) throw new ProviderError('not_configured', userMessage('not_configured', 'anthropic'), 'anthropic');
    const json = (await getJson(this.fetchFn, `${BASE}/models?limit=100`, this.headers(key), 'anthropic', signal)) as {
      data?: Array<{ id?: unknown }>;
    };
    if (!Array.isArray(json.data)) throw malformed('anthropic', 'model list missing');
    return json.data.map((m) => m.id).filter((id): id is string => typeof id === 'string');
  }

  async *stream(req: LlmRequest): AsyncGenerator<LlmEvent> {
    const key = this.getKey();
    if (!key) throw new ProviderError('not_configured', userMessage('not_configured', 'anthropic'), 'anthropic');
    const ctl = linkedAbort(req.signal, req.idleTimeoutMs);
    try {
      let res: Response;
      try {
        res = await this.fetchFn(`${BASE}/messages`, {
          method: 'POST',
          headers: this.headers(key),
          body: JSON.stringify({ model: req.model, max_tokens: req.maxTokens, system: req.system, messages: req.messages, stream: true }),
          signal: ctl.signal,
        });
      } catch (err) {
        if (req.signal.aborted) return;
        throw ctl.timedOut() ? timeoutError('anthropic') : classifyThrown(err, 'anthropic');
      }
      if (!res.ok) throw classifyHttp(res.status, await readErrorText(res), 'anthropic');
      if (!res.body) throw malformed('anthropic', 'empty body');
      let finished = false;
      try {
        for await (const ev of readSSE(res.body, ctl.signal)) {
          ctl.touch();
          let data: Record<string, any>;
          try {
            data = JSON.parse(ev.data) as Record<string, any>;
          } catch {
            throw malformed('anthropic', 'invalid event JSON');
          }
          switch (data.type) {
            case 'message_start': {
              const u = data.message?.usage;
              if (u && typeof u.input_tokens === 'number') yield { type: 'usage', inputTokens: u.input_tokens };
              break;
            }
            case 'content_block_delta':
              if (data.delta?.type === 'text_delta' && typeof data.delta.text === 'string' && data.delta.text) {
                yield { type: 'text', text: data.delta.text };
              }
              break;
            case 'message_delta': {
              const u = data.usage;
              if (u && typeof u.output_tokens === 'number') yield { type: 'usage', outputTokens: u.output_tokens };
              if (data.delta?.stop_reason) yield { type: 'done', stopReason: String(data.delta.stop_reason) };
              break;
            }
            case 'message_stop':
              finished = true;
              break;
            case 'error':
              throw mapStreamError(String(data.error?.type ?? ''), String(data.error?.message ?? ''));
            default:
              break; // ping, content_block_start/stop, future event types
          }
        }
      } catch (err) {
        if (req.signal.aborted) return;
        if (err instanceof ProviderError) throw err;
        throw ctl.timedOut() ? timeoutError('anthropic') : classifyThrown(err, 'anthropic');
      }
      if (req.signal.aborted) return;
      if (!finished) throw malformed('anthropic', 'stream ended before message_stop');
    } finally {
      ctl.dispose();
    }
  }
}

/** Prefers a low-latency model when it exists in the account's model list. Never invents IDs. */
export function suggestAnthropicModel(ids: string[]): string {
  if (ids.includes('claude-haiku-5-5')) return 'claude-haiku-5-5';
  const haiku = ids.filter((i) => i.includes('haiku')).sort().reverse()[0];
  return haiku ?? ids[0] ?? '';
}
