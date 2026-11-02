import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Square } from "lucide-react";
import { JarvisAudioSession, type LiveState } from "./lib/audio";
import { JarvisCoreCanvas } from "./components/JarvisCoreCanvas";
import type { JarvisState } from "./utils/jarvisEngine";
import { runOfflineCommand } from "./lib/offlineCommands";

function toRingState(live: LiveState, activity: "idle" | "thinking" | "executing" | "error"): JarvisState {
  if (live === "speaking") return "speaking";
  if (activity === "executing") return "executing";
  if (activity === "thinking" || live === "connecting") return "thinking";
  if (activity === "error") return "error";
  return live === "listening" ? "listening" : "idle";
}

export default function App() {
  const sessionRef = useRef<JarvisAudioSession | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const playbackAnalyserRef = useRef<AnalyserNode | null>(null);
  const [liveState, setLiveState] = useState<LiveState>("disconnected");
  const [isMuted, setIsMuted] = useState(false);
  const [activity, setActivity] = useState<"idle" | "thinking" | "executing" | "error">("idle");
  const [reducedMotion, setReducedMotion] = useState(false);

  const speakLocally = (text: string) => {
    const session = sessionRef.current;
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    session?.setPresentationState("speaking");
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.12;
    utterance.onend = () => session?.setPresentationState("listening");
    utterance.onerror = () => session?.setPresentationState("listening");
    window.speechSynthesis.speak(utterance);
  };

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(preference.matches);
    update();
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const session = new JarvisAudioSession({
      onStateChange: (next) => {
        setLiveState(next);
        micAnalyserRef.current = session.inputAnalyser;
        playbackAnalyserRef.current = session.outputAnalyser;
        if (next === "listening" || next === "disconnected") setActivity("idle");
        if (next === "disconnected") setIsMuted(false);
      },
      onTranscription: () => {},
      onFallbackTranscript: async (transcript) => {
        setActivity("thinking");
        const response = await runOfflineCommand(transcript);
        setActivity("idle");
        speakLocally(response);
      },
      onToolCall: async (name, args, callback) => {
        setActivity("executing");
        try {
          const response = await fetch("/api/system/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: name, args: args ?? {} }),
          });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error || "The operation could not be completed.");
          callback({ result: payload.result, verification: payload.verification, operationId: payload.operationId });
          setActivity("idle");
        } catch (error) {
          callback({ error: error instanceof Error ? error.message : "The operation failed." });
          setActivity("error");
          window.setTimeout(() => setActivity("idle"), 1400);
        }
      },
      onError: () => {
        setActivity("error");
        speakLocally("JARVIS could not start the voice service. I am ready for basic local voice commands when browser speech recognition is available.");
        window.setTimeout(() => setActivity("idle"), 1400);
      },
    });
    sessionRef.current = session;
    return () => session.disconnect();
  }, []);

  const speak = async () => {
    const session = sessionRef.current;
    if (!session) return;

    // While JARVIS is replying, this single control becomes a terminate action.
    // Listening resumes afterwards, preserving the user's current mute choice.
    if (liveState === "speaking") {
      window.speechSynthesis?.cancel();
      session.interrupt();
      session.setPresentationState("listening");
      return;
    }

    if (liveState === "disconnected") {
      setActivity("thinking");
      await session.connect();
      return;
    }

    const nextMuted = !session.isMicrophoneMuted();
    if (session.setMicrophoneMuted(nextMuted)) {
      setIsMuted(nextMuted);
    }
  };

  const cancel = () => {
    sessionRef.current?.cancel();
    setActivity("idle");
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
      if (event.key === " " && event.target === document.body) {
        event.preventDefault();
        void speak();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const ringState = toRingState(liveState, activity);
  const isActive = liveState !== "disconnected";
  const microphoneLabel = !isActive
    ? "Start a voice session with JARVIS"
    : liveState === "speaking"
      ? "Stop JARVIS response"
    : isMuted
      ? "Unmute microphone"
      : "Mute microphone";
  return (
    <main className="jarvis-shell">
      <div className="jarvis-ambient" aria-hidden="true" />
      <JarvisCoreCanvas state={ringState} reducedMotion={reducedMotion} micAnalyserRef={micAnalyserRef} playbackAnalyserRef={playbackAnalyserRef} onRingClick={() => void speak()} />
      <button type="button" className={`jarvis-speak ${isActive ? "jarvis-speak--active" : ""} ${isMuted && liveState !== "speaking" ? "jarvis-speak--muted" : ""}`} onClick={() => void speak()} onContextMenu={(event) => { event.preventDefault(); cancel(); }} aria-label={microphoneLabel} aria-pressed={liveState !== "speaking" && isActive ? !isMuted : undefined} title={`${microphoneLabel}. Press Escape to cancel.`}>
        {liveState === "speaking" ? <Square size={21} fill="currentColor" /> : isMuted ? <MicOff size={25} /> : <Mic size={25} />}
      </button>
    </main>
  );
}
