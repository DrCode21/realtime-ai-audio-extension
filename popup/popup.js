// popup/popup.js — normalize controls, send aiMode = "proxy" | "onnx", draw meters, show status.

const UI = {
    startBtn: document.getElementById("start"),
    stopBtn: document.getElementById("stop"),
    masterGain: document.getElementById("masterGain"),
    masterGainVal: document.getElementById("masterGainVal"),
    voiceGain: document.getElementById("voiceGain"),
    voiceGainVal: document.getElementById("voiceGainVal"),
    bgGain: document.getElementById("bgGain"),
    bgGainVal: document.getElementById("bgGainVal"),
    muteVoice: document.getElementById("muteVoice"),
    muteBg: document.getElementById("muteBg"),
    muteTabAudio: document.getElementById("muteTabAudio"),
    musicCut: document.getElementById("musicCut"),
    musicCutVal: document.getElementById("musicCutVal"),
    sfxCut: document.getElementById("sfxCut"),
    sfxCutVal: document.getElementById("sfxCutVal"),
    aiMode: document.getElementById("aiMode"),
    status: document.getElementById("status"),
    meter: document.getElementById("meter"),
};

const state = {
    port: null,
    portReady: false,
    tabId: null,
    status: "idle",
    queue: [],
    meterCtx: null
};

function setStatus(s) {
    state.status = s;
    if (UI.status) UI.status.textContent = s[0].toUpperCase() + s.slice(1);
    console.log("[popup] status:", s);
}

async function getActiveTabId() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0].id : null;
}

function pctTextFromRange(el) {
    const v = Number(el.value || 0);
    return `${v}%`;
}

// Normalize sliders:
// - master/voice/bg gains: 0..200% → 0..2.0 linear
// - cuts: 0..100% → 0..1.0 linear
function collectControl() {
    const master = Math.max(0, Math.min(200, Number(UI.masterGain.value || 100))) / 100; // 0..2
    const voice = Math.max(0, Math.min(200, Number(UI.voiceGain.value || 100))) / 100;
    const bg = Math.max(0, Math.min(200, Number(UI.bgGain.value || 100))) / 100;
    const music = Math.max(0, Math.min(100, Number(UI.musicCut.value || 0))) / 100; // 0..1
    const sfx = Math.max(0, Math.min(100, Number(UI.sfxCut.value || 0))) / 100;

    return {
        masterGain: master,
        voiceGain: voice,
        bgGain: bg,
        muteVoice: !!UI.muteVoice.checked,
        muteBg: !!UI.muteBg.checked,
        muteTabAudio: !!UI.muteTabAudio.checked,
        musicCut: music,
        sfxCut: sfx,
        aiMode: (UI.aiMode && UI.aiMode.value === "onnx") ? "onnx" : "proxy"
    };
}

function updateValueLabels() {
    UI.masterGainVal.textContent = pctTextFromRange(UI.masterGain);
    UI.voiceGainVal.textContent = pctTextFromRange(UI.voiceGain);
    UI.bgGainVal.textContent = pctTextFromRange(UI.bgGain);
    UI.musicCutVal.textContent = pctTextFromRange(UI.musicCut);
    UI.sfxCutVal.textContent = pctTextFromRange(UI.sfxCut);
}

function connectBackground() {
    try {
        const port = chrome.runtime.connect({ name: "popup" });
        state.port = port;
        state.portReady = true;
        console.log("[popup] bg connected");

        port.onMessage.addListener((msg) => {
            if (!msg || !msg.type) return;

            if (msg.type === "STATUS" && msg.value) {
                setStatus(msg.value);
            }

            if (msg.type === "METERS" && UI.meter) {
                drawMeter(msg.voiceRMS ?? 0, msg.peak ?? 0);
                if (state.status !== "running") setStatus("running");
            }
        });

        port.onDisconnect.addListener(() => {
            state.portReady = false;
            console.log("[popup] bg disconnected");
            setStatus("disconnected");
            chrome.runtime.sendMessage({ ping: "wake" }).catch(() => { });
            setTimeout(connectBackground, 300);
        });

        flushQueue();
    } catch (e) {
        state.portReady = false;
        console.warn("[popup] connect failed; retrying…", e);
        chrome.runtime.sendMessage({ ping: "wake" }).catch(() => { });
        setTimeout(connectBackground, 300);
    }
}

function sendOrQueue(msg) {
    msg.tabId = state.tabId;
    if (state.portReady && state.port) {
        try { state.port.postMessage(msg); }
        catch (e) { state.queue.push(msg); setTimeout(connectBackground, 150); }
    } else {
        state.queue.push(msg);
    }
}

function flushQueue() {
    if (!state.portReady || !state.port) return;
    while (state.queue.length) {
        const m = state.queue.shift();
        try { state.port.postMessage(m); } catch (e) {
            state.queue.unshift(m);
            setTimeout(connectBackground, 150);
            break;
        }
    }
}

function drawMeter(rms, peak) {
    const c = UI.meter;
    if (!c) return;
    if (!state.meterCtx) state.meterCtx = c.getContext("2d");
    const ctx = state.meterCtx;
    const w = c.width, h = c.height;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, w, h);

    const toPct = (x) => Math.max(0, Math.min(1, x * 1.4));
    const v = toPct(rms);
    const p = Math.max(v, toPct(peak));

    ctx.fillStyle = "#2ecc71";
    ctx.fillRect(0, h - h * v, w, h * v);

    ctx.fillStyle = "#16a085";
    ctx.fillRect(0, h - h * p, w, 2);
}

// ---- init ----
document.addEventListener("DOMContentLoaded", async () => {
    setStatus("idle");
    state.tabId = await getActiveTabId();
    if (state.tabId == null) {
        if (UI.status) UI.status.textContent = "No active tab";
        return;
    }

    UI.startBtn.addEventListener("click", () => {
        setStatus("starting");
        sendOrQueue({ type: "START_CAPTURE", tabId: state.tabId, options: { control: collectControl() } });
    });
    UI.stopBtn.addEventListener("click", () => {
        sendOrQueue({ type: "STOP_CAPTURE", tabId: state.tabId });
        setStatus("idle");
    });

    [UI.masterGain, UI.voiceGain, UI.bgGain, UI.musicCut, UI.sfxCut].forEach((el) => {
        el.addEventListener("input", () => {
            updateValueLabels();
            sendOrQueue({ type: "CONTROL_UPDATE", control: collectControl() });
        });
    });

    [UI.muteVoice, UI.muteBg, UI.aiMode, UI.muteTabAudio].forEach((el) => {
        el.addEventListener("change", () => {
            sendOrQueue({ type: "CONTROL_UPDATE", control: collectControl() });
        });
    });

    updateValueLabels();
    connectBackground();
});
