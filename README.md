# **Real-Time AI Stream Audio Control (Chrome Extension)**



##### Overview



Stream Audio Control is an experimental Chrome extension exploring real-time AI audio processing directly inside the browser.



The project focuses on identifying and eventually isolating voice and background audio streams from live tab audio while maintaining low latency and smooth playback. The current implementation demonstrates working detection and visualization of audio signal classification, with ongoing development toward full separation and independent control of audio layers.



This project explores how AI processing can operate inside real user environments (browsers and local machines) rather than isolated notebooks.



##### Current Capabilities



* Captures live tab audio using Chrome tab capture APIs
* Processes audio through AudioWorklet pipeline
* Routes processing through ONNX/Web inference worker
* Detects and visualizes voice vs background signal activity
* Real-time visualization feedback
* Pass-through fallback to prevent playback lag
* Modular pipeline for future separation and control features



##### Status:

Working prototype — detection and visualization functioning

Separation accuracy improvements in progress



##### Architecture



###### Pipeline:



Tab Audio Capture

&nbsp;  ↓

AudioWorklet (buffer + preprocessing)

&nbsp;  ↓

Worker Thread (ONNX Runtime Web / WebGPU / WASM)

&nbsp;  ↓

Detection + Visualization

&nbsp;  ↓

Audio Output (pass-through or processed)





###### Design goals:



* Sub-100ms latency target
* Browser-safe real-time processing
* GPU/WebGPU acceleration where available
* Automatic fallback if performance drops
* Expandable to remote inference or hybrid processing



#### Technical Features



###### Real-Time Audio Pipeline



* AudioWorklet-based processing
* Configurable block sizes and hop length
* Low-latency buffering strategy



###### AI Inference Layer



* ONNX Runtime Web integration
* WebGPU acceleration when available
* WASM fallback for compatibility
* Designed for quantized local models



###### Performance Safeguards



* Automatic pass-through if lag detected
* Modular worker architecture
* Optional WebSocket offload for remote inference



##### Experimental Features



* Voice detection focus
* Background/music downmix exploration
* Early diarization-lite detection logic
* Multi-iteration pipeline testing across forks
* Local vs browser inference experimentation



##### Installation



1. Clone or download this repository
2. Open Chrome → Extensions
3. Enable Developer Mode
4. Click Load Unpacked
5. Select project folder
6. Open any tab with audio
7. Click extension → Start for this tab



##### Model Usage



Place a quantized ONNX model next to:



*/workers/separationWorker.js*





Or configure local model URL inside worker file.



##### Project Direction



* This project explores:
* Real-time AI inside browser constraints
* Low-latency inference pipelines
* Practical deployment of AI tools
* GPU vs WASM tradeoffs
* Moving AI from demos to usable tools



##### Next Steps



* Improve separation accuracy
* Independent voice/background volume control
* GPU/local hybrid processing
* Multi-speaker differentiation
* Performance optimization for consumer hardware
