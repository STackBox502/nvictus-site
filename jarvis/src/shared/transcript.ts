// Assembles realtime STT partial/committed segments into one user turn with explicit endpointing.

export class TranscriptAssembler {
  private segments: string[] = [];
  private partial = '';
  private lastActivity = 0;
  private speechSeen = false;

  constructor(private endpointMs: number) {}

  setEndpoint(ms: number): void {
    this.endpointMs = ms;
  }

  onPartial(text: string, now: number): void {
    this.partial = text.trim();
    if (this.partial) {
      this.lastActivity = now;
      this.speechSeen = true;
    }
  }

  onCommitted(text: string, now: number): void {
    const t = text.trim();
    if (t) {
      this.segments.push(t);
      this.speechSeen = true;
    }
    this.partial = '';
    this.lastActivity = now;
  }

  /** VAD mode: finalize once a committed segment exists, no partial is pending, and silence lasted endpointMs. */
  shouldFinalize(now: number): boolean {
    return this.segments.length > 0 && !this.partial && now - this.lastActivity >= this.endpointMs;
  }

  hasSpeech(): boolean {
    return this.speechSeen;
  }

  /** Final text: committed segments only (partials are never submitted). */
  text(): string {
    return joinSegments(this.segments);
  }

  /** Live display: committed segments plus the current partial. */
  displayText(): string {
    return joinSegments(this.partial ? [...this.segments, this.partial] : this.segments);
  }

  reset(): void {
    this.segments = [];
    this.partial = '';
    this.lastActivity = 0;
    this.speechSeen = false;
  }
}

export function joinSegments(segments: readonly string[]): string {
  return segments
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Removes a leading wake phrase ("Hey Jarvis, …") captured in pre-roll audio. */
export function stripWakePhrase(text: string, assistantName = 'Jarvis'): string {
  const name = assistantName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*(?:(?:hey|hi|ok|okay|a|hay)[\\s,]+)?(?:${name}|jarvis|jervis|travis)\\b[\\s,.!?:-]*`, 'i');
  return text.replace(re, '').trim();
}
