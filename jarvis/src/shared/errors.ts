export type ErrorCode =
  | 'auth'
  | 'credits'
  | 'rate_limit'
  | 'outage'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'bad_request'
  | 'invalid_model'
  | 'invalid_voice'
  | 'malformed'
  | 'not_configured'
  | 'budget'
  | 'mic_denied'
  | 'mic_missing'
  | 'device_lost'
  | 'stt_failed'
  | 'tts_failed'
  | 'unknown';

export type ServiceName = 'anthropic' | 'openai' | 'elevenlabs' | 'app' | 'demo';

const RETRYABLE: ReadonlySet<ErrorCode> = new Set(['rate_limit', 'outage', 'network', 'timeout']);

export class ProviderError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly service: ServiceName = 'app',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = RETRYABLE.has(code);
  }
}

const SERVICE_LABEL: Record<ServiceName, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  elevenlabs: 'ElevenLabs',
  app: 'Jarvis',
  demo: 'Demo',
};

export function userMessage(code: ErrorCode, service: ServiceName): string {
  const s = SERVICE_LABEL[service];
  switch (code) {
    case 'auth':
      return `${s} rejected the API key. Check or replace it in Setup.`;
    case 'credits':
      return `${s} reports insufficient credits or quota. Check billing in the ${s} dashboard.`;
    case 'rate_limit':
      return `${s} is rate-limiting requests. Wait a moment and retry.`;
    case 'outage':
      return `${s} is temporarily unavailable (server error). Retry shortly.`;
    case 'network':
      return `Could not reach ${s}. Check your internet connection.`;
    case 'timeout':
      return `${s} did not respond in time.`;
    case 'cancelled':
      return 'Cancelled.';
    case 'invalid_model':
      return `${s} does not recognise the selected model for this account. Pick another in Settings.`;
    case 'invalid_voice':
      return `${s} does not recognise the selected voice. Choose a voice available to your account.`;
    case 'malformed':
      return `${s} sent an incomplete or malformed response.`;
    case 'not_configured':
      return `${s} is not configured yet. Add a key in Setup.`;
    case 'budget':
      return 'Local usage limit reached. Raise it in Settings → Usage limits, or wait until tomorrow.';
    case 'mic_denied':
      return 'Microphone permission was denied. Allow microphone access for Jarvis in Windows Settings → Privacy & security → Microphone.';
    case 'mic_missing':
      return 'No microphone found. Connect one, then choose it in Settings → Input/Output.';
    case 'device_lost':
      return 'The microphone disconnected. Choose a microphone, then try again.';
    case 'stt_failed':
      return 'Speech recognition failed. Typed chat still works.';
    case 'tts_failed':
      return 'Voice unavailable for this reply. The text answer is shown.';
    case 'bad_request':
      return `${s} rejected the request.`;
    default:
      return `${s} returned an unexpected error.`;
  }
}

/** Classifies an HTTP error status plus body text into a stable error code. */
export function classifyHttp(status: number, body: string, service: ServiceName): ProviderError {
  const b = body.toLowerCase();
  const mk = (code: ErrorCode) => new ProviderError(code, userMessage(code, service), service, status);
  const mentionsCredits = /credit balance|insufficient_quota|quota_exceeded|exceeded your current quota|billing|payment required|insufficient credits|out of credits/.test(b);
  if (status === 401) return mk(mentionsCredits ? 'credits' : 'auth');
  if (status === 402) return mk('credits');
  if (status === 403) return mk(mentionsCredits ? 'credits' : 'auth');
  if (status === 408) return mk('timeout');
  if (status === 429) return mk(mentionsCredits ? 'credits' : 'rate_limit');
  if (status >= 500) return mk('outage');
  if (status === 400 || status === 404 || status === 422) {
    if (mentionsCredits) return mk('credits');
    if (/voice/.test(b) && /not found|does not exist|invalid|unknown/.test(b)) return mk('invalid_voice');
    if (/model/.test(b) && /not found|does not exist|invalid|not supported|unknown|access/.test(b)) return mk('invalid_model');
    if (status === 404) return mk(/voice/.test(b) ? 'invalid_voice' : 'invalid_model');
    return mk('bad_request');
  }
  return mk('unknown');
}

/** Classifies a thrown value (network failure, abort, timeout, ProviderError). */
export function classifyThrown(err: unknown, service: ServiceName): ProviderError {
  if (err instanceof ProviderError) return err;
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string } } | undefined;
  const name = e?.name ?? '';
  const msg = (e?.message ?? '').toLowerCase();
  if (name === 'TimeoutError' || msg.includes('timeout') || msg.includes('timed out'))
    return new ProviderError('timeout', userMessage('timeout', service), service);
  if (name === 'AbortError') return new ProviderError('cancelled', userMessage('cancelled', service), service);
  const code = e?.code ?? e?.cause?.code ?? '';
  if (
    name === 'TypeError' ||
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENETUNREACH|ETIMEDOUT|UND_ERR/.test(code) ||
    msg.includes('fetch failed') ||
    msg.includes('network')
  )
    return new ProviderError('network', userMessage('network', service), service);
  return new ProviderError('unknown', userMessage('unknown', service), service);
}
