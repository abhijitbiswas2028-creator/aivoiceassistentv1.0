import React, { useEffect, useRef } from "react";
import { JarvisAudioSession, LiveState } from "../lib/audio";
import { JarvisCoreCanvas } from "./JarvisCoreCanvas";
import type { JarvisState } from "../utils/jarvisEngine";

export type JarvisEmotion =
  | "idle"
  | "happy"
  | "excited"
  | "curious"
  | "thinking"
  | "proud"
  | "sad"
  | "confused"
  | "surprised"
  | "embarrassed"
  | "playful";

export type MyraaEmotion = JarvisEmotion;

interface JarvisCoreVisualizerProps {
  session: JarvisAudioSession | null;
  state: LiveState;
  themeColor: string; // violet, crimson, emerald, celestial, gold, rose, charcoal
  activeEmotion?: JarvisEmotion;
  characterState: "idle" | "thinking" | "talking";
  onRingClick?: () => void;
}

export const JarvisCoreVisualizer: React.FC<JarvisCoreVisualizerProps> = ({
  session,
  state,
  themeColor,
  activeEmotion = "idle",
  characterState,
  onRingClick,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const playbackAnalyserRef = useRef<AnalyserNode | null>(null);
  const simulatedVoiceEnergyRef = useRef<number>(0);

  const mouseRef = useRef<{ x: number; y: number }>({ x: 0.5, y: 0.4 });
  const targetMouseRef = useRef<{ x: number; y: number }>({ x: 0.5, y: 0.4 });
  const speechVolumeRef = useRef<number>(0);

  const particlesRef = useRef<
    Array<{
      x: number;
      y: number;
      speed: number;
      size: number;
      opacity: number;
    }>
  >([]);

  // Map LiveState + characterState to the procedural JARVIS energy ring state machine
  const mappedRingState: JarvisState =
    state === "speaking" || characterState === "talking"
      ? "speaking"
      : characterState === "thinking" || state === "connecting"
      ? "thinking"
      : state === "listening"
      ? "listening"
      : "idle";

  // Keep analyser refs synchronized with live audio session
  useEffect(() => {
    micAnalyserRef.current = session?.inputAnalyser ?? null;
    playbackAnalyserRef.current = session?.outputAnalyser ?? null;
  });

  // Cursor position tracking hook
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      targetMouseRef.current = {
        x: e.clientX / window.innerWidth,
        y: e.clientY / window.innerHeight,
      };
    };
    window.addEventListener("mousemove", handleMouseMove);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
    };
  }, []);

  const getGlowColors = () => {
    switch (themeColor) {
      case "violet":
        return {
          primary: "rgba(147, 51, 234, 1)",
          secondary: "rgba(192, 38, 211, 0.8)",
          glow: "rgba(168, 85, 247, 0.7)",
        };
      case "crimson":
        return {
          primary: "rgba(225, 29, 72, 1)",
          secondary: "rgba(234, 88, 12, 0.8)",
          glow: "rgba(244, 63, 94, 0.7)",
        };
      case "emerald":
        return {
          primary: "rgba(5, 150, 105, 1)",
          secondary: "rgba(13, 148, 136, 0.8)",
          glow: "rgba(16, 185, 129, 0.7)",
        };
      case "celestial":
        return {
          primary: "rgba(2, 132, 199, 1)",
          secondary: "rgba(8, 145, 178, 0.8)",
          glow: "rgba(14, 165, 233, 0.7)",
        };
      case "gold":
        return {
          primary: "rgba(202, 138, 4, 1)",
          secondary: "rgba(217, 119, 6, 0.8)",
          glow: "rgba(234, 179, 8, 0.7)",
        };
      case "rose":
        return {
          primary: "rgba(219, 39, 119, 1)",
          secondary: "rgba(220, 38, 38, 0.8)",
          glow: "rgba(236, 72, 153, 0.7)",
        };
      default:
        return {
          primary: "rgba(58, 223, 255, 1)",
          secondary: "rgba(120, 85, 255, 0.8)",
          glow: "rgba(36, 95, 255, 0.7)",
        };
    }
  };

  // Ambient Holographic Stage & Floating Stardust Canvas Loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let timerId = 0;
    let width = (canvas.width = canvas.offsetWidth || window.innerWidth);
    let height = (canvas.height = canvas.offsetHeight || window.innerHeight);

    const generateParticles = () => {
      const count = Math.min(50, Math.max(20, Math.floor(width / 28)));
      particlesRef.current = Array.from({ length: count }, (_, idx) => ({
        x: ((idx * 73) % 100) * 0.01 * width,
        y: ((idx * 41) % 100) * 0.01 * height,
        speed: 0.18 + (idx % 5) * 0.07,
        size: 0.6 + (idx % 3) * 0.45,
        opacity: 0.25 + (idx % 4) * 0.14,
      }));
    };

    generateParticles();

    const handleResize = () => {
      if (!canvas) return;
      width = canvas.width = canvas.offsetWidth || window.innerWidth;
      height = canvas.height = canvas.offsetHeight || window.innerHeight;
      generateParticles();
    };

    window.addEventListener("resize", handleResize);

    const dataArray = new Uint8Array(64);

    const render = () => {
      ctx.clearRect(0, 0, width, height);
      const colors = getGlowColors();

      micAnalyserRef.current = session?.inputAnalyser ?? null;
      playbackAnalyserRef.current = session?.outputAnalyser ?? null;

      let audioLevel = 0;
      const activeAnalyser =
        state === "speaking"
          ? session?.outputAnalyser
          : state === "listening"
          ? session?.inputAnalyser
          : null;

      if (activeAnalyser) {
        try {
          activeAnalyser.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i];
          }
          audioLevel = sum / dataArray.length;
        } catch {}
      } else if (state === "speaking" || characterState === "talking") {
        const t = performance.now() * 0.006;
        audioLevel = 95 + Math.abs(Math.sin(t)) * 85 + Math.abs(Math.cos(t * 1.6)) * 45;
      } else if (state === "listening") {
        const t = performance.now() * 0.004;
        audioLevel = 38 + Math.abs(Math.sin(t)) * 32;
      }

      speechVolumeRef.current += (audioLevel / 255 - speechVolumeRef.current) * 0.25;
      simulatedVoiceEnergyRef.current = speechVolumeRef.current;

      const baseScale = height / 440;
      const s = Math.max(0.95, Math.min(1.85, baseScale));

      mouseRef.current.x += (targetMouseRef.current.x - mouseRef.current.x) * 0.05;
      mouseRef.current.y += (targetMouseRef.current.y - mouseRef.current.y) * 0.05;

      const centerX = width / 2;

      // 1. Volumetric Stage Projector Beam
      ctx.save();
      const projectorCenterY = height + 40;
      const baseDiameterX = 280 * s;

      const conicalBeamGrad = ctx.createLinearGradient(centerX, height * 0.25, centerX, height);
      conicalBeamGrad.addColorStop(0, "rgba(0,0,0,0)");
      conicalBeamGrad.addColorStop(0.4, colors.primary.replace("1)", "0.025)"));
      conicalBeamGrad.addColorStop(0.75, colors.primary.replace("1)", "0.065)"));
      conicalBeamGrad.addColorStop(1, colors.secondary.replace("0.8)", "0.14)"));

      ctx.fillStyle = conicalBeamGrad;
      ctx.beginPath();
      ctx.moveTo(centerX - baseDiameterX * 0.35, projectorCenterY - 145);
      ctx.lineTo(centerX + baseDiameterX * 0.35, projectorCenterY - 145);
      ctx.lineTo(centerX + baseDiameterX * 1.5, height);
      ctx.lineTo(centerX - baseDiameterX * 1.5, height);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // 2. Hologram Neural Particles Rising
      particlesRef.current.forEach((p) => {
        const riseSpeed = p.speed * (1 + speechVolumeRef.current * 1.8);
        p.y -= riseSpeed;
        p.x += Math.sin(p.y * 0.015 + p.size) * 0.35;

        const currentOpacity = p.opacity * Math.max(0, p.y / height);
        if (p.y < height * 0.12) {
          p.y = height + 15;
        }

        ctx.fillStyle = colors.primary.replace("1)", `${currentOpacity * 0.42})`);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * s, 0, Math.PI * 2);
        ctx.fill();
      });

      timerId = window.setTimeout(render, 42);
    };

    render();

    return () => {
      window.removeEventListener("resize", handleResize);
      window.clearTimeout(timerId);
    };
  }, [session, state, themeColor, activeEmotion, characterState]);

  return (
    <div className="relative w-full h-full flex items-center justify-center overflow-hidden">
      {/* 1. Atmospheric Backlight Glow */}
      <div className="absolute inset-0 bg-transparent flex items-center justify-center pointer-events-none z-0">
        <div
          className={`w-[640px] h-[640px] sm:w-[760px] sm:h-[760px] rounded-full blur-[160px] opacity-30 bg-gradient-to-tr transition-all duration-1000 ${
            themeColor === "violet"
              ? "from-purple-600/40 to-fuchsia-600/15"
              : themeColor === "crimson"
              ? "from-rose-600/40 to-orange-600/15"
              : themeColor === "emerald"
              ? "from-emerald-600/40 to-teal-600/15"
              : themeColor === "celestial"
              ? "from-sky-600/40 to-cyan-600/15"
              : themeColor === "gold"
              ? "from-amber-600/40 to-yellow-600/15"
              : themeColor === "rose"
              ? "from-rose-600/40 to-pink-600/15"
              : "from-[#7855FF]/35 to-[#3ADFFF]/15"
          }`}
        />
      </div>

      {/* 2. Centered Procedural JARVIS Animation Circle Theme - Unbounded Open Curvature */}
      <div
        id="jarvis-animated-presence"
        className="relative z-10 flex items-center justify-center pointer-events-auto transition-all duration-500 -translate-y-4 sm:-translate-y-6"
      >
        <JarvisCoreCanvas
          state={mappedRingState}
          reducedMotion={false}
          themeColor={themeColor}
          micAnalyserRef={micAnalyserRef}
          playbackAnalyserRef={playbackAnalyserRef}
          simulatedVoiceEnergyRef={simulatedVoiceEnergyRef}
          onRingClick={onRingClick || (() => {})}
        />
      </div>

      {/* 3. Foreground Holographic Particle Stage Canvas */}
      <canvas
        id="jarvis-hologram-living-canvas"
        ref={canvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none z-20"
      />
    </div>
  );
};

export { JarvisCoreVisualizer as MyraaCoreVisualizer };
