// Permission policy: decides which tool calls run on their own, which need a click,
// and which always need an explicit yes (anything that sends, spends, publishes or deletes).
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

const FILE = path.join(DATA_DIR, 'permissions.json');

// Final word in a tool name that means "this changes something other people can see, or can't be undone".
const HARD = /(^|_|-|\b)(send|sends|publish|post|pay|purchase|buy|checkout|transfer|delete|trash|remove|destroy|drop|deploy|share|forward|reply|merge|charge|refund|call|dial|approve|unsubscribe|archive|launch|activate|submit|upload|import)(_|-|\b|$)/i;
const READ = /^(get|list|search|read|find|fetch|query|describe|show|view|lookup|check|status|whoami|count|browse|resolve|who|help|explore|inspect|download|export|suggest|estimate|preview)(_|-|$)/i;

const BUILTIN_SAFE = new Set([
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task', 'Agent', 'ToolSearch',
  'ListMcpResourcesTool', 'ReadMcpResourceTool', 'Skill', 'ListSkills', 'SearchSkills', 'ListConnectors',
  'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskStop', 'AskUserQuestion', 'ExitPlanMode',
  'EnterPlanMode', 'BashOutput', 'KillShell', 'NotebookRead', 'ListAgents', 'Monitor',
]);

const SECRET_PATH = /(^|[\\/])(\.ssh|\.aws|\.gnupg|\.env(\.[\w-]+)?|id_rsa|id_ed25519|credentials(\.json)?|\.netrc|keychain|login\.keychain|secrets?(\.\w+)?|\.npmrc|\.pypirc)([\\/]|$)/i;

const BASH_HARD = /(\brm\s+-[a-z]*[rf]|\bsudo\b|\bgit\s+push\b|\bgit\s+reset\s+--hard|\bmkfs|\bdd\s+if=|\|\s*(ba|z)?sh\b|\bshutdown\b|\breboot\b|\bchmod\s+-R|\bchown\s+-R|\bnpm\s+publish|\bcurl\b[^|]*\s-X\s*(POST|PUT|DELETE|PATCH)|\bkill(all)?\b|\bdiskutil\b|\bformat\b|>\s*\/dev\/|\bdel\s+\/|\brmdir\s+\/s|\bRemove-Item\b)/i;
const BASH_SAFE = /^(ls|pwd|cat|head|tail|wc|echo|date|whoami|which|where|file|stat|du|df|find|grep|rg|tree|uname|sw_vers|hostname|git\s+(status|log|diff|branch|show|remote)|node\s+--version|python3?\s+--version|open\s|start\s|xdg-open\s|dir(\s|$)|type\s|Get-ChildItem|Get-Content)\b/i;

function lastSegment(tool) {
  if (!tool.startsWith('mcp__')) return tool;
  const parts = tool.split('__');
  return parts[parts.length - 1];
}

function serverName(tool) {
  if (!tool.startsWith('mcp__')) return '';
  return tool.split('__')[1] || '';
}

export function prettyTool(tool) {
  if (!tool.startsWith('mcp__')) return tool;
  const server = serverName(tool).replace(/^claude_ai_/i, '').replace(/^plugin_[^_]+_/i, '').replace(/_/g, ' ');
  const action = lastSegment(tool).replace(/[_-]/g, ' ');
  return `${server} · ${action}`.trim();
}

function loadSaved() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { allow: [], bash: [] }; }
}

export class Policy {
  constructor(getCfg) {
    this.getCfg = getCfg;
    this.saved = loadSaved();
    this.saved.allow ||= [];
    this.saved.bash ||= [];
  }

  // Returns { decision: 'allow' | 'ask' | 'hard', reason }
  classify(tool, input = {}) {
    if (tool.startsWith('mcp__jarvis__')) return { decision: 'allow', reason: 'built-in Jarvis tool' };

    if (tool === 'Bash' || tool === 'PowerShell') {
      const cmd = String(input.command || '').trim();
      if (BASH_HARD.test(cmd)) return { decision: 'hard', reason: 'command can delete, push or change the system' };
      if (BASH_SAFE.test(cmd) && !/[;&|`$]\s*(rm|sudo|curl|wget)\b/.test(cmd)) return { decision: 'allow', reason: 'read-only command' };
      const first = cmd.split(/\s+/)[0];
      if (first && this.saved.bash.includes(first)) return { decision: 'allow', reason: `you always allow "${first}"` };
      return { decision: 'ask', reason: 'runs a command on this computer' };
    }

    if (BUILTIN_SAFE.has(tool)) {
      const p = String(input.file_path || input.path || '');
      if (p && SECRET_PATH.test(p)) return { decision: 'ask', reason: 'file looks like it holds credentials' };
      return { decision: 'allow', reason: 'read-only' };
    }

    if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
      const p = path.resolve(String(input.file_path || input.notebook_path || ''));
      const home = this.getCfg().home;
      if (SECRET_PATH.test(p)) return { decision: 'hard', reason: 'file looks like it holds credentials' };
      if (p === home || p.startsWith(home + path.sep)) return { decision: 'allow', reason: 'inside the Jarvis workspace' };
      if (this.saved.allow.includes(tool)) return { decision: 'allow', reason: 'you always allow file edits' };
      return { decision: 'ask', reason: 'changes a file outside the Jarvis workspace' };
    }

    const seg = lastSegment(tool);
    if (HARD.test(seg)) return { decision: 'hard', reason: 'sends, publishes, spends or deletes' };
    if (this.saved.allow.includes(tool)) return { decision: 'allow', reason: 'you always allow this' };
    if (tool.startsWith('mcp__') && READ.test(seg)) return { decision: 'allow', reason: 'read-only lookup' };
    return { decision: 'ask', reason: 'changes something in a connected app' };
  }

  remember(tool, input = {}) {
    if (tool === 'Bash' || tool === 'PowerShell') {
      const first = String(input.command || '').trim().split(/\s+/)[0];
      if (first && !this.saved.bash.includes(first)) this.saved.bash.push(first);
    } else if (!this.saved.allow.includes(tool)) {
      this.saved.allow.push(tool);
    }
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(this.saved, null, 2));
    } catch { /* non-fatal */ }
  }

  reset() {
    this.saved = { allow: [], bash: [] };
    try { fs.rmSync(FILE, { force: true }); } catch { /* ignore */ }
  }
}

// One-line plain-English description of what is about to happen, for the approval card and voice.
export function summarize(tool, input = {}) {
  const clip = (s, n = 140) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  if (tool === 'Bash' || tool === 'PowerShell') return `Run: ${clip(input.command, 200)}`;
  if (tool === 'Write') return `Create file ${clip(input.file_path)}`;
  if (tool === 'Edit' || tool === 'MultiEdit') return `Edit file ${clip(input.file_path)}`;
  const bits = [];
  for (const key of ['to', 'recipient', 'recipients', 'subject', 'title', 'name', 'summary', 'query', 'url', 'path', 'message', 'body', 'text']) {
    if (input[key] !== undefined && bits.length < 3) {
      const v = Array.isArray(input[key]) ? input[key].join(', ') : input[key];
      if (typeof v === 'string' || typeof v === 'number') bits.push(`${key}: ${clip(v, 90)}`);
    }
  }
  return `${prettyTool(tool)}${bits.length ? ' — ' + bits.join(' · ') : ''}`;
}
