// Offline unit tests (no Claude, no network).  Run:  node --test test/unit.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-unit-'));
process.env.JARVIS_ENV_FILE = path.join(tmp, 'test.env');
process.env.JARVIS_DATA_DIR = path.join(tmp, 'data');
for (const k of ['ELEVENLABS_API_KEY', 'JARVIS_ADDRESS', 'JARVIS_HOME', 'JARVIS_BRAIN_DIR', 'JARVIS_MODEL']) delete process.env[k];

const { loadConfig, saveEnv } = await import('../lib/config.mjs');
const { Policy, summarize, prettyTool } = await import('../lib/policy.mjs');
const { SentenceStream, speakable, createVoice } = await import('../lib/voice.mjs');
const { Vault } = await import('../lib/vault.mjs');
const { createMcp, TOOLS } = await import('../lib/mcp.mjs');
const { startMockEleven } = await import('./mock-eleven.mjs');

test('settings: saved to a private file, read back, unknown keys refused', () => {
  const cfg = saveEnv({ ELEVENLABS_API_KEY: ' abc123 ', JARVIS_ADDRESS: 'Chris', PATH: '/evil', JARVIS_HOME: path.join(tmp, 'ws') });
  assert.equal(cfg.elevenKey, 'abc123');
  assert.equal(cfg.address, 'Chris');
  const text = fs.readFileSync(process.env.JARVIS_ENV_FILE, 'utf8');
  assert.ok(!text.includes('PATH='));
  if (process.platform !== 'win32') assert.equal(fs.statSync(process.env.JARVIS_ENV_FILE).mode & 0o777, 0o600);
  saveEnv({ JARVIS_ADDRESS: 'Boss' });
  assert.equal(loadConfig().address, 'Boss');
  assert.equal(loadConfig().elevenKey, 'abc123', 'other keys survive an update');
  assert.equal(fs.readFileSync(process.env.JARVIS_ENV_FILE, 'utf8').match(/JARVIS_ADDRESS=/g).length, 1);
});

test('policy: reads run, changes ask, anything that sends/spends/deletes always asks', () => {
  const p = new Policy(() => loadConfig());
  const d = (tool, input) => p.classify(tool, input).decision;
  assert.equal(d('mcp__jarvis__look_at_screen', {}), 'allow');
  assert.equal(d('Read', { file_path: '/home/me/notes.md' }), 'allow');
  assert.equal(d('Read', { file_path: '/home/me/.ssh/id_rsa' }), 'ask');
  assert.equal(d('mcp__claude_ai_Gmail__search_threads', {}), 'allow');
  assert.equal(d('mcp__claude_ai_Google_Calendar__list_events', {}), 'allow');
  assert.equal(d('mcp__claude_ai_Gmail__create_draft', {}), 'ask');
  assert.equal(d('mcp__claude_ai_Gmail__send_message', {}), 'hard');
  assert.equal(d('mcp__claude_ai_Gmail__reply', {}), 'hard');
  assert.equal(d('mcp__claude_ai_Gmail__trash_thread', {}), 'hard');
  assert.equal(d('mcp__claude_ai_Google_Calendar__delete_event', {}), 'hard');
  assert.equal(d('mcp__plugin_x_stripe__create_refund', {}), 'hard');
  assert.equal(d('Bash', { command: 'ls -la ~/Documents' }), 'allow');
  assert.equal(d('Bash', { command: 'npm install left-pad' }), 'ask');
  assert.equal(d('Bash', { command: 'rm -rf ~/Documents' }), 'hard');
  assert.equal(d('Bash', { command: 'git push origin main' }), 'hard');
  assert.equal(d('Bash', { command: 'ls; rm -rf /' }), 'hard');
  assert.equal(d('Write', { file_path: path.join(loadConfig().home, 'notes.md') }), 'allow');
  assert.equal(d('Write', { file_path: '/etc/hosts' }), 'ask');
  assert.equal(d('Write', { file_path: '/home/me/.env' }), 'hard');
});

test('policy: "always allow" is remembered for soft actions only', () => {
  const p = new Policy(() => loadConfig());
  p.remember('mcp__claude_ai_Gmail__create_draft', {});
  assert.equal(p.classify('mcp__claude_ai_Gmail__create_draft', {}).decision, 'allow');
  p.remember('mcp__claude_ai_Gmail__send_message', {});
  assert.equal(p.classify('mcp__claude_ai_Gmail__send_message', {}).decision, 'hard', 'sending can never be pre-approved');
  p.remember('Bash', { command: 'npm install' });
  assert.equal(p.classify('Bash', { command: 'npm test' }).decision, 'allow');
  assert.equal(p.classify('Bash', { command: 'npm publish' }).decision, 'hard');
  assert.equal(new Policy(() => loadConfig()).classify('mcp__claude_ai_Gmail__create_draft', {}).decision, 'allow', 'persisted to disk');
  p.reset();
  assert.equal(p.classify('mcp__claude_ai_Gmail__create_draft', {}).decision, 'ask');
});

test('policy: approval text is plain English', () => {
  assert.equal(prettyTool('mcp__claude_ai_Gmail__send_message'), 'Gmail · send message');
  assert.match(summarize('mcp__claude_ai_Gmail__send_message', { to: 'a@b.co', subject: 'Invoice' }), /to: a@b\.co · subject: Invoice/);
  assert.match(summarize('Bash', { command: 'mkdir x' }), /^Run: mkdir x/);
});

test('speech: sentences stream out whole, markdown and code are never read aloud', () => {
  const out = [];
  const s = new SentenceStream((t) => out.push(t));
  for (const piece of ['Three meetings tomor', 'row, the first at 9.30 with Acme. ', 'I have put the **full list** on screen. ', 'Here is code:\n```js\nconsole.', 'log(1)\n```\nShall I draft a reply?']) s.push(piece);
  s.flush();
  assert.deepEqual(out, ['Three meetings tomorrow, the first at 9.30 with Acme.', 'I have put the full list on screen.', 'Here is code:', 'Shall I draft a reply?']);
  assert.equal(speakable('## Plan\n- [Open](https://x.co) the `file` at https://a.b/c'), 'Plan Open the file at a link');
});

test('speech: long unbroken text still gets cut into speakable chunks', () => {
  const out = [];
  const s = new SentenceStream((t) => out.push(t));
  s.push('word '.repeat(200));
  s.flush();
  assert.ok(out.length >= 3 && out.every((t) => t.length <= 330));
});

test('second brain: scan, wikilinks, search, and previews stay inside the folder', () => {
  const root = path.join(tmp, 'brain');
  const w = (rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  w('Brand Voice/tone-guide.md', 'See [[content-pillars]].');
  w('Brand Voice/content-pillars.md', '# Pillars');
  w('Clients/acme/proposal.md', 'Uses [tone](../../Brand%20Voice/tone-guide.md).');
  w('node_modules/junk/index.js', 'x');
  w('.secret/hidden.md', 'x');
  saveEnv({ JARVIS_BRAIN_DIR: root });
  const v = new Vault(() => loadConfig());
  const g = v.scan();
  const names = g.nodes.map((n) => n.name);
  assert.ok(names.includes('tone-guide.md') && names.includes('acme'));
  assert.ok(!names.includes('junk') && !names.includes('hidden.md'), 'dependency and hidden folders are skipped');
  assert.equal(g.links.filter((l) => l[2]).length, 2, 'wikilink + relative markdown link');
  const hits = v.find({ query: 'brand voice' }).map((n) => n.name);
  assert.ok(hits.includes('Brand Voice') && hits.includes('tone-guide.md'));
  assert.deepEqual(v.find({ paths: [path.join(root, 'Clients')] }).map((n) => n.name).sort(), ['Clients', 'acme', 'proposal.md'], 'a folder path includes its contents');
  assert.equal(v.preview(path.join(root, 'Brand Voice/content-pillars.md')).kind, 'markdown');
  assert.ok(v.preview('/etc/passwd').error, 'files outside the brain are refused');
  assert.ok(!JSON.stringify(v.publicGraph().nodes).includes(root), 'browser graph carries no absolute paths');
});

test('tool server: speaks MCP, lists tools, gates approvals', async () => {
  const asked = [];
  const hub = { screen: { on: false }, clients: () => 1, broadcast() {}, freshFrame: async () => null, registerFile: () => null, queueModel() {}, request: async () => ({ ok: false, error: 'no hud' }),
    askApproval: async (r) => { asked.push(r); return { allow: false }; } };
  const mcp = createMcp({ hub, policy: new Policy(() => loadConfig()), vault: { find: () => [], root: tmp }, getCfg: loadConfig });
  const init = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.body.result.serverInfo.name, 'jarvis');
  assert.equal((await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const list = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(list.body.result.tools.length, TOOLS.length);
  const call = (name, args) => mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }).then((r) => r.body.result);
  assert.ok((await call('look_at_screen', {})).isError, 'no screen share -> clear error');
  const allow = JSON.parse((await call('approve', { tool_name: 'Read', input: { file_path: '/x' } })).content[0].text);
  assert.equal(allow.behavior, 'allow');
  const deny = JSON.parse((await call('approve', { tool_name: 'mcp__claude_ai_Gmail__send_message', input: { to: 'a@b.co' } })).content[0].text);
  assert.equal(deny.behavior, 'deny');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].hard, true);
});

test('ElevenLabs client: speech, transcription, voices, and clear errors', async () => {
  const mock = await startMockEleven();
  saveEnv({ ELEVENLABS_API_KEY: 'test-key' });
  process.env.ELEVENLABS_BASE_URL = mock.url;
  const voice = createVoice(loadConfig);
  const res = await voice.speak('Hello there.');
  const audio = Buffer.from(await res.arrayBuffer());
  assert.ok(audio.length > 400 && audio[0] === 0xff, 'got MP3 bytes');
  assert.deepEqual(mock.calls.tts[0], { voice: 'JBFqnCBsd6RMkjVDRZzb', text: 'Hello there.', model: 'eleven_flash_v2_5', format: 'mp3_44100_128' });
  assert.equal(await voice.transcribe(Buffer.alloc(2000, 1), 'audio/webm'), 'What is two plus two?');
  assert.equal((await voice.voices()).length, 2);
  assert.equal((await voice.check()).ok, true);
  saveEnv({ ELEVENLABS_API_KEY: 'nope' });
  const bad = await voice.check();
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'bad_key');
  saveEnv({ ELEVENLABS_API_KEY: 'test-key', ELEVENLABS_VOICE_ID: 'missing-voice' });
  assert.equal((await voice.check()).code, 'bad_voice');
  mock.server.close();
});
