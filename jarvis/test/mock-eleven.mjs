// Stand-in for the ElevenLabs API so the voice pipeline can be tested without a key or credits.
// Accepts the key "test-key"; anything else gets the same 401 shape the real API returns.
import http from 'node:http';

// One silent MPEG-1 Layer III frame (128 kbps, 44.1 kHz): valid audio a browser will play.
function silentMp3(seconds) {
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  return Buffer.concat(Array.from({ length: Math.ceil(seconds * 38.28) }, () => frame));
}

export function startMockEleven() {
  const calls = { tts: [], stt: 0, voices: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    // Mirrors real responses seen from api.elevenlabs.io: the key's ID pasted instead of the key gives a 400, a wrong key a 401.
    if (req.headers['xi-api-key'] === 'key-id-not-key') return send(400, { detail: { type: 'authentication_error', code: 'invalid_api_key', message: "API key ID used as API key - only valid API keys can be used. API keys start with 'sk_' and are shown when the key is created or rotated.", status: 'api_key_id_used_as_api_key' } });
    if (req.headers['xi-api-key'] !== 'test-key') return send(401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } });
    const tts = url.pathname.match(/^\/v1\/text-to-speech\/([^/]+)\/stream$/);
    if (tts && req.method === 'POST') {
      if (tts[1] === 'missing-voice') return send(404, { detail: { status: 'voice_not_found', message: 'A voice with that id was not found.' } });
      const j = JSON.parse(body.toString('utf8'));
      calls.tts.push({ voice: tts[1], text: j.text, model: j.model_id, format: url.searchParams.get('output_format') });
      const audio = silentMp3(Math.min(1.2, 0.25 + j.text.length * 0.012));
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      // Stream in pieces, like the real endpoint.
      for (let i = 0; i < audio.length; i += 4170) { res.write(audio.subarray(i, i + 4170)); await new Promise((r) => setTimeout(r, 15)); }
      return res.end();
    }
    if (url.pathname === '/v1/speech-to-text' && req.method === 'POST') {
      calls.stt++;
      const ok = /name="model_id"\r\n\r\nscribe_v2/.test(body.toString('latin1')) && /name="file"; filename=/.test(body.toString('latin1'));
      return ok ? send(200, { language_code: 'en', text: 'What is two plus two?', words: [] }) : send(422, { detail: { status: 'invalid', message: 'model_id and file are required' } });
    }
    if (url.pathname === '/v2/voices' || url.pathname === '/v1/voices') {
      calls.voices++;
      return send(200, { voices: [
        { voice_id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', category: 'premade', labels: { accent: 'british', gender: 'male' } },
        { voice_id: 'voice-two', name: 'Second Voice', category: 'cloned', labels: { accent: 'american', gender: 'female' } },
      ] });
    }
    send(404, { detail: 'not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}
