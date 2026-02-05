// workers/onnx_worker.js
// VAD worker: tries ONNX (silero VAD), falls back to energy VAD.
// Receives {type:'FRAME', data:ArrayBuffer(Float32)} mono frames.
// Posts {type:'VOICE', prob:Number in [0,1]}.
// Init with {type:'LOAD', ortUrl, modelUrl}.

let ort = null;
let session = null;
let useOnnx = false;

// Simple energy-based fallback
function energyProb(frame) {
    let sum = 0, zc = 0, prev = 0;
    for (let i = 0; i < frame.length; i++) {
        const v = frame[i];
        sum += v * v;
        if ((v >= 0 && prev < 0) || (v < 0 && prev >= 0)) zc++;
        prev = v;
    }
    const rms = Math.sqrt(sum / Math.max(1, frame.length));
    // crude mapping
    const zcr = zc / frame.length;
    const p = Math.max(0, Math.min(1, (rms * 12) * (1 + 0.5 * Math.max(0, 0.12 - Math.abs(zcr - 0.08)))));
    return p;
}

async function loadOnnx(ortUrl, modelUrl) {
    try {
        importScripts(ortUrl);
        // global "ort" should now exist
        if (!self.ort) throw new Error("ORT not available");
        ort = self.ort;

        // Prefer WebGPU/WebNN if available; else WASM
        let epList = ["webgpu", "webnn", "wasm"];
        const availableEPs = [];
        for (const ep of epList) {
            try {
                if (ep === "webgpu" && ort.env.webgpu) availableEPs.push("webgpu");
                else if (ep === "webnn" && ort.env.webnn) availableEPs.push("webnn");
                else if (ep === "wasm") availableEPs.push("wasm");
            } catch { }
        }

        session = await ort.InferenceSession.create(modelUrl, {
            executionProviders: availableEPs,
            graphOptimizationLevel: "all",
            enableMemPattern: true,
            intraOpNumThreads: 1
        });

        useOnnx = true;
        postMessage({ type: "READY", ok: true, ep: availableEPs[0] || "wasm" });
    } catch (e) {
        useOnnx = false;
        postMessage({ type: "READY", ok: false, error: String(e && e.message || e) });
    }
}

function hannWindow(N) {
    const w = new Float32Array(N);
    for (let n = 0; n < N; n++) w[n] = 0.5 * (1 - Math.cos(2 * Math.PI * n / (N - 1)));
    return w;
}
const HANN_512 = hannWindow(512);

async function inferVadOnnx(frame) {
    // Silero expects 16kHz mono PCM float; we’ll assume the input is close
    // (Your frames from ScriptProcessor will be 48k; for demo we sub-sample by 3: quick & dirty)
    let N = Math.min(frame.length, 1536);
    const mono16k = new Float32Array(512);
    // naive decimate 3: 48k->16k, and window
    for (let i = 0; i < 512; i++) {
        const j = i * 3;
        mono16k[i] = (frame[j] + frame[j + 1] + frame[j + 2]) / 3 * HANN_512[i];
    }

    const input = new ort.Tensor("float32", mono16k, [1, 512]);
    // common Silero VAD export uses input name "input" or "input_0"; try both.
    const feeds = {};
    feeds["input"] = input;
    try {
        const out = await session.run(feeds);
        // Try to locate a single scalar prob
        const k = Object.keys(out)[0];
        const tensor = out[k];
        let prob = 0;
        if (tensor && tensor.data && tensor.data.length > 0) {
            prob = Math.max(0, Math.min(1, tensor.data[0]));
        }
        return prob;
    } catch (e) {
        // inference failure → fallback
        return energyProb(frame);
    }
}

onmessage = async (ev) => {
    const msg = ev.data || {};
    if (msg.type === "LOAD") {
        await loadOnnx(msg.ortUrl, msg.modelUrl);
        return;
    }
    if (msg.type === "FRAME" && msg.data) {
        const f32 = new Float32Array(msg.data);
        let prob = 0;
        if (useOnnx && session) {
            prob = await inferVadOnnx(f32);
        } else {
            prob = energyProb(f32);
        }
        postMessage({ type: "VOICE", prob });
    }
};
