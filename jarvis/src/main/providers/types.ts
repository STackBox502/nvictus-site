import type { LlmMessage } from '../../shared/context';
import { assertAllowedUrl } from '../../shared/endpoints';
import { ProviderError, classifyHttp, classifyThrown, type ServiceName } from '../../shared/errors';
import type { ProviderId } from '../../shared/types';

export type LlmEvent =
  | { type: 'text'; text: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  | { type: 'done'; stopReason?: string };

export interface LlmRequest {
  model: string;
  system: string;
  messages: LlmMessage[];
  maxTokens: number;
  signal: AbortSignal;
  /** Abort if no bytes arrive for this long (first byte or between chunks). */
  idleTimeoutMs: number;
  reasoningEffort?: 'minimal' | 'low' | 'medium';
}

export interface LlmAdapter {
  readonly id: ProviderId | 'demo';
  stream(req: LlmRequest): AsyncGenerator<LlmEvent>;
  listModels(signal?: AbortSignal): Promise<string[]>;
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** Wraps fetch so only allowlisted provider hosts over HTTPS can be contacted. */
export function guardedFetch(impl: FetchFn): FetchFn {
  return (url, init) => {
    assertAllowedUrl(url);
    return impl(url, { ...init, redirect: 'error' });
  };
}

/** Child abort controller linked to a parent signal, with a resettable idle timeout. */
export function linkedAbort(parent: AbortSignal, idleMs: number) {
  const ctl = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onParent = () => ctl.abort(parent.reason);
  if (parent.aborted) ctl.abort(parent.reason);
  else parent.addEventListener('abort', onParent, { once: true });
  const touch = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      ctl.abort(new DOMException('Idle timeout', 'TimeoutError'));
    }, idleMs);
  };
  touch();
  return {
    signal: ctl.signal,
    touch,
    timedOut: () => timedOut,
    dispose: () => {
      if (timer) clearTimeout(timer);
      parent.removeEventListener('abort', onParent);
    },
  };
}

export async function readErrorText(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 4000);
  } catch {
    return '';
  }
}

export function timeoutError(service: ServiceName): ProviderError {
  return classifyThrown(new DOMException('timed out', 'TimeoutError'), service);
}

const LABEL: Record<ServiceName, string> = { anthropic: 'Anthropic', openai: 'OpenAI', elevenlabs: 'ElevenLabs', app: 'Jarvis', demo: 'Demo' };

export function malformed(service: ServiceName, detail: string): ProviderError {
  return new ProviderError('malformed', `${LABEL[service]} sent a malformed response: ${detail}.`, service);
}

export async function getJson(fetchFn: FetchFn, url: string, headers: Record<string, string>, service: ServiceName, signal?: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, { method: 'GET', headers, signal: signal ?? AbortSignal.timeout(15000) });
  } catch (err) {
    throw classifyThrown(err, service);
  }
  if (!res.ok) throw classifyHttp(res.status, await readErrorText(res), service);
  try {
    return await res.json();
  } catch {
    throw malformed(service, 'invalid JSON');
  }
}
