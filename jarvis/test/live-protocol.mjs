// Live protocol check against the real Claude Code CLI (uses a little of your Claude usage).
// Verifies the four things Jarvis depends on: streaming I/O, the Jarvis tool server (incl. images),
// the approval gate, and interrupting a turn.   Run:  node test/live-protocol.mjs [model]
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Brain } from '../lib/brain.mjs';
import { createMcp } from '../lib/mcp.mjs';
import { Policy } from '../lib/policy.mjs';

const model = process.argv[2] || 'haiku';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-live-'));
const cfg = { home: work, claudeBin: process.env.CLAUDE_BIN || 'claude', model };

// --- tiny solid-colour PNG so look_at_screen has something real to return ---
function png(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const approvals = [];
let approveAnswer = { allow: false, reason: 'User said no in the test.' };
const hub = {
  screen: { on: true },
  clients: () => 1,
  broadcast: () => {},
  freshFrame: async () => ({ data: png(64, 64, [220, 20, 20]), mime: 'image/png', at: Date.now(), width: 64, height: 64 }),
  askApproval: async (req) => { approvals.push(req); return approveAnswer; },
  request: async () => ({ ok: false, error: 'no HUD in test' }),
  registerFile: () => null,
  queueModel: () => {},
};
const policy = new Policy(() => cfg);
const mcp = createMcp({ hub, policy, vault: { find: () => [], root: work }, getCfg: () => cfg, log: console.log });

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  let body = ''; for await (const c of req) body += c;
  const out = await mcp(JSON.parse(body));
  if (!out.body) { res.writeHead(out.status).end(); return; }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out.body));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const mcpFile = path.join(work, 'mcp.json');
fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { jarvis: { type: 'http', url: `http://127.0.0.1:${port}/mcp` } } }));
const personaFile = path.join(work, 'persona.md');
fs.writeFileSync(personaFile, 'You are in an automated test. Follow instructions exactly and answer in one short sentence.');

const brain = new Brain({
  getCfg: () => cfg,
  log: (m) => process.env.VERBOSE && console.log(m),
  getArgs: ({ resume, model: m }) => [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--append-system-prompt-file', personaFile, '--mcp-config', mcpFile, '--strict-mcp-config',
    '--permission-prompt-tool', 'mcp__jarvis__approve',
    ...(m ? ['--model', m] : []), ...(resume ? ['--resume', resume] : []),
  ],
});

let text = ''; const tools = [];
brain.on('text', (t) => { text += t; });
brain.on('tool_input', (t) => tools.push(t));
brain.on('fatal', (f) => { console.error('FATAL', f); process.exit(2); });
const turn = (prompt, { timeout = 120000 } = {}) => new Promise((resolve, reject) => {
  text = ''; tools.length = 0;
  const timer = setTimeout(() => reject(new Error('turn timed out')), timeout);
  brain.once('result', (r) => { clearTimeout(timer); resolve({ ...r, said: text, tools: tools.map((t) => t.name) }); });
  brain.send(prompt);
});

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

try {
  let initSeen = null;
  brain.once('init', (i) => { initSeen = i; });
  brain.start();
  await new Promise((r) => setTimeout(r, 6000));
  console.log(`info  init before first message: ${initSeen ? 'yes' : 'no'}`);

  const r1 = await turn('Reply with exactly the word READY.');
  check('streaming turn', /READY/.test(r1.said) && !r1.isError, r1.said.slice(0, 60));
  check('init reports jarvis tool server', (brain.info.mcp || []).some((s) => s.name === 'jarvis' && s.status === 'connected'), JSON.stringify(brain.info.mcp));
  console.log(`info  claude code ${brain.info.version}, model ${brain.model}`);

  const r2 = await turn('Call the look_at_screen tool, then tell me the single dominant colour of the image in one word.');
  check('screen image reaches the model', r2.tools.includes('mcp__jarvis__look_at_screen') && /red/i.test(r2.said), r2.said.slice(0, 80));

  const target = path.join(work, 'denied.txt');
  const r3 = await turn(`Use the Bash tool to run exactly: touch "${target}". If it is refused, say REFUSED.`);
  check('approval gate asked + deny respected', approvals.length >= 1 && !fs.existsSync(target), `asks=${approvals.length} said=${r3.said.slice(0, 60)}`);

  approveAnswer = { allow: true };
  const target2 = path.join(work, 'allowed.txt');
  const r4 = await turn(`Use the Bash tool to run exactly: touch "${target2}". Then say DONE.`);
  check('approval gate allow runs the tool', fs.existsSync(target2), r4.said.slice(0, 60));

  const before = Date.now();
  const p5 = turn('Count slowly from 1 to 400, one number per line, no other text.', { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2500));
  brain.interrupt();
  const r5 = await p5;
  check('interrupt stops a turn', Date.now() - before < 20000 && !/\b400\b/.test(r5.said), `stopped after ${Date.now() - before}ms, subtype=${r5.subtype}`);

  const r6 = await turn('What single word did I ask you to reply with in my very first message?');
  check('conversation memory survives interrupt', /READY/i.test(r6.said), r6.said.slice(0, 60));
} catch (e) {
  check('run completed', false, e.message);
} finally {
  brain.stop();
  server.close();
  setTimeout(() => {
    const failed = results.filter((r) => !r.ok).length;
    console.log(failed ? `\n${failed} check(s) failed` : '\nAll live protocol checks passed');
    process.exit(failed ? 1 : 0);
  }, 1800);
}
