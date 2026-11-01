// Redaction for anything that may leave memory: logs, errors shown in UI, diagnostics exports.

const PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED_ANTHROPIC_KEY]'],
  [/sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}/g, '[REDACTED_OPENAI_KEY]'],
  [/\bsk_[A-Za-z0-9]{20,}/g, '[REDACTED_ELEVENLABS_KEY]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 [REDACTED]'],
  [/("?(?:xi-api-key|x-api-key|authorization|api[_-]?key|xi_api_key|token)"?\s*[:=]\s*"?)([^\s"',}&]+)/gi, '$1[REDACTED]'],
  [/([?&](?:token|key|api_key|xi_api_key|access_token)=)[^&\s#]+/gi, '$1[REDACTED]'],
];

export function redact(input: unknown, knownSecrets: readonly string[] = []): string {
  let s = typeof input === 'string' ? input : safeStringify(input);
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 8) s = s.split(secret).join('[REDACTED]');
  }
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  return s;
}

function safeStringify(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Mask a secret for display: only the last 4 characters are shown. */
export function maskSecret(value: string | undefined): string {
  if (!value) return '';
  return `••••${value.slice(-4)}`;
}
