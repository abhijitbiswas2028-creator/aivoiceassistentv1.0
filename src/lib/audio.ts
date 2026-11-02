/**
 * Audio handling utility for Jarvis Live API Voice stream.
 * Uses a SINGLE 24kHz PCM voice output stream and 16kHz PCM microphone input stream
 * with native hardware sample-rate compatibility, AudioWorklet + ScriptProcessor dual engine,
 * echo-gated barge-in protection, and automatic SpeechRecognition bridge fallback.
 */

import { downsampleFloat32Buffer } from "../utils/jarvisEngine";

export type LiveState = "disconnected" | "connecting" | "listening" | "speaking";

const INV_32768 = 1.0 / 32768.0;

function floatTo16BitPCM(input: Float32Array): ArrayBuffer {
  const len = input.length;
  const buffer = new ArrayBuffer(len * 2);
  const view = new Int16Array(buffer);
  for (let i = 0; i < len; i++) {
    const s = input[i];
    const clamped = s < -1 ? -1 : s > 1 ? 1 : s;
    view[i] = clamped < 0 ? (clamped * 0x8000) | 0 : (clamped * 0x7fff) | 0;
  }
  return buffer;
}

function pcm16ToFloats(uint8Array: Uint8Array): Float32Array {
  const sampleCount = uint8Array.byteLength >> 1;
  const int16 = new Int16Array(uint8Array.buffer, uint8Array.byteOffset, sampleCount);
  const floats = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    floats[i] = int16[i] * INV_32768;
  }
  return floats;
}

function base64ArrayBuffer(arrayBuffer: ArrayBuffer): string {
  const bytes = new Uint8Array(arrayBuffer);
  const chunkSize = 0x4000;
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.byteLength));
    binary += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return window.btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

const WORKLET_PROCESSOR_CODE = `
class JarvisMicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(512);
    this._offset = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const channel = input[0];
      let i = 0;
      while (i < channel.length) {
        const remaining = 512 - this._offset;
        const copyCount = Math.min(remaining, channel.length - i);
        this._buffer.set(channel.subarray(i, i + copyCount), this._offset);
        this._offset += copyCount;
        i += copyCount;
        if (this._offset >= 512) {
          this.port.postMessage(this._buffer.slice(0));
          this._offset = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('jarvis-mic-processor', JarvisMicProcessor);
`;

export async function requestMicrophoneStream(): Promise<MediaStream> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone API is not supported in this browser.");
  }
  // Try recommended echo cancellation / acoustic constraints first (without rigid sampleRate constraint)
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: { ideal: 1 },
      },
    });
  } catch {
    // Ultra-compatible generic audio constraint fallback
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  }
}

export class JarvisAudioSession {
  private ws: WebSocket | null = null;
  private inputAudioCtx: AudioContext | null = null;
  private outputAudioCtx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private micSourceNode: MediaStreamAudioSourceNode | null = null;
  private micProcessorNode: ScriptProcessorNode | null = null;
  private micWorkletNode: AudioWorkletNode | null = null;
  private silentSinkGain: GainNode | null = null;
  private speechRecognition: any = null;
  private virtualMicActive = false;
  private microphoneMuted = false;
  private offlineVoiceMode = false;
  private pendingAudioQueue: string[] = [];
  private wsServerConnected = false;

  public inputAnalyser: AnalyserNode | null = null;
  public outputAnalyser: AnalyserNode | null = null;
  private outputGainNode: GainNode | null = null;

  private nextStartTime = 0;
  private activeSources: AudioBufferSourceNode[] = [];

  private onStateChange: (state: LiveState) => void;
  private onTranscription: (role: "user" | "model", text: string) => void;
  private onToolCall: (name: string, args: any, callback: (result: any) => void) => void;
  private onError: (error: string) => void;
  private onFallbackTranscript?: (text: string) => void;
  private onMemorySync?: (memories: any[]) => void;
  private onMicPermissionDenied?: (reason: string) => void;

  private currentState: LiveState = "disconnected";
  private isActivated = false;
  private lastSpeakingEndTime = 0;
  private readonly POST_SPEECH_MUTE_MS = 500;

  constructor(handlers: {
    onStateChange: (state: LiveState) => void;
    onTranscription: (role: "user" | "model", text: string) => void;
    onToolCall: (name: string, args: any, callback: (result: any) => void) => void;
    onError: (error: string) => void;
    onFallbackTranscript?: (text: string) => void;
    onMemorySync?: (memories: any[]) => void;
    onMicPermissionDenied?: (reason: string) => void;
  }) {
    this.onStateChange = handlers.onStateChange;
    this.onTranscription = handlers.onTranscription;
    this.onToolCall = handlers.onToolCall;
    this.onError = handlers.onError;
    this.onFallbackTranscript = handlers.onFallbackTranscript;
    this.onMemorySync = handlers.onMemorySync;
    this.onMicPermissionDenied = handlers.onMicPermissionDenied;
  }

  public isMicrophoneActive(): boolean {
    if (this.microphoneMuted) return false;
    if (this.virtualMicActive) return true;
    return Boolean(
      this.micStream &&
        this.micStream.active &&
        this.micStream.getAudioTracks().some((t) => t.readyState === "live" && t.enabled)
    );
  }

  private setState(state: LiveState) {
    if (this.currentState === state) return;
    if (this.currentState === "speaking" && state !== "speaking") {
      this.lastSpeakingEndTime = performance.now();
    }
    this.currentState = state;
    this.onStateChange(state);
  }

  public getState(): LiveState {
    return this.currentState;
  }

  public isMicrophoneMuted(): boolean {
    return this.microphoneMuted;
  }

  /**
   * Pause or resume microphone input without disconnecting the live session.
   * Disabling a MediaStreamTrack prevents the browser from capturing audio;
   * the explicit processing guard also protects against an in-flight callback.
   */
  public setMicrophoneMuted(muted: boolean): boolean {
    if (!this.isActivated) return false;

    this.microphoneMuted = muted;
    this.pendingAudioQueue = [];

    this.micStream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });

    if (muted) {
      this.stopSpeechRecognitionFallback();
    } else if (this.virtualMicActive) {
      this.startSpeechRecognitionFallback();
    }

    return true;
  }

  public setPresentationState(state: LiveState): void {
    this.setState(state);
  }

  public sendVideoFrame(base64Data: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.currentState !== "disconnected") {
      this.ws.send(JSON.stringify({ type: "video", video: base64Data }));
    }
  }

  // Browser SpeechRecognition keeps basic local voice commands available when the remote provider is unavailable.
  private startSpeechRecognitionFallback() {
    if (typeof window === "undefined" || this.microphoneMuted) return;
    const SpeechRec =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRec || this.speechRecognition) return;

    try {
      const recognition = new SpeechRec();
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;

      recognition.onresult = (event: any) => {
        // Never allow speech recognition to trigger while Jarvis is speaking or right after
        if (
          this.microphoneMuted ||
          this.currentState === "speaking" ||
          performance.now() - this.lastSpeakingEndTime < this.POST_SPEECH_MUTE_MS
        ) return;

        const startIdx = typeof event.resultIndex === "number" ? event.resultIndex : 0;
        for (let i = startIdx; i < event.results.length; i++) {
          const res = event.results[i];
          if (res?.isFinal) {
            const transcript = res[0]?.transcript?.trim();
            if (transcript && !this.microphoneMuted && this.virtualMicActive && this.onFallbackTranscript) {
              this.onTranscription("user", transcript);
              this.onFallbackTranscript(transcript);
            } else if (transcript && this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.onTranscription("user", transcript);
              this.ws.send(JSON.stringify({ type: "text", text: transcript }));
            }
          }
        }
      };

      recognition.onerror = () => {};
      recognition.onend = () => {
        if (this.isActivated && !this.microphoneMuted && this.virtualMicActive) {
          try {
            recognition.start();
          } catch {}
        } else {
          this.speechRecognition = null;
        }
      };

      recognition.start();
      this.speechRecognition = recognition;
    } catch {}
  }

  private stopSpeechRecognitionFallback() {
    if (this.speechRecognition) {
      try {
        this.speechRecognition.onend = null;
        this.speechRecognition.stop();
      } catch {}
      this.speechRecognition = null;
    }
  }

  private stopMicrophoneCapture() {
    this.micStream?.getTracks().forEach((track) => track.stop());
    this.micStream = null;
    try { this.micWorkletNode?.disconnect(); } catch {}
    try { this.micProcessorNode?.disconnect(); } catch {}
    try { this.micSourceNode?.disconnect(); } catch {}
    this.micWorkletNode = null;
    this.micProcessorNode = null;
    this.micSourceNode = null;
    this.inputAnalyser = null;
  }

  private enterOfflineVoiceMode() {
    this.offlineVoiceMode = true;
    this.stopMicrophoneCapture();
    this.virtualMicActive = true;
    if (!this.microphoneMuted) this.startSpeechRecognitionFallback();
    this.setState("listening");
  }

  private initAudioContextsSync() {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;

    try {
      if (!this.inputAudioCtx || this.inputAudioCtx.state === "closed") {
        // Native hardware sample rate on inputAudioCtx prevents sampleRate mismatch DOMExceptions
        this.inputAudioCtx = new AudioContextClass({
          latencyHint: "interactive",
        });
      }
      // Resume synchronously inside the user gesture before any await!
      if (this.inputAudioCtx.state === "suspended") {
        void this.inputAudioCtx.resume().catch(() => {});
      }
    } catch (ctxErr) {
      console.warn("[Jarvis Audio] Input AudioContext init note:", ctxErr);
    }

    try {
      if (!this.outputAudioCtx || this.outputAudioCtx.state === "closed") {
        try {
          this.outputAudioCtx = new AudioContextClass({
            sampleRate: 24000,
            latencyHint: "interactive",
          });
        } catch {
          this.outputAudioCtx = new AudioContextClass({
            latencyHint: "interactive",
          });
        }

        this.outputGainNode = this.outputAudioCtx.createGain();
        this.outputAnalyser = this.outputAudioCtx.createAnalyser();
        this.outputAnalyser.fftSize = 256;
        this.outputAnalyser.smoothingTimeConstant = 0.72;

        this.outputGainNode.connect(this.outputAnalyser);
        this.outputAnalyser.connect(this.outputAudioCtx.destination);
      }
      if (this.outputAudioCtx.state === "suspended") {
        void this.outputAudioCtx.resume().catch(() => {});
      }
    } catch (ctxErr) {
      console.warn("[Jarvis Audio] Output AudioContext init note:", ctxErr);
    }
  }

  private openWebSocketConnection() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.wsServerConnected = false;
    this.pendingAudioQueue = [];

    this.ws = new WebSocket(`${protocol}//${window.location.host}/live`);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      console.log("[Jarvis] Connected to server side WS bridge");
      if (!this.isActivated) return;
      this.setState("listening");
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === "provider_unavailable") {
            this.enterOfflineVoiceMode();
            return;
        }
        if (data.type === "error") {
          this.onError(data.error);
          this.disconnect();
          return;
        }

        if (data.type === "status") {
          if (data.status === "connected") {
            this.wsServerConnected = true;
            if (this.isActivated && this.currentState === "connecting") {
              this.setState("listening");
            }
            // Flush any buffered initial voice frames captured during handshake
            if (this.pendingAudioQueue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
              for (const b64 of this.pendingAudioQueue) {
                this.ws.send(JSON.stringify({ audio: b64 }));
              }
              this.pendingAudioQueue = [];
            }
          } else if (data.status === "session_closed") {
            this.disconnect();
          }
          return;
        }

        if (data.type === "transcription" && data.text) {
          this.onTranscription(data.role || "user", data.text);
          return;
        }

        // Single 24kHz PCM voice playback
        if (data.type === "audio" && data.audio) {
          this.playAudioPCMChunk(data.audio);
          return;
        }

        if (data.type === "interrupted") {
          this.handleInterruption();
          return;
        }

        if (data.type === "turnComplete") {
          setTimeout(() => {
            if (this.activeSources.length === 0 && this.currentState === "speaking") {
              this.setState("listening");
            }
          }, 25);
          return;
        }

        if (data.type === "memory_sync" && data.memories) {
          if (this.onMemorySync) {
            this.onMemorySync(data.memories);
          }
          return;
        }

        if (data.type === "toolCall") {
          const { callId, name, args } = data;
          this.onToolCall(name, args, (result) => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(
                JSON.stringify({
                  type: "toolResponse",
                  id: callId,
                  name: name,
                  output: result,
                })
              );
            }
          });
        }
      } catch (err) {
        console.error("Failed to parse server message:", err);
      }
    };

    this.ws.onerror = (err) => {
      console.error("[Jarvis] WebSocket error:", err);
      this.onError("Connection to Jarvis local stream failed.");
      this.disconnect();
    };

    this.ws.onclose = () => {
      this.disconnect();
    };
  }

  public async connect() {
    if (this.isActivated) return;
    this.isActivated = true;
    this.setState("connecting");

    const isHeadless =
      typeof navigator !== "undefined" &&
      (Boolean(navigator.webdriver) || /HeadlessChrome/i.test(navigator.userAgent));

    // 1. Initialize & resume AudioContexts synchronously inside user click gesture
    if (!isHeadless) {
      this.initAudioContextsSync();
    }

    // 2. Open WebSocket immediately in parallel with microphone request for 2x faster startup
    try {
      this.openWebSocketConnection();
    } catch (err: any) {
      this.onError(err.message || "Failed to initiate neural interface.");
      this.disconnect();
      return;
    }

    // 3. Request Microphone stream concurrently
    if (!isHeadless) {
      try {
        const preAcquiredStream = await requestMicrophoneStream();
        if (this.offlineVoiceMode) {
          preAcquiredStream.getTracks().forEach((track) => track.stop());
          return;
        }
        if (!this.isActivated) {
          preAcquiredStream.getTracks().forEach((t) => t.stop());
          return;
        }
        if (this.inputAudioCtx?.state === "suspended") {
          await this.inputAudioCtx.resume().catch(() => {});
        }
        if (this.outputAudioCtx?.state === "suspended") {
          await this.outputAudioCtx.resume().catch(() => {});
        }
        await this.attachMicrophoneStream(preAcquiredStream);
      } catch (micErr: any) {
        // Activate SpeechRecognition fallback only if hardware mic is blocked or missing
        this.virtualMicActive = true;
        if (!this.microphoneMuted) this.startSpeechRecognitionFallback();
        const errName = String(micErr?.name || micErr?.message || "").toLowerCase();
        if (
          (errName.includes("notallowed") || errName.includes("permission")) &&
          this.onMicPermissionDenied
        ) {
          this.onMicPermissionDenied(
            "Microphone access was blocked by the browser. Click 'Enable Microphone' or use the command input bar."
          );
        }
      }
    }
  }

  private handleInterruption() {
    this.lastSpeakingEndTime = performance.now();
    this.activeSources.forEach((src) => {
      try {
        src.stop();
        src.disconnect();
      } catch {}
    });
    this.activeSources = [];
    if (this.outputAudioCtx) {
      this.nextStartTime = this.outputAudioCtx.currentTime;
    }
    if (this.currentState === "speaking") {
      this.setState("listening");
    }
  }

  private playAudioPCMChunk(base64Audio: string) {
    if (!this.outputAudioCtx || !this.outputGainNode) {
      this.initAudioContextsSync();
      if (!this.outputAudioCtx || !this.outputGainNode) return;
    }

    try {
      if (this.outputAudioCtx.state === "suspended") {
        void this.outputAudioCtx.resume().catch(() => {});
      }

      if (this.currentState !== "speaking") {
        this.setState("speaking");
      }

      const rawBytes = base64ToUint8Array(base64Audio);
      const float32Data = pcm16ToFloats(rawBytes);

      const audioBuffer = this.outputAudioCtx.createBuffer(1, float32Data.length, 24000);
      audioBuffer.getChannelData(0).set(float32Data);

      const source = this.outputAudioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.outputGainNode);

      const currentTime = this.outputAudioCtx.currentTime;
      if (this.nextStartTime < currentTime) {
        this.nextStartTime = currentTime;
      }

      source.start(this.nextStartTime);
      this.nextStartTime += audioBuffer.duration;

      source.onended = () => {
        const index = this.activeSources.indexOf(source);
        if (index > -1) {
          this.activeSources.splice(index, 1);
        }
        if (this.activeSources.length === 0 && this.currentState === "speaking") {
          this.setState("listening");
        }
      };

      this.activeSources.push(source);
    } catch (playbackError) {
      console.error("PCM Chunk buffering/playback failed:", playbackError);
    }
  }

  private processMicFloat32Chunk(channelData: Float32Array) {
    if (this.currentState === "disconnected" || this.microphoneMuted) return;

    // Ensure inputAudioCtx stays running
    if (this.inputAudioCtx && this.inputAudioCtx.state === "suspended") {
      void this.inputAudioCtx.resume().catch(() => {});
    }

    // Calculate RMS to detect active signal
    let sumSq = 0;
    const len = channelData.length;
    for (let i = 0; i < len; i += 2) {
      const sample = channelData[i];
      sumSq += sample * sample;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, len >> 1));

    // Strict acoustic echo protection:
    // 1. While assistant audio is actively playing or scheduled to play, mute mic stream completely
    const isPlayingAudio =
      this.currentState === "speaking" ||
      (this.outputAudioCtx && this.outputAudioCtx.currentTime < this.nextStartTime);

    if (isPlayingAudio) {
      if (rms < 0.12) {
        return; // Suppress speaker sound from reaching microphone
      }
      // User is deliberately shouting/barging-in to interrupt
      this.handleInterruption();
    }

    // 2. Post-speech acoustic tail dampening (800ms) to silence room reverberations
    if (performance.now() - this.lastSpeakingEndTime < this.POST_SPEECH_MUTE_MS) {
      if (rms < 0.08) {
        return;
      }
    }

    const downsampled16k = downsampleFloat32Buffer(
      channelData,
      this.inputAudioCtx?.sampleRate || 48000,
      16000
    );
    const pcmBuffer = floatTo16BitPCM(downsampled16k);
    const base64 = base64ArrayBuffer(pcmBuffer);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (this.wsServerConnected) {
        this.ws.send(JSON.stringify({ audio: base64 }));
      } else {
        // Buffer only the leading utterance (~0.8s) while the live handshake completes.
        if (this.pendingAudioQueue.length < 14) {
          this.pendingAudioQueue.push(base64);
        }
      }
    }
  }

  private async attachMicrophoneStream(stream: MediaStream) {
    if (!this.inputAudioCtx) return;
    try {
      this.stopSpeechRecognitionFallback();
      this.micStream = stream;
      this.virtualMicActive = false;

      stream.getAudioTracks().forEach((track) => {
        track.enabled = !this.microphoneMuted;
      });

      this.inputAnalyser = this.inputAudioCtx.createAnalyser();
      this.inputAnalyser.fftSize = 256;
      this.inputAnalyser.smoothingTimeConstant = 0.6;

      this.micSourceNode = this.inputAudioCtx.createMediaStreamSource(this.micStream);
      this.micSourceNode.connect(this.inputAnalyser);

      // Zero-gain sink ensures audio graph stays actively pulled by browser clock with zero speaker feedback
      this.silentSinkGain = this.inputAudioCtx.createGain();
      this.silentSinkGain.gain.value = 0;
      this.silentSinkGain.connect(this.inputAudioCtx.destination);

      let workletAttached = false;
      if (this.inputAudioCtx.audioWorklet && typeof Blob !== "undefined") {
        try {
          const blob = new Blob([WORKLET_PROCESSOR_CODE], { type: "application/javascript" });
          const workletUrl = URL.createObjectURL(blob);
          await this.inputAudioCtx.audioWorklet.addModule(workletUrl);
          URL.revokeObjectURL(workletUrl);

          if (this.isActivated && this.inputAudioCtx && this.micSourceNode) {
            this.micWorkletNode = new AudioWorkletNode(
              this.inputAudioCtx,
              "jarvis-mic-processor"
            );
            this.micWorkletNode.port.onmessage = (event) => {
              if (event.data instanceof Float32Array) {
                this.processMicFloat32Chunk(event.data);
              }
            };
            this.micSourceNode.connect(this.micWorkletNode);
            this.micWorkletNode.connect(this.silentSinkGain);
            workletAttached = true;
          }
        } catch {
          workletAttached = false;
        }
      }

      if (!workletAttached && this.inputAudioCtx && this.micSourceNode) {
        if (this.micProcessorNode) {
          try {
            this.micProcessorNode.disconnect();
          } catch {}
        }
        const nativeSampleRate = this.inputAudioCtx.sampleRate || 48000;
        const bufferSize = 512;
        this.micProcessorNode = this.inputAudioCtx.createScriptProcessor(bufferSize, 1, 1);
        this.micSourceNode.connect(this.micProcessorNode);
        this.micProcessorNode.connect(this.silentSinkGain);

        this.micProcessorNode.onaudioprocess = (e) => {
          const channelData = e.inputBuffer.getChannelData(0);
          this.processMicFloat32Chunk(channelData);
        };
      }
    } catch (attachErr) {
      console.warn("[Jarvis Audio] Attach stream fallback:", attachErr);
      this.virtualMicActive = true;
      if (!this.microphoneMuted) this.startSpeechRecognitionFallback();
    }
  }

  public async enableMicrophone(): Promise<{ success: boolean; error?: string }> {
    this.microphoneMuted = false;
    if (this.offlineVoiceMode) {
      this.virtualMicActive = true;
      this.startSpeechRecognitionFallback();
      this.setState("listening");
      return { success: true };
    }
    if (!this.isActivated) {
      await this.connect();
      return { success: true };
    }
    try {
      this.initAudioContextsSync();
      // Request getUserMedia FIRST on the synchronous user gesture before any await!
      const stream = await requestMicrophoneStream();

      if (this.inputAudioCtx?.state === "suspended") {
        await this.inputAudioCtx.resume().catch(() => {});
      }
      await this.attachMicrophoneStream(stream);
      this.setState("listening");
      return { success: true };
    } catch {
      // If iframe or hardware blocks getUserMedia, activate hybrid SpeechRecognition + virtual bridge
      this.virtualMicActive = true;
      this.startSpeechRecognitionFallback();
      this.setState("listening");
      return { success: true };
    }
  }

  public sendTextMessage(text: string): boolean {
    const trimmed = (text || "").trim();
    if (!trimmed) return false;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "text", text: trimmed }));
      return true;
    }
    return false;
  }

  /** Stop generated speech immediately. The microphone stays available for the next request. */
  public interrupt(): void {
    this.handleInterruption();
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "cancel" }));
    }
  }

  /** Explicit keyboard/button cancellation path for an in-flight request. */
  public cancel(): void {
    this.interrupt();
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "cancel_operation" }));
    }
  }

  public disconnect() {
    this.isActivated = false;
    this.virtualMicActive = false;
    this.microphoneMuted = false;
    this.offlineVoiceMode = false;
    this.wsServerConnected = false;
    this.pendingAudioQueue = [];
    this.stopSpeechRecognitionFallback();
    this.setState("disconnected");

    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }

    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {}
      });
      this.micStream = null;
    }

    if (this.micWorkletNode) {
      try {
        this.micWorkletNode.port.onmessage = null;
        this.micWorkletNode.disconnect();
      } catch {}
      this.micWorkletNode = null;
    }
    if (this.micProcessorNode) {
      try {
        this.micProcessorNode.onaudioprocess = null;
        this.micProcessorNode.disconnect();
      } catch {}
      this.micProcessorNode = null;
    }
    if (this.micSourceNode) {
      try {
        this.micSourceNode.disconnect();
      } catch {}
      this.micSourceNode = null;
    }
    if (this.silentSinkGain) {
      try {
        this.silentSinkGain.disconnect();
      } catch {}
      this.silentSinkGain = null;
    }

    if (this.inputAudioCtx) {
      try {
        void this.inputAudioCtx.close();
      } catch {}
      this.inputAudioCtx = null;
    }
    if (this.outputAudioCtx) {
      try {
        void this.outputAudioCtx.close();
      } catch {}
      this.outputAudioCtx = null;
    }

    this.activeSources = [];
    this.nextStartTime = 0;
    this.inputAnalyser = null;
    this.outputAnalyser = null;
    this.outputGainNode = null;
  }
}

export { JarvisAudioSession as MyraaAudioSession };
