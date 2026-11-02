import React, { useEffect, useRef } from 'react';
import {
  computeGatedAudioEnvelope,
  computeRingHarmonics,
  computeVoiceOrbDynamics,
  type JarvisState,
} from '../utils/jarvisEngine';

interface JarvisCoreCanvasProps {
  state: JarvisState;
  reducedMotion: boolean;
  themeColor?: string;
  micAnalyserRef?: React.MutableRefObject<AnalyserNode | null>;
  playbackAnalyserRef?: React.MutableRefObject<AnalyserNode | null>;
  simulatedVoiceEnergyRef?: React.MutableRefObject<number>;
  onRingClick: () => void;
}

interface FloatingEnergyParticle {
  angle: number;
  radiusNorm: number;
  angularVelocity: number;
  radialVelocity: number;
  size: number;
  phase: number;
  baseAlpha: number;
  colorType: 'cyan' | 'violet' | 'amber' | 'white';
}

interface RibbonDescriptor {
  name: string;
  stroke: string;
  glow: string;
  coreWidth: number;
  freqA: number;
  freqB: number;
  freqC: number;
  speed: number;
  phase: number;
  radiusOffset: number;
  bandWeight: (bands: { lowBand: number; midBand: number; highBand: number }) => number;
}

export const JarvisCoreCanvas: React.FC<JarvisCoreCanvasProps> = ({
  state,
  reducedMotion,
  themeColor = 'charcoal',
  micAnalyserRef,
  playbackAnalyserRef,
  simulatedVoiceEnergyRef,
  onRingClick,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<{ state: JarvisState; reducedMotion: boolean; themeColor: string }>({
    state,
    reducedMotion,
    themeColor,
  });
  const smoothedEnvelopeRef = useRef<number>(0);

  useEffect(() => {
    stateRef.current = { state, reducedMotion, themeColor };
  }, [state, reducedMotion, themeColor]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let timerId = 0;
    const startTime = performance.now();
    const freqBins = new Uint8Array(64);

    // Unbounded floating energetic particles that drift naturally through all space
    const particles: FloatingEnergyParticle[] = Array.from({ length: 48 }, (_, idx) => ({
      angle: (idx / 48) * Math.PI * 2 + Math.random() * 0.4,
      radiusNorm: 0.28 + (idx % 7) * 0.11 + Math.random() * 0.12,
      angularVelocity: (0.15 + (idx % 5) * 0.08) * (idx % 2 === 0 ? 1 : -1) * 0.012,
      radialVelocity: (Math.random() - 0.5) * 0.002,
      size: 0.8 + (idx % 4) * 0.55,
      phase: Math.random() * Math.PI * 2,
      baseAlpha: 0.35 + (idx % 5) * 0.12,
      colorType:
        idx % 5 === 0
          ? 'white'
          : idx % 3 === 0
          ? 'cyan'
          : idx % 7 === 0
          ? 'amber'
          : 'violet',
    }));

    const handleResize = () => {
      if (!canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(380, Math.round(rect.width * dpr));
      canvas.height = Math.max(380, Math.round(rect.height * dpr));
    };

    handleResize();
    window.addEventListener('resize', handleResize);

    const render = (now: number) => {
      const elapsed = (now - startTime) / 1000;
      const { state: curState, reducedMotion: isReduced, themeColor: currentTheme } =
        stateRef.current;

      // Sample real microphone or playback audio analyser with noise gating
      let bands = {
        rawRms: 0,
        gatedEnergy: 0,
        lowBand: 0,
        midBand: 0,
        highBand: 0,
      };

      const activeAnalyser =
        curState === 'listening'
          ? micAnalyserRef?.current
          : curState === 'speaking'
          ? playbackAnalyserRef?.current
          : null;

      if (activeAnalyser) {
        activeAnalyser.getByteFrequencyData(freqBins);
        bands = computeGatedAudioEnvelope(freqBins, smoothedEnvelopeRef.current, 0.05);
        smoothedEnvelopeRef.current = bands.gatedEnergy;
      } else if (curState === 'speaking' && simulatedVoiceEnergyRef?.current) {
        // A speaking pulse is only permitted when an actual playback analyser or audio source reports energy.
        const target = Math.min(0.92, Math.max(0, simulatedVoiceEnergyRef.current));
        smoothedEnvelopeRef.current += (target - smoothedEnvelopeRef.current) * 0.26;
        bands = {
          rawRms: smoothedEnvelopeRef.current,
          gatedEnergy: smoothedEnvelopeRef.current,
          lowBand: smoothedEnvelopeRef.current * 0.92,
          midBand: smoothedEnvelopeRef.current,
          highBand: smoothedEnvelopeRef.current * 0.75,
        };
      } else {
        smoothedEnvelopeRef.current *= 0.84;
        bands.gatedEnergy = Number(smoothedEnvelopeRef.current.toFixed(4));
      }

      const dynamics = computeVoiceOrbDynamics(curState, bands.gatedEnergy);
      const timeFactor = isReduced ? elapsed * 0.15 : elapsed;

      const width = canvas.width;
      const height = canvas.height;
      const cx = width / 2;
      const cy = height / 2;

      // Generous responsive radius scaling with safe canvas margins
      const baseRadius = Math.min(width, height) * 0.25;
      const expansion =
        curState === 'speaking'
          ? 1.0 + bands.gatedEnergy * 0.12
          : curState === 'listening'
          ? 1.0 + bands.gatedEnergy * 0.08
          : 1.0;
      const ringRadius = baseRadius * dynamics.orbScale * expansion;

      ctx.clearRect(0, 0, width, height);

      // State flags
      const isConfirming = curState === 'confirming';
      const isError = curState === 'error';
      const isSuccess = curState === 'success';
      const isThinking = curState === 'thinking';
      const isExecuting = curState === 'executing';
      const isSpeaking = curState === 'speaking';
      const isListening = curState === 'listening';

      // Palette theme mapping with high-intensity chromatic brilliance
      let primaryColor = '#7855FF';
      let cyanColor = '#3ADFFF';
      let deepBlue = '#245FFF';
      let accentPurple = '#B282FF';
      let warmAccent = '#FBBF24';

      if (isError) {
        primaryColor = '#F43F5E';
        cyanColor = '#FB923C';
        deepBlue = '#BE123C';
        accentPurple = '#FDA4AF';
        warmAccent = '#F59E0B';
      } else if (isConfirming) {
        primaryColor = '#F59E0B';
        cyanColor = '#FBBF24';
        deepBlue = '#B45309';
        accentPurple = '#FDE68A';
        warmAccent = '#FDE047';
      } else if (isSuccess) {
        primaryColor = '#10B981';
        cyanColor = '#34D399';
        deepBlue = '#059669';
        accentPurple = '#6EE7B7';
        warmAccent = '#A7F3D0';
      } else if (currentTheme === 'crimson') {
        primaryColor = '#E11D48';
        cyanColor = '#FB7185';
        deepBlue = '#9F1239';
        accentPurple = '#FDA4AF';
      } else if (currentTheme === 'emerald') {
        primaryColor = '#059669';
        cyanColor = '#34D399';
        deepBlue = '#047857';
        accentPurple = '#6EE7B7';
      } else if (currentTheme === 'celestial') {
        primaryColor = '#0284C7';
        cyanColor = '#38BDF8';
        deepBlue = '#0369A1';
        accentPurple = '#7DD3FC';
      } else if (currentTheme === 'gold') {
        primaryColor = '#D97706';
        cyanColor = '#FBBF24';
        deepBlue = '#B45309';
        accentPurple = '#FDE68A';
      } else if (currentTheme === 'rose') {
        primaryColor = '#DB2777';
        cyanColor = '#F472B6';
        deepBlue = '#9D174D';
        accentPurple = '#FBCFE8';
      }

      // =========================================================================
      // 1. UNBOUNDED VOLUMETRIC AURA (Soft organic radial falloff, ZERO hard clipping)
      // =========================================================================
      ctx.save();
      const auraMaxRadius = ringRadius * 1.55;
      const auraGradient = ctx.createRadialGradient(
        cx,
        cy,
        ringRadius * 0.15,
        cx,
        cy,
        auraMaxRadius
      );

      const auraAlpha = 0.22 * dynamics.glowOpacity * (1 + bands.gatedEnergy * 0.5);
      auraGradient.addColorStop(0, `rgba(58, 223, 255, ${auraAlpha * 0.4})`);
      auraGradient.addColorStop(0.35, `rgba(120, 85, 255, ${auraAlpha * 0.7})`);
      auraGradient.addColorStop(0.65, `rgba(36, 95, 255, ${auraAlpha * 0.45})`);
      auraGradient.addColorStop(0.9, `rgba(3, 5, 10, ${auraAlpha * 0.15})`);
      auraGradient.addColorStop(1, 'rgba(3, 5, 10, 0)');

      ctx.fillStyle = auraGradient;
      ctx.beginPath();
      ctx.arc(cx, cy, auraMaxRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // =========================================================================
      // 2. SEAMLESS ORGANIC CRESCENT DEPTH (No hard circular clipping path!)
      // =========================================================================
      ctx.save();
      ctx.globalCompositeOperation = 'screen';

      // Lower edge luminous crescent depth that merges softly into the center
      const crescentCenterY = cy + ringRadius * 0.35;
      const crescentRadius = ringRadius * 0.95;
      const crescentGrad = ctx.createRadialGradient(
        cx,
        crescentCenterY,
        ringRadius * 0.05,
        cx,
        crescentCenterY,
        crescentRadius
      );

      const crescentAlpha = (0.55 + bands.gatedEnergy * 0.45) * dynamics.crescentIntensity;
      crescentGrad.addColorStop(0, `rgba(58, 223, 255, ${crescentAlpha * 0.85})`);
      crescentGrad.addColorStop(0.32, `rgba(36, 95, 255, ${crescentAlpha * 0.65})`);
      crescentGrad.addColorStop(0.62, `rgba(120, 85, 255, ${crescentAlpha * 0.32})`);
      crescentGrad.addColorStop(1, 'rgba(3, 5, 10, 0)');

      ctx.fillStyle = crescentGrad;
      ctx.beginPath();
      ctx.arc(cx, crescentCenterY, crescentRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // =========================================================================
      // 3. UNBOUNDED FLOATING SWIRLING EMBERS & HARMONIC STARDUST
      // =========================================================================
      if (!isReduced) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const activeCount = Math.min(particles.length, dynamics.emberCount * 2);

        for (let i = 0; i < activeCount; i++) {
          const p = particles[i];
          // Swirling orbital velocity accelerated by sound energy
          p.angle += p.angularVelocity * (1 + bands.gatedEnergy * 2.2);
          p.radiusNorm += p.radialVelocity * (1 + bands.midBand * 1.5);

          // Wrap particles across an open radial corridor without bounding walls
          if (p.radiusNorm > 1.25) p.radiusNorm = 0.25;
          if (p.radiusNorm < 0.2) p.radiusNorm = 1.2;

          const currentR = ringRadius * p.radiusNorm;
          const px = cx + Math.cos(p.angle) * currentR;
          const py = cy + Math.sin(p.angle) * currentR;

          const twinkle = 0.4 + 0.6 * Math.abs(Math.sin(timeFactor * 4.2 + p.phase));
          const pAlpha = twinkle * p.baseAlpha * (curState === 'idle' ? 0.45 : 0.95);
          const pr = p.size * (1 + bands.highBand * 0.8);

          const emberGrad = ctx.createRadialGradient(px, py, 0, px, py, pr * 3.0);
          if (p.colorType === 'white') {
            emberGrad.addColorStop(0, `rgba(255, 255, 255, ${pAlpha})`);
            emberGrad.addColorStop(0.4, `rgba(224, 242, 254, ${pAlpha * 0.8})`);
            emberGrad.addColorStop(1, 'rgba(56, 189, 248, 0)');
          } else if (p.colorType === 'cyan') {
            emberGrad.addColorStop(0, `rgba(58, 223, 255, ${pAlpha})`);
            emberGrad.addColorStop(0.5, `rgba(36, 95, 255, ${pAlpha * 0.7})`);
            emberGrad.addColorStop(1, 'rgba(36, 95, 255, 0)');
          } else if (p.colorType === 'amber') {
            emberGrad.addColorStop(0, `rgba(254, 240, 138, ${pAlpha})`);
            emberGrad.addColorStop(0.5, `rgba(245, 158, 11, ${pAlpha * 0.6})`);
            emberGrad.addColorStop(1, 'rgba(245, 158, 11, 0)');
          } else {
            emberGrad.addColorStop(0, `rgba(192, 132, 252, ${pAlpha})`);
            emberGrad.addColorStop(0.5, `rgba(120, 85, 255, ${pAlpha * 0.7})`);
            emberGrad.addColorStop(1, 'rgba(120, 85, 255, 0)');
          }

          ctx.fillStyle = emberGrad;
          ctx.beginPath();
          ctx.arc(px, py, pr * 3.0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      // =========================================================================
      // 4. UNBOUNDED FLUID HARMONIC RIBBONS (Continuous, Open Wave Curvature)
      // =========================================================================
      ctx.save();
      ctx.translate(cx, cy);
      ctx.globalCompositeOperation = 'lighter';

      const ribbons: RibbonDescriptor[] = [
        {
          name: 'primary-ultraviolet',
          stroke: primaryColor,
          glow: primaryColor,
          coreWidth: 2.8,
          freqA: 3,
          freqB: 5,
          freqC: 7,
          speed: 1.5,
          phase: 0,
          radiusOffset: 1.0,
          bandWeight: (b) => b.lowBand,
        },
        {
          name: 'electroluminescent-cyan',
          stroke: cyanColor,
          glow: cyanColor,
          coreWidth: 2.2,
          freqA: 4,
          freqB: 6,
          freqC: 9,
          speed: -1.8,
          phase: 1.25,
          radiusOffset: 1.02,
          bandWeight: (b) => b.highBand,
        },
        {
          name: 'deep-cobalt-structural',
          stroke: deepBlue,
          glow: deepBlue,
          coreWidth: 3.2,
          freqA: 2,
          freqB: 4,
          freqC: 6,
          speed: 1.1,
          phase: 2.5,
          radiusOffset: 0.97,
          bandWeight: (b) => b.lowBand,
        },
        {
          name: 'luminous-amethyst',
          stroke: accentPurple,
          glow: accentPurple,
          coreWidth: 2.0,
          freqA: 5,
          freqB: 3,
          freqC: 8,
          speed: -2.2,
          phase: 3.8,
          radiusOffset: 1.03,
          bandWeight: (b) => b.midBand,
        },
        {
          name: 'warm-photon-filament',
          stroke: warmAccent,
          glow: warmAccent,
          coreWidth: 1.4,
          freqA: 3,
          freqB: 7,
          freqC: 11,
          speed: 2.0,
          phase: 5.1,
          radiusOffset: 0.99,
          bandWeight: (b) => b.midBand,
        },
        {
          name: 'core-crystalline-white',
          stroke: '#FFFFFF',
          glow: cyanColor,
          coreWidth: 1.2,
          freqA: 4,
          freqB: 8,
          freqC: 12,
          speed: -1.4,
          phase: 4.4,
          radiusOffset: 1.01,
          bandWeight: (b) => (b.midBand + b.highBand) * 0.5,
        },
      ];

      // 240 high-resolution segments per ribbon for silky smooth spline curvature
      const segments = 240;

      for (let rIdx = 0; rIdx < ribbons.length; rIdx++) {
        const rib = ribbons[rIdx];
        const bandVal = rib.bandWeight(bands);

        // Normalized amplitude scaling that stays gracefully within the unbounded open canvas
        const voiceBoost =
          isSpeaking || isListening
            ? 1.0 + bands.gatedEnergy * 1.1
            : 1.0 + bands.gatedEnergy * 0.45;
        const normalizedAmp = Math.min(3.2, Math.max(0.6, (dynamics.ribbonAmplitude / 6.2) * voiceBoost));

        ctx.strokeStyle = rib.stroke;
        ctx.lineWidth = rib.coreWidth * (1 + bandVal * 0.5);
        ctx.shadowColor = rib.glow;
        ctx.shadowBlur = 12 + bands.gatedEnergy * 16;

        const maxAllowedDisp = Math.min(cx, cy) * 0.40;

        ctx.beginPath();
        for (let s = 0; s <= segments; s++) {
          const theta = (s / segments) * Math.PI * 2;

          // Pure multi-harmonic wave displacement (unbounded organic curvature)
          const harmonic = computeRingHarmonics(
            theta + rib.phase,
            timeFactor * (rib.speed * 0.45),
            curState,
            bands.gatedEnergy
          );

          // Fluid wave superposition across 3 continuous harmonic frequencies
          const waveA =
            Math.sin(theta * rib.freqA + timeFactor * rib.speed + rib.phase) *
            ringRadius *
            0.055 *
            normalizedAmp;
          const waveB =
            Math.cos(theta * rib.freqB - timeFactor * (rib.speed * 0.8) + rib.phase * 1.4) *
            ringRadius *
            0.038 *
            normalizedAmp;
          const waveC =
            Math.sin(theta * rib.freqC + timeFactor * (rib.speed * 1.3) - rib.phase * 0.7) *
            ringRadius *
            0.022 *
            normalizedAmp *
            (0.4 + bandVal * 0.6);

          const rawDisp = waveA + waveB + waveC + harmonic * (ringRadius * 0.05);
          // Sigmoid compression: always silky smooth, never clipped into straight lines
          const safeDisp = Math.tanh(rawDisp / maxAllowedDisp) * maxAllowedDisp;
          const r = ringRadius * rib.radiusOffset + safeDisp;

          const x = Math.cos(theta) * r;
          const y = Math.sin(theta) * r;

          if (s === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.stroke();

        // Luminous traveling photon beads along the active unbounded waves
        if (!isReduced && (isSpeaking || isListening || isThinking || isExecuting)) {
          const beadCount = isSpeaking ? 3 : 2;
          for (let b = 0; b < beadCount; b++) {
            const beadProgress =
              (timeFactor * (rib.speed * 0.35) + (b / beadCount) * Math.PI * 2 + rib.phase) %
              (Math.PI * 2);
            const normBeadAngle = beadProgress < 0 ? beadProgress + Math.PI * 2 : beadProgress;

            const bHarmonic = computeRingHarmonics(
              normBeadAngle + rib.phase,
              timeFactor * (rib.speed * 0.45),
              curState,
              bands.gatedEnergy
            );
            const bWaveA =
              Math.sin(normBeadAngle * rib.freqA + timeFactor * rib.speed + rib.phase) *
              ringRadius *
              0.055 *
              normalizedAmp;
            const bWaveB =
              Math.cos(normBeadAngle * rib.freqB - timeFactor * (rib.speed * 0.8) + rib.phase * 1.4) *
              ringRadius *
              0.038 *
              normalizedAmp;

            const rawBeadDisp = bWaveA + bWaveB + bHarmonic * (ringRadius * 0.05);
            const safeBeadDisp = Math.tanh(rawBeadDisp / maxAllowedDisp) * maxAllowedDisp;
            const br = ringRadius * rib.radiusOffset + safeBeadDisp;

            const bx = Math.cos(normBeadAngle) * br;
            const by = Math.sin(normBeadAngle) * br;

            const beaconGlow = ctx.createRadialGradient(bx, by, 0, bx, by, 7 + bandVal * 4);
            beaconGlow.addColorStop(0, '#FFFFFF');
            beaconGlow.addColorStop(0.35, rib.glow);
            beaconGlow.addColorStop(1, 'rgba(0,0,0,0)');

            ctx.fillStyle = beaconGlow;
            ctx.beginPath();
            ctx.arc(bx, by, 7 + bandVal * 4, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      // =========================================================================
      // 5. UNBOUNDED TRAVELING RESONANCE HIGHLIGHTS (Thinking / Executing / Success)
      // =========================================================================
      if (isThinking) {
        // Double luminous orbiting arc with high-speed quantum trace
        for (let a = 0; a < 2; a++) {
          const orbitAngle = timeFactor * (2.8 + a * 0.6) + a * Math.PI;
          ctx.strokeStyle = a === 0 ? '#3ADFFF' : '#C084FC';
          ctx.shadowColor = a === 0 ? '#3ADFFF' : '#A855F7';
          ctx.shadowBlur = 20;
          ctx.lineWidth = 3.5;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.arc(0, 0, ringRadius * (1.02 + a * 0.04), orbitAngle, orbitAngle + Math.PI * 0.55);
          ctx.stroke();
        }
      } else if (isExecuting) {
        // High-energy dual traveling pulses when a directive/tool executes
        for (let p = 0; p < 3; p++) {
          const pulse = timeFactor * 3.6 + (p * Math.PI * 2) / 3;
          ctx.strokeStyle = p === 0 ? '#3ADFFF' : p === 1 ? '#7855FF' : '#FBBF24';
          ctx.shadowColor = ctx.strokeStyle;
          ctx.shadowBlur = 18;
          ctx.lineWidth = 3.2;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.arc(0, 0, ringRadius * (1.0 + (p - 1) * 0.03), pulse, pulse + Math.PI * 0.35);
          ctx.stroke();
        }
      } else if (isSuccess) {
        // Settling concentric halo wave
        ctx.strokeStyle = 'rgba(52, 211, 153, 0.85)';
        ctx.shadowColor = '#34D399';
        ctx.shadowBlur = 24;
        ctx.lineWidth = 3.0;
        ctx.beginPath();
        ctx.arc(0, 0, ringRadius * 1.04, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.restore();

      const frameDelay = document.hidden ? 800 : curState === 'idle' || isReduced ? 40 : 33;
      timerId = window.setTimeout(() => {
        render(performance.now());
      }, frameDelay);
    };

    render(performance.now());

    return () => {
      window.clearTimeout(timerId);
      window.removeEventListener('resize', handleResize);
    };
  }, [micAnalyserRef, playbackAnalyserRef, simulatedVoiceEnergyRef]);

  return (
    <div
      onClick={onRingClick}
      className="relative flex items-center justify-center w-[460px] h-[460px] sm:w-[560px] sm:h-[560px] md:w-[620px] md:h-[620px] max-w-[94vw] max-h-[72vh] cursor-pointer select-none"
    >
      <canvas
        ref={canvasRef}
        data-testid="jarvis-core-canvas"
        aria-label={`JARVIS energy ring in ${state} state`}
        className="w-full h-full transition-transform duration-200 active:scale-98"
      />
    </div>
  );
};
