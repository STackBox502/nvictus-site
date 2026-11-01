/// <reference types="vite/client" />
import type { EventChannel, InvokeChannel, SendChannel } from '../../shared/channels';

declare global {
  interface Window {
    jarvis: {
      invoke(channel: InvokeChannel, payload?: unknown): Promise<unknown>;
      send(channel: SendChannel, payload?: unknown): void;
      sendFrame(sessionId: number, data: Uint8Array): void;
      on(channel: EventChannel, cb: (payload: unknown) => void): () => void;
    };
  }
  interface AudioContext {
    setSinkId?(id: string): Promise<void>;
  }
}
export {};
