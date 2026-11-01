import { useEffect, useMemo, useRef, useState } from 'react';
import { STATE_LABELS } from '../../../shared/stateMachine';
import { envelope, levelToEnergy, motionAt, stateVisual } from '../../../shared/motion';
import type { ConvState } from '../../../shared/types';
import type { AudioEngine } from '../audio/engine';
import { useAsset, usePrefersReducedMotion, useSettings, useSnapshot } from '../hooks';
import { Placeholder } from './Placeholder';

const ACTIVE: ConvState[] = ['listening', 'transcribing', 'thinking', 'speaking', 'interrupted', 'error'];
const ICON: Partial<Record<ConvState, string>> = {
  listening: '●',
  transcribing: '…',
  thinking: '◌',
  speaking: '♪',
  muted: '⨯',
  error: '!',
  armed: '◉',
};

export function Overlay({ engine }: { engine: AudioEngine }) {
  const snap = useSnapshot();
  const settings = useSettings();
  const { asset, url } = useAsset();
  const systemReduced = usePrefersReducedMotion();
  const stageRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);
  const trailA = useRef<SVGEllipseElement>(null);
  const trailB = useRef<SVGEllipseElement>(null);
  const draggingRef = useRef(false);
  const [expanded, setExpanded] = useState(true);
  const [hover, setHover] = useState(false);

  const preview = snap?.preview.active ?? false;
  const view: ConvState = preview ? snap!.preview.state : (snap?.state ?? 'idle');
  const reduced = settings ? settings.motion.reducedMotion === 'on' || (settings.motion.reducedMotion === 'system' && systemReduced) : systemReduced;
  const visibility = settings?.overlay.visibility ?? 'onDemand';

  // Compact badge when idle (on-demand mode); gentle reveal on activity; collapse after a delay.
  useEffect(() => {
    if (visibility === 'always' || ACTIVE.includes(view) || hover) {
      setExpanded(true);
      return;
    }
    const t = setTimeout(() => setExpanded(false), settings?.overlay.collapseDelayMs ?? 6000);
    return () => clearTimeout(t);
  }, [view, visibility, hover, settings?.overlay.collapseDelayMs]);

  // Animation loop: transforms/opacity only; stops when hidden.
  useEffect(() => {
    if (!settings) return;
    let raf = 0;
    let last = performance.now();
    let inE = 0;
    let outE = 0;
    let sweep = 0;
    const t0 = last;
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const t = (now - t0) / 1000;
      let inTarget = levelToEnergy(engine.inputLevel());
      let outTarget = levelToEnergy(engine.outputRms());
      if (preview) {
        // Visual preview only: synthetic levels, clearly labelled, never used for live behaviour.
        const syn = 0.5 + 0.45 * Math.sin(t * 7) * Math.abs(Math.sin(t * 2.3));
        inTarget = view === 'listening' ? syn : 0;
        outTarget = view === 'speaking' ? syn : 0;
      }
      inE = envelope(inE, inTarget, dt);
      outE = envelope(outE, outTarget, dt, 0.03, 0.18);
      const v = stateVisual(view, inE, outE, settings.motion.glow);
      const m = motionAt(t, settings.motion, reduced);
      if (v.sweep && !reduced) sweep = (sweep + dt * 60) % 360;
      const body = bodyRef.current;
      if (body) body.style.transform = `translate(${m.x.toFixed(2)}px, ${m.y.toFixed(2)}px) rotate(${m.rot.toFixed(3)}deg)`;
      const glow = glowRef.current;
      if (glow) {
        glow.style.opacity = (0.15 + v.energy * 0.85).toFixed(3);
        glow.style.transform = `scale(${(0.92 + v.energy * 0.14).toFixed(3)})`;
      }
      const drift = reduced ? 0 : t * (settings.motion.preset === 'orbit' ? 6 : 2) * settings.motion.speed;
      const width = (1 + v.energy * 2.2).toFixed(2);
      const opacity = (0.22 + v.energy * 0.7).toFixed(3);
      for (const [el, base, dir] of [
        [trailA.current, -16, 1],
        [trailB.current, 13, -1],
      ] as const) {
        if (!el) continue;
        el.setAttribute('transform', `rotate(${(base + dir * (v.sweep ? sweep * 0.25 : drift % 360 * 0.05)).toFixed(2)} 120 150)`);
        el.style.strokeWidth = width;
        el.style.opacity = opacity;
        el.style.strokeDashoffset = v.sweep ? String(-sweep * 2) : '0';
      }
      raf = requestAnimationFrame(frame);
    };
    const start = () => {
      if (!raf && document.visibilityState === 'visible') raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    const onVis = () => (document.visibilityState === 'visible' ? start() : stop());
    document.addEventListener('visibilitychange', onVis);
    start();
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [engine, settings, view, preview, reduced]);

  const interactive = (on: boolean) => {
    if (!on && draggingRef.current) return;
    window.jarvis.send('overlay:setInteractive', { interactive: on });
  };
  const hit = {
    onPointerEnter: () => {
      interactive(true);
      setHover(true);
    },
    onPointerLeave: () => {
      interactive(false);
      setHover(false);
    },
    onFocus: () => interactive(true),
  };

  const mode = settings?.activation.mode ?? 'click';
  const talkProps =
    mode === 'push'
      ? {
          onPointerDown: (e: React.PointerEvent) => {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            void window.jarvis.invoke('conv:talk', { action: 'start' });
          },
          onPointerUp: () => void window.jarvis.invoke('conv:talk', { action: 'end' }),
          onKeyDown: (e: React.KeyboardEvent) => e.key === ' ' && !e.repeat && void window.jarvis.invoke('conv:talk', { action: 'start' }),
          onKeyUp: (e: React.KeyboardEvent) => e.key === ' ' && void window.jarvis.invoke('conv:talk', { action: 'end' }),
          title: 'Hold to talk',
        }
      : { onClick: () => void window.jarvis.invoke('conv:talk', { action: 'toggle' }), title: view === 'listening' ? 'Click to send' : 'Click to talk' };

  const visual = useMemo(() => stateVisual(view, 0, 0, 1), [view]);
  const label = snap?.notice && !preview ? snap.notice : STATE_LABELS[view];
  const style = {
    '--gold': settings?.motion.accentGold ?? '#d4a64a',
    '--violet': settings?.motion.accentViolet ?? '#8b5cf6',
  } as React.CSSProperties;

  if (!snap || !settings) return null;
  const showOrbits = settings.motion.showOrbits;

  return (
    <div className={`overlay accent-${visual.accent} ${expanded ? 'expanded' : 'compact'} ${reduced ? 'reduced' : ''}`} style={style} data-state={view}>
      {(snap.demoMode || preview) && (
        <div className="banner" role="status">
          {preview ? 'VISUAL PREVIEW · simulated' : 'DEMO · simulated, no charges'}
        </div>
      )}
      <div
        ref={stageRef}
        className="stage hit"
        {...hit}
        role="button"
        tabIndex={0}
        aria-label={`${settings.personality.assistantName}: ${label}. Click to open chat.`}
        title="Click to open chat · right-click for menu"
        onClick={() => window.jarvis.send('overlay:openChat')}
        onKeyDown={(e) => e.key === 'Enter' && window.jarvis.send('overlay:openChat')}
        onContextMenu={(e) => {
          e.preventDefault();
          window.jarvis.send('overlay:contextMenu');
        }}
      >
        <div ref={bodyRef} className="body">
          <div ref={glowRef} className="glow" />
          {showOrbits && (
            <svg className="trails" viewBox="0 0 240 300" aria-hidden="true">
              <ellipse ref={trailA} cx="120" cy="150" rx="108" ry="36" className="trail gold" />
              <ellipse ref={trailB} cx="120" cy="156" rx="100" ry="30" className="trail violet" />
            </svg>
          )}
          {asset && !asset.isPlaceholder && url ? <img className="character" src={url} alt="" draggable={false} /> : <Placeholder />}
        </div>
      </div>
      <div className="status hit" {...hit} aria-live="polite">
        <span className="icon" aria-hidden="true">
          {ICON[view] ?? '◆'}
        </span>
        {label}
        {snap.muted && view !== 'muted' && <span className="mute-pill">MIC MUTED</span>}
      </div>
      {snap.armed && !preview && <div className="wake-chip">Listening for wake word · local only</div>}
      <div className="controls hit" {...hit}>
        <button {...talkProps} disabled={snap.muted} aria-label="Talk">
          {view === 'listening' ? 'Send' : 'Talk'}
        </button>
        <button onClick={() => void window.jarvis.invoke('conv:stop')} title="Stop speaking / listening" aria-label="Stop">
          Stop
        </button>
        <button onClick={() => void window.jarvis.invoke('conv:mute', { muted: !snap.muted })} title={snap.muted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={snap.muted}>
          {snap.muted ? 'Unmute' : 'Mute'}
        </button>
        <button onClick={() => void window.jarvis.invoke('overlay:setShown', { shown: false })} title="Hide character (tray restores it). Hiding does not mute." aria-label="Hide character">
          Hide
        </button>
      </div>
      <div
        className="drag hit"
        {...hit}
        title="Drag to move"
        aria-label="Drag handle"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          draggingRef.current = true;
          window.jarvis.send('overlay:drag', { phase: 'start' });
        }}
        onPointerUp={() => {
          draggingRef.current = false;
          window.jarvis.send('overlay:drag', { phase: 'end' });
        }}
      >
        ⠿
      </div>
    </div>
  );
}
