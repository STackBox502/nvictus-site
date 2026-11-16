// The brain: one long-lived Claude Code process in headless streaming mode.
// It runs under the user's own Claude login, so it has the same connectors, skills,
// memory and CLAUDE.md files as Claude Code in their terminal.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

export class Brain extends EventEmitter {
  constructor({ getCfg, getArgs, log }) {
    super();
    this.getCfg = getCfg;
    this.getArgs = getArgs;       // ({resume, model}) => string[]
    this.log = log || (() => {});
    this.proc = null;
    this.sessionId = null;
    this.model = null;            // model reported by the CLI
    this.wantModel = null;        // model override requested by the user
    this.busy = false;
    this.ready = false;
    this.stopping = false;
    this.crashes = [];
    this.stderrTail = '';
    this.buf = '';
    this.info = { tools: [], mcp: [], version: '' };
    this.pending = [];            // messages typed before the process is up
    this.resumeFailed = false;
  }

  start({ fresh = false } = {}) {
    if (this.proc) return;
    const cfg = this.getCfg();
    if (fresh) this.sessionId = null;
    const resume = !fresh && !this.resumeFailed ? this.sessionId : null;
    const args = this.getArgs({ resume, model: this.wantModel || cfg.model });
    const useShell = process.platform === 'win32';
    const finalArgs = useShell ? args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args;
    fs.mkdirSync(cfg.home, { recursive: true });
    this.log(`[brain] starting: ${cfg.claudeBin} ${args.filter((a) => !a.includes('\n')).join(' ').slice(0, 400)}`);
    this.stopping = false;
    this.ready = false;
    this.stderrTail = '';
    this.buf = '';
    this.startedAt = Date.now();
    let proc;
    try {
      proc = spawn(cfg.claudeBin, finalArgs, {
        cwd: cfg.home,
        shell: useShell,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'jarvis-hud' },
        windowsHide: true,
      });
    } catch (e) {
      this.emit('fatal', { code: 'spawn_failed', message: e.message });
      return;
    }
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (d) => this.#onData(d));
    proc.stderr.on('data', (d) => { this.stderrTail = (this.stderrTail + d).slice(-4000); });
    proc.on('error', (e) => {
      this.proc = null;
      const missing = e.code === 'ENOENT';
      this.emit('fatal', {
        code: missing ? 'claude_not_found' : 'spawn_failed',
        message: missing
          ? `Claude Code was not found (looked for "${cfg.claudeBin}"). Install it from https://claude.com/claude-code, run "claude" once to log in, then restart Jarvis.`
          : e.message,
      });
    });
    proc.on('exit', (code, signal) => this.#onExit(code, signal));
    proc.stdin.on('error', () => { /* process went away; exit handler deals with it */ });
    // The CLI only prints its init line once it gets input, so flush anything queued right away.
    this.state('starting');
    const queued = this.pending.splice(0);
    for (const m of queued) this.#write(m);
  }

  state(s) { this.status = s; this.emit('state', s); }

  #write(obj) {
    if (!this.proc || !this.proc.stdin.writable) return false;
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  }

  // content: string, or an array of Anthropic content blocks (text / image).
  send(content) {
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    const msg = { type: 'user', message: { role: 'user', content: blocks } };
    this.busy = true;
    this.state('thinking');
    if (!this.proc) { this.pending.push(msg); this.start(); return; }
    this.#write(msg);
  }

  interrupt() {
    if (!this.proc || !this.busy) return false;
    this.#write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
    // If the CLI ignores the control message, fall back to a restart that resumes the same conversation.
    clearTimeout(this.interruptTimer);
    this.interruptTimer = setTimeout(() => {
      if (this.busy) { this.log('[brain] interrupt not acknowledged; restarting'); this.restart(); }
    }, 4000);
    return true;
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.interruptTimer);
    if (this.proc) {
      try { this.proc.stdin.end(); } catch { /* ignore */ }
      const p = this.proc;
      setTimeout(() => { try { p.kill(); } catch { /* ignore */ } }, 1500);
    }
  }

  restart({ fresh = false, model } = {}) {
    if (model !== undefined) this.wantModel = model || null;
    const go = () => { this.busy = false; this.start({ fresh }); };
    if (!this.proc) return go();
    this.stopping = true;
    this.proc.once('exit', () => setTimeout(go, 150));
    try { this.proc.stdin.end(); } catch { /* ignore */ }
    const p = this.proc;
    setTimeout(() => { try { p.kill(); } catch { /* ignore */ } }, 1200);
  }

  #onExit(code, signal) {
    const wasBusy = this.busy;
    const lived = Date.now() - (this.startedAt || 0);
    this.proc = null;
    this.ready = false;
    clearTimeout(this.interruptTimer);
    this.log(`[brain] exited code=${code} signal=${signal} after ${lived}ms`);
    if (this.stopping) { this.stopping = false; this.state('stopped'); return; }
    this.busy = false;
    const tail = this.stderrTail.trim().split('\n').slice(-6).join('\n');
    // A resume that dies immediately usually means the saved conversation no longer exists.
    if (this.sessionId && !this.resumeFailed && lived < 15000 && /no conversation found|session.*not found|could not resume/i.test(tail)) {
      this.resumeFailed = true;
      this.sessionId = null;
      this.emit('notice', 'Previous conversation could not be resumed; starting a new one.');
      return this.start({ fresh: true });
    }
    if (/unknown option|unknown argument|error: option/i.test(tail)) {
      this.state('down');
      this.emit('fatal', { code: 'outdated', message: `Your Claude Code is too old for Jarvis. Open a terminal, run "claude update", then press Reconnect.\n${tail}` });
      return;
    }
    this.crashes = this.crashes.filter((t) => Date.now() - t < 60000);
    this.crashes.push(Date.now());
    if (wasBusy) this.emit('turn_error', { message: tail || `Claude Code exited (code ${code}).` });
    if (this.crashes.length >= 3) {
      this.state('down');
      this.emit('fatal', { code: 'crash_loop', message: `Claude Code keeps exiting.\n${tail || '(no error output)'}` });
      return;
    }
    this.state('restarting');
    setTimeout(() => this.start(), 800);
  }

  #onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      try { this.#onEvent(ev); } catch (e) { this.log(`[brain] event handler error: ${e.message}`); }
    }
  }

  #onEvent(ev) {
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') {
          this.sessionId = ev.session_id;
          this.model = ev.model || this.model;
          this.ready = true;
          this.resumeFailed = false;
          this.info = {
            tools: ev.tools || [],
            mcp: (ev.mcp_servers || []).map((s) => ({ name: s.name, status: s.status })),
            version: ev.claude_code_version || '',
            cwd: ev.cwd,
            permissionMode: ev.permissionMode,
          };
          this.emit('init', { sessionId: this.sessionId, model: this.model, ...this.info });
        } else if (ev.subtype === 'compact_boundary') {
          this.emit('notice', 'Conversation memory was compacted.');
        }
        break;

      case 'stream_event': {
        if (ev.parent_tool_use_id) break; // sub-agent chatter is not spoken
        const e = ev.event || {};
        if (e.type === 'message_start' && e.message?.model) this.model = e.message.model;
        if (e.type === 'content_block_start') {
          const b = e.content_block || {};
          if (b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use') {
            this.emit('tool_start', { id: b.id, name: b.name });
          } else if (b.type === 'thinking') {
            this.emit('thinking');
          } else if (b.type === 'text') {
            this.emit('text_start');
          }
        } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          this.streamedText = true;
          this.emit('text', e.delta.text);
        } else if (e.type === 'content_block_stop') {
          this.emit('block_stop');
        }
        break;
      }

      case 'assistant': {
        if (ev.parent_tool_use_id) break;
        const content = ev.message?.content || [];
        for (const b of content) {
          if (b.type === 'tool_use') this.emit('tool_input', { id: b.id, name: b.name, input: b.input });
          // Without partial messages (older CLI), fall back to whole text blocks.
          if (b.type === 'text' && !this.streamedText) { this.emit('text_start'); this.emit('text', b.text); this.emit('block_stop'); }
        }
        break;
      }

      case 'user': {
        if (ev.parent_tool_use_id) break;
        const content = ev.message?.content;
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b.type === 'tool_result') this.emit('tool_end', { id: b.tool_use_id, isError: !!b.is_error });
          }
        }
        break;
      }

      case 'rate_limit_event':
        this.emit('usage', ev.rate_limit_info || {});
        break;

      case 'result': {
        clearTimeout(this.interruptTimer);
        this.busy = false;
        this.streamedText = false;
        this.sessionId = ev.session_id || this.sessionId;
        this.emit('result', {
          isError: !!ev.is_error,
          subtype: ev.subtype,
          text: typeof ev.result === 'string' ? ev.result : '',
          costUsd: ev.total_cost_usd,
          durationMs: ev.duration_ms,
          turns: ev.num_turns,
          stopReason: ev.stop_reason,
          denials: ev.permission_denials || [],
        });
        this.state('idle');
        break;
      }

      case 'control_response':
        // Acknowledgement of our interrupt request.
        break;

      default:
        break;
    }
  }
}
