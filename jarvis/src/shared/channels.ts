// IPC channel allowlists. Imported by preload (no zod) and main (with schemas in ipcSchemas.ts).

export const INVOKE_CHANNELS = [
  'app:snapshot',
  'settings:get',
  'settings:update',
  'settings:reset',
  'secrets:set',
  'secrets:delete',
  'conn:test',
  'models:list',
  'voices:list',
  'voices:validate',
  'tts:models',
  'voice:preview',
  'conv:sendText',
  'conv:talk',
  'conv:stop',
  'conv:mute',
  'conv:new',
  'conv:retry',
  'conv:confirm',
  'conv:switchProvider',
  'wake:arm',
  'wake:selfTest',
  'memory:list',
  'memory:add',
  'memory:update',
  'memory:delete',
  'memory:clear',
  'history:clear',
  'export:conversation',
  'export:memories',
  'export:diagnostics',
  'assets:get',
  'assets:pick',
  'assets:confirm',
  'assets:reset',
  'displays:list',
  'overlay:resetPosition',
  'overlay:setShown',
  'preview:set',
  'usage:get',
  'audio:levelTest',
  'audio:testTone',
  'diagnostics:get',
  'external:open',
  'app:quit',
] as const;

export const SEND_CHANNELS = [
  'overlay:setInteractive',
  'overlay:drag',
  'overlay:openChat',
  'overlay:contextMenu',
  'audio:event',
] as const;

export const EVENT_CHANNELS = ['state', 'settings', 'audio:cmd', 'levels', 'asset:changed', 'usage', 'nav'] as const;

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];
export type SendChannel = (typeof SEND_CHANNELS)[number];
export type EventChannel = (typeof EVENT_CHANNELS)[number];

/** Dedicated high-rate channel for 16 kHz PCM microphone frames (overlay → main). */
export const AUDIO_FRAME_CHANNEL = 'audio:frame';
