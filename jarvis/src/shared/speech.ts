// Streaming text → speech-sized chunks, plus Markdown → speakable text.

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'inc', 'ltd', 'co', 'corp',
  'no', 'fig', 'approx', 'dept', 'est', 'mt', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug',
  'sep', 'sept', 'oct', 'nov', 'dec', 'e.g', 'i.e', 'a.m', 'p.m', 'u.s', 'u.k', 'ph.d',
]);

const CLOSERS = new Set([')', ']', '"', "'", '’', '”', '*', '_']);

export interface ChunkerOptions {
  /** Minimum characters for the first chunk (small = lower latency). */
  firstMinChars: number;
  /** Minimum characters for later chunks (short sentences are merged to save requests). */
  minChars: number;
  /** Hard maximum per chunk; long runs are split at the best soft boundary. */
  maxChars: number;
}

export const DEFAULT_CHUNKER: ChunkerOptions = { firstMinChars: 1, minChars: 40, maxChars: 260 };

function isAbbreviation(text: string, dotIndex: number): boolean {
  // Word immediately before the dot, including internal dots like "e.g".
  let start = dotIndex - 1;
  while (start >= 0 && /[A-Za-z.]/.test(text[start]!)) start--;
  const word = text.slice(start + 1, dotIndex).toLowerCase();
  if (!word) return false;
  if (ABBREVIATIONS.has(word)) return true;
  // Single-letter initials such as "J. Smith" or "U.S."
  return /^[a-z]$/.test(word) || /^([a-z]\.)+[a-z]$/.test(word);
}

/**
 * Finds the end index (exclusive) of the first complete sentence in `text`, or -1.
 * A boundary needs to be followed by whitespace, so "3.14" and "example.com" never split,
 * and a trailing "." at the very end of a still-streaming buffer is not trusted yet.
 */
export function findBoundary(text: string, from = 0): number {
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\n') return i + 1;
    if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '…' && ch !== ';' && ch !== ':') continue;
    let j = i + 1;
    while (j < text.length && CLOSERS.has(text[j]!)) j++;
    if (j >= text.length) return -1; // need lookahead
    if (!/\s/.test(text[j]!)) continue;
    if (ch === '.' && isAbbreviation(text, i)) continue;
    if (ch === ':' || ch === ';') {
      // Only treat colon/semicolon as a boundary when the clause is reasonably long.
      if (i < 60) continue;
    }
    return j;
  }
  return -1;
}

function softSplit(text: string, maxChars: number): number {
  const window = text.slice(0, maxChars);
  for (const sep of [', ', ' — ', ' - ', ' ']) {
    const idx = window.lastIndexOf(sep);
    if (idx > maxChars * 0.4) return idx + sep.length;
  }
  return maxChars;
}

export class SentenceChunker {
  private buffer = '';
  private emitted = 0;
  constructor(private readonly opts: ChunkerOptions = DEFAULT_CHUNKER) {}

  push(text: string): string[] {
    this.buffer += text;
    return this.drain(false);
  }

  flush(): string[] {
    return this.drain(true);
  }

  private drain(final: boolean): string[] {
    const out: string[] = [];
    for (;;) {
      const min = this.emitted === 0 ? this.opts.firstMinChars : this.opts.minChars;
      let end = -1;
      let searchFrom = 0;
      for (;;) {
        const b = findBoundary(this.buffer, searchFrom);
        if (b === -1) break;
        if (this.buffer.slice(0, b).trim().length >= min) {
          end = b;
          break;
        }
        searchFrom = b;
      }
      if (end === -1 && this.buffer.length > this.opts.maxChars) end = softSplit(this.buffer, this.opts.maxChars);
      if (end === -1) break;
      if (end > this.opts.maxChars) end = softSplit(this.buffer, this.opts.maxChars);
      const chunk = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end);
      if (chunk) {
        out.push(chunk);
        this.emitted++;
      }
    }
    if (final) {
      const rest = this.buffer.trim();
      this.buffer = '';
      if (rest) {
        out.push(rest);
        this.emitted++;
      }
    }
    return out;
  }
}

/**
 * Streaming filter that drops fenced code blocks from speech while they stream in.
 * Emits a single spoken placeholder per code block.
 */
export class FenceFilter {
  private inFence = false;
  private carry = '';
  constructor(private readonly placeholder = ' I put the code in the chat. ') {}

  push(text: string): string {
    let input = this.carry + text;
    this.carry = '';
    let out = '';
    // Hold back trailing backticks that might be the start of a fence.
    const tail = /`{1,2}$/.exec(input);
    if (tail) {
      this.carry = tail[0];
      input = input.slice(0, -tail[0].length);
    }
    let idx = input.indexOf('```');
    while (idx !== -1) {
      if (!this.inFence) out += input.slice(0, idx) + this.placeholder;
      this.inFence = !this.inFence;
      input = input.slice(idx + 3);
      idx = input.indexOf('```');
    }
    if (!this.inFence) out += input;
    return out;
  }

  flush(): string {
    const rest = this.inFence ? '' : this.carry;
    this.carry = '';
    this.inFence = false;
    return rest;
  }
}

/** Converts inline Markdown to speakable text. Keeps words, drops syntax and raw URLs. */
export function cleanForSpeech(text: string): string {
  let s = text;
  s = s.replace(/<[^>]{1,200}>/g, ' '); // stray HTML tags
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1'); // images → alt text
  s = s.replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1'); // links → label
  s = s.replace(/\bhttps?:\/\/[^\s)]+/gi, 'the link in the chat');
  s = s.replace(/\bwww\.[^\s)]+/gi, 'the link in the chat');
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  s = s.replace(/^\s{0,3}>\s?/gm, '');
  s = s.replace(/^\s*[-*+•]\s+/gm, '');
  s = s.replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, ''); // table separator rows
  s = s.replace(/\s*\|\s*/g, ', ');
  s = s.replace(/(\*\*|__|~~)(.+?)\1/g, '$2');
  s = s.replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?;:]|$)/g, '$1$2');
  s = s.replace(/[*_~`#]{2,}/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[,\s]+|[,\s]+$/g, '');
  return s;
}

/** Full pipeline helper: feed LLM deltas, receive speakable chunks. */
export class SpeechPipeline {
  private fence = new FenceFilter();
  private chunker: SentenceChunker;
  constructor(opts: ChunkerOptions = DEFAULT_CHUNKER) {
    this.chunker = new SentenceChunker(opts);
  }
  push(delta: string): string[] {
    return this.chunker.push(this.fence.push(delta)).map(cleanForSpeech).filter(Boolean);
  }
  flush(): string[] {
    const tail = this.fence.flush();
    const chunks = tail ? this.chunker.push(tail) : [];
    return [...chunks, ...this.chunker.flush()].map(cleanForSpeech).filter(Boolean);
  }
}
