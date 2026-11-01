import { useEffect, useState } from 'react';
import type { InvokeChannel } from '../../shared/channels';
import type { Settings } from '../../shared/settings';
import type { AppSnapshot, CharacterAsset } from '../../shared/types';

/** Friendly accelerator text for Windows users. */
export function prettyAccel(acc: string): string {
  return acc.replace(/CommandOrControl|CmdOrCtrl/g, 'Ctrl').replace(/\+/g, ' + ');
}

export function call<T = unknown>(channel: InvokeChannel, payload?: unknown): Promise<T> {
  return window.jarvis.invoke(channel, payload) as Promise<T>;
}

/** Strips Electron's "Error invoking remote method" prefix for display. */
export function errText(err: unknown): string {
  const m = (err as Error)?.message ?? String(err);
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

export function useSnapshot(): AppSnapshot | null {
  const [snap, setSnap] = useState<AppSnapshot | null>(null);
  useEffect(() => {
    let alive = true;
    call<AppSnapshot>('app:snapshot').then((s) => alive && setSnap(s)).catch(() => undefined);
    const off = window.jarvis.on('state', (s) => setSnap(s as AppSnapshot));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return snap;
}

export function useSettings(): Settings | null {
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => {
    let alive = true;
    call<Settings>('settings:get').then((v) => alive && setS(v)).catch(() => undefined);
    const off = window.jarvis.on('settings', (v) => setS(v as Settings));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return s;
}

export function patchSettings(patch: Record<string, unknown>): Promise<Settings> {
  return call<Settings>('settings:update', patch);
}

/** Builds a nested patch from a dotted path: ("voice.speed", 1.1) → { voice: { speed: 1.1 } }. */
export function pathPatch(path: string, value: unknown): Record<string, unknown> {
  const keys = path.split('.');
  const root: Record<string, unknown> = {};
  let cur = root;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) cur[k] = value;
    else {
      const next: Record<string, unknown> = {};
      cur[k] = next;
      cur = next;
    }
  });
  return root;
}

export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

export function useAsset(): { asset: CharacterAsset | null; url: string | null } {
  const [state, setState] = useState<{ asset: CharacterAsset | null; url: string | null }>({ asset: null, url: null });
  useEffect(() => {
    let alive = true;
    let current: string | null = null;
    const load = () =>
      call<CharacterAsset>('assets:get').then((a) => {
        if (!alive) return;
        if (current) URL.revokeObjectURL(current);
        current = a.bytes ? URL.createObjectURL(new Blob([a.bytes as BlobPart], { type: a.mime })) : null;
        setState({ asset: a, url: current });
      });
    void load();
    const off = window.jarvis.on('asset:changed', () => void load());
    return () => {
      alive = false;
      off();
      if (current) URL.revokeObjectURL(current);
    };
  }, []);
  return state;
}

export function usePrefersReducedMotion(): boolean {
  const [r, setR] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const fn = () => setR(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  return r;
}
