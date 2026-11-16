// Minimal MCP server (Streamable HTTP, JSON responses) that gives Claude its Jarvis-only abilities:
// seeing the shared screen, putting things on the HUD, the 3D workshop, and asking for approval.
// Hand-rolled so the app has zero npm dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { summarize, prettyTool } from './policy.mjs';

const text = (t) => ({ content: [{ type: 'text', text: String(t) }] });
const fail = (t) => ({ content: [{ type: 'text', text: String(t) }], isError: true });

const WORKSHOP_GUIDE = `Builds or replaces the 3D model on the workshop bench. "code" is the BODY of a JavaScript function
called as (THREE, api). Build the model from named parts so it can be pulled apart and labelled:

  api.part(name, object3D, { label?: string, explode?: [x,y,z] })   // add or replace one named part
  api.mat.metal(color, roughness=0.35) | api.mat.matte(color) | api.mat.glass(color, opacity=0.35)
  api.mat.glow(color, intensity=2) | api.mat.plastic(color)          // ready-made PBR materials
  api.remove(name)                                                   // delete a part

Rules: units are metres, +Y is up, sit the model on y=0. Every visible piece must go through api.part
(group small meshes into a THREE.Group per part). Use only THREE geometry/material classes - no imports,
no network, no DOM. Typical model: 6-40 parts. With mode "replace" (default) the bench is cleared first;
with mode "patch" only the parts you call api.part/api.remove on change, everything else stays, so use
"patch" for edits like recolouring or adding one thing. Returns the part list and any runtime error so
you can fix it. After a build, call workshop_snapshot once to check your work visually before describing it.`;

export const TOOLS = [
  {
    name: 'look_at_screen',
    description: "Returns a fresh image of the screen the user is sharing with the HUD. Use whenever the user says 'look', 'what's this', 'what am I looking at', or asks about something on their screen. Fails if screen sharing is off - then ask them to press the Share Screen button.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'point_at_screen',
    description: 'Draws a pointer arrow on the HUD preview of the shared screen to show the user where something is. x and y are fractions of the screen image from look_at_screen (0,0 = top-left, 1,1 = bottom-right). Call look_at_screen first.',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, label: { type: 'string', description: 'Short label, e.g. "Create button"' } },
      required: ['x', 'y'],
    },
  },
  {
    name: 'show_panel',
    description: 'Puts content on the HUD for the user to read: long answers, lists, tables, drafts, code, an image. Speak a one-line summary and put the detail here - never read long content aloud unless asked. markdown supports headings, lists, tables, links, bold, code. image_path is an optional absolute path to a local image to display.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, markdown: { type: 'string' }, image_path: { type: 'string' } },
      required: ['title'],
    },
  },
  {
    name: 'brain_focus',
    description: "Lights up files/folders in the user's second-brain galaxy and lists them in the HUD side panel. Use for 'pull up X', 'show me my X files'. Give a name query and/or exact absolute paths you already found. Returns the matched paths.",
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } },
    },
  },
  {
    name: 'workshop_build',
    description: WORKSHOP_GUIDE,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short name of the object' },
        code: { type: 'string', description: 'Function body receiving (THREE, api)' },
        mode: { type: 'string', enum: ['replace', 'patch'] },
      },
      required: ['title', 'code'],
    },
  },
  {
    name: 'workshop_control',
    description: 'Controls the workshop view. action: "open" (show the empty bench), "close", "explode" (pull the model apart with labels), "assemble" (put it back together), "focus" (zoom to the named part), "labels_on", "labels_off", "spin_on", "spin_off".',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'close', 'explode', 'assemble', 'focus', 'labels_on', 'labels_off', 'spin_on', 'spin_off'] },
        part: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'workshop_snapshot',
    description: 'Returns an image of the current workshop model so you can check your own 3D work. With save=true the PNG is also written to the Jarvis renders folder and its path is returned.',
    inputSchema: { type: 'object', properties: { save: { type: 'boolean' } } },
  },
  {
    name: 'set_brain',
    description: "Switches which Claude model Jarvis runs on, e.g. 'fable', 'opus', 'sonnet', 'haiku', or a full model id. Takes effect right after this reply. Use when the user says 'switch your brain to ...'.",
    inputSchema: { type: 'object', properties: { model: { type: 'string' } }, required: ['model'] },
  },
  {
    name: 'approve',
    description: 'Internal permission gate. Never call this yourself.',
    inputSchema: {
      type: 'object',
      properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
      required: ['tool_name', 'input'],
    },
  },
];

export function createMcp({ hub, policy, vault, getCfg, log }) {
  const handlers = {
    async look_at_screen() {
      const frame = await hub.freshFrame();
      if (!frame) return fail('Screen sharing is off. Ask the user to press the Share Screen button on the HUD, then try again.');
      return {
        content: [
          { type: 'image', data: frame.data.toString('base64'), mimeType: frame.mime },
          { type: 'text', text: `Screen captured ${Math.max(0, Math.round((Date.now() - frame.at) / 1000))}s ago (${frame.width || '?'}x${frame.height || '?'}).` },
        ],
      };
    },

    async point_at_screen({ x, y, label }) {
      if (!hub.screen.on) return fail('Screen sharing is off.');
      const cx = Math.min(1, Math.max(0, Number(x)));
      const cy = Math.min(1, Math.max(0, Number(y)));
      hub.broadcast('pointer', { x: cx, y: cy, label: String(label || '').slice(0, 80) });
      return text('Pointer shown on the HUD screen preview.');
    },

    async show_panel({ title, markdown, image_path }) {
      let image = null;
      if (image_path) {
        const id = hub.registerFile(image_path);
        if (!id) return fail(`Cannot read image at ${image_path}`);
        image = `/api/served/${id}`;
      }
      hub.broadcast('panel', { title: String(title || '').slice(0, 160), markdown: String(markdown || ''), image });
      return text('Shown on the HUD.');
    },

    async brain_focus({ query, paths }) {
      const found = vault.find({ query, paths });
      hub.broadcast('focus', { query: query || '', ids: found.map((n) => n.id), items: found.slice(0, 60).map((n) => ({ id: n.id, name: n.name, type: n.type, where: path.relative(vault.root, path.dirname(n.abs)) || path.basename(vault.root) })) });
      if (!found.length) return text(`No files matching "${query || (paths || []).join(', ')}" in the second brain (${vault.root}). Try Grep/Glob on the folder, then call brain_focus with exact paths.`);
      return text(`Highlighted ${found.length} item(s) on the HUD:\n` + found.slice(0, 40).map((n) => `- ${n.abs}`).join('\n'));
    },

    async workshop_build({ title, code, mode }) {
      if (!hub.clients()) return fail('The HUD is not open in a browser, so nothing can be built.');
      const r = await hub.request('workshop_build', { title: String(title || 'Model'), code: String(code || ''), mode: mode === 'patch' ? 'patch' : 'replace' }, 20000);
      if (!r.ok) return fail(`Build failed: ${r.error}\nFix the code and call workshop_build again.`);
      return text(`Built "${title}". Parts (${r.data.parts.length}): ${r.data.parts.join(', ')}. Size ≈ ${r.data.size.map((n) => n.toFixed(2)).join(' x ')} m.`);
    },

    async workshop_control({ action, part }) {
      if (!hub.clients()) return fail('The HUD is not open in a browser.');
      const r = await hub.request('workshop_control', { action, part: part || '' }, 8000);
      if (!r.ok) return fail(r.error);
      return text(r.data?.message || 'Done.');
    },

    async workshop_snapshot({ save }) {
      if (!hub.clients()) return fail('The HUD is not open in a browser.');
      const r = await hub.request('workshop_snapshot', {}, 8000);
      if (!r.ok) return fail(r.error);
      const b64 = String(r.data.png || '').replace(/^data:image\/png;base64,/, '');
      const out = [{ type: 'image', data: b64, mimeType: 'image/png' }];
      if (save) {
        const dir = path.join(getCfg().home, 'renders');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `workshop-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
        fs.writeFileSync(file, Buffer.from(b64, 'base64'));
        out.push({ type: 'text', text: `Saved to ${file}` });
      }
      return { content: out };
    },

    async set_brain({ model }) {
      const m = String(model || '').trim();
      if (!/^[\w.\-\[\]]{2,80}$/.test(m)) return fail('That does not look like a model name.');
      hub.queueModel(m);
      return text(`Brain will switch to "${m}" as soon as this reply finishes. Confirm it to the user in one short line.`);
    },

    // Called by Claude Code itself (via --permission-prompt-tool) whenever a tool needs permission.
    async approve({ tool_name, input }) {
      const allow = () => text(JSON.stringify({ behavior: 'allow', updatedInput: input || {} }));
      const deny = (message) => text(JSON.stringify({ behavior: 'deny', message }));
      const verdict = policy.classify(tool_name, input || {});
      if (verdict.decision === 'allow') return allow();
      if (!hub.clients()) return deny('The HUD is not open, so the user cannot approve this. Tell them what you wanted to do and ask them to open the HUD.');
      const answer = await hub.askApproval({
        tool: tool_name,
        label: prettyTool(tool_name),
        summary: summarize(tool_name, input || {}),
        detail: JSON.stringify(input || {}, null, 2).slice(0, 4000),
        hard: verdict.decision === 'hard',
        reason: verdict.reason,
      });
      if (answer.allow) {
        if (answer.always && verdict.decision !== 'hard') policy.remember(tool_name, input || {});
        return allow();
      }
      return deny(answer.reason || 'The user said no. Do not retry this action; ask what they would like instead.');
    },
  };

  const publicTools = TOOLS;

  async function rpc(msg) {
    const { id, method, params } = msg;
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const error = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'jarvis', version: '1.0.0' },
          instructions: 'Jarvis HUD tools: screen sight, HUD panels, second-brain galaxy, 3D workshop.',
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: publicTools });
      case 'tools/call': {
        const name = params?.name;
        const fn = handlers[name];
        if (!fn) return error(-32602, `Unknown tool: ${name}`);
        try {
          return reply(await fn(params.arguments || {}));
        } catch (e) {
          log?.(`[mcp] ${name} failed: ${e.message}`);
          return reply(fail(`Tool ${name} failed: ${e.message}`));
        }
      }
      case 'resources/list':
        return reply({ resources: [] });
      case 'prompts/list':
        return reply({ prompts: [] });
      default:
        if (id === undefined) return null; // notification
        return error(-32601, `Method not found: ${method}`);
    }
  }

  // Returns { status, body } for an HTTP POST body (single message or batch).
  return async function handle(body) {
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(rpc))).filter(Boolean);
      return out.length ? { status: 200, body: out } : { status: 202, body: null };
    }
    const out = await rpc(body);
    return out ? { status: 200, body: out } : { status: 202, body: null };
  };
}
