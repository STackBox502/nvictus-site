// The workshop bench: Claude writes the model as named parts; this builds, explodes, labels and photographs it.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class Workshop {
  constructor({ canvas, labelsLayer, partsList, emptyEl, busyEl, titleEl }) {
    Object.assign(this, { canvas, labelsLayer, partsList, emptyEl, busyEl, titleEl });
    this.ready = false;
    this.parts = new Map();      // name -> { group, label, explode, el, offset }
    this.exploded = false;
    this.explodeT = 0;
    this.showLabels = false;
    this.spin = false;
    this.reveal = [];
    this.active = false;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  #init() {
    if (this.ready) return;
    this.ready = true;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.01, 2000);
    this.camera.position.set(3, 2.2, 4);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.scene.add(new THREE.HemisphereLight(0xdfefff, 0x1a2230, 0.7));
    this.key = new THREE.DirectionalLight(0xffffff, 2.2);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.bias = -0.0004;
    this.scene.add(this.key, this.key.target);
    const rim = new THREE.DirectionalLight(0x7fe9ff, 0.9);
    rim.position.set(-4, 3, -5);
    this.scene.add(rim);
    this.floor = new THREE.Mesh(new THREE.CircleGeometry(1, 96), new THREE.ShadowMaterial({ opacity: 0.38 }));
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);
    this.grid = new THREE.GridHelper(2, 20, 0x3a6f86, 0x1b2c3a);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.55;
    this.scene.add(this.grid);
    this.model = new THREE.Group();
    this.scene.add(this.model);
    this.clock = new THREE.Clock();
    new ResizeObserver(() => this.resize()).observe(this.canvas.parentElement);
    this.resize();
    this.renderer.setAnimationLoop(() => this.#frame());
  }

  resize() {
    if (!this.ready) return;
    const el = this.canvas.parentElement, w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setActive(on) {
    this.active = on;
    if (on) { this.#init(); requestAnimationFrame(() => this.resize()); }
  }

  get materials() {
    return {
      metal: (color = 0xc9d2da, roughness = 0.35) => new THREE.MeshStandardMaterial({ color, metalness: 1, roughness }),
      matte: (color = 0x888888) => new THREE.MeshStandardMaterial({ color, metalness: 0, roughness: 0.9 }),
      plastic: (color = 0x333333) => new THREE.MeshStandardMaterial({ color, metalness: 0, roughness: 0.42 }),
      glass: (color = 0xbfe9ff, opacity = 0.35) => new THREE.MeshPhysicalMaterial({ color, metalness: 0, roughness: 0.05, transparent: true, opacity, transmission: 0.6, thickness: 0.05, side: THREE.DoubleSide, depthWrite: false }),
      glow: (color = 0x7fe9ff, intensity = 2) => new THREE.MeshStandardMaterial({ color: 0x111111, emissive: color, emissiveIntensity: intensity, roughness: 0.4 }),
    };
  }

  #dispose(obj) {
    obj.traverse((o) => {
      o.geometry?.dispose?.();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) { for (const k of Object.keys(m)) if (m[k]?.isTexture) m[k].dispose(); m.dispose?.(); }
    });
  }

  #removePart(name) {
    const p = this.parts.get(name);
    if (!p) return false;
    this.model.remove(p.group);
    this.#dispose(p.group);
    p.el.remove();
    p.li?.remove();
    this.parts.delete(name);
    return true;
  }

  clear() { for (const name of [...this.parts.keys()]) this.#removePart(name); this.partsList.innerHTML = ''; }

  // Runs Claude's build code. Returns { parts, size } or throws with a message Claude can act on.
  build({ title, code, mode }) {
    this.#init();
    const patch = mode === 'patch' && this.parts.size > 0;
    const wasExploded = this.exploded;
    if (!patch) { this.clear(); this.exploded = false; this.explodeT = 0; }
    const touched = [];
    const api = {
      mat: this.materials,
      part: (name, object, opts = {}) => {
        name = String(name || '').trim();
        if (!name) throw new Error('api.part needs a name');
        if (!object || !object.isObject3D) throw new Error(`api.part("${name}") needs a THREE.Object3D (Mesh or Group)`);
        const existed = this.#removePart(name);
        const group = new THREE.Group();
        group.name = name;
        group.add(object);
        group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        this.model.add(group);
        const el = document.createElement('span');
        el.textContent = opts.label || name;
        el.style.display = 'none';
        this.labelsLayer.appendChild(el);
        const li = document.createElement('li');
        li.textContent = opts.label || name;
        this.partsList.appendChild(li);
        const explode = Array.isArray(opts.explode) && opts.explode.length === 3 ? new THREE.Vector3(...opts.explode.map(Number)) : null;
        this.parts.set(name, { group, el, li, explode, offset: new THREE.Vector3(), label: opts.label || name });
        touched.push({ name, existed });
      },
      remove: (name) => this.#removePart(String(name)),
    };
    let fn;
    try { fn = new Function('THREE', 'api', `"use strict";\n${code}`); }
    catch (e) { throw new Error(`Syntax error in build code: ${e.message}`); }
    try { fn(THREE, api); }
    catch (e) {
      const where = /<anonymous>:(\d+):(\d+)/.exec(e.stack || '');
      throw new Error(`${e.name}: ${e.message}${where ? ` (line ${Number(where[1]) - 3})` : ''}`);
    }
    if (!this.parts.size) throw new Error('The code ran but added no parts. Call api.part(name, object3D) for every piece.');
    this.titleEl.textContent = title || 'Model';
    this.emptyEl.hidden = true;
    const size = this.#layout(!patch);
    // New parts grow in one after another, like the bench assembling them.
    if (!this.reduced) {
      let i = 0;
      for (const t of touched) {
        if (t.existed) continue;
        const p = this.parts.get(t.name);
        if (!p) continue;
        p.group.scale.setScalar(0.001);
        this.reveal.push({ p, delay: (patch ? 0 : 0.12) * i++, t: 0 });
      }
    }
    if (patch && wasExploded) this.exploded = true;
    // Parts added while the model is pulled apart must land in their exploded position too.
    const k = ease(this.explodeT);
    for (const p of this.parts.values()) p.group.position.copy(p.offset).multiplyScalar(k);
    return { parts: [...this.parts.keys()], size };
  }

  // Works out explode offsets, fits the floor, lights and camera to the model.
  #layout(reframe) {
    this.model.updateMatrixWorld(true);
    const saved = new Map();
    for (const [name, p] of this.parts) { saved.set(name, p.group.position.clone()); p.group.position.set(0, 0, 0); const s = p.group.scale.x; p.keepScale = s; p.group.scale.setScalar(1); }
    this.model.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const centers = [];
    for (const [name, p] of this.parts) {
      const b = new THREE.Box3().setFromObject(p.group);
      if (b.isEmpty()) continue;
      box.union(b);
      p.center = b.getCenter(new THREE.Vector3());
      centers.push([name, p.center.y]);
    }
    if (box.isEmpty()) box.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
    const size = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    centers.sort((a, b) => a[1] - b[1]);
    const rank = new Map(centers.map(([name], i) => [name, centers.length > 1 ? i / (centers.length - 1) : 0]));
    const lift = Math.max(size.y, maxDim * 0.55);
    for (const [name, p] of this.parts) {
      if (p.explode) { p.offset.copy(p.explode); continue; }
      const c = p.center || mid;
      p.offset.set((c.x - mid.x) * 0.7, (rank.get(name) ?? 0) * lift * 1.05, (c.z - mid.z) * 0.7);
    }
    for (const [name, p] of this.parts) { p.group.position.copy(saved.get(name)); p.group.scale.setScalar(p.keepScale); }
    this.bounds = { box, size, mid, maxDim };
    const pad = maxDim * 1.9;
    this.floor.scale.setScalar(pad);
    this.floor.position.set(mid.x, box.min.y - 0.001, mid.z);
    this.grid.scale.setScalar(pad);
    this.grid.position.set(mid.x, box.min.y - 0.002, mid.z);
    this.key.position.set(mid.x + maxDim * 1.4, box.max.y + maxDim * 2.2, mid.z + maxDim * 1.6);
    this.key.target.position.copy(mid);
    const sc = this.key.shadow.camera;
    sc.left = sc.bottom = -maxDim * 2.2; sc.right = sc.top = maxDim * 2.2; sc.near = 0.01; sc.far = maxDim * 12;
    sc.updateProjectionMatrix();
    if (reframe) this.#frameCamera(false);
    return [size.x, size.y, size.z];
  }

  #frameCamera(exploded) {
    const { mid, maxDim, size } = this.bounds;
    let radius = Math.hypot(size.x, size.y, size.z) / 2 || maxDim;
    const target = mid.clone();
    if (exploded) {
      const box = new THREE.Box3();
      for (const p of this.parts.values()) if (p.center) box.expandByPoint(p.center.clone().add(p.offset));
      box.union(this.bounds.box);
      box.getCenter(target);
      radius = box.getSize(new THREE.Vector3()).length() / 2;
    }
    const fov = (this.camera.fov * Math.PI) / 180;
    const dist = (radius / Math.sin(fov / 2)) * 1.08;
    const dir = new THREE.Vector3(0.62, 0.48, 0.78).normalize();
    this.camFly = { from: this.camera.position.clone(), to: target.clone().add(dir.multiplyScalar(dist)), tFrom: this.controls.target.clone(), tTo: target, t: 0 };
    this.camera.near = Math.max(0.005, dist / 200);
    this.camera.far = dist * 40;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = radius * 0.25;
    this.controls.maxDistance = dist * 6;
    if (this.reduced) { this.camera.position.copy(this.camFly.to); this.controls.target.copy(target); this.camFly = null; }
  }

  control(action, part) {
    this.#init();
    switch (action) {
      case 'explode':
        if (!this.parts.size) throw new Error('Nothing on the bench to pull apart.');
        this.exploded = true; this.showLabels = true; this.#frameCamera(true);
        return `Pulled apart into ${this.parts.size} labelled parts: ${[...this.parts.values()].map((p) => p.label).join(', ')}.`;
      case 'assemble':
        this.exploded = false; this.showLabels = false; if (this.bounds) this.#frameCamera(false);
        return 'Put back together.';
      case 'labels_on': this.showLabels = true; return 'Labels on.';
      case 'labels_off': this.showLabels = false; return 'Labels off.';
      case 'spin_on': this.spin = true; return 'Spinning.';
      case 'spin_off': this.spin = false; return 'Spin stopped.';
      case 'focus': {
        const key = [...this.parts.keys()].find((k) => k.toLowerCase() === String(part).toLowerCase()) || [...this.parts.keys()].find((k) => k.toLowerCase().includes(String(part).toLowerCase()));
        if (!key) throw new Error(`No part named "${part}". Parts: ${[...this.parts.keys()].join(', ')}`);
        const p = this.parts.get(key);
        const b = new THREE.Box3().setFromObject(p.group);
        const c = b.getCenter(new THREE.Vector3()), r = Math.max(b.getSize(new THREE.Vector3()).length() / 2, this.bounds.maxDim * 0.08);
        const dir = this.camera.position.clone().sub(this.controls.target).normalize();
        this.camFly = { from: this.camera.position.clone(), to: c.clone().add(dir.multiplyScalar(r * 3.4)), tFrom: this.controls.target.clone(), tTo: c, t: 0 };
        this.showLabels = true;
        return `Focused on ${p.label}.`;
      }
      default: throw new Error(`Unknown workshop action: ${action}`);
    }
  }

  snapshot(maxWidth = 1280) {
    this.#init();
    // Finish any grow-in animation first so the picture shows the whole model.
    for (const r of this.reveal) r.p.group.scale.setScalar(1);
    this.reveal = [];
    this.renderer.render(this.scene, this.camera);
    const src = this.renderer.domElement;
    const scale = Math.min(1, maxWidth / src.width);
    const out = document.createElement('canvas');
    out.width = Math.max(2, Math.round(src.width * scale));
    out.height = Math.max(2, Math.round(src.height * scale));
    const ctx = out.getContext('2d');
    const g = ctx.createRadialGradient(out.width / 2, out.height * 0.62, 0, out.width / 2, out.height * 0.62, out.width * 0.8);
    g.addColorStop(0, '#16202e'); g.addColorStop(1, '#06090e');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  }

  #frame() {
    if (!this.active) return;
    const dt = Math.min(0.05, this.clock.getDelta());
    const goal = this.exploded ? 1 : 0;
    if (this.explodeT !== goal) {
      this.explodeT = this.reduced ? goal : Math.max(0, Math.min(1, this.explodeT + (goal ? 1 : -1) * dt / 0.9));
      const k = ease(this.explodeT);
      for (const p of this.parts.values()) p.group.position.copy(p.offset).multiplyScalar(k);
    }
    if (this.reveal.length) {
      for (const r of this.reveal) {
        r.delay -= dt;
        if (r.delay > 0) continue;
        r.t = Math.min(1, r.t + dt / 0.45);
        const s = 1 - (1 - r.t) ** 3;
        r.p.group.scale.setScalar(Math.max(0.001, s));
      }
      this.reveal = this.reveal.filter((r) => r.t < 1);
    }
    if (this.camFly) {
      this.camFly.t = Math.min(1, this.camFly.t + dt / 1.0);
      const k = ease(this.camFly.t);
      this.camera.position.lerpVectors(this.camFly.from, this.camFly.to, k);
      this.controls.target.lerpVectors(this.camFly.tFrom, this.camFly.tTo, k);
      if (this.camFly.t >= 1) this.camFly = null;
    }
    this.controls.autoRotate = this.spin && !this.reduced;
    this.controls.autoRotateSpeed = 1.6;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight, v = new THREE.Vector3();
    for (const p of this.parts.values()) {
      if (!this.showLabels || !p.center) { p.el.style.display = 'none'; continue; }
      v.copy(p.center).add(p.group.position).project(this.camera);
      const vis = v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1;
      p.el.style.display = vis ? '' : 'none';
      if (vis) { p.el.style.left = `${(v.x * 0.5 + 0.5) * w}px`; p.el.style.top = `${(-v.y * 0.5 + 0.5) * h}px`; }
    }
  }
}
