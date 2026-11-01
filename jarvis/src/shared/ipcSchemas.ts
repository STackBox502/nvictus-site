import { z } from 'zod';
import type { InvokeChannel } from './channels';
import { EXTERNAL_LINKS } from './endpoints';

const provider = z.enum(['anthropic', 'openai']);
const secretName = z.enum(['anthropic', 'openai', 'elevenlabs']);
const none = z.undefined().or(z.null()).or(z.object({}).strict());
const confirm = z.object({ confirm: z.literal(true) });

/** Every invoke channel has a strict payload schema. Unknown keys are rejected. */
export const INVOKE_SCHEMAS: Record<InvokeChannel, z.ZodType> = {
  'app:snapshot': none,
  'settings:get': none,
  'settings:update': z.record(z.string(), z.unknown()),
  'settings:reset': confirm,
  'secrets:set': z.object({ name: secretName, value: z.string().min(10).max(400), persist: z.boolean() }).strict(),
  'secrets:delete': z.object({ name: secretName }).strict(),
  'conn:test': z.object({ target: secretName }).strict(),
  'models:list': z.object({ provider }).strict(),
  'voices:list': none,
  'voices:validate': z.object({ voiceId: z.string().regex(/^[A-Za-z0-9]{8,40}$/) }).strict(),
  'tts:models': none,
  'voice:preview': none,
  'conv:sendText': z.object({ text: z.string().min(1).max(8000) }).strict(),
  'conv:talk': z.object({ action: z.enum(['toggle', 'start', 'end']) }).strict(),
  'conv:stop': none,
  'conv:mute': z.object({ muted: z.boolean() }).strict(),
  'conv:new': none,
  'conv:retry': none,
  'conv:confirm': z.object({ id: z.string().max(64), accept: z.boolean() }).strict(),
  'conv:switchProvider': z.object({ provider }).strict(),
  'wake:arm': z.object({ armed: z.boolean() }).strict(),
  'wake:selfTest': none,
  'memory:list': none,
  'memory:add': z.object({ text: z.string().min(1).max(500) }).strict(),
  'memory:update': z.object({ id: z.string().max(64), text: z.string().min(1).max(500) }).strict(),
  'memory:delete': z.object({ id: z.string().max(64) }).strict(),
  'memory:clear': confirm,
  'history:clear': confirm,
  'export:conversation': z.object({ format: z.enum(['json', 'md']) }).strict(),
  'export:memories': z.object({ format: z.enum(['json', 'md']) }).strict(),
  'export:diagnostics': z.object({ includeConversation: z.boolean() }).strict(),
  'assets:get': none,
  'assets:pick': none,
  'assets:confirm': z.object({ token: z.string().regex(/^[a-f0-9]{32}$/) }).strict(),
  'assets:reset': confirm,
  'displays:list': none,
  'overlay:resetPosition': none,
  'overlay:setShown': z.object({ shown: z.boolean() }).strict(),
  'preview:set': z
    .object({
      active: z.boolean(),
      state: z.enum(['unconfigured', 'idle', 'armed', 'listening', 'transcribing', 'thinking', 'speaking', 'interrupted', 'muted', 'error']).optional(),
    })
    .strict(),
  'usage:get': none,
  'audio:levelTest': z.object({ active: z.boolean() }).strict(),
  'audio:testTone': none,
  'diagnostics:get': none,
  'external:open': z.object({ key: z.enum(Object.keys(EXTERNAL_LINKS) as [keyof typeof EXTERNAL_LINKS, ...(keyof typeof EXTERNAL_LINKS)[]]) }).strict(),
  'app:quit': none,
};

export const SEND_SCHEMAS = {
  'overlay:setInteractive': z.object({ interactive: z.boolean() }).strict(),
  'overlay:drag': z.object({ phase: z.enum(['start', 'end']) }).strict(),
  'overlay:openChat': none,
  'overlay:contextMenu': none,
  'audio:event': z.discriminatedUnion('type', [
    z.object({ type: z.literal('captureStarted'), sessionId: z.number().int(), sampleRate: z.number() }).strict(),
    z.object({ type: z.literal('captureStopped') }).strict(),
    z.object({ type: z.literal('captureError'), code: z.enum(['mic_denied', 'mic_missing', 'mic_error']), message: z.string().max(500) }).strict(),
    z.object({ type: z.literal('deviceLost') }).strict(),
    z.object({ type: z.literal('level'), input: z.number().min(0).max(1), output: z.number().min(0).max(1) }).strict(),
    z.object({ type: z.literal('playbackStarted'), turnId: z.number().int() }).strict(),
    z.object({ type: z.literal('chunkPlayed'), turnId: z.number().int(), seq: z.number().int().min(0) }).strict(),
    z.object({ type: z.literal('playbackDrained'), turnId: z.number().int() }).strict(),
    z.object({ type: z.literal('outputError'), message: z.string().max(500) }).strict(),
  ]),
} as const;

/** Maximum bytes accepted for one microphone frame (100 ms of 16 kHz int16 = 3200 bytes). */
export const MAX_AUDIO_FRAME_BYTES = 16000;

export function validateFrame(sessionId: unknown, data: unknown): data is Uint8Array {
  return (
    Number.isInteger(sessionId) &&
    data instanceof Uint8Array &&
    data.byteLength > 0 &&
    data.byteLength <= MAX_AUDIO_FRAME_BYTES &&
    data.byteLength % 2 === 0
  );
}

/** Trusted renderer origins: the packaged app:// origin, or the exact dev server in development. */
export function isTrustedOrigin(url: string, devServerUrl: string | undefined): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'app:' && u.host === 'jarvis') return true;
    if (devServerUrl) {
      const d = new URL(devServerUrl);
      return u.origin === d.origin;
    }
    return false;
  } catch {
    return false;
  }
}
