// ElevenLabs voice: streaming text-to-speech for Jarvis's replies and speech-to-text for push-to-talk.
// The API key stays on this machine (jarvis/.env) and is only ever sent to api.elevenlabs.io.

export class VoiceError extends Error {
  constructor(message, { status = 0, code = 'voice_error' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function explain(res) {
  // Real ElevenLabs errors look like { detail: { type, code, status, message } }; older ones use a plain string.
  let detail = '', tag = '';
  try {
    const body = await res.text();
    try {
      const j = JSON.parse(body);
      const d = j.detail ?? j;
      if (typeof d === 'string') detail = d;
      else {
        detail = d?.message || j.message || body.slice(0, 200);
        tag = [d?.type, d?.code, d?.status].filter(Boolean).join(' ');
      }
    } catch { detail = body.slice(0, 200); }
  } catch { /* ignore */ }
  const s = res.status;
  const hint = `${tag} ${detail}`;
  let code = 'elevenlabs_error';
  let msg = `ElevenLabs returned ${s}${detail ? ': ' + detail : ''}`;
  if (s === 401 || /invalid_api_key|authentication_error|api_key|unauthorized|needs_authorization/i.test(tag)) {
    code = 'bad_key';
    msg = `ElevenLabs rejected the API key${detail ? ' (' + detail + ')' : ''}. Check the key in Settings.`;
  } else if (/missing_permissions|permission/i.test(hint)) {
    code = 'bad_key';
    msg = `This ElevenLabs key is not allowed to do that${detail ? ' (' + detail + ')' : ''}. Give the key Text to Speech, Speech to Text and Voices access.`;
  } else if (s === 402 || /quota|credit|payment_required|paid_plan/i.test(hint)) {
    code = 'quota';
    msg = `ElevenLabs credits are used up or the plan does not cover this${detail ? ' (' + detail + ')' : ''}.`;
  } else if (s === 404 || /voice_not_found|voice.*not.*found/i.test(hint)) {
    code = 'bad_voice';
    msg = 'That ElevenLabs voice was not found on this account. Pick another voice in Settings.';
  } else if (s === 429) {
    code = 'rate_limited';
    msg = 'ElevenLabs is rate-limiting requests; slowing down.';
  }
  return new VoiceError(msg, { status: s, code });
}

export function createVoice(getCfg) {
  const headers = (extra = {}) => ({ 'xi-api-key': getCfg().elevenKey, ...extra });

  return {
    enabled: () => !!getCfg().elevenKey,

    // Returns a fetch Response whose body is an MP3 stream.
    async speak(text, { signal } = {}) {
      const cfg = getCfg();
      if (!cfg.elevenKey) throw new VoiceError('No ElevenLabs key set.', { code: 'no_key' });
      const url = `${cfg.elevenBase}/v1/text-to-speech/${encodeURIComponent(cfg.elevenVoice)}/stream?output_format=mp3_44100_128`;
      const res = await fetch(url, {
        method: 'POST',
        signal,
        headers: headers({ 'content-type': 'application/json', accept: 'audio/mpeg' }),
        body: JSON.stringify({ text, model_id: cfg.elevenModel }),
      });
      if (!res.ok) throw await explain(res);
      return res;
    },

    // Buffer of recorded audio -> transcript text.
    async transcribe(buffer, mime = 'audio/webm') {
      const cfg = getCfg();
      if (!cfg.elevenKey) throw new VoiceError('No ElevenLabs key set.', { code: 'no_key' });
      const ext = mime.includes('mp4') ? 'mp4' : mime.includes('ogg') ? 'ogg' : mime.includes('wav') ? 'wav' : 'webm';
      const form = new FormData();
      form.append('model_id', cfg.elevenSttModel);
      form.append('tag_audio_events', 'false');
      form.append('file', new Blob([buffer], { type: mime }), `speech.${ext}`);
      const res = await fetch(`${cfg.elevenBase}/v1/speech-to-text`, { method: 'POST', headers: headers(), body: form });
      if (!res.ok) throw await explain(res);
      const j = await res.json();
      return String(j.text || '').trim();
    },

    async voices() {
      const cfg = getCfg();
      if (!cfg.elevenKey) throw new VoiceError('No ElevenLabs key set.', { code: 'no_key' });
      let res = await fetch(`${cfg.elevenBase}/v2/voices?page_size=100`, { headers: headers() });
      if (res.status === 404) res = await fetch(`${cfg.elevenBase}/v1/voices`, { headers: headers() });
      if (!res.ok) throw await explain(res);
      const j = await res.json();
      return (j.voices || []).map((v) => ({
        id: v.voice_id,
        name: v.name,
        category: v.category || '',
        accent: v.labels?.accent || '',
        gender: v.labels?.gender || '',
        description: v.labels?.description || v.labels?.descriptive || '',
        preview: v.preview_url || '',
      }));
    },

    // Cheapest real proof that the key + voice + model work: synthesise two words and read the first bytes.
    async check() {
      const cfg = getCfg();
      if (!cfg.elevenKey) return { ok: false, code: 'no_key', message: 'No ElevenLabs API key saved yet.' };
      try {
        const res = await this.speak('Online.');
        const reader = res.body.getReader();
        const { value } = await reader.read();
        try { await reader.cancel(); } catch { /* ignore */ }
        if (!value || !value.length) return { ok: false, code: 'empty', message: 'ElevenLabs answered but sent no audio.' };
        return { ok: true, message: 'ElevenLabs voice is working.' };
      } catch (e) {
        return { ok: false, code: e.code || 'error', message: e.message };
      }
    },
  };
}

// Turns a stream of text deltas into speakable sentences. Skips code blocks and strips markdown,
// so Jarvis never reads symbols aloud.
export class SentenceStream {
  constructor(onSentence) {
    this.onSentence = onSentence;
    this.buf = '';
    this.inCode = false;
  }

  push(delta) {
    this.buf += delta;
    this.#drain(false);
  }

  flush() {
    this.#drain(true);
    this.buf = '';
    this.inCode = false;
  }

  #drain(final) {
    for (;;) {
      // Code fences: drop everything between ``` pairs.
      const fence = this.buf.indexOf('```');
      if (this.inCode) {
        if (fence < 0) { if (final) this.buf = ''; else this.buf = this.buf.slice(-2); return; }
        this.buf = this.buf.slice(fence + 3);
        this.inCode = false;
        continue;
      }
      const limit = fence >= 0 ? fence : this.buf.length;
      const head = this.buf.slice(0, limit);
      // Sentence boundary: . ! ? followed by whitespace, or a newline. Requiring whitespace keeps
      // "3.5" and "example.com" whole; the minimum length stops tiny fragments like "Mr." going out alone.
      let cut = -1;
      const re = /([.!?…]["')\]]?)\s+|\n+/g;
      let mm;
      while ((mm = re.exec(head))) {
        const end = mm.index + mm[0].length;
        const piece = head.slice(0, end).trim();
        if (piece.length >= 28 || /\n/.test(mm[0])) { cut = end; break; }
      }
      if (cut < 0 && head.length > 320) {
        const sp = head.lastIndexOf(' ', 300);
        cut = sp > 120 ? sp + 1 : 300;
      }
      if (cut < 0) {
        if (fence >= 0) { this.#emit(head); this.buf = this.buf.slice(fence + 3); this.inCode = true; continue; }
        if (final) { this.#emit(head); this.buf = ''; }
        return;
      }
      this.#emit(head.slice(0, cut));
      this.buf = this.buf.slice(cut);
    }
  }

  #emit(raw) {
    const clean = speakable(raw);
    if (clean) this.onSentence(clean);
  }
}

export function speakable(s) {
  return String(s)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/https?:\/\/\S+/g, ' a link ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/[*_~#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
