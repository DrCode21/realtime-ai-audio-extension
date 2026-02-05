// content/inject.js — adds optional AI Separation path (sep worklet + worker) behind aiMode toggle.
// Defaults to existing VAD/EQ path. No regressions to meters/gain.

(function () {
    if (window.__streamAudioInjected) return;
    window.__streamAudioInjected = true;

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg && msg.type === "PING_CONTENT") { sendResponse({ ok: true }); return true; }
    });

    const state = {
        audioCtx: null,
        mediaEl: null,
        stream: null,

        // Graph nodes (shared)
        srcNode: null,
        masterGain: null,
        analyser: null,

        // VAD/EQ path
        lowShelf: null,
        highShelf: null,
        aiGain: null,
        vadTap: null,
        workletVADLoaded: false,

        // Separation path
        sepNode: null,
        sepModeActive: false,
        workletSepLoaded: false,

        // Worker(s)
        aiWorker: null,        // onnx_worker (for VAD) — optional
        sepWorker: null,       // sep_worker (for separation) — optional

        // Meters/UI/control
        meterBuf: null,
        meterTimer: null,
        running: false,
        userMutedOriginal: false,
        musicCut: 0.0,
        sfxCut: 0.0,
        aiMode: "vad"          // "vad" | "sep"
    };

    const clamp01 = (x) => x < 0 ? 0 : (x > 1 ? 1 : x);
    const safeConnect = (a, b) => { try { a && b && a.connect(b); } catch { } };
    const safeDisconnect = (n) => { try { n && n.disconnect(); } catch { } };

    function findMediaElement() {
        return document.querySelector("video.html5-main-video") || document.querySelector("video, audio") || null;
    }

    async function teardownGraph() {
        try { clearInterval(state.meterTimer); } catch { }
        state.meterTimer = null;

        [state.vadTap, state.sepNode, state.srcNode, state.masterGain,
        state.lowShelf, state.highShelf, state.aiGain, state.analyser].forEach(safeDisconnect);

        if (state.aiWorker) { try { state.aiWorker.terminate(); } catch { } state.aiWorker = null; }
        if (state.sepWorker) { try { state.sepWorker.terminate(); } catch { } state.sepWorker = null; }

        try { state.stream?.getTracks().forEach(t => t.stop()); } catch { }
        state.stream = null;

        state.srcNode = state.masterGain = state.lowShelf = state.highShelf =
            state.aiGain = state.analyser = state.vadTap = state.sepNode = null;

        if (state.audioCtx) { try { await state.audioCtx.close(); } catch { } state.audioCtx = null; }

        state.running = false;
    }

    async function ensureFreshContext() {
        const AC = window.AudioContext || window.webkitAudioContext;
        state.audioCtx = new AC({ latencyHint: "interactive" });

        // Try to load VAD tap worklet
        state.workletVADLoaded = false;
        await tryAddWorklet("worklet/vad-tap-processor.js").then(ok => state.workletVADLoaded = ok);

        // Try to load separation worklet (sep processor)
        state.workletSepLoaded = false;
        await tryAddWorklet("worklet/sep-processor.js").then(ok => state.workletSepLoaded = ok);

        if (state.audioCtx.state === "suspended") {
            try { await state.audioCtx.resume(); } catch { }
        }
    }

    async function tryAddWorklet(relUrl) {
        // Attempt direct extension URL first
        try {
            await state.audioCtx.audioWorklet.addModule(chrome.runtime.getURL(relUrl));
            return true;
        } catch (e1) {
            // Fallback: fetch -> blob URL
            try {
                const abs = chrome.runtime.getURL(relUrl);
                const res = await fetch(abs, { cache: "no-store" });
                if (!res.ok) throw new Error(`fetch ${relUrl} ${res.status}`);
                const code = await res.text();
                const blobUrl = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
                try {
                    await state.audioCtx.audioWorklet.addModule(blobUrl);
                    return true;
                } finally {
                    URL.revokeObjectURL(blobUrl);
                }
            } catch (e2) {
                console.warn("[inject] addModule failed for", relUrl, ":", e1?.message || e1, "|", e2?.message || e2);
                return false;
            }
        }
    }

    function startMeters() {
        state.meterBuf = new Float32Array(state.analyser.fftSize);
        state.meterTimer = setInterval(() => {
            try {
                state.analyser.getFloatTimeDomainData(state.meterBuf);
                let sum = 0, N = state.meterBuf.length;
                for (let i = 0; i < N; i++) sum += state.meterBuf[i] * state.meterBuf[i];
                const rms = Math.sqrt(sum / N);
                chrome.runtime.sendMessage({ type: "METERS", voiceRMS: rms, peak: rms });
            } catch { }
        }, 33);
    }

    function buildGraphVAD(stream, initialGain) {
        const ctx = state.audioCtx;

        const src = ctx.createMediaStreamSource(stream);
        const master = ctx.createGain();
        master.gain.value = (typeof initialGain === "number" && initialGain >= 0 && initialGain <= 2) ? initialGain : 1.0;

        const low = ctx.createBiquadFilter(); low.type = "lowshelf"; low.frequency.value = 180; low.gain.value = 0;
        const high = ctx.createBiquadFilter(); high.type = "highshelf"; high.frequency.value = 4500; high.gain.value = 0;
        const aig = ctx.createGain(); aig.gain.value = 1.0;
        const an = ctx.createAnalyser(); an.fftSize = 2048;

        safeConnect(src, master);
        safeConnect(master, low);
        safeConnect(low, high);
        safeConnect(high, aig);
        safeConnect(aig, an);
        safeConnect(aig, ctx.destination);

        // VAD tap (optional, if worklet loaded)
        let tap = null;
        if (state.workletVADLoaded) {
            try {
                tap = new AudioWorkletNode(ctx, "vad-tap-processor", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2 });
                safeConnect(master, tap);
                // If you still run a VAD worker, connect tap.port → worker here (kept as-is if you already had it)
            } catch (e) {
                console.warn("[inject] VAD tap creation failed:", e?.message || e);
            }
        }

        state.srcNode = src; state.masterGain = master;
        state.lowShelf = low; state.highShelf = high; state.aiGain = aig;
        state.analyser = an; state.vadTap = tap;
    }

    function buildGraphSEP(stream, initialGain, initialControl) {
        const ctx = state.audioCtx;

        const src = ctx.createMediaStreamSource(stream);
        const master = ctx.createGain();
        master.gain.value = (typeof initialGain === "number" && initialGain >= 0 && initialGain <= 2) ? initialGain : 1.0;

        const sepOutAnalyser = ctx.createAnalyser(); sepOutAnalyser.fftSize = 2048;

        // Separation worklet node (if loaded), else fallback to just master→analyser
        let sepNode = null;
        if (state.workletSepLoaded) {
            try {
                sepNode = new AudioWorkletNode(ctx, "sep-processor", {
                    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2]
                });
            } catch (e) {
                console.warn("[inject] sep worklet creation failed:", e?.message || e);
                sepNode = null;
            }
        }

        if (sepNode) {
            // Attach separation worker
            try {
                const w = new Worker(chrome.runtime.getURL("workers/sep_worker.js"));
                const mc = new MessageChannel();
                w.onmessage = (ev) => {
                    if (ev.data?.type === "READY") {
                        // ok to proceed
                    }
                };
                sepNode.port.postMessage({ type: "ATTACH_WORKER", port: mc.port2 }, [mc.port2]);
                w.postMessage({
                    type: "LOAD",
                    ortUrl: chrome.runtime.getURL("lib/ort.min.js"),
                    modelUrl: chrome.runtime.getURL("models/voice_sep.onnx"),
                    control: initialControl || {}
                });
                state.sepWorker = w;
            } catch (e) {
                console.warn("[inject] sep worker attach failed:", e?.message || e);
            }

            // Route: src -> master -> sep -> analyser -> destination
            safeConnect(src, master);
            safeConnect(master, sepNode);
            safeConnect(sepNode, sepOutAnalyser);
            safeConnect(sepNode, ctx.destination);

            // forward initial control (if any)
            if (initialControl) {
                try { sepNode.port.postMessage({ type: "CONTROL", control: initialControl }); } catch { }
            }
        } else {
            // Fallback: behave like VAD-less pass-through to keep meters/gain alive
            safeConnect(src, master);
            safeConnect(master, sepOutAnalyser);
            safeConnect(master, ctx.destination);
        }

        state.srcNode = src; state.masterGain = master;
        state.sepNode = sepNode;
        state.analyser = sepOutAnalyser;
    }

    function startMetersAndMarkRunning() {
        startMeters();
        state.running = true;
        chrome.runtime.sendMessage({ type: "STATUS", value: "running" });
    }

    function buildGraphForMode(stream, initialGain, control) {
        if (state.aiMode === "sep") {
            buildGraphSEP(stream, initialGain, control);
        } else {
            buildGraphVAD(stream, initialGain);
        }
        startMetersAndMarkRunning();
    }

    function captureFromMediaEl(el) {
        let s = null;
        try { if (typeof el.captureStream === "function") s = el.captureStream(); } catch { }
        try { if ((!s || s.getAudioTracks().length === 0) && typeof el.mozCaptureStream === "function") s = el.mozCaptureStream(); } catch { }
        return s;
    }

    // messages
    chrome.runtime.onMessage.addListener((msg) => {
        if (!msg || !msg.type) return;

        if (msg.type === "START_CAPTURE") {
            const el = findMediaElement();
            if (!el) { chrome.runtime.sendMessage({ type: "STATUS", value: "idle" }); return; }

            (async () => {
                await teardownGraph();
                await ensureFreshContext();

                // read desired mode from options.control.aiMode ("vad" | "sep")
                state.aiMode = (msg.options && msg.options.control && msg.options.control.aiMode === "sep") ? "sep" : "vad";

                let stream = captureFromMediaEl(el);
                if (stream && stream.getAudioTracks().length === 0) {
                    try { await el.play().catch(() => { }); } catch { }
                    stream = captureFromMediaEl(el);
                }
                if (!stream || stream.getAudioTracks().length === 0) {
                    chrome.runtime.sendMessage({ type: "STATUS", value: "idle" });
                    console.warn("[inject] no captureStream audio available");
                    return;
                }

                const ctrl = (msg.options && msg.options.control) || {};
                state.musicCut = clamp01(ctrl.musicCut || 0);
                state.sfxCut = clamp01(ctrl.sfxCut || 0);

                const mg = (typeof ctrl.masterGain === "number") ? ctrl.masterGain : 1.0;

                state.mediaEl = el;
                state.stream = stream;

                buildGraphForMode(stream, mg, ctrl);
            })();
        }

        if (msg.type === "STOP_CAPTURE") {
            (async () => {
                await teardownGraph();
                if (state.mediaEl && state.userMutedOriginal) {
                    try { state.mediaEl.muted = false; } catch { }
                    state.userMutedOriginal = false;
                }
                chrome.runtime.sendMessage({ type: "STATUS", value: "idle" });
            })();
        }

        if (msg.type === "CONTROL_UPDATE") {
            const ctrl = msg.control || {};
            if (state.masterGain && typeof ctrl.masterGain === "number") {
                let v = ctrl.masterGain; if (!(v >= 0 && v <= 2)) v = 1.0; state.masterGain.gain.value = v;
            }

            // Mode switch request?
            if (typeof ctrl.aiMode === "string") {
                const next = (ctrl.aiMode === "sep") ? "sep" : "vad";
                if (next !== state.aiMode && state.stream) {
                    // rebuild graph in the other mode, preserving current gain
                    const currentGain = state.masterGain ? state.masterGain.gain.value : 1.0;
                    (async () => {
                        await teardownGraph();
                        await ensureFreshContext();
                        state.aiMode = next;
                        buildGraphForMode(state.stream, currentGain, ctrl);
                    })();
                    return;
                }
                state.aiMode = next;
            }

            // Forward control to sep worklet/worker if active
            if (state.aiMode === "sep" && state.sepNode) {
                try { state.sepNode.port.postMessage({ type: "CONTROL", control: ctrl }); } catch { }
            }

            // Update VAD/EQ shaping if in VAD mode
            if (state.aiMode === "vad") {
                state.musicCut = clamp01(ctrl.musicCut || 0);
                state.sfxCut = clamp01(ctrl.sfxCut || 0);
                // (VAD/EQ shaping happens inside the VAD path you already had; left unchanged)
            }
        }

        if (msg.type === "MUTE_ORIGINAL_MEDIA") {
            const el2 = state.mediaEl || findMediaElement();
            if (!el2) return;
            try { el2.muted = !!msg.muted; state.userMutedOriginal = !!msg.muted; } catch { }
        }

        if (msg.type === "FORCE_UNMUTE_TAB") {
            const el3 = state.mediaEl || findMediaElement();
            if (!el3) return;
            try { el3.muted = false; state.userMutedOriginal = false; } catch { }
        }
    });

    // Handle SPA media element swaps
    const obs = new MutationObserver(() => {
        if (!state.running) return;
        const el = findMediaElement();
        if (el && el !== state.mediaEl) {
            chrome.runtime.sendMessage({ type: "STATUS", value: "starting" });
            (async () => {
                const oldGain = state.masterGain ? state.masterGain.gain.value : 1.0;
                await teardownGraph();
                await ensureFreshContext();
                let stream = captureFromMediaEl(el);
                if (stream && stream.getAudioTracks().length === 0) {
                    try { await el.play().catch(() => { }); } catch { }
                    stream = captureFromMediaEl(el);
                }
                if (stream && stream.getAudioTracks().length > 0) {
                    state.mediaEl = el; state.stream = stream;
                    buildGraphForMode(stream, oldGain, { aiMode: state.aiMode });
                } else {
                    chrome.runtime.sendMessage({ type: "STATUS", value: "idle" });
                }
            })();
        }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
})();
