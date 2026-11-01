import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { AUDIO_FRAME_CHANNEL, EVENT_CHANNELS, INVOKE_CHANNELS, SEND_CHANNELS, type EventChannel, type InvokeChannel, type SendChannel } from '../shared/channels';

const invokeSet = new Set<string>(INVOKE_CHANNELS);
const sendSet = new Set<string>(SEND_CHANNELS);
const eventSet = new Set<string>(EVENT_CHANNELS);

/**
 * Narrow bridge: fixed channel allowlists only. No fs, shell, raw ipcRenderer, or arbitrary channels.
 * All payloads are validated again in main.
 */
const api = {
  invoke(channel: InvokeChannel, payload?: unknown): Promise<unknown> {
    if (!invokeSet.has(channel)) return Promise.reject(new Error('Channel not allowed'));
    return ipcRenderer.invoke(channel, payload);
  },
  send(channel: SendChannel, payload?: unknown): void {
    if (sendSet.has(channel)) ipcRenderer.send(channel, payload);
  },
  sendFrame(sessionId: number, data: Uint8Array): void {
    ipcRenderer.send(AUDIO_FRAME_CHANNEL, sessionId, data);
  },
  on(channel: EventChannel, cb: (payload: unknown) => void): () => void {
    if (!eventSet.has(channel)) return () => undefined;
    const listener = (_e: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld('jarvis', api);

export type JarvisApi = typeof api;
