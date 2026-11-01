import { ProviderError, userMessage } from '../../shared/errors';
import type { TtsModelInfo, VoiceInfo } from '../../shared/types';
import { getJson, malformed, type FetchFn } from '../providers/types';

const BASE = 'https://api.elevenlabs.io';

function need(key: string | undefined): string {
  if (!key) throw new ProviderError('not_configured', userMessage('not_configured', 'elevenlabs'), 'elevenlabs');
  return key;
}

/** Lists voices available to the account (free metadata call; no characters consumed). */
export async function listVoices(fetchFn: FetchFn, apiKey: string | undefined): Promise<VoiceInfo[]> {
  const key = need(apiKey);
  const out: VoiceInfo[] = [];
  let token: string | undefined;
  for (let page = 0; page < 5; page++) {
    const url = `${BASE}/v2/voices?page_size=100${token ? `&next_page_token=${encodeURIComponent(token)}` : ''}`;
    const json = (await getJson(fetchFn, url, { 'xi-api-key': key }, 'elevenlabs')) as {
      voices?: Array<{ voice_id?: unknown; name?: unknown; category?: unknown }>;
      has_more?: boolean;
      next_page_token?: string | null;
    };
    if (!Array.isArray(json.voices)) throw malformed('elevenlabs', 'voice list missing');
    for (const v of json.voices) {
      if (typeof v.voice_id === 'string' && typeof v.name === 'string') {
        out.push({ id: v.voice_id, name: v.name, category: typeof v.category === 'string' ? v.category : undefined });
      }
    }
    if (!json.has_more || !json.next_page_token) break;
    token = json.next_page_token;
  }
  return out;
}

/** Confirms a pasted voice ID exists for this account (free metadata call). */
export async function validateVoice(fetchFn: FetchFn, apiKey: string | undefined, voiceId: string): Promise<VoiceInfo> {
  const key = need(apiKey);
  const json = (await getJson(fetchFn, `${BASE}/v1/voices/${encodeURIComponent(voiceId)}`, { 'xi-api-key': key }, 'elevenlabs')) as {
    voice_id?: unknown;
    name?: unknown;
    category?: unknown;
  };
  if (typeof json.voice_id !== 'string' || typeof json.name !== 'string') throw malformed('elevenlabs', 'voice details missing');
  return { id: json.voice_id, name: json.name, category: typeof json.category === 'string' ? json.category : undefined };
}

/** Lists TTS-capable models with their supported voice settings (free metadata call). */
export async function listTtsModels(fetchFn: FetchFn, apiKey: string | undefined): Promise<TtsModelInfo[]> {
  const key = need(apiKey);
  const json = (await getJson(fetchFn, `${BASE}/v1/models`, { 'xi-api-key': key }, 'elevenlabs')) as Array<{
    model_id?: unknown;
    name?: unknown;
    can_do_text_to_speech?: unknown;
    can_use_style?: unknown;
    can_use_speaker_boost?: unknown;
    requires_alpha_access?: unknown;
  }>;
  if (!Array.isArray(json)) throw malformed('elevenlabs', 'model list missing');
  return json
    .filter((m) => m.can_do_text_to_speech === true && m.requires_alpha_access !== true && typeof m.model_id === 'string')
    .map((m) => ({
      id: m.model_id as string,
      name: typeof m.name === 'string' ? m.name : (m.model_id as string),
      canUseStyle: m.can_use_style === true,
      canUseSpeakerBoost: m.can_use_speaker_boost === true,
    }));
}
