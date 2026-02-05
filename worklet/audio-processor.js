// worklet/audio-processor.js
// Hybrid processor: inline proxy DSP + ONNX separation via worker (with OLA support).

class OnePoleLP { constructor(a = 0.15) { this.a = a; this.z = 0; } step(x) { this.z += this.a * (x - this.z); return this.z; } }
class OnePoleHP { constructor(a = 0.02) { this.lp = new OnePoleLP(a); } step(x) { return x - this.lp.step(x); } }
class Envelope { constructor(a = 0.15, r = 0.02) { this.a = a; this.r = r; this.y = 0; } step(x) { const c = x > this.y ? this.a : this.r; this.y += c * (x - this.y); return this.y; } }

class InlineSeparator {
    constructor() {
        this.vHp = new OnePoleHP(0.005);
        this.vLp = new OnePoleLP(0.15);
        this.bgHpL = new OnePoleHP(0.02);
        this.bgHpR = new OnePoleHP(0.02);
        this.bgLpL = new OnePoleLP(0.10);
        this.bgLpR = new OnePoleLP(0.10);
        this.vadSmooth = 0; this.vadEnv = new Envelope(0.25, 0.03); this.lastW = 0;
        this.presHP = new OnePoleHP(0.02);
    }
    _presence(v) { return v + 0.15 * this.presHP.step(v); }
    _clamp(x) { return x < -1 ? -1 : (x > 1 ? 1 : x); }

    processBlock(Li, Ri, Lo, Ro, ctrl) {
        const N = Li.length;
        const DUCK_DEPTH = ctrl.duckDepth ?? 0.75;
        const DUCK_POWER = ctrl.duckPower ?? 1.6;
        const PRESENCE_DB = ctrl.presenceDb ?? 2.5;
        const PRESENCE = Math.pow(10, PRESENCE_DB / 20);
        const LEAK_KILL = ctrl.leakKill ?? 0.85;

        let eSum = 0, zc = 0, prev = 0;
        for (let i = 0; i < N; i++) {
            const l = Li[i], r = Ri[i];
            const mid = 0.5 * (l + r);
            const v = this.vLp.step(this.vHp.step(mid));
            eSum += v * v;
            if ((v >= 0 && prev < 0) || (v < 0 && prev >= 0)) zc++;
            prev = v;

            let bL = l - v, bR = r - v;
            if (ctrl.musicCut > 0) { const hpL = this.bgHpL.step(bL), hpR = this.bgHpR.step(bR); bL = (1 - ctrl.musicCut) * bL + ctrl.musicCut * hpL; bR = (1 - ctrl.musicCut) * bR + ctrl.musicCut * hpR; }
            if (ctrl.sfxCut > 0) { const lpL = this.bgLpL.step(bL), lpR = this.bgLpR.step(bR); bL = (1 - ctrl.sfxCut) * bL + ctrl.sfxCut * lpL; bR = (1 - ctrl.sfxCut) * bR + ctrl.sfxCut * lpR; }

            Lo[i] = v; Ro[i] = v; Li[i] = bL; Ri[i] = bR;
        }

        const rms = Math.sqrt(eSum / Math.max(1, N));
        this.vadSmooth = 0.9 * this.vadSmooth + 0.1 * rms;
        const thr = Math.max(0.015, 0.45 * this.vadSmooth);
        const zRate = zc / N;
        const zWeight = 1 - Math.min(1, Math.abs(zRate - 0.08) / 0.1);
        let w = rms > thr ? Math.max(0, Math.min(1, zWeight)) : 0;
        const wSmooth = this.vadEnv.step(0.85 * (0.85 * this.lastW + 0.15 * w));
        this.lastW = wSmooth;

        let vGain = ctrl.muteVoice ? 0 : (ctrl.voiceGain ?? 1);
        let bGain = ctrl.muteBg ? 0 : (ctrl.bgGain ?? 1);
        const hardMute = (vGain === 0 || ctrl.muteVoice === true);
        const duckAtten = DUCK_DEPTH * Math.pow(wSmooth, DUCK_POWER);
        const effBg = bGain * (1 - duckAtten);

        for (let i = 0; i < N; i++) {
            let vL = Lo[i], vR = Ro[i];
            if (!ctrl.muteVoice && vGain > 0) { vL = this._presence(vL) * PRESENCE; vR = this._presence(vR) * PRESENCE; }
            let bL = Li[i], bR = Ri[i];
            if (hardMute) { bL -= LEAK_KILL * Lo[i]; bR -= LEAK_KILL * Ro[i]; }
            const oL = this._clamp(vGain * (wSmooth * vL) + effBg * bL);
            const oR = this._clamp(vGain * (wSmooth * vR) + effBg * bR);
            Lo[i] = oL; Ro[i] = oR;
        }
        return true;
    }
}

class InterleavedQueue {
    constructor() { this.buffers = []; this.offset = 0; }
    push(buf) { if (buf && buf.length) this.buffers.push(buf); }
    consumeStereo(outputL, outputR) {
        const needed = outputL.length;
        let filled = 0;
        while (filled < needed && this.buffers.length) {
            const buf = this.buffers[0];
            const frames = (buf.length >> 1);
            while (filled < needed && this.offset < frames) {
                const idx = this.offset;
                outputL[filled] = buf[2 * idx];
                outputR[filled] = buf[2 * idx + 1];
                this.offset++; filled++;
            }
            if (this.offset >= frames) { this.buffers.shift(); this.offset = 0; }
        }
        return filled;
    }
}

class HybridProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.ctrl = {
            masterGain: 1, voiceGain: 1, bgGain: 1,
            muteVoice: false, muteBg: false,
            musicCut: 0, sfxCut: 0,
            aiMode: "proxy"
        };
        this.inline = new InlineSeparator();
        this.workerPort = null;
        this.voiceQueue = new InterleavedQueue();
        this.bgQueue = new InterleavedQueue();
        this.tmpBgL = null; this.tmpBgR = null;

        this.port.onmessage = (ev) => {
            const { type, control, port } = ev.data || {};
            if (type === "CONTROL" && control) {
                const norm = (x) => (typeof x === "number" ? (x > 4 ? Math.max(0, Math.min(2, x / 100)) : Math.max(0, Math.min(2, x))) : 1);
                if ("masterGain" in control) control.masterGain = norm(control.masterGain);
                if ("voiceGain" in control) control.voiceGain = norm(control.voiceGain);
                if ("bgGain" in control) control.bgGain = norm(control.bgGain);
                this.ctrl = { ...this.ctrl, ...control };
                if (this.workerPort) this.workerPort.postMessage({ type: "CONTROL", control: this.ctrl });
            } else if (type === "ATTACH_WORKER" && port) {
                this.workerPort = port;
                this.workerPort.onmessage = (e) => {
                    if (e.data?.type === "OUT") {
                        const { voice, bg } = e.data;
                        if (voice) this.voiceQueue.push(new Float32Array(voice));
                        if (bg) this.bgQueue.push(new Float32Array(bg));
                    }
                };
                this.workerPort.postMessage({ type: "CONTROL", control: this.ctrl });
            }
        };
    }

    process(inputs, outputs) {
        const input = inputs[0], output = outputs[0];
        if (!input || !input[0] || !output || !output[0]) return true;

        const L = input[0];
        const R = input[1] || input[0];
        const Lo = output[0];
        const Ro = output[1] || output[0];
        const N = L.length;

        // ONNX path
        if (this.workerPort && this.ctrl.aiMode === "onnx") {
            const inter = new Float32Array(2 * N);
            for (let i = 0; i < N; i++) { inter[2 * i] = L[i]; inter[2 * i + 1] = R[i]; }
            try { this.workerPort.postMessage({ type: "PROCESS", data: inter.buffer }, [inter.buffer]); } catch { }

            if (!this.tmpBgL || this.tmpBgL.length !== N) { this.tmpBgL = new Float32Array(N); this.tmpBgR = new Float32Array(N); }
            const filledVoice = this.voiceQueue.consumeStereo(Lo, Ro);
            const filledBg = this.bgQueue.consumeStereo(this.tmpBgL, this.tmpBgR);

            if (filledVoice === N && filledBg === N) {
                for (let i = 0; i < N; i++) {
                    const vL = Lo[i], vR = Ro[i];
                    const bL = this.tmpBgL[i], bR = this.tmpBgR[i];
                    const outL = (this.ctrl.muteVoice ? 0 : this.ctrl.voiceGain * vL) + (this.ctrl.muteBg ? 0 : this.ctrl.bgGain * bL);
                    const outR = (this.ctrl.muteVoice ? 0 : this.ctrl.voiceGain * vR) + (this.ctrl.muteBg ? 0 : this.ctrl.bgGain * bR);
                    Lo[i] = outL; Ro[i] = outR;
                }
                return true;
            }
            // Worker not ready/insufficient data → clear any partial fill and use proxy
            Lo.fill(0); Ro.fill(0);
            // If worker not ready yet, fall through to proxy
        }

        // Proxy DSP fallback
        this.inline.processBlock(L, R, Lo, Ro, this.ctrl);
        return true;
    }
}

registerProcessor("ai-audio-processor", HybridProcessor);
