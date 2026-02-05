// offscreen.js — stable capture + meters; hosts AudioContext + AudioWorklet + ONNX worker.
console.log("[offscreen] loaded");

let bgPort;
try {
    bgPort = chrome.runtime.connect({ name: "offscreen" });
    bgPort.postMessage({ type: "OFFSCREEN_READY" });
    console.log("[offscreen] connected to background");
} catch (e) {
    console.error("[offscreen] failed to connect:", e);
}

const WORKLET_URL = "worklet/audio-processor.js";
const SEP_WORKER_URL = "workers/sep_worker.js";
const MODEL_PATH = "models/mdx23c_quant.onnx";

const graphs = new Map();
// tabId -> { audioCtx, mediaStream, src, node, postGain, analyser, dest, audioEl, meterBuf, meterTimer, worker, control }

function postStatus(tabId, value) {
    try { bgPort?.postMessage({ type: "STATUS", tabId, value }); } catch { }
}

if (bgPort) {
    bgPort.onMessage.addListener(async (msg) => {
        if (!msg || !msg.type) return;

        if (msg.type === "OFFSCREEN_START") {
            await startGraph(msg.tabId, msg.streamId, msg.options);
        } else if (msg.type === "OFFSCREEN_STOP") {
            await stopGraph(msg.tabId);
        } else if (msg.type === "CONTROL_UPDATE") {
            const g = graphs.get(msg.tabId);
            if (!g) return;
            const c = { ...(g.control || {}), ...(msg.control || {}) };
            g.control = c;

            if (typeof c.masterGain === "number" && g.postGain) {
                g.postGain.gain.value = Math.max(0, Math.min(2, c.masterGain));
            }

            try { g.node?.port.postMessage({ type: "CONTROL", control: c }); } catch { }

            // Wake AudioContext if it drifted to suspended
            try { if (g.audioCtx?.state === "suspended") await g.audioCtx.resume(); } catch { }
        } else if (msg.type === "OFFSCREEN_RESUME") {
            const g = graphs.values().next().value;
            if (!g) return;
            try {
                if (g.audioCtx?.state === "suspended") await g.audioCtx.resume();
                if (g.audioEl?.paused) await g.audioEl.play().catch(() => { });
            } catch { }
        }
    });
}

async function startGraph(tabId, streamId, options) {
    try {
        if (graphs.has(tabId)) await stopGraph(tabId);
        if (!streamId) { postStatus(tabId, "idle"); return; }
        postStatus(tabId, "starting");

        // 1) getUserMedia with tab constraints
        const constraints = { audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } }, video: false };
        let mediaStream = null;
        for (let i = 0; i < 3; i++) {
            try { mediaStream = await navigator.mediaDevices.getUserMedia(constraints); break; }
            catch (e) {
                if (String(e?.name) === "AbortError" && i < 2) { await new Promise(r => setTimeout(r, 200)); continue; }
                throw e;
            }
        }
        if (!mediaStream) { postStatus(tabId, "idle"); return; }
        console.log("[offscreen] getUserMedia OK (tab)");

        // 2) AudioContext
        const audioCtx = new AudioContext({ latencyHint: "interactive" });
        console.log("[offscreen] AudioContext sr=", audioCtx.sampleRate);

        // 3) Worklet
        await audioCtx.audioWorklet.addModule(chrome.runtime.getURL(WORKLET_URL));
        console.log("[offscreen] worklet loaded");

        // 4) Build node + separation worker (always attach so mode switch is hot)
        const { node, worker } = await buildNode(audioCtx);

        // 5) Graph: src -> node -> postGain -> analyser -> dest -> <audio> (muted) & destination
        const src = audioCtx.createMediaStreamSource(mediaStream);
        const postGain = audioCtx.createGain();
        postGain.gain.value = options?.control?.masterGain ?? 1.0;

        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;

        const dest = audioCtx.createMediaStreamDestination();
        const silent = audioCtx.createGain();
        silent.gain.value = 0;

        src.connect(node).connect(postGain);
        postGain.connect(analyser);
        postGain.connect(dest);
        postGain.connect(silent).connect(audioCtx.destination);

        const audioEl = new Audio();
        audioEl.srcObject = dest.stream;
        audioEl.muted = true;
        audioEl.volume = 0;
        await audioEl.play().catch(() => { });

        if (audioCtx.state === "suspended") { try { await audioCtx.resume(); } catch { } }

        // 6) Meters
        const meterBuf = new Float32Array(analyser.fftSize);
        const meterTimer = setInterval(() => {
            try {
                analyser.getFloatTimeDomainData(meterBuf);
                let sum = 0, peak = 0;
                for (let i = 0; i < meterBuf.length; i++) {
                    const v = meterBuf[i];
                    sum += v * v;
                    const a = Math.abs(v);
                    if (a > peak) peak = a;
                }
                const rms = Math.sqrt(sum / meterBuf.length);
                bgPort?.postMessage({ type: "METERS", tabId, voiceRMS: rms, peak });
            } catch { }
        }, 33);

        // 7) Initial control
        const control = {
            masterGain: options?.control?.masterGain ?? 1.0,
            voiceGain: options?.control?.voiceGain ?? 1.0,
            bgGain: options?.control?.bgGain ?? 1.0,
            muteVoice: !!options?.control?.muteVoice,
            muteBg: !!options?.control?.muteBg,
            musicCut: options?.control?.musicCut ?? 0.0,
            sfxCut: options?.control?.sfxCut ?? 0.0,
            aiMode: options?.control?.aiMode === "onnx" ? "onnx" : "proxy"
        };
        try { node.port.postMessage({ type: "CONTROL", control }); } catch { }

        graphs.set(tabId, {
            audioCtx, mediaStream,
            src, node, postGain, analyser, dest, audioEl,
            meterBuf, meterTimer,
            worker,
            control
        });

        postStatus(tabId, "running");
        console.log("[offscreen] graph running mode:", control.aiMode);
    } catch (err) {
        console.error("[offscreen] startGraph error:", err);
        postStatus(tabId, "idle");
    }
}

async function buildNode(audioCtx) {
    const node = new AudioWorkletNode(audioCtx, "ai-audio-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: {},
    });

    let worker = null;
    try {
        worker = new Worker(chrome.runtime.getURL(SEP_WORKER_URL));
        const mc = new MessageChannel();
        node.port.postMessage({ type: "ATTACH_WORKER", port: mc.port2 }, [mc.port2]);

        worker.postMessage({
            type: "LOAD",
            modelPath: MODEL_PATH,
            ortPath: "lib/ort.min.js",
        });

        worker.onmessage = (e) => {
            if (e.data?.type === "READY") {
                console.log("[offscreen] sep-worker ready (ep:", e.data.ep || "unknown", ")");
            }
        };
    } catch (e) {
        console.warn("[offscreen] sep-worker attach failed; continuing without ONNX:", e);
        if (worker) try { worker.terminate(); } catch { }
        worker = null;
    }
    return { node, worker };
}

async function stopGraph(tabId) {
    const g = tabId ? graphs.get(tabId) : graphs.values().next().value;
    if (!g) return;
    try { clearInterval(g.meterTimer); } catch { }
    try { g.src?.disconnect(); } catch { }
    try { g.node?.disconnect(); } catch { }
    try { g.analyser?.disconnect(); } catch { }
    try { g.postGain?.disconnect(); } catch { }
    try { g.dest?.disconnect?.(); } catch { }
    try { if (g.audioEl) { g.audioEl.pause(); g.audioEl.srcObject = null; } } catch { }
    try { await g.audioCtx?.close(); } catch { }
    try { g.mediaStream?.getTracks()?.forEach(t => t.stop()); } catch { }
    try { if (g.worker) g.worker.terminate(); } catch { }
    graphs.delete(tabId);
    postStatus(tabId, "idle");
    console.log("[offscreen] stopped graph", tabId ?? "");
}

self.onunload = () => {
    for (const [tabId] of graphs) stopGraph(tabId);
    console.log("[offscreen] unloaded");
};
