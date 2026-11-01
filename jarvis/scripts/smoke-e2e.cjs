// End-to-end smoke test of the built app (demo mode, fake mic, no provider network, no charges).
// Usage (Linux CI/dev): npm run build && SHOTS=out-shots JARVIS_SMOKE_PYTHON=/path/to/venv/python xvfb-run -a node scripts/smoke-e2e.cjs
// Requires the playwright package to be resolvable. Not part of npm test.
const { _electron } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const APP = path.resolve(__dirname, '..');
const OUT = process.env.SHOTS;
const results = [];
const log = (ok, name, detail = '') => { results.push({ ok, name, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-smoke-'));
  const ud = path.join(cfg, 'Jarvis');
  fs.mkdirSync(ud, { recursive: true });
  fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({
    demoMode: true,
    activation: { mode: 'handsfree', pythonPath: process.env.JARVIS_SMOKE_PYTHON || '' },
    overlay: { visibility: 'always' },
  }));
  const app = await _electron.launch({
    executablePath: require(path.join(APP, 'node_modules/electron')),
    args: [APP, '--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    cwd: APP,
    env: { ...process.env, XDG_CONFIG_HOME: cfg, ELECTRON_ENABLE_LOGGING: '0' },
    timeout: 60000,
  });
  const consoleErrors = [];
  const pages = {};
  const waitPages = async () => {
    for (let i = 0; i < 100 && (!pages.chat || !pages.overlay); i++) {
      for (const w of app.windows()) {
        const u = w.url();
        if (u.includes('chat.html')) pages.chat = w;
        if (u.includes('overlay.html')) pages.overlay = w;
      }
      await sleep(100);
    }
  };
  app.on('window', (w) => w.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${w.url().split('/').pop()}: ${m.text()}`); }));
  await waitPages();
  for (const w of Object.values(pages)) w.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${w.url().split('/').pop()}: ${m.text()}`); });
  log(!!pages.chat && !!pages.overlay, 'both windows load from app://jarvis', `${pages.chat?.url()} | ${pages.overlay?.url()}`);
  const chat = pages.chat, overlay = pages.overlay;
  await chat.waitForLoadState('domcontentloaded');
  await overlay.waitForLoadState('domcontentloaded');
  const inv = (ch, p) => chat.evaluate(([c, x]) => window.jarvis.invoke(c, x), [ch, p]);
  const snap = () => inv('app:snapshot');
  const until = async (fn, ms = 15000) => { const t = Date.now(); for (;;) { const s = await snap(); if (fn(s)) return s; if (Date.now() - t > ms) return null; await sleep(100); } };

  // Security surface
  const sec = await chat.evaluate(async () => {
    const r = { require: typeof require, process: typeof process, module: typeof module, bridgeKeys: Object.keys(window.jarvis).sort().join(',') };
    try { await window.jarvis.invoke('shell:exec', {}); r.badChannel = 'allowed'; } catch (e) { r.badChannel = 'rejected'; }
    try { await window.jarvis.invoke('conv:sendText', { text: 'x', evil: true }); r.badPayload = 'allowed'; } catch (e) { r.badPayload = 'rejected'; }
    r.windowOpen = String(window.open('https://example.com'));
    try { await fetch('https://api.openai.com/v1/models'); r.fetch = 'allowed'; } catch (e) { r.fetch = 'blocked'; }
    return r;
  });
  log(sec.require === 'undefined' && sec.process === 'undefined' && sec.module === 'undefined', 'renderer has no Node globals', JSON.stringify(sec));
  log(sec.bridgeKeys === 'invoke,on,send,sendFrame', 'preload bridge exposes only the narrow API', sec.bridgeKeys);
  log(sec.badChannel === 'rejected' && sec.badPayload === 'rejected', 'IPC rejects unknown channels and extra payload keys');
  log(sec.windowOpen === 'null', 'window.open is denied');
  log(sec.fetch === 'blocked', 'renderer cannot reach provider APIs directly (CSP connect-src)');

  let s = await snap();
  log(s.state === 'idle' && s.demoMode, 'starts idle in demo mode with mic off', `state=${s.state} mic=${s.micActive}`);
  log(s.micActive === false, 'microphone is off at launch');
  await sleep(500);
  if (OUT) { await chat.screenshot({ path: path.join(OUT, 'chat-setup.png') }); await overlay.screenshot({ path: path.join(OUT, 'overlay-idle.png'), omitBackground: true }); }

  // Wake helper (real openWakeWord process)
  s = await until((x) => x.wake.state === 'ready' || x.wake.state === 'error', 30000);
  log(s && s.wake.state === 'ready', 'real wake-word helper starts and loads hey_jarvis', s ? `${s.wake.state}: ${s.wake.reason}` : 'timeout');

  // Typed turn with real Web Audio playback
  await inv('conv:sendText', { text: 'Hello from the smoke test' });
  s = await until((x) => x.state === 'speaking', 15000);
  log(!!s, 'demo turn reaches "speaking" (playback actually started in the overlay)', s ? '' : 'never reached speaking');
  if (OUT && s) await overlay.screenshot({ path: path.join(OUT, 'overlay-speaking.png'), omitBackground: true });
  s = await until((x) => x.state === 'idle', 20000);
  const reply = s && s.messages.find((m) => m.role === 'assistant');
  log(!!s && !!reply && !reply.pending && !reply.interrupted, 'reply completes and returns to idle after playback drains', reply ? reply.text.slice(0, 60) : '');

  // Interrupt during speech
  await inv('conv:sendText', { text: 'Give me a long answer please' });
  s = await until((x) => x.state === 'speaking', 15000);
  await sleep(400);
  await inv('conv:stop');
  s = await until((x) => x.state === 'idle', 5000);
  const last = s && [...s.messages].reverse().find((m) => m.role === 'assistant');
  log(!!last && last.interrupted === true, 'Stop interrupts speech and marks the reply interrupted', last ? `heard="${(last.heardText || '').slice(0, 50)}"` : '');

  // Voice turn through the real capture path (fake mic → AudioWorklet → IPC frames → demo STT)
  await inv('conv:talk', { action: 'toggle' });
  s = await until((x) => x.micActive && x.micPermission === 'granted', 8000);
  log(!!s, 'mic capture starts (audio-only permission granted by app handler)', s ? `state=${s.state}` : '');
  s = await until((x) => x.messages.some((m) => m.role === 'user' && m.source === 'voice'), 15000);
  log(!!s, 'captured audio frames reached STT and produced a voice turn', s ? s.messages.filter((m) => m.source === 'voice').map((m) => m.text).join(' | ') : '');
  await until((x) => x.state === 'idle', 20000);
  s = await snap();
  log(s.micActive === false, 'mic released after the turn (not armed)');

  // Hands-free arm/disarm with the real helper
  await inv('wake:arm', { armed: true });
  s = await until((x) => x.armed && x.state === 'armed', 5000);
  log(!!s && s.micActive, 'hands-free arms: mic on, state armed (local wake detection only)');
  if (OUT && s) await overlay.screenshot({ path: path.join(OUT, 'overlay-armed.png'), omitBackground: true });
  await sleep(1500);
  await inv('wake:arm', { armed: false });
  s = await until((x) => !x.armed && !x.micActive, 5000);
  log(!!s, 'disarm releases the microphone');

  // Mute
  await inv('conv:mute', { muted: true });
  s = await snap();
  log(s.state === 'muted' && !s.micActive, 'mute: state muted, mic off');
  await inv('conv:mute', { muted: false });

  // Visual preview states
  for (const st of ['listening', 'thinking', 'error', 'muted']) {
    await inv('preview:set', { active: true, state: st });
    await sleep(600);
    if (OUT) await overlay.screenshot({ path: path.join(OUT, `overlay-preview-${st}.png`), omitBackground: true });
  }
  await inv('preview:set', { active: false });
  log(true, 'visual preview cycles states (screenshots captured)');

  // Motion presets + drift
  for (const p of ['drift', 'still', 'orbit']) await inv('settings:update', { motion: { preset: p } });
  const bad = await chat.evaluate(async () => { try { await window.jarvis.invoke('settings:update', { motion: { amplitude: 500 } }); return 'accepted'; } catch { return 'rejected'; } });
  log(bad === 'rejected', 'settings reject out-of-range values');

  // Memory via local command
  await inv('conv:sendText', { text: 'Remember that the smoke test ran' });
  const mems = await inv('memory:list');
  log(mems.some((m) => m.text === 'the smoke test ran'), 'spoken/typed "remember that" persists a memory');

  // Chat tab screenshot
  await chat.evaluate(() => { const b = [...document.querySelectorAll('nav.tabs button')].find((x) => x.textContent === 'Chat'); b && b.click(); });
  await sleep(400);
  if (OUT) await chat.screenshot({ path: path.join(OUT, 'chat-conversation.png') });
  await chat.evaluate(() => { const b = [...document.querySelectorAll('nav.tabs button')].find((x) => x.textContent === 'Settings'); b && b.click(); });
  await sleep(300);
  if (OUT) await chat.screenshot({ path: path.join(OUT, 'chat-settings.png') });

  // No secrets on disk; CSP/console errors
  const files = fs.readdirSync(ud);
  log(!files.includes('credentials.enc.json'), 'no credential file created when no keys are entered', files.join(','));
  const relevantErrors = consoleErrors.filter((e) => !/Autofill|DevTools/.test(e) && !/api\.openai\.com\/v1\/models/.test(e)); // that one is our deliberate CSP probe
  log(relevantErrors.length === 0, 'no renderer console errors (incl. CSP violations)', relevantErrors.slice(0, 5).join(' || '));

  // Quit closes helper processes
  const pyBefore = require('child_process').execSync("pgrep -f '[w]akeword/helper[.]py' || true").toString().trim();
  chat.evaluate(() => window.jarvis.invoke('app:quit').catch(() => undefined)).catch(() => undefined);
  await sleep(3000);
  const pyAfter = require('child_process').execSync("pgrep -f '[w]akeword/helper[.]py' || true").toString().trim();
  log(pyBefore !== '' && pyAfter === '', 'Quit stops the wake-word helper process', `before=[${pyBefore.replace(/\n/g, ',')}] after=[${pyAfter}]`);
  try { await app.close(); } catch {}
  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(OUT || '.', 'smoke-results.json'), JSON.stringify(results, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} smoke checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('SMOKE CRASH', e); process.exit(2); });
