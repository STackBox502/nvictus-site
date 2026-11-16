// End-to-end test: real server + real Claude Code + a headless Chrome driving the real HUD.
// ElevenLabs is replaced by a local stand-in (test/mock-eleven.mjs); everything else is live.
// Needs Playwright (dev-only; not needed to run Jarvis).  Run:  node test/e2e.mjs [model]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockEleven } from './mock-eleven.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const model = process.argv[2] || 'haiku';
const shots = process.env.SHOTS || path.join(os.tmpdir(), 'jarvis-e2e-shots');
fs.mkdirSync(shots, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-e2e-'));
const home = path.join(tmp, 'workspace');
const brainDir = path.join(tmp, 'brain');
const w = (rel, text) => { const f = path.join(brainDir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
w('Brand Voice/tone-guide.md', '# Tone guide\nDirect, warm, zero filler. See [[content-pillars]].\n');
w('Brand Voice/content-pillars.md', '# Content pillars\n1. Practical AI\n2. Honest education\n');
w('Clients/acme/proposal.md', '# Proposal for Acme\nScope: AI literacy workshop. See [[tone-guide]].\n');
w('Clients/acme/notes.txt', 'Kickoff call on Tuesday.\n');
w('Finance/2026/q3-summary.md', '# Q3 summary\nPlaceholder numbers for the test fixture.\n');
for (let i = 0; i < 40; i++) w(`Archive/batch-${i % 5}/note-${i}.md`, `# Note ${i}\n`);

const mock = await startMockEleven();
// Settings live in a throwaway file so the test never touches the real jarvis/.env.
const envFile = path.join(tmp, 'test.env');
fs.writeFileSync(envFile, 'ELEVENLABS_API_KEY=test-key\n');
const port = 4800 + Math.floor(Math.random() * 150);
const serverLog = [];
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, JARVIS_ENV_FILE: envFile, JARVIS_DATA_DIR: path.join(tmp, 'data'), JARVIS_PORT: String(port), JARVIS_HOME: home, JARVIS_BRAIN_DIR: brainDir, JARVIS_NO_OPEN: '1', JARVIS_MODEL: model, JARVIS_ADDRESS: 'Captain', ELEVENLABS_BASE_URL: mock.url },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => serverLog.push(String(d)));
server.stderr.on('data', (d) => serverLog.push(String(d)));
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server did not start: ' + serverLog.join(''))), 20000);
  const poll = setInterval(() => { if (serverLog.join('').includes('is online')) { clearInterval(poll); clearTimeout(t); resolve(); } }, 100);
});

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + String(detail).slice(0, 220) : ''}`); };
const soft = (name, ok, detail = '') => console.log(`${ok ? 'PASS' : 'SKIP'}  ${name}${detail ? '  — ' + String(detail).slice(0, 220) : ''}`);

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 }, permissions: ['microphone'] });
const page = await ctx.newPage();
const consoleErrors = [];
const ttsResponses = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('response', (r) => { if (r.url().includes('/api/tts/')) ttsResponses.push({ status: r.status(), type: r.headers()['content-type'] }); });

const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) });
const J = (fn, arg) => page.evaluate(fn, arg);
const ask = async (text) => { await page.fill('#ask-input', text); await page.press('#ask-input', 'Enter'); };
// Wait for a whole turn: busy goes true, then false, and Jarvis has stopped speaking.
const turnDone = async (timeout = 150000) => {
  await page.waitForFunction(() => window.__jarvis.S.busy === true, null, { timeout: 15000 }).catch(() => {});
  await page.waitForFunction(() => window.__jarvis.S.busy === false && window.__jarvis.S.speaking === false && !window.__jarvis.S.approval, null, { timeout });
};

try {
  await page.goto(`http://localhost:${port}/`);
  await page.waitForSelector('#wake-go');
  await page.waitForFunction(() => window.__jarvis?.S.status, null, { timeout: 15000 });
  await shot('01-start');
  await page.click('#wake-go');
  await page.waitForFunction(() => window.__jarvis.galaxy.nodes.length > 0, null, { timeout: 15000 });
  const st = await J(() => window.__jarvis.S.status);
  check('HUD loads and connects', st && st.claude.found && !st.brain.fatal, `claude ${st.claude.version}`);
  check('second brain scanned into the galaxy', (await J(() => window.__jarvis.galaxy.nodes.length)) >= 45, `${await J(() => window.__jarvis.galaxy.nodes.length)} stars`);
  check('settings stay closed when a key is already saved', !(await J(() => document.getElementById('settings').open)));
  for (let i = 0; i < 60 && !mock.calls.tts.some((c) => /online/i.test(c.text)); i++) await page.waitForTimeout(250);
  check('greeting spoken through the ElevenLabs path', mock.calls.tts.some((c) => /online/i.test(c.text)), JSON.stringify(mock.calls.tts[0]));
  await page.waitForFunction(() => window.__jarvis.S.speaking === false, null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await shot('02-idle');

  // --- a spoken turn
  const tAsk = Date.now();
  const ttsBefore = mock.calls.tts.length;
  await ask('Reply with exactly this sentence and nothing else: Systems check complete, Captain.');
  for (let i = 0; i < 600 && mock.calls.tts.length === ttsBefore; i++) await page.waitForTimeout(50);
  console.log(`info  time from request to first words sent to the voice: ${Date.now() - tAsk} ms (${model})`);
  await turnDone();
  const cap1 = await page.textContent('#caption');
  check('Claude answers and the caption shows it', /systems check complete/i.test(cap1), cap1);
  check('reply went to ElevenLabs with the right voice + model', mock.calls.tts.some((c) => /systems check complete/i.test(c.text) && c.voice === 'JBFqnCBsd6RMkjVDRZzb' && c.model === 'eleven_flash_v2_5' && c.format === 'mp3_44100_128'), JSON.stringify(mock.calls.tts.at(-1)));
  check('browser fetched streamed audio', ttsResponses.some((r) => r.status === 200 && /audio\/mpeg/.test(r.type || '')), JSON.stringify(ttsResponses.slice(-2)));
  const st2 = await J(() => window.__jarvis.S.status);
  console.log(`info  model=${st2.brain.model}  connectors=${JSON.stringify((st2.connectors || []).map((c) => `${c.name}:${c.status}`)).slice(0, 600)}`);

  // --- wake word logic (the transcript handler is what speech recognition feeds)
  await J(() => window.__jarvis.handleTranscript('I was just talking about lunch with someone'));
  await page.waitForTimeout(600);
  check('speech without the wake word is ignored', (await J(() => window.__jarvis.S.busy)) === false);
  await J(() => window.__jarvis.handleTranscript('Hey Jarvis, reply with exactly: Wake word received.'));
  await turnDone();
  check('wake word triggers a turn', /wake word received/i.test(await page.textContent('#caption')), await page.textContent('#caption'));

  // --- hold to talk: real microphone recorder (fake device) -> transcription -> a turn
  await page.dispatchEvent('#btn-mic', 'pointerdown', { pointerId: 1, button: 0 });
  await page.waitForTimeout(1300);
  await page.dispatchEvent('#btn-mic', 'pointerup', { pointerId: 1, button: 0 });
  await page.waitForFunction(() => /two plus two/i.test(document.getElementById('heard').textContent), null, { timeout: 15000 }).catch(() => {});
  check('hold-to-talk records and transcribes through ElevenLabs', mock.calls.stt === 1 && /two plus two/i.test(await page.textContent('#heard')), `stt calls=${mock.calls.stt} heard=${await page.textContent('#heard')}`);
  await turnDone();
  check('the transcribed question gets answered', /\b(4|four)\b/i.test(await page.textContent('#caption')), await page.textContent('#caption'));

  // --- second brain
  await ask('Pull up my brand voice files.');
  await turnDone();
  const focused = await J(() => (window.__jarvis.galaxy.focusIds ? window.__jarvis.galaxy.focusIds.size : 0));
  check('"pull up" lights up files in the galaxy', focused >= 2 && !(await J(() => document.getElementById('panel').hidden)), `${focused} highlighted; panel: ${(await page.textContent('#panel-title'))}`);
  await shot('03-pull-up');
  await page.click('#panel-close');

  // --- workshop
  await ask('Build a simple desk lamp in the workshop: base, arm, shade and a glowing bulb. Keep it quick.');
  await turnDone(240000);
  const parts = await J(() => [...window.__jarvis.workshop.parts.keys()]);
  check('workshop builds a 3D model from named parts', parts.length >= 3 && !(await J(() => document.getElementById('workshop').hidden)), parts.join(', '));
  await page.waitForTimeout(1500);
  await shot('04-workshop');
  await ask('Pull it apart.');
  await turnDone();
  check('"pull it apart" explodes the model', await J(() => window.__jarvis.workshop.exploded === true));
  await page.waitForTimeout(1600);
  await shot('05-exploded');
  await ask('Make the shade red.');
  await turnDone(180000);
  const parts2 = await J(() => [...window.__jarvis.workshop.parts.keys()]);
  check('voice edit keeps the model and patches it', parts2.length >= parts.length - 1 && parts2.length <= parts.length + 2, parts2.join(', '));
  await shot('06-edited');
  await page.click('#ws-close');

  // --- approval gate
  const dir = path.join(tmp, 'made-by-jarvis');
  await ask(`Use the Bash tool to run exactly this command: mkdir "${dir}"`);
  await page.waitForSelector('#approval:not([hidden])', { timeout: 90000 });
  await shot('07-approval');
  check('risky action shows an approval card first', !fs.existsSync(dir), await page.textContent('#ap-summary'));
  await page.click('#ap-allow');
  await turnDone();
  check('approved action runs', fs.existsSync(dir));

  const dir2 = path.join(tmp, 'never-made');
  await ask(`Use the Bash tool to run exactly this command: mkdir "${dir2}"`);
  await page.waitForSelector('#approval:not([hidden])', { timeout: 90000 });
  await page.click('#ap-deny');
  await turnDone();
  check('denied action does not run', !fs.existsSync(dir2), await page.textContent('#caption'));

  // --- interrupt
  await ask('Count from 1 to 300, one number per sentence, speaking each number.');
  await page.waitForFunction(() => document.getElementById('caption').textContent.length > 10, null, { timeout: 60000 });
  const t0 = Date.now();
  await page.click('#ask-stop');
  await page.waitForFunction(() => window.__jarvis.S.busy === false && window.__jarvis.S.speaking === false, null, { timeout: 15000 });
  check('Stop interrupts speech and thinking', Date.now() - t0 < 12000, `${Date.now() - t0}ms`);
  await ask('Reply with exactly: Still here.');
  await turnDone();
  check('conversation continues after an interrupt', /still here/i.test(await page.textContent('#caption')), await page.textContent('#caption'));

  // --- barge-in: a new spoken request replaces the task in progress
  await ask('Count from 1 to 300, one number per sentence, speaking each number.');
  await page.waitForFunction(() => document.getElementById('caption').textContent.length > 10, null, { timeout: 60000 });
  await J(() => window.__jarvis.handleTranscript('Jarvis, reply with exactly: Switched tasks.'));
  await page.waitForFunction(() => /switched tasks/i.test(document.getElementById('caption').textContent), null, { timeout: 60000 }).catch(() => {});
  await turnDone();
  const capB = await page.textContent('#caption');
  check('saying "Jarvis, ..." mid-task switches to the new request', /switched tasks/i.test(capB) && !/\b(4[0-9]|[5-9][0-9]|[12][0-9][0-9])\b/.test(capB), capB);

  // --- screen sharing (needs a capturable display; skipped where the test machine has none)
  await page.click('#btn-screen');
  const sharing = await page.waitForFunction(() => document.getElementById('btn-screen').getAttribute('aria-pressed') === 'true', null, { timeout: 8000 }).then(() => true).catch(() => false);
  if (sharing) {
    await page.waitForTimeout(1500);
    await ask('Look at my screen and tell me in one short sentence what you see.');
    await turnDone();
    const said = await page.textContent('#caption');
    check('Jarvis can see the shared screen', said.length > 20 && !/sharing is off|can.?t see|cannot see/i.test(said), said);
    await shot('08-screen');
    await page.click('#btn-screen');
  } else soft('screen sharing', false, 'this headless browser has no display to capture — covered by test/live-protocol.mjs instead');

  // --- settings + voice failure handling
  await page.click('#btn-settings');
  await page.waitForSelector('#settings[open]');
  await page.waitForFunction(() => document.querySelectorAll('#set-voice option').length >= 2, null, { timeout: 10000 });
  await shot('09-settings');
  check('settings list voices from the account', (await page.$$eval('#set-voice option', (o) => o.map((x) => x.textContent))).some((t) => /George/.test(t)));
  await page.fill('#set-key', 'wrong-key');
  await page.click('#set-save');
  await page.waitForFunction(() => /failed|rejected/i.test(document.getElementById('set-status').textContent + document.getElementById('set-voice-result').textContent), null, { timeout: 15000 });
  check('a bad ElevenLabs key is reported clearly', /rejected the API key/i.test(await page.textContent('#set-voice-result')), await page.textContent('#set-voice-result'));
  await page.fill('#set-key', 'test-key');
  await page.click('#set-save');
  await page.waitForFunction(() => /working/i.test(document.getElementById('set-voice-result').textContent), null, { timeout: 15000 });
  check('fixing the key restores the voice', true);
  check('key is stored outside the page', !(await page.content()).includes('test-key'));
  await page.keyboard.press('Escape');

  check('no browser console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} catch (e) {
  check('run completed', false, e.message);
  await shot('99-failure').catch(() => {});
  console.log('--- console errors\n' + consoleErrors.slice(0, 8).join('\n'));
  console.log('--- server log tail\n' + serverLog.join('').split('\n').slice(-25).join('\n'));
} finally {
  await browser.close();
  server.kill('SIGINT');
  mock.server.close();
  setTimeout(() => {
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\nscreenshots: ${shots}`);
    console.log(failed ? `${failed} check(s) failed` : `All ${results.length} end-to-end checks passed`);
    process.exit(failed ? 1 : 0);
  }, 1200);
}
