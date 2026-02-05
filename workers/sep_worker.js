// workers/sep_worker.js
// Loads MDX23C/MDX model and performs streaming separation with OLA. Emits voice and background stems separately.

let ort = null;
let session = null;
let ready = false;
let ioNames = null;

let ctrl = {
    voiceGain: 1.0,
    bgGain: 1.0,
    muteVoice: false,
    muteBg: false
};

const BLOCK = 4096;           // model window
const HOP = BLOCK >> 1;       // 50% overlap
const WIN = new Float32Array(BLOCK);
for (let i = 0; i < BLOCK; i++) WIN[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (BLOCK - 1)));

let inBuf = new Float32Array(0);
let olaVoiceL = new Float32Array(BLOCK);
let olaVoiceR = new Float32Array(BLOCK);
let olaBgL = new Float32Array(BLOCK);
let olaBgR = new Float32Array(BLOCK);
let olaFill = 0;

self.onmessage = async (e) => {
    const msg = e.data || {};

    if (msg.type === "LOAD") {
        await loadModel(msg);
        return;
    }

    if (msg.type === "CONTROL" && msg.control) {
        const norm = (x) => (typeof x === "number" ? (x > 4 ? Math.max(0, Math.min(2, x / 100)) : Math.max(0, Math.min(2, x))) : 1);
        if ("voiceGain" in msg.control) ctrl.voiceGain = norm(msg.control.voiceGain);
        if ("bgGain" in msg.control) ctrl.bgGain = norm(msg.control.bgGain);
        if ("muteVoice" in msg.control) ctrl.muteVoice = !!msg.control.muteVoice;
        if ("muteBg" in msg.control) ctrl.muteBg = !!msg.control.muteBg;
        return;
    }

    if (msg.type === "PROCESS" && msg.data) {
        // If the model is not ready, drop data so the worklet falls back to proxy mode
        if (!ready || !session) return;

        const chunk = new Float32Array(msg.data);
        const next = new Float32Array(inBuf.length + chunk.length);
        next.set(inBuf, 0);
        next.set(chunk, inBuf.length);
        inBuf = next;

        const outVoice = [];
        const outBg = [];

        while (inBuf.length >= 2 * BLOCK) {
            const L = new Float32Array(BLOCK);
            const R = new Float32Array(BLOCK);
            for (let i = 0; i < BLOCK; i++) {
                L[i] = inBuf[2 * i] * WIN[i];
                R[i] = inBuf[2 * i + 1] * WIN[i];
            }

            const voice = await runModelStereo(L, R);
            // voice contains [vL, vR] windowed
            for (let i = 0; i < BLOCK; i++) {
                const vL = voice[2 * i];
                const vR = voice[2 * i + 1];
                const bL = L[i] - vL;
                const bR = R[i] - vR;
                olaVoiceL[i] += vL;
                olaVoiceR[i] += vR;
                olaBgL[i] += bL;
                olaBgR[i] += bR;
            }

            const hopVoice = new Float32Array(2 * HOP);
            const hopBg = new Float32Array(2 * HOP);
            for (let i = 0; i < HOP; i++) {
                hopVoice[2 * i] = olaVoiceL[i];
                hopVoice[2 * i + 1] = olaVoiceR[i];
                hopBg[2 * i] = olaBgL[i];
                hopBg[2 * i + 1] = olaBgR[i];
            }
            outVoice.push(hopVoice);
            outBg.push(hopBg);

            slideOla();
            dropInputHop();
        }

        if (outVoice.length) {
            const total = outVoice.reduce((a, f) => a + f.length, 0);
            const totalBg = outBg.reduce((a, f) => a + f.length, 0);
            const mergedV = new Float32Array(total);
            const mergedB = new Float32Array(totalBg);
            let off = 0, offB = 0;
            for (let i = 0; i < outVoice.length; i++) {
                mergedV.set(outVoice[i], off); off += outVoice[i].length;
                mergedB.set(outBg[i], offB); offB += outBg[i].length;
            }
            postMessage({ type: "OUT", voice: mergedV.buffer, bg: mergedB.buffer }, [mergedV.buffer, mergedB.buffer]);
        }
        return;
    }
};

async function loadModel(msg) {
    try {
        if (msg.ortPath) importScripts(chrome.runtime.getURL(msg.ortPath));
        ort = self.ort || null;
        if (!ort) throw new Error("ORT not found");

        const modelUrl = chrome.runtime.getURL(msg.modelPath || "models/mdx23c_quant.onnx");

        let ep = "wasm";
        try {
            if (ort.env.webgpu) {
                await ort.env.webgpu.init();
                session = await ort.InferenceSession.create(modelUrl, {
                    executionProviders: ["webgpu"],
                    graphOptimizationLevel: "all",
                });
                ep = "webgpu";
            } else {
                throw new Error("WebGPU not available");
            }
        } catch {
            session = await ort.InferenceSession.create(modelUrl, {
                executionProviders: ["wasm"],
                graphOptimizationLevel: "all",
                intraOpNumThreads: 1,
            });
            ep = "wasm";
        }

        ready = true;
        postMessage({ type: "READY", ok: true, ep });
    } catch (err) {
        console.error("[sep-worker] LOAD failed:", err);
        ready = false;
        postMessage({ type: "READY", ok: false, error: String(err) });
    }
}

function slideOla() {
    olaVoiceL.copyWithin(0, HOP); olaVoiceR.copyWithin(0, HOP);
    olaBgL.copyWithin(0, HOP); olaBgR.copyWithin(0, HOP);
    olaVoiceL.fill(0, BLOCK - HOP); olaVoiceR.fill(0, BLOCK - HOP);
    olaBgL.fill(0, BLOCK - HOP); olaBgR.fill(0, BLOCK - HOP);
}

function dropInputHop() {
    const drop = 2 * HOP;
    const remain = inBuf.length - drop;
    const tmp = new Float32Array(remain);
    tmp.set(inBuf.subarray(drop));
    inBuf = tmp;
}

function passthroughStereo(L, R) {
    const out = new Float32Array(2 * BLOCK);
    for (let i = 0; i < BLOCK; i++) {
        out[2 * i] = L[i];
        out[2 * i + 1] = R[i];
    }
    return out;
}

async function runModelStereo(L, R) {
    const inputData = new Float32Array(2 * BLOCK);
    inputData.set(L, 0);
    inputData.set(R, BLOCK);

    const input = new ort.Tensor("float32", inputData, [1, 2, BLOCK]);
    if (!ioNames) {
        const probe = await session.run({ input });
        ioNames = { in: "input", out: Object.keys(probe)[0] };
    }

    let outputs;
    try {
        outputs = await session.run({ [ioNames.in]: input });
    } catch (e) {
        outputs = await session.run({ "input_1": input }).catch(() => null);
        if (!outputs) return passthroughStereo(L, R);
        ioNames = { in: "input_1", out: Object.keys(outputs)[0] };
    }

    const y = outputs[ioNames.out]?.data;
    if (!y || y.length < 2 * BLOCK) return passthroughStereo(L, R);

    const out = new Float32Array(2 * BLOCK);
    for (let i = 0; i < BLOCK; i++) {
        out[2 * i] = y[i] * WIN[i];
        out[2 * i + 1] = y[i + BLOCK] * WIN[i];
    }
    return out;
}
