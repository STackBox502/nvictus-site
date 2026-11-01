import { writeFileSync } from 'node:fs';
import { BrowserWindow, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { AUDIO_FRAME_CHANNEL, type InvokeChannel } from '../shared/channels';
import { EXTERNAL_LINKS, type ExternalLinkKey } from '../shared/endpoints';
import { INVOKE_SCHEMAS, SEND_SCHEMAS, isTrustedOrigin, validateFrame } from '../shared/ipcSchemas';
import { redact } from '../shared/redact';
import type { ChatMessage, ConvState, MemoryRecord, ProviderId, SecretName } from '../shared/types';
import type { AssetManager } from './assets';
import type { ConversationController } from './controller';
import { buildDiagnostics } from './diagnostics';
import type { Logger } from './log';
import type { SecretStore } from './secrets';
import type { MemoryStore, SettingsStore, UsageStore } from './stores';
import { SecretError } from './secrets';
import { displaysLike } from './windows';

export interface IpcContext {
  controller: ConversationController;
  settings: SettingsStore;
  secrets: SecretStore;
  memories: MemoryStore;
  usage: UsageStore;
  assets: AssetManager;
  log: Logger;
  devUrl: string | undefined;
  overlay(): BrowserWindow | null;
  chat(): BrowserWindow | null;
  listModels(provider: ProviderId): Promise<string[]>;
  listVoices(): Promise<unknown>;
  validateVoice(id: string): Promise<unknown>;
  listTtsModels(): Promise<unknown>;
  overlayInteractive(interactive: boolean): void;
  overlayDrag(phase: 'start' | 'end'): void;
  overlayContextMenu(): void;
  showChat(tab?: string): void;
  setOverlayShown(shown: boolean): void;
  resetOverlayPosition(): void;
  broadcastAsset(): void;
  audioSend(cmd: unknown): void;
  wakeDropped(): number;
  quit(): void;
}

function senderOk(event: IpcMainInvokeEvent | IpcMainEvent, ctx: IpcContext, onlyOverlay = false): boolean {
  const url = event.senderFrame?.url ?? '';
  if (!isTrustedOrigin(url, ctx.devUrl)) return false;
  const ov = ctx.overlay();
  const ch = ctx.chat();
  if (onlyOverlay) return !!ov && event.sender === ov.webContents;
  return (!!ov && event.sender === ov.webContents) || (!!ch && event.sender === ch.webContents);
}

function toMarkdown(messages: ChatMessage[], startedAt: number): string {
  const lines = [`# Jarvis conversation`, ``, `Started ${new Date(startedAt).toLocaleString()}`, ``];
  for (const m of messages) {
    const who = m.role === 'user' ? '**You**' : m.role === 'assistant' ? `**Assistant**${m.provider ? ` (${m.provider}${m.model ? ` · ${m.model}` : ''})` : ''}` : '_Note_';
    lines.push(`${who}: ${m.text}${m.interrupted ? `\n\n> Interrupted. Heard: ${m.heardText ?? ''}` : ''}`, '');
  }
  return lines.join('\n');
}

function memoriesMarkdown(mems: MemoryRecord[]): string {
  return ['# Jarvis saved memories', '', ...mems.map((m) => `- ${m.text} _(saved ${new Date(m.createdAt).toLocaleDateString()})_`), ''].join('\n');
}

async function saveFile(win: BrowserWindow | null, defaultName: string, content: string): Promise<{ saved: boolean; path?: string }> {
  const ext = defaultName.split('.').pop()!;
  const opts = { defaultPath: defaultName, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] };
  const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (res.canceled || !res.filePath) return { saved: false };
  writeFileSync(res.filePath, content, 'utf8');
  return { saved: true, path: res.filePath };
}

export function registerIpc(ctx: IpcContext): void {
  const c = ctx.controller;
  const handlers: Record<InvokeChannel, (p: any, e: IpcMainInvokeEvent) => unknown> = {
    'app:snapshot': () => c.snapshot(),
    'settings:get': () => ctx.settings.get(),
    'settings:update': (p) => {
      const res = ctx.settings.update(p);
      if (!res.ok) throw new Error(res.error);
      return res.settings;
    },
    'settings:reset': () => ctx.settings.reset(),
    'secrets:set': async (p: { name: SecretName; value: string; persist: boolean }) => {
      try {
        await ctx.secrets.set(p.name, p.value, p.persist);
      } catch (err) {
        // Deliberately no `cause`: the original error could carry the key value; only a safe message crosses IPC.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(err instanceof SecretError ? err.message : 'Could not store the key.');
      }
      c.secretsChanged(p.name);
      return ctx.secrets.status();
    },
    'secrets:delete': async (p: { name: SecretName }) => {
      await ctx.secrets.delete(p.name);
      c.secretsChanged(p.name);
      return ctx.secrets.status();
    },
    'conn:test': (p: { target: SecretName }) => c.testConnection(p.target),
    'models:list': (p: { provider: ProviderId }) => ctx.listModels(p.provider),
    'voices:list': () => ctx.listVoices(),
    'voices:validate': (p: { voiceId: string }) => ctx.validateVoice(p.voiceId),
    'tts:models': () => ctx.listTtsModels(),
    'voice:preview': () => c.previewVoice(),
    'conv:sendText': (p: { text: string }) => c.sendText(p.text),
    'conv:talk': (p: { action: 'toggle' | 'start' | 'end' }) => c.talk(p.action, p.action === 'toggle' ? 'click' : 'hold'),
    'conv:stop': () => c.stop(),
    'conv:mute': (p: { muted: boolean }) => c.setMuted(p.muted),
    'conv:new': () => c.newConversation(false),
    'conv:retry': () => c.retry(),
    'conv:confirm': (p: { id: string; accept: boolean }) => c.confirm(p.id, p.accept),
    'conv:switchProvider': (p: { provider: ProviderId }) => c.switchProvider(p.provider),
    'wake:arm': (p: { armed: boolean }) => c.arm(p.armed),
    'wake:selfTest': () => c.wakeSelfTest(),
    'memory:list': () => ctx.memories.list(),
    'memory:add': (p: { text: string }) => ctx.memories.add(p.text),
    'memory:update': (p: { id: string; text: string }) => ctx.memories.update(p.id, p.text),
    'memory:delete': (p: { id: string }) => ctx.memories.delete([p.id]),
    'memory:clear': () => ctx.memories.clear(),
    'history:clear': () => c.clearHistory(),
    'export:conversation': (p: { format: 'json' | 'md' }) => {
      const { messages, startedAt } = c.conversationExport();
      const content = p.format === 'json' ? JSON.stringify({ startedAt: new Date(startedAt).toISOString(), messages }, null, 2) : toMarkdown(messages, startedAt);
      return saveFile(ctx.chat(), `jarvis-conversation.${p.format}`, content);
    },
    'export:memories': (p: { format: 'json' | 'md' }) => {
      const mems = ctx.memories.list();
      return saveFile(ctx.chat(), `jarvis-memories.${p.format}`, p.format === 'json' ? JSON.stringify(mems, null, 2) : memoriesMarkdown(mems));
    },
    'export:diagnostics': (p: { includeConversation: boolean }) => {
      const diag = buildDiagnostics({
        snapshot: c.snapshot(),
        settings: ctx.settings.get(),
        usage: ctx.usage.snapshot(),
        log: ctx.log.recent(),
        wakeDropped: ctx.wakeDropped(),
        includeConversation: p.includeConversation,
      });
      return saveFile(ctx.chat(), 'jarvis-diagnostics.json', redact(JSON.stringify(diag, null, 2), ctx.secrets.values()));
    },
    'diagnostics:get': () =>
      JSON.parse(
        redact(
          JSON.stringify(
            buildDiagnostics({ snapshot: c.snapshot(), settings: ctx.settings.get(), usage: ctx.usage.snapshot(), log: ctx.log.recent(), wakeDropped: ctx.wakeDropped(), includeConversation: false }),
          ),
          ctx.secrets.values(),
        ),
      ),
    'assets:get': () => ctx.assets.current(),
    'assets:pick': () => ctx.assets.pick(ctx.chat()),
    'assets:confirm': (p: { token: string }) => {
      const a = ctx.assets.confirm(p.token);
      ctx.broadcastAsset();
      return a;
    },
    'assets:reset': () => {
      const a = ctx.assets.reset();
      ctx.broadcastAsset();
      return a;
    },
    'displays:list': () => displaysLike().map((d, i) => ({ id: d.id, label: `Display ${i + 1}${d.primary ? ' (primary)' : ''} · ${d.workArea.width}×${d.workArea.height}`, primary: !!d.primary, workArea: d.workArea, scaleFactor: 1 })),
    'overlay:resetPosition': () => ctx.resetOverlayPosition(),
    'overlay:setShown': (p: { shown: boolean }) => ctx.setOverlayShown(p.shown),
    'preview:set': (p: { active: boolean; state?: ConvState }) => c.setPreview(p.active, p.state),
    'usage:get': () => ctx.usage.snapshot(),
    'audio:levelTest': (p: { active: boolean }) => c.levelTest(p.active),
    'audio:testTone': () => ctx.audioSend({ type: 'testTone' }),
    'external:open': (p: { key: ExternalLinkKey }) => {
      const url = EXTERNAL_LINKS[p.key];
      if (!url.startsWith('https://')) throw new Error('Blocked link');
      return shell.openExternal(url);
    },
    'app:quit': () => ctx.quit(),
  };

  for (const [channel, fn] of Object.entries(handlers) as Array<[InvokeChannel, (p: unknown, e: IpcMainInvokeEvent) => unknown]>) {
    ipcMain.handle(channel, async (event, payload: unknown) => {
      if (!senderOk(event, ctx)) {
        ctx.log.warn('ipc.untrusted_sender', { channel });
        throw new Error('Untrusted sender');
      }
      const parsed = INVOKE_SCHEMAS[channel].safeParse(payload);
      if (!parsed.success) {
        ctx.log.warn('ipc.invalid_payload', { channel });
        throw new Error(`Invalid request for ${channel}`);
      }
      try {
        return await fn(parsed.data, event);
      } catch (err) {
        // Deliberately no `cause`: only the redacted message may reach the renderer.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(redact((err as Error)?.message ?? 'Request failed', ctx.secrets.values()));
      }
    });
  }

  ipcMain.on('overlay:setInteractive', (event, payload: unknown) => {
    if (!senderOk(event, ctx, true)) return;
    const p = SEND_SCHEMAS['overlay:setInteractive'].safeParse(payload);
    if (p.success) ctx.overlayInteractive(p.data.interactive);
  });
  ipcMain.on('overlay:drag', (event, payload: unknown) => {
    if (!senderOk(event, ctx, true)) return;
    const p = SEND_SCHEMAS['overlay:drag'].safeParse(payload);
    if (p.success) ctx.overlayDrag(p.data.phase);
  });
  ipcMain.on('overlay:openChat', (event) => {
    if (senderOk(event, ctx, true)) ctx.showChat('chat');
  });
  ipcMain.on('overlay:contextMenu', (event) => {
    if (senderOk(event, ctx, true)) ctx.overlayContextMenu();
  });
  ipcMain.on('audio:event', (event, payload: unknown) => {
    if (!senderOk(event, ctx, true)) return;
    const p = SEND_SCHEMAS['audio:event'].safeParse(payload);
    if (p.success) c.onAudioEvent(p.data);
  });
  ipcMain.on(AUDIO_FRAME_CHANNEL, (event, sessionId: unknown, data: unknown) => {
    if (!senderOk(event, ctx, true)) return;
    if (!validateFrame(sessionId, data)) return;
    c.onAudioFrame(sessionId as number, data);
  });
}
