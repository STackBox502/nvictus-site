// The reactor: a 2D canvas orb that shows what Jarvis is doing (idle, listening, thinking, speaking).
const COLORS = {
  idle: [127, 233, 255], speaking: [127, 233, 255], listening: [125, 255, 181], hearing: [125, 255, 181],
  thinking: [255, 196, 107], working: [255, 196, 107], error: [255, 122, 107], offline: [255, 122, 107],
};

export class Orb {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.state = 'offline';
    this.level = 0;        // 0..1 audio energy
    this.smooth = 0;
    this.color = [...COLORS.offline];
    this.t = 0;
    this.last = performance.now();
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.bars = new Float32Array(64);
    requestAnimationFrame((n) => this.frame(n));
  }

  set(state) { this.state = state; }
  setLevel(v) { this.level = Math.max(0, Math.min(1, v)); }

  frame(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const speed = { thinking: 2.4, working: 2.4, speaking: 1.2, listening: 0.9, hearing: 1.4, idle: 0.45, error: 0.2, offline: 0.12 }[this.state] || 0.5;
    this.t += dt * (this.reduced ? 0.15 : speed);
    const target = COLORS[this.state] || COLORS.idle;
    for (let i = 0; i < 3; i++) this.color[i] += (target[i] - this.color[i]) * Math.min(1, dt * 5);
    let drive = this.level;
    if (this.state === 'thinking' || this.state === 'working') drive = 0.25 + 0.2 * Math.sin(this.t * 3);
    if (this.state === 'listening') drive = Math.max(drive, 0.12 + 0.08 * Math.sin(this.t * 4));
    this.smooth += (drive - this.smooth) * Math.min(1, dt * 10);
    this.draw();
    requestAnimationFrame((n) => this.frame(n));
  }

  draw() {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height, cx = W / 2, cy = H / 2, R = W * 0.3;
    const [r, g, b] = this.color.map(Math.round);
    const col = (a) => `rgba(${r},${g},${b},${a})`;
    const e = this.smooth;
    ctx.clearRect(0, 0, W, H);

    // soft halo
    const halo = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.65);
    halo.addColorStop(0, col(0.2 + e * 0.25));
    halo.addColorStop(0.55, col(0.05 + e * 0.06));
    halo.addColorStop(1, col(0));
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, W, H);

    // radial energy bars
    const n = this.bars.length;
    ctx.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const wob = 0.5 + 0.5 * Math.sin(this.t * 5 + i * 0.9) * Math.sin(this.t * 2.1 + i * 0.37);
      const targetLen = 4 + e * 62 * wob + (this.state === 'thinking' || this.state === 'working' ? 10 * (0.5 + 0.5 * Math.sin(this.t * 6 - i * 0.4)) : 0);
      this.bars[i] += (targetLen - this.bars[i]) * 0.3;
      const r0 = R * 1.12, r1 = r0 + this.bars[i];
      ctx.strokeStyle = col(0.25 + 0.5 * Math.min(1, this.bars[i] / 40));
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.stroke();
    }

    // rotating segmented rings
    const ring = (radius, width, segs, gap, rot, alpha) => {
      ctx.lineWidth = width;
      ctx.strokeStyle = col(alpha);
      const step = (Math.PI * 2) / segs;
      for (let i = 0; i < segs; i++) {
        ctx.beginPath();
        ctx.arc(cx, cy, radius, rot + i * step + gap / 2, rot + (i + 1) * step - gap / 2);
        ctx.stroke();
      }
    };
    ctx.lineCap = 'butt';
    ring(R * 1.04, 2, 1, 0, 0, 0.35);
    ring(R * 0.92, 9, 3, 0.5, this.t * 0.6, 0.55);
    ring(R * 0.74, 3, 12, 0.14, -this.t * 0.9, 0.5);
    ring(R * 0.6, 14, 5, 0.34, this.t * 0.35, 0.16 + e * 0.2);
    ring(R * 0.46, 2, 24, 0.1, -this.t * 1.6, 0.6);

    // core
    const coreR = R * (0.26 + e * 0.1);
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 1.6);
    core.addColorStop(0, 'rgba(255,255,255,0.95)');
    core.addColorStop(0.25, col(0.95));
    core.addColorStop(0.7, col(0.25));
    core.addColorStop(1, col(0));
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR * 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
}
