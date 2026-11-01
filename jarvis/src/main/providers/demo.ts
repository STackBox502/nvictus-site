import type { LlmAdapter, LlmEvent, LlmRequest } from './types';

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

/** Demo-mode "brain": deterministic local replies. No network, no charges, never counts as live verification. */
export class DemoLlm implements LlmAdapter {
  readonly id = 'demo' as const;
  constructor(private readonly delayMs = 35) {}
  async listModels(): Promise<string[]> {
    return ['demo'];
  }
  async *stream(req: LlmRequest): AsyncGenerator<LlmEvent> {
    const last = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const reply = demoReply(last);
    await sleep(250, req.signal);
    for (const word of reply.split(/(?<= )/)) {
      if (req.signal.aborted) return;
      yield { type: 'text', text: word };
      await sleep(this.delayMs, req.signal);
    }
    if (!req.signal.aborted) yield { type: 'done', stopReason: 'demo' };
  }
}

export function demoReply(userText: string): string {
  const quoted = userText.replace(/\s+/g, ' ').trim().slice(0, 80);
  return `Demo mode. I received: "${quoted}". This reply is simulated on your computer, so no API was called and nothing was charged. Turn off demo mode in Settings once your keys are set, and the real voice and brain take over. The audio you hear now is a placeholder tone, not a voice.`;
}
