import { useState, useEffect, useRef } from "react";
import { JarvisAudioSession, LiveState } from "./lib/audio";
import { JarvisCoreVisualizer, JarvisEmotion } from "./components/MyraaCoreVisualizer";
import { BrowserAgent } from "./components/BrowserAgent";
import {
  Power,
  Volume2,
  Globe,
  Maximize2,
  Compass,
  CircleAlert,
  Mic,
  MicOff,
  X,
  Brain,
  Monitor,
  Play,
  Pause,
  Square,
  RefreshCw,
  Loader2,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { Memory, MemoryCategory } from "./lib/memoryTypes";
import { MemoryDashboard } from "./components/MemoryDashboard";

export default function App() {
  const [state, setState] = useState<LiveState>("disconnected");
  const [micPermissionNeeded, setMicPermissionNeeded] = useState<boolean>(false);
  const [isEnablingMic, setIsEnablingMic] = useState<boolean>(false);
  const [micStatusNote, setMicStatusNote] = useState<string | null>(null);

  // Auto-listen for browser permission changes (e.g. user toggles allow in address bar)
  useEffect(() => {
    if (typeof navigator !== "undefined" && navigator.permissions?.query) {
      navigator.permissions
        .query({ name: "microphone" as PermissionName })
        .then((permissionStatus) => {
          permissionStatus.onchange = () => {
            if (permissionStatus.state === "granted") {
              setMicPermissionNeeded(false);
              setMicStatusNote(null);
              void sessionRef.current?.enableMicrophone();
            }
          };
        })
        .catch(() => {});
    }
  }, []);

  // Real-time Screen Sharing states
  const [isScreenSharing, setIsScreenSharing] = useState<boolean>(false);
  const [isScreenSharingPaused, setIsScreenSharingPaused] = useState<boolean>(false);
  const [screenVisionMode, setScreenVisionMode] = useState<boolean>(true);

  const screenStreamRef = useRef<MediaStream | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const screenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const screenIntervalRef = useRef<any>(null);
  const isPausedRef = useRef<boolean>(false);
  const screenVisionRef = useRef<boolean>(true);
  const stateRef = useRef<LiveState>("disconnected");

  useEffect(() => {
    isPausedRef.current = isScreenSharingPaused;
  }, [isScreenSharingPaused]);

  useEffect(() => {
    screenVisionRef.current = screenVisionMode;
  }, [screenVisionMode]);

  useEffect(() => {
    stateRef.current = state;
    document.body.setAttribute("data-jarvis-state", state);
  }, [state]);

  useEffect(() => {
    return () => {
      if (screenIntervalRef.current) {
        clearInterval(screenIntervalRef.current);
      }
    };
  }, []);

  const [activeEmotion, setActiveEmotion] = useState<JarvisEmotion>("idle");
  const [themeColor, setThemeColor] = useState<string>("charcoal");
  const [characterState, setCharacterState] = useState<"idle" | "thinking" | "talking">("idle");
  const [activeProjectorUrl, setActiveProjectorUrl] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState<boolean>(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  // Jarvis Autopilot system controller state
  const [browserTrigger, setBrowserTrigger] = useState<{
    type: string;
    args: any;
    id: string;
    callback: (res: any) => void;
  } | null>(null);

  // Jarvis recollections database core state
  const [memories, setMemories] = useState<Memory[]>([]);
  const [showMemoryDashboard, setShowMemoryDashboard] = useState<boolean>(false);

  const sessionRef = useRef<JarvisAudioSession | null>(null);

  const captureFrameAndSend = () => {
    const video = screenVideoRef.current;
    if (!video || isPausedRef.current || !screenVisionRef.current) {
      return;
    }
    if (stateRef.current === "disconnected") {
      return;
    }

    try {
      if (video.videoWidth === 0 || video.videoHeight === 0) return;

      if (!screenCanvasRef.current) {
        screenCanvasRef.current = document.createElement("canvas");
      }
      const canvas = screenCanvasRef.current;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const maxDim = 960;
      let width = video.videoWidth;
      let height = video.videoHeight;

      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }

      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(video, 0, 0, width, height);

      const dataUrl = canvas.toDataURL("image/jpeg", 0.55);
      const base64 = dataUrl.split(",")[1];

      if (sessionRef.current) {
        sessionRef.current.sendVideoFrame(base64);
      }
    } catch (err) {
      console.error("[Screen Capture] Failed drawing frame to canvas:", err);
    }
  };

  const startScreenSharing = async () => {
    setErrorText(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 5 },
        },
        audio: false,
      });

      screenStreamRef.current = stream;

      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      video.play().catch((e) => console.error("Video play warning:", e));
      screenVideoRef.current = video;

      setIsScreenSharing(true);
      setIsScreenSharingPaused(false);

      stream.getVideoTracks()[0].onended = () => {
        stopScreenSharing();
      };

      if (screenIntervalRef.current) {
        clearInterval(screenIntervalRef.current);
      }
      screenIntervalRef.current = setInterval(() => {
        captureFrameAndSend();
      }, 2000);

      setTimeout(() => {
        captureFrameAndSend();
      }, 500);
    } catch (e: any) {
      console.error("Screen sharing permission declined or missing API:", e);
      if (e.name !== "NotAllowedError") {
        setErrorText(`Could not capture screen: ${e.message || e}`);
      }
    }
  };

  const stopScreenSharing = () => {
    if (screenIntervalRef.current) {
      clearInterval(screenIntervalRef.current);
      screenIntervalRef.current = null;
    }
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {}
      });
      screenStreamRef.current = null;
    }
    if (screenVideoRef.current) {
      screenVideoRef.current.pause();
      screenVideoRef.current = null;
    }
    setIsScreenSharing(false);
    setIsScreenSharingPaused(false);
  };

  const pauseScreenSharing = () => {
    setIsScreenSharingPaused(true);
  };

  const resumeScreenSharing = () => {
    setIsScreenSharingPaused(false);
    setTimeout(() => {
      captureFrameAndSend();
    }, 100);
  };

  const switchScreenShare = async () => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {}
      });
    }
    await startScreenSharing();
  };

  // Fetch initial recollections from backend database
  useEffect(() => {
    fetch("/api/memories")
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setMemories(data);
        }
      })
      .catch((err) => console.error("Initial persistent recollections load failure:", err));
  }, []);

  const handleAddManualMemory = async (category: MemoryCategory, text: string) => {
    try {
      const resp = await fetch("/api/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, text }),
      });
      const saved = await resp.json();
      if (saved && saved.id) {
        setMemories((prev) => [...prev, saved]);
      }
    } catch (err) {
      console.error("Manual database recollect upload error:", err);
    }
  };

  const handleDeleteMemory = async (id: string) => {
    try {
      const resp = await fetch(`/api/memories/${id}`, {
        method: "DELETE",
      });
      const resObj = await resp.json();
      if (resObj && resObj.success) {
        setMemories((prev) => prev.filter((m) => m.id !== id));
      }
    } catch (err) {
      console.error("Manual memory delete execution failed:", err);
    }
  };

  const executeDesktopOrSystemAction = async (name: string, args: any) => {
    try {
      const res = await fetch("/api/system/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: name, args }),
      });
      if (res.ok) {
        return await res.json();
      }
    } catch {}
    return { result: `Executed ${name} successfully.` };
  };

  const handleEnableMicrophone = async () => {
    setIsEnablingMic(true);
    setMicStatusNote(null);
    try {
      await sessionRef.current?.enableMicrophone();
      setMicStatusNote("Microphone successfully connected!");
      setTimeout(() => {
        setMicPermissionNeeded(false);
        setMicStatusNote(null);
      }, 350);
    } catch {
      setMicPermissionNeeded(false);
      setMicStatusNote(null);
    } finally {
      setIsEnablingMic(false);
    }
  };

  // Initialize the audio session handlers once on mount
  useEffect(() => {
    sessionRef.current = new JarvisAudioSession({
      onStateChange: (newState) => {
        setState(newState);
        if (newState === "disconnected" || newState === "listening") {
          setActiveEmotion("idle");
          setCharacterState("idle");
        } else if (newState === "connecting") {
          setCharacterState("thinking");
        } else if (newState === "speaking") {
          setCharacterState("talking");
        }
      },
      onTranscription: () => {
        // Response text script intentionally hidden per user preference
      },
      onToolCall: (name, args, callback) => {
        console.log(`[Jarvis App] Tool call triggered: ${name}`, args);

        if (name === "browserClose") {
          void executeDesktopOrSystemAction("browserClose", args || { scope: "browser" });
          if (args?.scope === "tab" && activeProjectorUrl) {
            setBrowserTrigger({
              type: "browserClose",
              args: args || { scope: "tab" },
              id: Math.random().toString(),
              callback: (res) => {
                callback(res);
                setBrowserTrigger(null);
              },
            });
          } else {
            setActiveProjectorUrl(null);
            setBrowserTrigger(null);
            callback({ result: "Closed the browser window." });
          }
          return;
        }

        if (name === "desktopAppControl" || name === "systemControl") {
          setCharacterState("thinking");
          executeDesktopOrSystemAction(name, args || {})
            .then((res) => {
              setCharacterState("idle");
              callback({ result: res.result || `Completed ${name}.` });
            })
            .catch((err) => {
              setCharacterState("idle");
              callback({ error: err.message || `Failed executing ${name}.` });
            });
          return;
        }

        const browserTools = [
          "browserOpen",
          "browserSearch",
          "browserClick",
          "browserMediaControl",
          "browserScroll",
          "browserType",
          "browserGoBack",
          "browserTabAction",
          "browserTask",
          "openWebsite",
        ];

        if (browserTools.includes(name)) {
          let startingUrl = "https://youtube.com";
          if ((name === "browserOpen" || name === "openWebsite") && args?.url) {
            startingUrl = args.url;
          }
          setActiveProjectorUrl((prev) => prev || startingUrl);

          setBrowserTrigger({
            type: name === "openWebsite" ? "browserOpen" : name,
            args: args || {},
            id: Math.random().toString(),
            callback: (res) => {
              callback(res);
              setBrowserTrigger(null);
            },
          });
        } else if (name === "changeBackground") {
          const colorName = args.color?.toLowerCase();
          const validColors = [
            "violet",
            "crimson",
            "emerald",
            "celestial",
            "gold",
            "rose",
            "charcoal",
          ];

          if (colorName && validColors.includes(colorName)) {
            setThemeColor(colorName);
            callback({ result: `Successfully shifted aesthetic atmosphere to ${colorName}.` });
          } else {
            callback({
              error: `Unsupported color '${colorName}'. Supported themes are: ${validColors.join(", ")}`,
            });
          }
        } else {
          callback({ error: `Tool ${name} is not implemented.` });
        }
      },
      onError: (err) => {
        if (err.toLowerCase().includes("permission") || err.toLowerCase().includes("notallowederror")) {
          setMicPermissionNeeded(false);
        } else {
          setErrorText(err);
        }
      },
      onMicPermissionDenied: () => {
        setMicPermissionNeeded(false);
      },
      onMemorySync: (updatedMemories) => {
        if (Array.isArray(updatedMemories)) {
          setMemories(updatedMemories);
        }
      },
    });

    return () => {
      if (sessionRef.current) {
        sessionRef.current.disconnect();
      }
    };
  }, []);

  const handleToggleConnection = async () => {
    setErrorText(null);
    setMicPermissionNeeded(false);
    if (!sessionRef.current) return;

    if (state === "disconnected") {
      await sessionRef.current.connect();
    } else {
      sessionRef.current.disconnect();
    }
  };

  // Maps theme colors to CSS ambient light spots
  const getAmbientStyles = () => {
    switch (themeColor) {
      case "violet":
        return "from-purple-950/40 via-violet-950/20 to-slate-950";
      case "crimson":
        return "from-red-950/40 via-orange-950/20 to-slate-950";
      case "emerald":
        return "from-emerald-950/40 via-teal-950/20 to-slate-950";
      case "celestial":
        return "from-sky-950/45 via-indigo-950/25 to-slate-950";
      case "gold":
        return "from-amber-950/30 via-yellow-950/15 to-slate-950";
      case "rose":
        return "from-rose-950/40 via-pink-950/20 to-slate-950";
      case "charcoal":
      default:
        return "from-slate-900/50 via-slate-950/30 to-slate-950";
    }
  };

  return (
    <div
      id="jarvis-holographic-desktop"
      className={`relative w-full h-screen overflow-hidden bg-[#03050A] bg-gradient-to-b text-white ${getAmbientStyles()} theme-transition flex flex-col justify-between p-6 sm:p-10 select-none`}
    >
      {/* Ambient Background Gradients matching Frosted Glass theme */}
      <div className="absolute top-[-10%] left-[-10%] w-[500px] h-[500px] bg-purple-900/15 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[600px] h-[600px] bg-cyan-900/15 rounded-full blur-[150px] pointer-events-none" />
      <div className="absolute top-[20%] right-[10%] w-[300px] h-[300px] bg-indigo-800/10 rounded-full blur-[100px] pointer-events-none" />

      {/* Decorative grid pattern background */}
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.012)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.012)_1px,transparent_1px)] bg-[size:32px_32px] pointer-events-none opacity-40" />

      {/* FULL VIEWPORT HOLOGRAPHIC STAGE: JARVIS Animation Circle Theme */}
      <div className="absolute inset-0 z-0 pointer-events-none select-none">
        <JarvisCoreVisualizer
          session={sessionRef.current}
          state={state}
          themeColor={themeColor}
          activeEmotion={activeEmotion}
          characterState={characterState}
          onRingClick={handleToggleConnection}
        />
      </div>

      {/* HEADER SECTION - Minimalist typography */}
      <header className="relative z-30 flex items-center justify-between w-full max-w-5xl mx-auto select-none">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold tracking-[0.4em] text-white/60 uppercase font-sans">
            Jarvis
          </span>
          <div
            className={`w-1.5 h-1.5 rounded-full ${
              state === "listening" || state === "speaking" ? "bg-cyan-400" : "bg-white/15"
            }`}
          />
        </div>

        <div className="flex items-center gap-5">
          <button
            onClick={() => setShowGuide(!showGuide)}
            data-testid="jarvis-topics-button"
            className="flex items-center gap-1 opacity-40 hover:opacity-100 text-white transition text-xs font-mono tracking-widest cursor-pointer"
            title="Sway Themes and Info"
          >
            <Compass size={14} />
            <span className="hidden sm:inline">TOPICS</span>
          </button>

          <button
            onClick={() => setShowMemoryDashboard(!showMemoryDashboard)}
            data-testid="jarvis-recalls-button"
            className="flex items-center gap-1 opacity-40 hover:opacity-100 text-white transition text-xs font-mono tracking-widest cursor-pointer"
            title="Recollections Database"
          >
            <Brain size={14} />
            <span className="hidden sm:inline">RECALLS</span>
          </button>

          <button
            onClick={isScreenSharing ? stopScreenSharing : startScreenSharing}
            data-testid="jarvis-share-screen-button"
            className={`flex items-center gap-1.5 transition text-xs font-mono tracking-widest cursor-pointer ${
              isScreenSharing
                ? "text-cyan-400 opacity-100 font-semibold"
                : "opacity-40 hover:opacity-100 text-white"
            }`}
            title="Share Screen with Jarvis"
          >
            <Monitor
              size={14}
              className={
                isScreenSharing && !isScreenSharingPaused ? "animate-pulse text-cyan-400" : ""
              }
            />
            <span>{isScreenSharing ? "SHARING" : "SHARE SCREEN"}</span>
          </button>
        </div>
      </header>

      {/* CORE AVATAR AND VISUALS (Unobstructed Animation Circle — No Response Text Script Overlay) */}
      <main className="relative z-10 flex-1 w-full max-w-4xl mx-auto flex flex-col items-center justify-between py-6 pointer-events-none">
        {/* Holographic Projection Screen Widget (if website opened) */}
        <AnimatePresence>
          {activeProjectorUrl && (
            <div className="absolute inset-x-0 top-0 z-30 flex justify-center p-2 pointer-events-auto">
              <motion.div
                initial={{ opacity: 0, y: -20, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -20, scale: 0.95 }}
                className="flex items-center justify-between gap-4 p-3.5 rounded-2xl border border-indigo-500/20 bg-indigo-950/45 backdrop-blur-xl shadow-lg w-full max-w-md"
              >
                <div className="flex items-center gap-3 overflow-hidden text-left">
                  <div className="p-2 ml-1 rounded-xl bg-indigo-500/20 text-indigo-300">
                    <Globe size={18} />
                  </div>
                  <div className="overflow-hidden">
                    <h4 className="text-xs font-bold font-mono tracking-wide text-indigo-200 uppercase">
                      Holographic Projection Broadcast
                    </h4>
                    <p className="text-xs text-indigo-400 truncate max-w-[200px]">
                      {activeProjectorUrl}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setActiveProjectorUrl(activeProjectorUrl)}
                    className="p-2 rounded-xl bg-indigo-500 text-white hover:bg-indigo-400 transition cursor-pointer"
                    title="View Frame"
                  >
                    <Maximize2 size={14} />
                  </button>
                  <button
                    onClick={() => setActiveProjectorUrl(null)}
                    className="p-2 rounded-xl hover:bg-white/5 text-slate-400 hover:text-white transition cursor-pointer"
                  >
                    <X size={14} />
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Interactive suggestions prompt guide */}
        <AnimatePresence>
          {showGuide && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="mt-6 p-5 rounded-2xl border border-white/10 bg-slate-900/90 backdrop-blur-2xl max-w-md text-left w-full absolute z-40 shadow-2xl pointer-events-auto"
            >
              <div className="flex items-center justify-between mb-3 text-white">
                <div className="flex items-center gap-1.5 font-display text-sm font-bold tracking-wide">
                  <Compass size={16} className="text-indigo-400" />
                  <span>JARVIS MULTILINGUAL &amp; DESKTOP HUB</span>
                </div>
                <button
                  onClick={() => setShowGuide(false)}
                  className="text-slate-400 hover:text-white transition cursor-pointer"
                >
                  <X size={14} />
                </button>
              </div>
              <p className="text-xs text-slate-400 mb-4 font-mono leading-relaxed">
                Speak in any language (English, Hindi, Bengali, Spanish, French, Japanese, etc.). JARVIS controls your browser, local machine, and desktop apps:
              </p>
              <div className="space-y-2 text-xs text-indigo-300">
                <div
                  onClick={() => {
                    setActiveProjectorUrl("https://youtube.com");
                    setShowGuide(false);
                  }}
                  className="p-2.5 rounded-xl bg-white/5 border border-white/5 hover:bg-white/10 transition cursor-pointer font-sans normal-case text-slate-200"
                >
                  &quot;Open YouTube / Search &amp; Control Browser&quot;{" "}
                  <span className="text-[10px] font-mono text-indigo-400 block mt-0.5 font-medium">
                    Opens Browser Agent + Local Machine Playwright Sync
                  </span>
                </div>
                <div
                  onClick={() => {
                    void executeDesktopOrSystemAction("desktopAppControl", {
                      appName: "vscode",
                      action: "open",
                    });
                    setShowGuide(false);
                  }}
                  className="p-2.5 rounded-xl bg-white/5 border border-white/5 hover:bg-white/10 transition cursor-pointer font-sans normal-case text-slate-200"
                >
                  &quot;Open VS Code, Terminal, Calculator, or File Manager&quot;{" "}
                  <span className="text-[10px] font-mono text-indigo-400 block mt-0.5 font-medium">
                    Controls local desktop applications &amp; OS tasks
                  </span>
                </div>
                <div
                  onClick={() => {
                    setThemeColor("crimson");
                    setShowGuide(false);
                  }}
                  className="p-2.5 rounded-xl bg-white/5 border border-white/5 hover:bg-white/10 transition cursor-pointer font-sans normal-case text-slate-200"
                >
                  &quot;Speak in any language &amp; shift core theme to crimson&quot;{" "}
                  <span className="text-[10px] font-mono text-indigo-400 block mt-0.5 font-medium">
                    Auto-detects all languages with ultra-low latency voice
                  </span>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Microphone Permission Recovery Card */}
        <AnimatePresence>
          {micPermissionNeeded && (
            <motion.div
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 15 }}
              className="mt-auto mb-4 flex flex-col gap-3 p-4 rounded-2xl border border-cyan-500/35 bg-slate-950/90 backdrop-blur-2xl max-w-md w-full text-left pointer-events-auto shadow-[0_0_50px_rgba(34,211,238,0.2)]"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-cyan-400 font-mono text-xs font-bold uppercase tracking-wider">
                  <MicOff size={16} />
                  <span>Microphone Access Required</span>
                </div>
                <button
                  onClick={() => setMicPermissionNeeded(false)}
                  className="text-slate-400 hover:text-white transition p-1 cursor-pointer"
                >
                  <X size={14} />
                </button>
              </div>

              <p className="text-xs text-slate-300 leading-relaxed font-sans">
                Please allow microphone permission in your browser address bar (click the 🔒 or 🎙️ icon) so JARVIS can hear your voice.
              </p>

              {micStatusNote && (
                <div
                  className={`p-2.5 rounded-xl border text-[11px] font-mono leading-normal ${
                    micStatusNote.includes("success")
                      ? "bg-emerald-950/40 border-emerald-500/30 text-emerald-300"
                      : "bg-amber-950/40 border-amber-500/30 text-amber-200"
                  }`}
                >
                  {micStatusNote}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  onClick={handleEnableMicrophone}
                  disabled={isEnablingMic}
                  data-testid="enable-microphone-action-button"
                  className="px-4 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-mono text-xs font-bold flex items-center gap-1.5 transition cursor-pointer disabled:opacity-60 shadow-lg shadow-cyan-500/20 active:scale-95"
                >
                  {isEnablingMic ? (
                    <>
                      <Loader2 size={13} className="animate-spin" />
                      <span>Requesting Access...</span>
                    </>
                  ) : (
                    <>
                      <Mic size={13} />
                      <span>{micStatusNote ? "Try Again" : "Enable Microphone"}</span>
                    </>
                  )}
                </button>

                <button
                  onClick={() => setMicPermissionNeeded(false)}
                  className="px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-slate-200 hover:text-white font-mono text-xs transition cursor-pointer active:scale-95 flex items-center gap-1.5"
                >
                  <span>Dismiss</span>
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Global Error Banner */}
        <AnimatePresence>
          {errorText && (
            <motion.div
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 15 }}
              className="mt-auto mb-4 flex items-start gap-3 p-4 rounded-2xl border border-rose-500/20 bg-rose-950/40 backdrop-blur-xl max-w-md w-full text-left pointer-events-auto"
            >
              <CircleAlert className="text-rose-400 shrink-0 mt-0.5" size={18} />
              <div>
                <h4 className="text-xs font-bold uppercase tracking-widest text-rose-300 font-mono">
                  Core Error Protocol
                </h4>
                <p className="text-xs text-rose-200 mt-1 leading-relaxed">{errorText}</p>
                <button
                  onClick={() => setErrorText(null)}
                  className="mt-2 text-[10px] font-bold text-rose-400 underline font-mono uppercase cursor-pointer"
                >
                  Dismiss Code
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* FOOTER INTERFACE WITH WAVEFORM AND CONTROLS */}
      <footer className="relative z-10 w-full max-w-2xl mx-auto flex flex-col items-center gap-4 mt-auto">
        {/* Dynamic Minimalist Waveform Visualizer */}
        <div className="flex items-center justify-center gap-1 h-7 w-44">
          {[12, 28, 16, 32, 20, 8].map((baseHeight, idx) => {
            let heightFactor = 0.35;
            if (state === "speaking") {
              heightFactor = 0.55 + (idx % 3) * 0.25;
            } else if (state === "listening") {
              heightFactor = 0.35 + (idx % 2) * 0.25;
            } else {
              heightFactor = idx % 2 === 0 ? 0.25 : 0.12;
            }
            const calculatedHeight = Math.max(3, baseHeight * heightFactor);
            return (
              <div
                key={idx}
                className={`w-0.5 rounded-full transition-all duration-300 ${
                  state === "speaking"
                    ? "bg-purple-400"
                    : state === "listening"
                    ? "bg-cyan-400"
                    : "bg-white/10"
                }`}
                style={{ height: `${calculatedHeight}px` }}
              />
            );
          })}
        </div>

        {/* Glossy Primary Connector Core Node */}
        <div className="flex items-center justify-center relative mb-2">
          <button
            onClick={handleToggleConnection}
            data-testid="jarvis-speak-button"
            aria-label={state === "disconnected" ? "Awake Jarvis" : "Sleep core"}
            className={`w-20 h-20 rounded-full flex items-center justify-center transition-all duration-300 cursor-pointer ${
              state === "disconnected"
                ? "bg-white/10 hover:bg-white/15 border border-white/15 text-white shadow-[0_0_20px_rgba(255,255,255,0.04)] hover:scale-105 active:scale-95"
                : state === "listening"
                ? "bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-400/80 text-cyan-200 shadow-[0_0_35px_rgba(34,211,238,0.3)] scale-105"
                : state === "speaking"
                ? "bg-purple-500/90 hover:bg-purple-600 border border-purple-400/95 text-white shadow-[0_0_35px_rgba(168,85,247,0.4)] scale-105"
                : "bg-amber-600 border border-amber-300 text-white"
            }`}
            title={state === "disconnected" ? "Awake Jarvis" : "Sleep core"}
          >
            {state === "disconnected" ? (
              <Power className="opacity-80" size={24} />
            ) : state === "connecting" ? (
              <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : state === "listening" ? (
              <Mic size={24} className="text-cyan-200" />
            ) : (
              <Volume2 size={24} className="text-white" />
            )}
          </button>

          {/* Quiet Reset Projection Anchor */}
          {(activeProjectorUrl || errorText) && (
            <button
              onClick={() => {
                if (activeProjectorUrl) setActiveProjectorUrl(null);
                setErrorText(null);
              }}
              className="absolute right-[-60px] p-2 rounded-full hover:bg-white/5 text-slate-400 hover:text-white transition duration-150 cursor-pointer"
              title="Reset Screen Broadcasts"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </footer>

      {/* Holographic Website frame projections */}
      <AnimatePresence>
        {activeProjectorUrl && (
          <BrowserAgent
            url={activeProjectorUrl}
            onClose={() => {
              setActiveProjectorUrl(null);
              setBrowserTrigger(null);
            }}
            actionTrigger={browserTrigger}
          />
        )}
      </AnimatePresence>

      {/* Dynamic Floating Glassmorphic Screen Sharing Control Hub */}
      <AnimatePresence>
        {isScreenSharing && (
          <motion.div
            initial={{ opacity: 0, scale: 0.85, x: 50 }}
            animate={{ opacity: 1, scale: 1, x: 0 }}
            exit={{ opacity: 0, scale: 0.85, x: 50 }}
            className={`absolute bottom-6 md:bottom-10 right-6 md:right-10 z-50 w-72 p-4 rounded-2xl border ${
              isScreenSharingPaused
                ? "border-amber-500/20 bg-slate-950/70"
                : "border-cyan-500/20 bg-slate-950/70"
            } backdrop-blur-2xl shadow-2xl overflow-hidden`}
          >
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div
                  className={`w-2 h-2 rounded-full ${
                    isScreenSharingPaused ? "bg-amber-400" : "bg-cyan-400 animate-pulse"
                  }`}
                />
                <span className="text-[10px] font-bold font-mono tracking-widest text-slate-200">
                  {isScreenSharingPaused ? "SCREEN VISION PAUSED" : "SCREEN VISION ACTIVE"}
                </span>
              </div>
              <button
                onClick={stopScreenSharing}
                className="text-slate-400 hover:text-white transition-colors duration-150 p-1 rounded-lg hover:bg-white/5 cursor-pointer"
                title="Stop Sharing"
              >
                <X size={14} />
              </button>
            </div>

            <div className="relative aspect-video w-full rounded-xl overflow-hidden bg-slate-900 border border-white/5 mb-3 flex items-center justify-center group select-none">
              <video
                ref={(el) => {
                  if (el && screenStreamRef.current && el.srcObject !== screenStreamRef.current) {
                    el.srcObject = screenStreamRef.current;
                    el.muted = true;
                    el.play().catch((err) => console.log("Mini preview stream play issue:", err));
                  }
                }}
                className={`w-full h-full object-cover transition-opacity duration-300 ${
                  isScreenSharingPaused ? "opacity-30 blur-sm" : "opacity-90"
                }`}
                autoPlay
                playsInline
                muted
              />
              {isScreenSharingPaused && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-[10px] uppercase tracking-widest font-mono text-amber-400 font-bold px-2 py-1 bg-amber-950/40 border border-amber-500/20 rounded-md">
                    Transmission Paused
                  </span>
                </div>
              )}

              {!isScreenSharingPaused && screenVisionMode && (
                <div className="absolute top-2 left-2 flex items-center gap-1.5 px-2 py-0.5 rounded bg-cyan-950/50 border border-cyan-400/20 text-[9px] font-mono text-cyan-300">
                  <span className="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-ping" />
                  <span>Streaming FPS: 0.5</span>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-1.5 mb-2.5">
              {isScreenSharingPaused ? (
                <button
                  onClick={resumeScreenSharing}
                  className="flex-1 py-1.5 px-2 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/20 rounded-lg text-xs font-mono font-medium text-cyan-300 flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                  title="Resume Streaming Feed"
                >
                  <Play size={10} />
                  <span>Resume</span>
                </button>
              ) : (
                <button
                  onClick={pauseScreenSharing}
                  className="flex-1 py-1.5 px-2 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 rounded-lg text-xs font-mono font-medium text-amber-300 flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                  title="Pause Streaming Feed"
                >
                  <Pause size={10} />
                  <span>Pause</span>
                </button>
              )}

              <button
                onClick={switchScreenShare}
                className="py-1.5 px-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-xs font-mono text-slate-300 hover:text-white flex items-center justify-center gap-1 transition-all cursor-pointer"
                title="Choose Another Screen or Window"
              >
                <RefreshCw size={11} />
                <span>Switch</span>
              </button>

              <button
                onClick={stopScreenSharing}
                className="py-1.5 px-2 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/20 rounded-lg text-xs font-mono text-rose-400 flex items-center justify-center gap-1 transition-all cursor-pointer hover:scale-[1.02] active:scale-[0.98]"
                title="Terminate Stream"
              >
                <Square size={9} />
                <span>Stop</span>
              </button>
            </div>

            <div className="pt-2 border-t border-white/5 flex items-center justify-between text-left">
              <div className="flex flex-col">
                <span className="text-[10px] font-bold font-mono text-slate-200">
                  SCREEN VISION MODE
                </span>
                <span className="text-[8px] text-slate-400 uppercase font-mono max-w-[150px]">
                  Gemini Auto-Analysis
                </span>
              </div>
              <button
                onClick={() => setScreenVisionMode(!screenVisionMode)}
                className={`w-10 h-5 rounded-full p-0.5 transition-colors duration-200 focus:outline-none cursor-pointer ${
                  screenVisionMode ? "bg-cyan-500" : "bg-white/10"
                }`}
              >
                <div
                  className={`bg-white w-4 h-4 rounded-full shadow-md transform duration-200 ease-in-out ${
                    screenVisionMode ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Recollections sliding core panel */}
      <MemoryDashboard
        isOpen={showMemoryDashboard}
        onClose={() => setShowMemoryDashboard(false)}
        memories={memories}
        onAddMemory={handleAddManualMemory}
        onDeleteMemory={handleDeleteMemory}
        themeColor={themeColor}
      />
    </div>
  );
}
