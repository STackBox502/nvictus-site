import { join } from 'node:path';
import { BrowserWindow, nativeImage, screen, type NativeImage } from 'electron';
import { computeOverlayBounds, clampToArea, dockFor, overlaySize, type DisplayLike } from '../shared/geometry';
import type { Settings } from '../shared/settings';

const secureWebPreferences = (preload: string, extra: Electron.WebPreferences = {}): Electron.WebPreferences => ({
  preload,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  spellcheck: false,
  navigateOnDragDrop: false,
  ...extra,
});

export function displaysLike(): DisplayLike[] {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d) => ({ id: d.id, workArea: d.workArea, primary: d.id === primary }));
}

export function rendererUrl(page: 'overlay' | 'chat', devUrl: string | undefined): string {
  return devUrl ? `${devUrl}/${page}.html` : `app://jarvis/${page}.html`;
}

export function createOverlayWindow(preload: string, url: string, s: Settings['overlay']): BrowserWindow {
  const { bounds } = computeOverlayBounds(s, displaysLike());
  const win = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: s.alwaysOnTop,
    focusable: true,
    title: 'Jarvis overlay',
    webPreferences: secureWebPreferences(preload, { backgroundThrottling: false }),
  });
  if (s.alwaysOnTop) win.setAlwaysOnTop(true, 'floating');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setOpacity(s.opacity);
  void win.loadURL(url);
  return win;
}

export function createChatWindow(preload: string, url: string, icon: NativeImage): BrowserWindow {
  const win = new BrowserWindow({
    width: 1020,
    height: 760,
    minWidth: 760,
    minHeight: 540,
    show: false,
    title: 'Jarvis',
    icon,
    backgroundColor: '#0c0c10',
    autoHideMenuBar: true,
    webPreferences: secureWebPreferences(preload),
  });
  win.setMenuBarVisibility(false);
  void win.loadURL(url);
  return win;
}

/** Re-applies size/position after scale, dock, display, or monitor changes. */
export function placeOverlay(win: BrowserWindow, s: Settings['overlay']): { x: number; y: number; displayId: number } {
  const { bounds, displayId } = computeOverlayBounds(s, displaysLike());
  win.setBounds(bounds);
  return { x: bounds.x, y: bounds.y, displayId };
}

/** Manual drag: polls the cursor while the handle is held (reliable together with click-through). */
export class OverlayDragger {
  private timer: ReturnType<typeof setInterval> | null = null;
  private offset = { x: 0, y: 0 };
  private safety: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private readonly win: () => BrowserWindow | null,
    private readonly onDone: (pos: { x: number; y: number; displayId: number; dock: 'left' | 'right' }) => void,
  ) {}
  start(): void {
    const w = this.win();
    if (!w || this.timer) return;
    const c = screen.getCursorScreenPoint();
    const [x, y] = w.getPosition() as [number, number];
    this.offset = { x: c.x - x, y: c.y - y };
    this.timer = setInterval(() => {
      const cur = screen.getCursorScreenPoint();
      this.win()?.setPosition(Math.round(cur.x - this.offset.x), Math.round(cur.y - this.offset.y));
    }, 16);
    this.safety = setTimeout(() => this.end(), 15000);
  }
  end(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    if (this.safety) clearTimeout(this.safety);
    const w = this.win();
    if (!w) return;
    const b = w.getBounds();
    const d = screen.getDisplayMatching(b);
    const clamped = clampToArea(b, d.workArea);
    w.setBounds(clamped);
    this.onDone({ x: clamped.x, y: clamped.y, displayId: d.id, dock: dockFor(clamped, d.workArea) });
  }
}

/** Procedurally drawn icon (gold ring, violet core) so no binary asset is required. */
export function drawIcon(size: number, accent: 'normal' | 'muted' | 'active' = 'normal'): NativeImage {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const core = accent === 'muted' ? [90, 90, 100] : accent === 'active' ? [180, 120, 255] : [139, 92, 246];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist = Math.hypot(x - c, y - c) / (size / 2);
      let rgb: number[] | null = null;
      let a = 0;
      if (dist <= 0.55) {
        rgb = core;
        a = 255;
      } else if (dist <= 0.72) {
        rgb = [12, 12, 16];
        a = 255;
      } else if (dist <= 0.98) {
        rgb = [212, 166, 74];
        a = dist > 0.92 ? Math.round(255 * (1 - (dist - 0.92) / 0.06)) : 255;
      }
      const i = (y * size + x) * 4;
      if (rgb) {
        buf[i] = rgb[2]!; // BGRA
        buf[i + 1] = rgb[1]!;
        buf[i + 2] = rgb[0]!;
        buf[i + 3] = a;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

export function overlayBaseSize(scale: number) {
  return overlaySize(scale);
}

export const preloadPath = () => join(__dirname, '../preload/index.js');
