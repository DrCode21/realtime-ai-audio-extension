// background.js — coordinates popup, offscreen document, and tab capture lifecycle.
// Responsibilities:
// - Respond to popup commands (start/stop/control updates)
// - Acquire tab capture stream IDs with retries
// - Spin up the offscreen document to host the audio graph
// - Relay status/meter updates back to popup
// - Persist sessions so service worker reloads can re-attach

console.log("[bg] service worker loaded");

const OFFSCREEN_URL = "offscreen.html";
const sessions = new Map(); // tabId -> { control, mutedTab }
let popupPort = null;
let offscreenPort = null;
const offscreenQueue = [];

chrome.runtime.onConnect.addListener((port) => {
    if (port.name === "popup") {
        popupPort = port;
        console.log("[bg] popup connected");
        port.onMessage.addListener((msg) => handlePopupMessage(msg));
        port.onDisconnect.addListener(() => { popupPort = null; });
    } else if (port.name === "offscreen") {
        offscreenPort = port;
        console.log("[bg] offscreen connected");
        port.onMessage.addListener((msg) => handleOffscreenMessage(msg));
        port.onDisconnect.addListener(() => { offscreenPort = null; });
        flushOffscreenQueue();
    }
});

chrome.runtime.onMessage.addListener((msg, sender) => {
    // Allow offscreen to relay via sendMessage if port not ready
    if (msg && msg.type && sender?.url?.includes(OFFSCREEN_URL)) {
        handleOffscreenMessage(msg);
    }
});

// Attempt to restore sessions after SW restart
(async () => {
    try {
        const stored = await chrome.storage.local.get({ sessions: {} });
        for (const [tabIdStr, data] of Object.entries(stored.sessions || {})) {
            const tabId = Number(tabIdStr);
            if (Number.isInteger(tabId)) {
                console.log("[bg] restoring session for tab", tabId);
                startCapture(tabId, { control: data.control || {} }, true);
            }
        }
    } catch (e) {
        console.warn("[bg] restore failed", e);
    }
})();

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status === "complete" && sessions.has(tabId)) {
        console.log("[bg] tab updated, resuming capture", tabId);
        const s = sessions.get(tabId);
        startCapture(tabId, { control: s.control || {} }, true);
    }
});

function sendToPopup(payload) {
    try {
        if (popupPort) popupPort.postMessage(payload);
        else chrome.runtime.sendMessage(payload).catch(() => { });
    } catch (e) {
        console.warn("[bg] sendToPopup failed:", e?.message || e);
    }
}

function sendToOffscreen(payload) {
    try {
        if (offscreenPort) {
            offscreenPort.postMessage(payload);
        } else {
            offscreenQueue.push(payload);
        }
    } catch (e) {
        console.warn("[bg] sendToOffscreen failed:", e?.message || e);
    }
}

function flushOffscreenQueue() {
    if (!offscreenPort || !offscreenQueue.length) return;
    while (offscreenQueue.length) {
        const msg = offscreenQueue.shift();
        try { offscreenPort.postMessage(msg); } catch (e) { console.warn("[bg] offscreen queue post failed", e); break; }
    }
}

function handleOffscreenMessage(msg) {
    if (!msg || !msg.type) return;
    if (msg.type === "STATUS") {
        sendToPopup({ type: "STATUS", tabId: msg.tabId, value: msg.value });
    } else if (msg.type === "METERS") {
        sendToPopup(msg);
    } else if (msg.type === "OFFSCREEN_READY") {
        flushOffscreenQueue();
    } else if (msg.type === "READY_FOR_STREAM" && msg.tabId) {
        // offscreen requests a fresh stream (after context resume)
        const s = sessions.get(msg.tabId);
        if (s) startCapture(msg.tabId, { control: s.control || {} }, true);
    }
}

async function handlePopupMessage(msg) {
    if (!msg || !msg.type || !msg.tabId) return;
    const tabId = msg.tabId;

    if (msg.type === "START_CAPTURE") {
        await startCapture(tabId, msg.options || {}, false);
    } else if (msg.type === "STOP_CAPTURE") {
        await stopCapture(tabId);
    } else if (msg.type === "CONTROL_UPDATE") {
        const control = msg.control || {};
        const entry = sessions.get(tabId) || { control: {} };
        entry.control = { ...entry.control, ...control };
        sessions.set(tabId, entry);
        persistSessions();
        sendToOffscreen({ type: "CONTROL_UPDATE", tabId, control });
        if (control.muteTabAudio !== undefined) updateTabMute(tabId, control.muteTabAudio);
    }
}

async function ensureOffscreen() {
    const has = chrome.offscreen?.hasDocument ? await chrome.offscreen.hasDocument() : false;
    if (!has) {
        await chrome.offscreen.createDocument({
            url: OFFSCREEN_URL,
            reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
            justification: "Process captured tab audio with AudioWorklet"
        });
    }
}

function persistSessions() {
    const obj = {};
    for (const [tabId, data] of sessions) obj[tabId] = { control: data.control || {} };
    chrome.storage.local.set({ sessions: obj }).catch(() => { });
}

async function getStreamId(tabId) {
    let lastError = null;
    for (let i = 0; i < 3; i++) {
        try {
            const id = await new Promise((resolve, reject) => {
                chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
                    const err = chrome.runtime.lastError;
                    if (err || !streamId) reject(new Error(err?.message || "no stream id"));
                    else resolve(streamId);
                });
            });
            return id;
        } catch (e) {
            lastError = e;
            await new Promise(r => setTimeout(r, 200 * (i + 1)));
        }
    }
    console.warn("[bg] getMediaStreamId failed", lastError?.message || lastError);
    return null;
}

async function startCapture(tabId, options = {}, isResume = false) {
    try {
        await ensureOffscreen();
        const streamId = await getStreamId(tabId);
        if (!streamId) {
            sendToPopup({ type: "STATUS", tabId, value: "idle" });
            return;
        }

        if (options.control?.muteTabAudio) updateTabMute(tabId, true);

        sessions.set(tabId, { control: options.control || {}, mutedTab: !!options.control?.muteTabAudio });
        persistSessions();

        sendToOffscreen({ type: "OFFSCREEN_START", tabId, streamId, options });
        if (!isResume) sendToPopup({ type: "STATUS", tabId, value: "starting" });
    } catch (e) {
        console.error("[bg] startCapture error", e);
        sendToPopup({ type: "STATUS", tabId, value: "idle" });
    }
}

async function stopCapture(tabId) {
    sendToOffscreen({ type: "OFFSCREEN_STOP", tabId });
    const data = sessions.get(tabId);
    if (data?.mutedTab) updateTabMute(tabId, false);
    sessions.delete(tabId);
    persistSessions();
    sendToPopup({ type: "STATUS", tabId, value: "idle" });
}

function updateTabMute(tabId, muted) {
    try { chrome.tabs.update(tabId, { muted }); } catch { }
}
