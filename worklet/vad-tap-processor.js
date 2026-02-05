// worklet/vad-tap-processor.js
// Tap input, downmix to mono, post frames to the main thread (content script).

class VADTapProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.buf = null;
    }
    process(inputs) {
        const input = inputs[0];
        if (!input || !input[0]) return true;
        const L = input[0];
        const R = input[1] || L;
        const N = L.length;
        if (!this.buf || this.buf.length !== N) this.buf = new Float32Array(N);
        const mono = this.buf;
        for (let i = 0; i < N; i++) mono[i] = 0.5 * (L[i] + R[i]);
        const copy = new Float32Array(N);
        copy.set(mono);
        try { this.port.postMessage({ type: 'FRAME', data: copy.buffer }, [copy.buffer]); } catch { }
        return true;
    }
}
registerProcessor('vad-tap-processor', VADTapProcessor);
