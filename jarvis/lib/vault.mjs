// The "second brain": scans a folder into a graph the HUD draws as a 3D galaxy.
// Everything stays on this machine; only names and structure go to the browser on localhost.
import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv', '.cache', '.next', 'dist', 'build',
  '.idea', '.vscode', 'Library', 'AppData', '$RECYCLE.BIN', 'System Volume Information', '.Trash', 'Pods',
  'DerivedData', 'target', '.gradle', '.terraform', 'vendor', 'bower_components', '.obsidian', '.brain-map',
]);
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.json', '.csv', '.tsv', '.yml', '.yaml', '.toml', '.html', '.htm', '.css', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.sh', '.sql', '.xml', '.ini', '.env.example', '.log', '.rtf', '.tex', '.srt', '.vtt']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);

const KIND = (ext) => {
  if (ext === '.md' || ext === '.markdown' || ext === '.txt' || ext === '.rtf') return 'note';
  if (ext === '.pdf' || ext === '.doc' || ext === '.docx' || ext === '.pages' || ext === '.odt') return 'doc';
  if (ext === '.xls' || ext === '.xlsx' || ext === '.csv' || ext === '.tsv' || ext === '.numbers') return 'sheet';
  if (ext === '.ppt' || ext === '.pptx' || ext === '.key') return 'deck';
  if (IMAGE_EXT.has(ext) || ext === '.psd' || ext === '.ai' || ext === '.fig' || ext === '.heic') return 'image';
  if (['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'].includes(ext)) return 'audio';
  if (TEXT_EXT.has(ext)) return 'code';
  return 'file';
};

export class Vault {
  constructor(getCfg, log) {
    this.getCfg = getCfg;
    this.log = log || (() => {});
    this.graph = { root: '', nodes: [], links: [], truncated: false, scannedAt: 0 };
    this.byId = new Map();
    this.byAbs = new Map();
  }

  get root() { return this.graph.root || this.getCfg().brainDir; }

  scan({ maxNodes = 2600, maxDepth = 7 } = {}) {
    const root = this.getCfg().brainDir;
    const nodes = [];
    const links = [];
    let truncated = false;
    const add = (n) => { n.id = nodes.length; nodes.push(n); return n; };
    if (!fs.existsSync(root)) {
      this.graph = { root, nodes: [], links: [], truncated: false, scannedAt: Date.now(), missing: true };
      this.#index();
      return this.graph;
    }
    const rootNode = add({ name: path.basename(root) || root, abs: root, type: 'dir', kind: 'root', parent: -1, depth: 0, group: 0, size: 0 });
    // Breadth-first so a huge folder cannot starve its siblings of the node budget.
    const queue = [rootNode];
    let group = 0;
    while (queue.length) {
      const dir = queue.shift();
      let entries;
      try { entries = fs.readdirSync(dir.abs, { withFileTypes: true }); } catch { continue; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      let filesHere = 0;
      for (const e of entries) {
        if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
        const abs = path.join(dir.abs, e.name);
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name) || dir.depth + 1 > maxDepth) continue;
          if (nodes.length >= maxNodes) { truncated = true; continue; }
          const n = add({ name: e.name, abs, type: 'dir', kind: 'dir', parent: dir.id, depth: dir.depth + 1, group: dir.depth === 0 ? ++group : dir.group, size: 0 });
          links.push([dir.id, n.id]);
          queue.push(n);
        } else if (e.isFile()) {
          if (nodes.length >= maxNodes || filesHere >= 220) { truncated = true; continue; }
          filesHere++;
          const ext = path.extname(e.name).toLowerCase();
          const n = add({ name: e.name, abs, type: 'file', kind: KIND(ext), ext, parent: dir.id, depth: dir.depth + 1, group: dir.group, size: 0 });
          links.push([dir.id, n.id]);
        }
      }
    }
    // Cross-links from [[wikilinks]] and relative markdown links, so connected notes pull together.
    const byBase = new Map();
    for (const n of nodes) if (n.type === 'file') byBase.set(n.name.replace(/\.[^.]+$/, '').toLowerCase(), n.id);
    let mdRead = 0;
    for (const n of nodes) {
      if (n.type !== 'file' || (n.ext !== '.md' && n.ext !== '.markdown') || mdRead >= 700) continue;
      mdRead++;
      let body = '';
      try {
        const fd = fs.openSync(n.abs, 'r');
        const buf = Buffer.alloc(48 * 1024);
        const len = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        body = buf.toString('utf8', 0, len);
      } catch { continue; }
      const seen = new Set();
      for (const m of body.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
        const t = byBase.get(m[1].trim().split('/').pop().toLowerCase());
        if (t !== undefined && t !== n.id && !seen.has(t)) { seen.add(t); links.push([n.id, t, 1]); }
      }
      for (const m of body.matchAll(/\]\((?!https?:|mailto:|#)([^)\s]+\.md)(?:#[^)]*)?\)/g)) {
        const t = this.#absId(path.resolve(path.dirname(n.abs), decodeURIComponent(m[1])), nodes);
        if (t !== undefined && t !== n.id && !seen.has(t)) { seen.add(t); links.push([n.id, t, 1]); }
      }
    }
    this.graph = { root, nodes, links, truncated, scannedAt: Date.now() };
    this.#index();
    this.log(`[vault] ${nodes.length} items from ${root}${truncated ? ' (capped)' : ''}`);
    return this.graph;
  }

  #absId(abs, nodes) {
    if (!this._absTmp || this._absTmpFor !== nodes) {
      this._absTmp = new Map(nodes.map((n) => [n.abs, n.id]));
      this._absTmpFor = nodes;
    }
    return this._absTmp.get(abs);
  }

  #index() {
    this.byId = new Map(this.graph.nodes.map((n) => [n.id, n]));
    this.byAbs = new Map(this.graph.nodes.map((n) => [n.abs, n]));
    this._absTmp = null;
  }

  // What the browser needs to draw: no absolute paths beyond the root label.
  publicGraph() {
    const g = this.graph;
    return {
      root: g.root,
      missing: !!g.missing,
      truncated: g.truncated,
      nodes: g.nodes.map((n) => ({ id: n.id, name: n.name, type: n.type, kind: n.kind, parent: n.parent, depth: n.depth, group: n.group })),
      links: g.links,
    };
  }

  find({ query, paths } = {}) {
    const out = new Map();
    for (const p of paths || []) {
      const abs = path.resolve(String(p));
      const n = this.byAbs.get(abs);
      if (n) out.set(n.id, n);
      // A folder path lights up everything inside it too.
      if (!n || n.type === 'dir') for (const node of this.graph.nodes) if (node.abs.startsWith(abs + path.sep) && out.size < 400) out.set(node.id, node);
    }
    const q = String(query || '').toLowerCase().trim();
    if (q) {
      const words = q.split(/[\s_\-./\\]+/).filter((w) => w.length > 1);
      const scored = [];
      for (const n of this.graph.nodes) {
        if (n.kind === 'root') continue;
        const name = n.name.toLowerCase();
        const rel = path.relative(this.graph.root, n.abs).toLowerCase();
        let s = 0;
        if (name.includes(q)) s += 10;
        else if (rel.includes(q)) s += 6;
        let hit = 0;
        for (const w of words) { if (name.includes(w)) { s += 3; hit++; } else if (rel.includes(w)) { s += 1; hit++; } }
        if (words.length && hit < Math.ceil(words.length * 0.6)) s = name.includes(q) ? s : 0;
        if (n.type === 'dir' && s) s += 1;
        if (s > 0) scored.push([s, n]);
      }
      scored.sort((a, b) => b[0] - a[0] || a[1].depth - b[1].depth);
      const top = scored.slice(0, 40);
      for (const [, n] of top) {
        out.set(n.id, n);
        // A matched folder lights up with its direct children.
        if (n.type === 'dir') for (const c of this.graph.nodes) if (c.parent === n.id && out.size < 160) out.set(c.id, c);
      }
    }
    return [...out.values()];
  }

  inside(abs) {
    const root = this.graph.root || this.getCfg().brainDir;
    const home = this.getCfg().home;
    const r = path.resolve(abs);
    return [root, home].some((base) => r === base || r.startsWith(base + path.sep));
  }

  // Preview for the HUD side panel. Only files inside the second brain or the Jarvis workspace.
  preview(idOrAbs) {
    const node = typeof idOrAbs === 'number' ? this.byId.get(idOrAbs) : null;
    const abs = node ? node.abs : path.resolve(String(idOrAbs));
    if (!this.inside(abs)) return { error: 'Outside the second-brain folder.' };
    let st;
    try { st = fs.statSync(abs); } catch { return { error: 'File not found.' }; }
    const base = { name: path.basename(abs), path: abs, size: st.size, modified: st.mtimeMs };
    if (st.isDirectory()) {
      let children = [];
      try { children = fs.readdirSync(abs, { withFileTypes: true }).filter((e) => !e.name.startsWith('.')).slice(0, 200).map((e) => ({ name: e.name, dir: e.isDirectory() })); } catch { /* ignore */ }
      return { ...base, kind: 'dir', children };
    }
    const ext = path.extname(abs).toLowerCase();
    if (IMAGE_EXT.has(ext)) return { ...base, kind: 'image' };
    if (TEXT_EXT.has(ext) || st.size < 200 * 1024) {
      try {
        const fd = fs.openSync(abs, 'r');
        const buf = Buffer.alloc(Math.min(st.size, 24 * 1024));
        fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        if (!buf.includes(0)) return { ...base, kind: ext === '.md' || ext === '.markdown' ? 'markdown' : 'text', text: buf.toString('utf8'), clipped: st.size > buf.length };
      } catch { /* fall through */ }
    }
    return { ...base, kind: 'binary' };
  }
}

export const isImagePath = (p) => IMAGE_EXT.has(path.extname(String(p)).toLowerCase());
