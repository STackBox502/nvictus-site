// Pure overlay placement math (testable without Electron).

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayLike {
  id: number;
  workArea: Rect;
  primary?: boolean;
}

export const OVERLAY_BASE = { width: 240, height: 330 } as const;
export const EDGE_MARGIN = 16;

export function overlaySize(scale: number): { width: number; height: number } {
  const s = Math.min(2, Math.max(0.5, scale || 1));
  return { width: Math.round(OVERLAY_BASE.width * s), height: Math.round(OVERLAY_BASE.height * s) };
}

export function clampToArea(r: Rect, area: Rect): Rect {
  const width = Math.min(r.width, area.width);
  const height = Math.min(r.height, area.height);
  const x = Math.min(Math.max(r.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(r.y, area.y), area.y + area.height - height);
  return { x: Math.round(x), y: Math.round(y), width, height };
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return w * h;
}

/** Docked default position: right (or left) edge, slightly below vertical centre, inside the work area (taskbar excluded). */
export function dockedPosition(area: Rect, size: { width: number; height: number }, dock: 'left' | 'right'): Rect {
  const x = dock === 'right' ? area.x + area.width - size.width - EDGE_MARGIN : area.x + EDGE_MARGIN;
  const y = area.y + Math.round(area.height * 0.56 - size.height / 2);
  return clampToArea({ x, y, ...size }, area);
}

/**
 * Chooses the overlay bounds: saved position on the display it overlaps most (recovering if that
 * monitor disconnected), else the docked default on the selected/primary display.
 */
export function computeOverlayBounds(
  opts: { scale: number; dock: 'left' | 'right'; displayId: number | null; position: { x: number; y: number } | null },
  displays: readonly DisplayLike[],
): { bounds: Rect; displayId: number } {
  const size = overlaySize(opts.scale);
  const primary = displays.find((d) => d.primary) ?? displays[0];
  if (!primary) return { bounds: { x: 0, y: 0, ...size }, displayId: 0 };
  if (opts.position) {
    const want = { ...opts.position, ...size };
    let best: DisplayLike | undefined;
    let bestArea = 0;
    for (const d of displays) {
      const a = overlap(want, d.workArea);
      if (a > bestArea) {
        bestArea = a;
        best = d;
      }
    }
    if (best && bestArea >= size.width * size.height * 0.25) return { bounds: clampToArea(want, best.workArea), displayId: best.id };
  }
  const target = displays.find((d) => d.id === opts.displayId) ?? primary;
  return { bounds: dockedPosition(target.workArea, size, opts.dock), displayId: target.id };
}

/** After a drag: which edge is closer decides the dock side. */
export function dockFor(bounds: Rect, area: Rect): 'left' | 'right' {
  return bounds.x + bounds.width / 2 < area.x + area.width / 2 ? 'left' : 'right';
}
