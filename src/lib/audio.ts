/**
 * Audio handling utility for Jarvis Live API Voice stream.
 * Uses a SINGLE 24kHz PCM voice output stream and 16kHz PCM microphone input stream
 * with native hardware sample-rate compatibility and automatic SpeechRecognition bridge fallback.
 */

import { downsampleFloat32Buffer } from "../utils/jarvisEngine";

export type LiveState = "disconnected" | "connecting" | "listening" | "speaking";

function floatTo16BitPCM(input: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < input.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

function pcm16ToFloats(uint8Array: Uint8Array): Float32Array {
  const int16 = new Int16Array(
    uint8Array.buffer,
    uint8Array.byteOffset,
    uint8Array.byteLength / 2
  );
  const floats = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    floats[i] = int16[i] / 32768.0;
  }
  return floats;
}

function base64ArrayBuffer(arrayBuffer: ArrayBuffer): string {
  const bytes = new Uint8Array(arrayBuffer);
  const chunkSize = 0x2000;
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
  private speechRecognition: any = null;
  private virtualMicActive = false;

  public inputAnalyser: AnalyserNode | null = null;
  public outputAnalyser: AnalyserNode | null = null;
  private outputGainNode: GainNode | null = null;

  private nextStartTime = 0;
  private activeSources: AudioBufferSourceNode[] = [];

  private onStateChange: (state: LiveState) => void;
  private onTranscription: (role: "user" | "model", text: string) => void;
  private onToolCall: (name: string, args: any, callback: (result: any) => void) => void;
  private onError: (error: string) => void;
  private onMemorySync?: (memories: any[]) => void;
  private onMicPermissionDenied?: (reason: string) => void;

  private currentState: LiveState = "disconnected";
  private isActivated = false;

  constructor(handlers: {
    onStateChange: (state: LiveState) => void;
    onTranscription: (role: "user" | "model", text: string) => void;
    onToolCall: (name: string, args: any, callback: (result: any) => void) => void;
    onError: (error: string) => void;
    onMemorySync?: (memories: any[]) => void;
    onMicPermissionDenied?: (reason: string) => void;
  }) {
    this.onStateChange = handlers.onStateChange;
    this.onTranscription = handlers.onTranscription;
    this.onToolCall = handlers.onToolCall;
    this.onError = handlers.onError;
    this.onMemorySync = handlers.onMemorySync;
    this.onMicPermissionDenied = handlers.onMicPermissionDenied;
  }

  public isMicrophoneActive(): boolean {
    if (this.virtualMicActive) return true;
    return Boolean(
      this.micStream &&
        this.micStream.active &&
        this.micStream.getAudioTracks().some((t) => t.readyState === "live")
    );
  }

  private setState(state: LiveState) {
    this.currentState = state;
    this.onStateChange(state);
  }

  public getState(): LiveState {
    return this.currentState;
  }

  public sendVideoFrame(base64Data: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.currentState !== "disconnected") {
      this.ws.send(JSON.stringify({ type: "video", video: base64Data }));
    }
  }

  private startSpeechRecognitionFallback() {
    if (typeof window === "undefined") return;
    const SpeechRec =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRec || this.speechRecognition) return;

    try {
      const recognition = new SpeechRec();
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.onresult = (event: any) => {
        const lastIdx = event.results.length - 1;
        const transcript = event.results[lastIdx]?.[0]?.transcript?.trim();
        if (transcript && this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: "text", text: transcript }));
        }
      };
      recognition.onerror = () => {};
      recognition.onend = () => {
        if (this.isActivated && !this.micStream) {
          try {
            recognition.start();
          } catch {}
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

  public async connect() {
    if (this.isActivated) return;
    this.isActivated = true;
    this.setState("connecting");

    const isHeadless =
      typeof navigator !== "undefined" &&
      (Boolean(navigator.webdriver) || /HeadlessChrome/i.test(navigator.userAgent));

    // 1. Initialize AudioContexts and request Microphone IMMEDIATELY inside user click gesture!
    let preAcquiredStream: MediaStream | null = null;
    if (!isHeadless) {
      try {
        const AudioContextClass =
          window.AudioContext || (window as any).webkitAudioContext;
        if (AudioContextClass) {
          // Use native hardware sample rate on inputAudioCtx to prevent sampleRate mismatch DOMExceptions
          this.inputAudioCtx = new AudioContextClass({
            latencyHint: "interactive",
          });
          this.outputAudioCtx = new AudioContextClass({
            sampleRate: 24000,
            latencyHint: "interactive",
          });

          this.outputGainNode = this.outputAudioCtx.createGain();
          this.outputAnalyser = this.outputAudioCtx.createAnalyser();
          this.outputAnalyser.fftSize = 256;
          this.outputAnalyser.smoothingTimeConstant = 0.72;

          this.outputGainNode.connect(this.outputAnalyser);
          this.outputAnalyser.connect(this.outputAudioCtx.destination);
        }
      } catch (ctxErr) {
        console.warn("[Jarvis Audio] AudioContext init note:", ctxErr);
      }

      // Trigger getUserMedia synchronously from the click gesture before awaiting WebSocket
      try {
        preAcquiredStream = await requestMicrophoneStream();
      } catch {
        // Fallback to SpeechRecognition bridge and virtual mic stream without blocking the UI
        this.virtualMicActive = true;
        this.startSpeechRecognitionFallback();
      }

      if (this.inputAudioCtx?.state === "suspended") {
        await this.inputAudioCtx.resume().catch(() => {});
      }
      if (this.outputAudioCtx?.state === "suspended") {
        await this.outputAudioCtx.resume().catch(() => {});
      }

      if (preAcquiredStream && this.isActivated && this.inputAudioCtx) {
        this.attachMicrophoneStream(preAcquiredStream);
      }
    }

    // 2. Connect to server-side Gemini Live WebSocket bridge
    try {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      this.ws = new WebSocket(`${protocol}//${window.location.host}/live`);
      this.ws.binaryType = "arraybuffer";

      this.ws.onopen = async () => {
        console.log("[Jarvis] Connected to server side WS bridge");
        if (!this.isActivated) return;
        this.setState("listening");
      };

      this.ws.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === "error") {
            this.onError(data.error);
            this.disconnect();
            return;
          }

          if (data.type === "status") {
            if (data.status === "connected") {
              this.setState("listening");
            } else if (data.status === "session_closed") {
              this.disconnect();
            }
            return;
          }

          // Single 24kHz PCM voice playback
          if (data.type === "audio" && data.audio) {
            this.playAudioPCMChunk(data.audio);
          }

          if (data.type === "interrupted") {
            this.handleInterruption();
          }

          if (data.type === "turnComplete") {
            setTimeout(() => {
              if (this.activeSources.length === 0 && this.currentState === "speaking") {
                this.setState("listening");
              }
            }, 35);
          }

          if (data.type === "memory_sync" && data.memories) {
            if (this.onMemorySync) {
              this.onMemorySync(data.memories);
            }
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
    } catch (err: any) {
      this.onError(err.message || "Failed to initiate neural interface.");
      this.disconnect();
    }
  }

  private handleInterruption() {
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
    if (!this.outputAudioCtx || !this.outputGainNode) return;

    try {
      if (this.outputAudioCtx.state === "suspended") {
        this.outputAudioCtx.resume().catch(() => {});
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
        this.nextStartTime = currentTime + 0.015;
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

  private attachMicrophoneStream(stream: MediaStream) {
    if (!this.inputAudioCtx) return;
    try {
      this.stopSpeechRecognitionFallback();
      this.micStream = stream;
      this.virtualMicActive = false;

      this.inputAnalyser = this.inputAudioCtx.createAnalyser();
      this.inputAnalyser.fftSize = 256;
      this.inputAnalyser.smoothingTimeConstant = 0.65;

      this.micSourceNode = this.inputAudioCtx.createMediaStreamSource(this.micStream);
      this.micSourceNode.connect(this.inputAnalyser);

      if (this.micProcessorNode) {
        try {
          this.micProcessorNode.disconnect();
        } catch {}
      }

      const nativeSampleRate = this.inputAudioCtx.sampleRate || 48000;
      const bufferSize = nativeSampleRate > 24000 ? 2048 : 1024;
      this.micProcessorNode = this.inputAudioCtx.createScriptProcessor(bufferSize, 1, 1);
      this.micSourceNode.connect(this.micProcessorNode);
      this.micProcessorNode.connect(this.inputAudioCtx.destination);

      this.micProcessorNode.onaudioprocess = (e) => {
        if (this.currentState === "disconnected" || this.currentState === "connecting")
          return;

        const channelData = e.inputBuffer.getChannelData(0);
        const downsampled16k = downsampleFloat32Buffer(
          channelData,
          this.inputAudioCtx?.sampleRate || 48000,
          16000
        );
        const pcmBuffer = floatTo16BitPCM(downsampled16k);
        const base64 = base64ArrayBuffer(pcmBuffer);

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ audio: base64 }));
        }
      };
    } catch (attachErr) {
      console.warn("[Jarvis Audio] Attach stream fallback:", attachErr);
      this.virtualMicActive = true;
      this.startSpeechRecognitionFallback();
    }
  }

  public async enableMicrophone(): Promise<{ success: boolean; error?: string }> {
    if (!this.isActivated) {
      await this.connect();
      return { success: true };
    }
    try {
      // Request getUserMedia FIRST on the synchronous user gesture before any await!
      const stream = await requestMicrophoneStream();

      if (!this.inputAudioCtx) {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        this.inputAudioCtx = new AudioContextClass({
          latencyHint: "interactive",
        });
      }
      if (this.inputAudioCtx.state === "suspended") {
        await this.inputAudioCtx.resume().catch(() => {});
      }
      this.attachMicrophoneStream(stream);
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
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "text", text }));
      return true;
    }
    return false;
  }

  public disconnect() {
    this.isActivated = false;
    this.virtualMicActive = false;
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

    if (this.micProcessorNode) {
      try {
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

    if (this.inputAudioCtx) {
      try {
        this.inputAudioCtx.close();
      } catch {}
      this.inputAudioCtx = null;
    }
    if (this.outputAudioCtx) {
      try {
        this.outputAudioCtx.close();
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
