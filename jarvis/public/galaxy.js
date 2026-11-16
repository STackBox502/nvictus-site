// The second brain as a galaxy: every file and folder is a star, folders are clusters.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const PALETTE = [0x7fe9ff, 0xffc46b, 0x9d8cff, 0x7dffb5, 0xff8fa3, 0x6fa8ff, 0xf5e663, 0xff9d5c, 0x5ef0d2, 0xd28cff, 0xa3e36b, 0xff7ad9];

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function onSphere(rand, radius) {
  const u = rand() * 2 - 1, th = rand() * Math.PI * 2, s = Math.sqrt(1 - u * u);
  return new THREE.Vector3(s * Math.cos(th) * radius, u * radius, s * Math.sin(th) * radius);
}

const VERT = `
attribute float aSize; attribute float aFocus; attribute vec3 aColor;
uniform float uPixel; uniform float uTime; uniform float uEnergy;
varying vec3 vColor; varying float vFocus;
void main() {
  vColor = aColor; vFocus = aFocus;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float tw = 0.85 + 0.15 * sin(uTime * 1.7 + position.x * 0.31 + position.y * 0.17);
  gl_PointSize = max(2.4 * uPixel, aSize * uPixel * tw * (1.0 + uEnergy * 0.5) * (aFocus > 1.5 ? 2.1 : 1.0) * (430.0 / max(1.0, -mv.z)));
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = `
varying vec3 vColor; varying float vFocus;
void main() {
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5) discard;
  float core = smoothstep(0.5, 0.0, d);
  float a = pow(core, 2.2);
  float dim = vFocus < 0.5 ? 0.1 : 1.0;
  vec3 c = mix(vColor, vec3(1.0), pow(core, 6.0) * 0.8);
  if (vFocus > 1.5) c = mix(c, vec3(1.0), 0.35);
  gl_FragColor = vec4(c * dim, a * dim);
}`;

export class Galaxy {
  constructor(canvas, labelsEl) {
    this.canvas = canvas;
    this.labelsEl = labelsEl;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(52, 1, 0.5, 6000);
    this.camera.position.set(-40, 120, 330);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 12;
    this.controls.maxDistance = 1600;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.28;
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.nodes = [];
    this.pos = [];
    this.focusIds = null;
    this.energy = 0;
    this.paused = false;
    this.onPick = () => {};
    this.labels = [];
    this.hoverEl = document.createElement('span');
    this.hoverEl.className = 'hover';
    this.hoverEl.style.opacity = 0;
    labelsEl.appendChild(this.hoverEl);
    this.ray = new THREE.Raycaster();
    this.clock = new THREE.Clock();
    this.fly = null;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (this.reduced) this.controls.autoRotate = false;
    this.#dust();
    this.#events();
    this.resize();
    addEventListener('resize', () => this.resize());
    this.renderer.setAnimationLoop(() => this.#frame());
  }

  #dust() {
    const n = 1400, p = new Float32Array(n * 3), rand = rng(7);
    for (let i = 0; i < n; i++) { const v = onSphere(rand, 900 + rand() * 1800); p.set([v.x, v.y, v.z], i * 3); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    this.scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8fb4c8, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.45, depthWrite: false })));
  }

  resize() {
    const w = this.canvas.clientWidth || innerWidth, h = this.canvas.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Centre the scene in the free space between an open panel (left) and the orb (right).
    const left = this.insetLeft || 0, right = w > 900 ? w * 0.24 : 0;
    const shift = left + (w - left - right) / 2 - w / 2;
    if (w > 900 && Math.abs(shift) > 1) this.camera.setViewOffset(w, h, -shift, 0, w, h); else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    if (this.material) this.material.uniforms.uPixel.value = this.renderer.getPixelRatio();
  }

  setGraph(graph) {
    for (const o of [this.points, this.lines, this.cross]) if (o) { this.root.remove(o); o.geometry.dispose(); o.material.dispose(); }
    for (const l of this.labels) l.el.remove();
    this.labels = [];
    this.nodes = graph.nodes || [];
    const N = this.nodes.length;
    this.pos = new Array(N);
    if (!N) return;

    const kids = new Map();
    for (const n of this.nodes) { if (n.parent >= 0) { if (!kids.has(n.parent)) kids.set(n.parent, []); kids.get(n.parent).push(n); } }
    const weight = new Array(N).fill(1);
    for (let i = N - 1; i >= 0; i--) { const n = this.nodes[i]; if (n.parent >= 0) weight[n.parent] += weight[i]; }

    // Top-level folders sit on a spiral; everything inside a folder orbits it.
    this.pos[0] = new THREE.Vector3(0, 0, 0);
    const spread = Math.min(1.15, Math.max(0.34, Math.sqrt(N) / 34)); // small vaults stay compact
    const top = (kids.get(0) || []).filter((n) => n.type === 'dir').sort((a, b) => weight[b.id] - weight[a.id]);
    top.forEach((n, i) => {
      const ang = i * 2.39996, rad = (70 + 34 * Math.sqrt(i + 0.6)) * spread + Math.sqrt(weight[n.id]) * 1.6;
      const rand = rng(n.id * 977 + 13);
      this.pos[n.id] = new THREE.Vector3(Math.cos(ang) * rad, (rand() - 0.5) * 60 * spread, Math.sin(ang) * rad);
    });
    const place = (parent) => {
      const list = kids.get(parent.id) || [];
      const dirs = list.filter((n) => n.type === 'dir' && !this.pos[n.id]);
      const files = list.filter((n) => n.type === 'file');
      const base = this.pos[parent.id];
      const rand = rng(parent.id * 7919 + 101);
      const shell = (parent.id === 0 ? 14 : 5) + Math.sqrt(files.length) * 1.9;
      for (const f of files) this.pos[f.id] = base.clone().add(onSphere(rand, shell * (0.45 + rand() * 0.75)));
      dirs.forEach((d) => {
        const reach = shell + 8 + Math.sqrt(weight[d.id]) * 2.4 + (26 * spread) / (parent.depth + 1);
        this.pos[d.id] = base.clone().add(onSphere(rand, reach));
      });
      for (const d of list.filter((n) => n.type === 'dir')) place(d);
    };
    place(this.nodes[0]);
    for (let i = 0; i < N; i++) if (!this.pos[i]) this.pos[i] = new THREE.Vector3();

    const position = new Float32Array(N * 3), color = new Float32Array(N * 3), size = new Float32Array(N), focus = new Float32Array(N).fill(1);
    const c = new THREE.Color();
    for (const n of this.nodes) {
      position.set([this.pos[n.id].x, this.pos[n.id].y, this.pos[n.id].z], n.id * 3);
      c.setHex(n.id === 0 ? 0xffffff : PALETTE[(n.group || 0) % PALETTE.length]);
      if (n.type === 'file') c.lerp(new THREE.Color(0xdcefff), 0.25);
      color.set([c.r, c.g, c.b], n.id * 3);
      size[n.id] = n.id === 0 ? 9 : n.type === 'dir' ? Math.min(7.5, 2.6 + Math.sqrt(weight[n.id]) * 0.42) : 1.5;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aFocus', new THREE.BufferAttribute(focus, 1));
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uPixel: { value: this.renderer.getPixelRatio() }, uTime: { value: 0 }, uEnergy: { value: 0 } },
    });
    this.points = new THREE.Points(geo, this.material);
    this.root.add(this.points);

    const tree = [], cross = [];
    for (const [a, b, kind] of graph.links || []) {
      const A = this.pos[a], B = this.pos[b];
      if (!A || !B) continue;
      (kind ? cross : tree).push(A.x, A.y, A.z, B.x, B.y, B.z);
    }
    const mk = (arr, hex, opacity) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3));
      return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: hex, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending }));
    };
    this.lines = mk(tree, 0x6fb7d6, 0.085);
    this.cross = mk(cross, 0xffc46b, 0.28);
    this.root.add(this.lines, this.cross);

    for (const n of [this.nodes[0], ...top.slice(0, 22)]) {
      const el = document.createElement('span');
      el.textContent = n.name;
      this.labelsEl.appendChild(el);
      this.labels.push({ id: n.id, el, temp: false });
    }
    const far = this.pos.reduce((m, v) => Math.max(m, v.length()), 40);
    this.home = { pos: new THREE.Vector3(-far * 0.3, far * 0.5, far * 1.55), target: new THREE.Vector3(0, 0, 0) };
    this.#flyTo(this.home.pos, this.home.target, 1.6);
    this.focusIds = null;
  }

  // Light up a set of nodes, dim the rest, and fly to them. Pass null/empty to clear.
  focus(ids) {
    if (!this.points) return;
    const attr = this.points.geometry.getAttribute('aFocus');
    for (const l of this.labels.filter((x) => x.temp)) l.el.remove();
    this.labels = this.labels.filter((x) => !x.temp);
    if (!ids || !ids.length) {
      attr.array.fill(1); attr.needsUpdate = true; this.focusIds = null;
      this.lines.material.opacity = 0.085;
      for (const l of this.labels) l.el.classList.remove('dim');
      if (this.home) this.#flyTo(this.home.pos, this.home.target, 1.2);
      this.controls.autoRotate = !this.reduced;
      return;
    }
    attr.array.fill(0);
    const box = new THREE.Box3();
    for (const id of ids) { if (this.pos[id]) { attr.array[id] = 2; box.expandByPoint(this.pos[id]); } }
    attr.needsUpdate = true;
    this.focusIds = new Set(ids);
    this.lines.material.opacity = 0.03;
    ids.slice(0, 14).forEach((id) => {
      const n = this.nodes[id];
      if (!n || this.labels.some((l) => l.id === id)) return;
      const el = document.createElement('span');
      el.className = 'hot';
      el.textContent = n.name;
      this.labelsEl.appendChild(el);
      this.labels.push({ id, el, temp: true });
    });
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const dist = Math.max(38, sphere.radius * 2.6 + 24);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.#flyTo(sphere.center.clone().add(dir.multiplyScalar(dist)), sphere.center, 1.4);
    this.controls.autoRotateSpeed = 0.12;
  }

  setEnergy(v) { this.energy = v; }
  setInset(leftPx) { if (leftPx !== this.insetLeft) { this.insetLeft = leftPx; this.resize(); } }
  setPaused(p) { this.paused = p; }

  #flyTo(pos, target, seconds) {
    if (this.reduced) { this.camera.position.copy(pos); this.controls.target.copy(target); return; }
    this.fly = { from: this.camera.position.clone(), to: pos.clone(), tFrom: this.controls.target.clone(), tTo: target.clone(), t: 0, dur: seconds };
  }

  #events() {
    let down = null;
    this.canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; this.fly = null; });
    this.canvas.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
      const id = this.#pick(e);
      if (id !== null) this.onPick(this.nodes[id]);
    });
    let raf = 0;
    this.canvas.addEventListener('pointermove', (e) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const id = this.#pick(e);
        this.hoverId = id;
        this.canvas.style.cursor = id !== null ? 'pointer' : '';
        if (id === null) { this.hoverEl.style.opacity = 0; return; }
        this.hoverEl.textContent = this.nodes[id].name;
        this.hoverEl.style.opacity = 1;
      });
    });
    this.canvas.addEventListener('pointerleave', () => { this.hoverId = null; this.hoverEl.style.opacity = 0; });
  }

  #pick(e) {
    if (!this.points) return null;
    const r = this.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    // Screen-space nearest star within a few pixels; simpler and steadier than ray thresholds.
    let best = null, bestD = 14 * 14;
    const v = new THREE.Vector3();
    for (let i = 0; i < this.nodes.length; i++) {
      if (this.focusIds && !this.focusIds.has(i)) continue;
      v.copy(this.pos[i]).applyMatrix4(this.root.matrixWorld).project(this.camera);
      if (v.z > 1 || v.z < -1) continue;
      const dx = (v.x * 0.5 + 0.5) * r.width - mx, dy = (-v.y * 0.5 + 0.5) * r.height - my;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  #frame() {
    if (this.paused) return;
    const dt = Math.min(0.05, this.clock.getDelta());
    if (this.fly) {
      this.fly.t = Math.min(1, this.fly.t + dt / this.fly.dur);
      const k = this.fly.t < 0.5 ? 4 * this.fly.t ** 3 : 1 - (-2 * this.fly.t + 2) ** 3 / 2;
      this.camera.position.lerpVectors(this.fly.from, this.fly.to, k);
      this.controls.target.lerpVectors(this.fly.tFrom, this.fly.tTo, k);
      if (this.fly.t >= 1) this.fly = null;
    }
    this.controls.update();
    if (this.material) {
      this.material.uniforms.uTime.value += dt;
      const u = this.material.uniforms.uEnergy;
      u.value += (this.energy - u.value) * Math.min(1, dt * 8);
    }
    this.renderer.render(this.scene, this.camera);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight, v = new THREE.Vector3();
    const put = (el, id) => {
      v.copy(this.pos[id]).applyMatrix4(this.root.matrixWorld).project(this.camera);
      const vis = v.z < 1 && v.z > -1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      el.style.display = vis ? '' : 'none';
      if (vis) { el.style.left = `${(v.x * 0.5 + 0.5) * w}px`; el.style.top = `${(-v.y * 0.5 + 0.5) * h}px`; }
    };
    for (const l of this.labels) {
      put(l.el, l.id);
      if (!l.temp) l.el.style.opacity = this.focusIds ? 0.18 : '';
    }
    if (this.hoverId != null && this.pos[this.hoverId]) put(this.hoverEl, this.hoverId);
  }
}
