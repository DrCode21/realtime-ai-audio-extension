// worklet/sep-processor.js
// Streams small interleaved blocks to a worker that returns a mixed interleaved output.
// If worker/model unavailable, falls back to pass-through.

class SepProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.ctrl = {
            voiceGain: 1.0,
            bgGain: 1.0,
            muteVoice: false,
            muteBg: false
        };
        this.workerPort = null;
        this.pendingOut = null;

        this.port.onmessage = (ev) => {
            const { type, control, port, data } = ev.data || {};
            if (type === 'CONTROL' && control) {
                this.ctrl = { ...this.ctrl, ...control };
                if (this.workerPort) this.workerPort.postMessage({ type: 'CONTROL', control: this.ctrl });
            } else if (type === 'ATTACH_WORKER' && port) {
                this.workerPort = port;
                this.workerPort.onmessage = (e) => {
                    const d = e.data || {};
                    if (d.type === 'OUT' && d.data) {
                        this.pendingOut = new Float32Array(d.data); // interleaved float32
                    }
                };
                // Push current control to worker
                this.workerPort.postMessage({ type: 'CONTROL', control: this.ctrl });
            } else if (type === 'OUT' && data) {
                // (not used; we rely on workerPort.onmessage)
                this.pendingOut = new Float32Array(data);
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

        // Send current block to worker if attached
        if (this.workerPort) {
            const inter = new Float32Array(2 * N);
            for (let i = 0; i < N; i++) { inter[2 * i] = L[i]; inter[2 * i + 1] = R[i]; }
            this.workerPort.postMessage({ type: 'PROCESS', data: inter.buffer }, [inter.buffer]);
        }

        // Use last worker result if available, else pass through
        if (this.pendingOut && this.pendingOut.length === 2 * N) {
            for (let i = 0; i < N; i++) { Lo[i] = this.pendingOut[2 * i]; Ro[i] = this.pendingOut[2 * i + 1]; }
            this.pendingOut = null;
        } else {
            Lo.set(L); if (Ro !== Lo) Ro.set(R);
        }
        return true;
    }
}

registerProcessor('sep-processor', SepProcessor);
