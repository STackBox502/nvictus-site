// Minimal, spec-following Server-Sent Events parser (event/data/id fields, CRLF, comments).

export interface SSEEvent {
  event: string;
  data: string;
}

export class SSEParser {
  private buffer = '';
  private eventName = '';
  private dataLines: string[] = [];
  /** Guards against a provider sending an unbounded line. */
  constructor(private readonly maxLine = 1_000_000) {}

  push(chunk: string): SSEEvent[] {
    this.buffer += chunk;
    const events: SSEEvent[] = [];
    for (;;) {
      const nl = this.buffer.search(/\r\n|\r|\n/);
      if (nl === -1) {
        if (this.buffer.length > this.maxLine) throw new Error('SSE line exceeded maximum length');
        break;
      }
      const line = this.buffer.slice(0, nl);
      const sepLen = this.buffer.startsWith('\r\n', nl) ? 2 : 1;
      this.buffer = this.buffer.slice(nl + sepLen);
      if (line === '') {
        if (this.dataLines.length) events.push({ event: this.eventName || 'message', data: this.dataLines.join('\n') });
        this.eventName = '';
        this.dataLines = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') this.eventName = value;
      else if (field === 'data') this.dataLines.push(value);
    }
    return events;
  }

  /** Dispatch a final event if the stream ended without a trailing blank line. */
  end(): SSEEvent[] {
    const out = this.buffer ? this.push('\n\n') : [];
    if (this.dataLines.length) out.push({ event: this.eventName || 'message', data: this.dataLines.join('\n') });
    this.dataLines = [];
    return out;
  }
}

/** Reads an SSE stream from a fetch Response body. */
export async function* readSSE(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SSEParser();
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      for (const ev of parser.push(decoder.decode(value, { stream: true }))) yield ev;
    }
    for (const ev of parser.push(decoder.decode())) yield ev;
    for (const ev of parser.end()) yield ev;
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
