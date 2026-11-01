// AudioWorklet: mono mix → anti-alias low-pass → linear resample to 16 kHz → Int16 frames (100 ms).
// Runs on the audio rendering thread; posts transferable PCM frames and periodic RMS levels.
class JarvisCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.target = o.targetRate || 16000;
    this.frameSamples = o.frameSamples || 1600;
    this.ratio = sampleRate / this.target;
    const fc = Math.min(7000, this.target * 0.45);
    this.alpha = 1 - Math.exp((-2 * Math.PI * fc) / sampleRate);
    this.lp = 0;
    this.prev = 0;
    this.pos = 0;
    this.out = new Int16Array(this.frameSamples);
    this.outLen = 0;
    this.levelAcc = 0;
    this.levelN = 0;
    this.levelEvery = Math.floor(sampleRate * 0.05);
    this.tmp = null;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;
    const ch0 = input[0];
    const ch1 = input.length > 1 ? input[1] : null;
    const n = ch0.length;
    if (!this.tmp || this.tmp.length !== n) this.tmp = new Float32Array(n);
    const buf = this.tmp;
    for (let i = 0; i < n; i++) {
      const s = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
      this.lp += this.alpha * (s - this.lp);
      buf[i] = this.lp;
      this.levelAcc += s * s;
      this.levelN++;
    }
    // Extended index space: 0 = previous block's last sample, 1..n = this block.
    while (this.pos <= n - 1) {
      const idx = Math.floor(this.pos);
      const frac = this.pos - idx;
      const s0 = idx === 0 ? this.prev : buf[idx - 1];
      const s1 = buf[idx];
      const v = s0 + (s1 - s0) * frac;
      this.out[this.outLen++] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
      if (this.outLen === this.frameSamples) {
        const frame = this.out.slice(0);
        this.port.postMessage({ type: 'frame', pcm: frame.buffer }, [frame.buffer]);
        this.outLen = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= n;
    this.prev = buf[n - 1];
    if (this.levelN >= this.levelEvery) {
      this.port.postMessage({ type: 'level', rms: Math.sqrt(this.levelAcc / this.levelN) });
      this.levelAcc = 0;
      this.levelN = 0;
    }
    return true;
  }
}

registerProcessor('jarvis-capture', JarvisCapture);
