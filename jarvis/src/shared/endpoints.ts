// Allowlist of the only network destinations the app may contact.

export const PROVIDER_HOSTS = {
  anthropic: 'api.anthropic.com',
  openai: 'api.openai.com',
  elevenlabs: 'api.elevenlabs.io',
} as const;

const ALLOWED = new Set<string>(Object.values(PROVIDER_HOSTS));

export function assertAllowedUrl(raw: string, protocols: readonly string[] = ['https:']): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Blocked request: invalid URL');
  }
  if (!protocols.includes(url.protocol)) throw new Error(`Blocked request: protocol ${url.protocol} not allowed`);
  if (!ALLOWED.has(url.hostname)) throw new Error(`Blocked request: host ${url.hostname} is not on the provider allowlist`);
  if (url.username || url.password) throw new Error('Blocked request: credentials in URL');
  if (url.port && url.port !== '443') throw new Error('Blocked request: non-standard port');
  return url;
}

/** External links the UI may open (by key only; the renderer never supplies a URL). */
export const EXTERNAL_LINKS = {
  anthropicKeys: 'https://platform.claude.com/settings/keys',
  anthropicBilling: 'https://platform.claude.com/settings/billing',
  openaiKeys: 'https://platform.openai.com/api-keys',
  openaiBilling: 'https://platform.openai.com/settings/organization/billing/overview',
  elevenlabsKeys: 'https://elevenlabs.io/app/settings/api-keys',
  elevenlabsUsage: 'https://elevenlabs.io/app/usage',
  elevenlabsVoices: 'https://elevenlabs.io/app/voice-library',
  pythonDownload: 'https://www.python.org/downloads/windows/',
  nodeDownload: 'https://nodejs.org/en/download',
  gitDownload: 'https://git-scm.com/downloads/win',
  openWakeWord: 'https://github.com/dscripka/openWakeWord',
} as const;

export type ExternalLinkKey = keyof typeof EXTERNAL_LINKS;
