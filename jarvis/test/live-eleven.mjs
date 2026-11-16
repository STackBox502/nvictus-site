// Live ElevenLabs check: proves the real key, voice and models work end to end by speaking a
// sentence and transcribing it back. Uses a few dozen characters of your ElevenLabs quota.
// Run:  node test/live-eleven.mjs        (reads the key from jarvis/.env or ELEVENLABS_API_KEY)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { createVoice } from '../lib/voice.mjs';

const cfg = loadConfig();
const voice = createVoice(loadConfig);
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + String(detail).slice(0, 240) : ''}`); };

if (!cfg.elevenKey) { console.log('No ElevenLabs key found. Add it in the HUD Settings (or jarvis/.env) and run this again.'); process.exit(1); }
console.log(`voice ${cfg.elevenVoice} · speech model ${cfg.elevenModel} · transcription model ${cfg.elevenSttModel}\n`);

try {
  const sentence = 'Good evening. All systems are online and standing by.';
  const t0 = Date.now();
  const res = await voice.speak(sentence);
  let first = 0; const chunks = [];
  for await (const c of res.body) { if (!first) first = Date.now() - t0; chunks.push(Buffer.from(c)); }
  const mp3 = Buffer.concat(chunks);
  const isMp3 = mp3.subarray(0, 3).toString('latin1') === 'ID3' || (mp3[0] === 0xff && (mp3[1] & 0xe0) === 0xe0);
  check('text-to-speech streams MP3 audio', isMp3 && mp3.length > 8000, `${mp3.length} bytes, first audio after ${first} ms, content-type ${res.headers.get('content-type')}`);
  const out = path.join(os.tmpdir(), 'jarvis-voice-check.mp3');
  fs.writeFileSync(out, mp3);
  console.log(`info  saved to ${out} — play it to hear the voice`);

  const heard = await voice.transcribe(mp3, 'audio/mpeg');
  const want = sentence.toLowerCase().replace(/[^a-z ]/g, '').split(' ');
  const got = heard.toLowerCase().replace(/[^a-z ]/g, '').split(' ');
  const overlap = want.filter((w) => got.includes(w)).length / want.length;
  check('speech-to-text hears the same sentence back', overlap >= 0.8, `"${heard}"`);

  try {
    const voices = await voice.voices();
    check('voice list loads', voices.length > 0, `${voices.length} voices; current voice ${voices.some((v) => v.id === cfg.elevenVoice) ? 'is' : 'is NOT'} in the list (${voices.slice(0, 6).map((v) => v.name).join(', ')}…)`);
  } catch (e) {
    console.log(`note  voice list unavailable (${e.message}) — speech still works; the Settings voice picker will show only the current voice.`);
  }
} catch (e) {
  check('ElevenLabs call', false, `${e.code || ''} ${e.message}`);
}
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} check(s) failed` : '\nElevenLabs is working end to end');
process.exit(failed ? 1 : 0);
