# Stream Audio Control (Extension Scaffold)

**Features**
- Tab capture → AudioWorklet → Worker(ORT Web) pipeline
- Voice Focus, Music Downmix, Diarization-lite toggle
- <100 ms target latency, pass-through fallback if GPU/WASM slow
- Optional WebSocket offload for remote model inference

**Install**
1. Copy files into a folder.
2. Load as an *Unpacked Extension* in Chrome (Developer mode).
3. Click extension → “Start for this tab.”

**Model**
Place a quantized ONNX model next to `workers/separationWorker.js` or serve from local URL.

**Performance**
- Use WebGPU where available; fallback to WASM.
- Keep blockSize = 512–1024, 50% hop.
- If lag detected → automatic pass-through for glitch-free playback.
