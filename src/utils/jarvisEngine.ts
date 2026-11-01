// Pure Audio Envelope & Procedural JARVIS Energy Ring Math

export type JarvisState =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'executing'
  | 'speaking'
  | 'confirming'
  | 'success'
  | 'error';

export interface AudioFrequencyBands {
  rawRms: number;
  gatedEnergy: number;
  lowBand: number;
  midBand: number;
  highBand: number;
}

export interface VoiceOrbDynamics {
  orbScale: number;
  glowOpacity: number;
  ribbonAmplitude: number;
  crescentIntensity: number;
  emberCount: number;
  cyanAccentRatio: number;
}

/**
 * Safely installs a getter + setter descriptor on window.fetch and Window.prototype.fetch
 * so third-party browser extensions that assign `window.fetch = ...` do not throw
 * `TypeError: Cannot set property fetch of #<Window> which has only a getter`.
 */
export function installSafeFetchDescriptor(targetWindow: Record<string, unknown>): boolean {
  try {
    let currentFetch =
      typeof targetWindow.fetch === 'function'
        ? (targetWindow.fetch as (...args: unknown[]) => unknown).bind(targetWindow)
        : undefined;

    Object.defineProperty(targetWindow, 'fetch', {
      configurable: true,
      enumerable: true,
      get() {
        return currentFetch;
      },
      set(nextFetch: unknown) {
        if (typeof nextFetch === 'function') {
          currentFetch = nextFetch as (...args: unknown[]) => unknown;
        }
      },
    });

    if (typeof Window !== 'undefined' && Window.prototype) {
      try {
        Object.defineProperty(Window.prototype, 'fetch', {
          configurable: true,
          enumerable: true,
          get() {
            return currentFetch;
          },
          set(nextFetch: unknown) {
            if (typeof nextFetch === 'function') {
              currentFetch = nextFetch as (...args: unknown[]) => unknown;
            }
          },
        });
      } catch {}
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Computes a noise-gated, smoothed audio energy envelope and 3-band frequency split
 * from an AnalyserNode byte frequency array (0..255).
 */
export function computeGatedAudioEnvelope(
  frequencyBins: Uint8Array,
  previousEnvelope: number,
  noiseFloor = 0.06
): AudioFrequencyBands {
  if (!frequencyBins || frequencyBins.length === 0) {
    return {
      rawRms: 0,
      gatedEnergy: 0,
      lowBand: 0,
      midBand: 0,
      highBand: 0,
    };
  }

  const len = frequencyBins.length;
  let sumSq = 0;
  let lowSum = 0;
  let midSum = 0;
  let highSum = 0;

  const lowEnd = Math.max(1, Math.floor(len * 0.25));
  const midEnd = Math.max(lowEnd + 1, Math.floor(len * 0.65));

  for (let i = 0; i < len; i++) {
    const norm = frequencyBins[i] / 255;
    sumSq += norm * norm;
    if (i < lowEnd) {
      lowSum += norm;
    } else if (i < midEnd) {
      midSum += norm;
    } else {
      highSum += norm;
    }
  }

  const rawRms = Math.sqrt(sumSq / len);

  if (rawRms < noiseFloor) {
    const decayed = previousEnvelope * 0.78;
    const gated = decayed < 0.01 ? 0 : Number(decayed.toFixed(4));
    return {
      rawRms: Number(rawRms.toFixed(4)),
      gatedEnergy: gated,
      lowBand: 0,
      midBand: 0,
      highBand: 0,
    };
  }

  const normalizedAboveGate = Math.min(1, (rawRms - noiseFloor) / (0.82 - noiseFloor));
  const smoothed = previousEnvelope * 0.55 + normalizedAboveGate * 0.45;
  const gatedEnergy = Number(Math.min(1, Math.max(0, smoothed)).toFixed(4));

  const lowBand = Number(Math.min(1, lowSum / lowEnd).toFixed(4));
  const midBand = Number(Math.min(1, midSum / Math.max(1, midEnd - lowEnd)).toFixed(4));
  const highBand = Number(Math.min(1, highSum / Math.max(1, len - midEnd)).toFixed(4));

  return {
    rawRms: Number(rawRms.toFixed(4)),
    gatedEnergy,
    lowBand,
    midBand,
    highBand,
  };
}

/**
 * Computes bounded procedural energy ring parameters for each assistant state.
 */
export function computeVoiceOrbDynamics(
  state: JarvisState,
  audioLevel: number
): VoiceOrbDynamics {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(audioLevel) ? audioLevel : 0));

  switch (state) {
    case 'listening':
      return {
        orbScale: Number((1.01 + clamped * 0.08).toFixed(4)),
        glowOpacity: Number((0.48 + clamped * 0.42).toFixed(4)),
        ribbonAmplitude: Number((5.5 + clamped * 16.0).toFixed(2)),
        crescentIntensity: Number((0.68 + clamped * 0.32).toFixed(4)),
        emberCount: Math.round(14 + clamped * 14),
        cyanAccentRatio: Number((0.35 + clamped * 0.45).toFixed(4)),
      };
    case 'transcribing':
      return {
        orbScale: 0.96,
        glowOpacity: 0.52,
        ribbonAmplitude: 4.2,
        crescentIntensity: 0.65,
        emberCount: 12,
        cyanAccentRatio: 0.55,
      };
    case 'thinking':
      return {
        orbScale: 1.0,
        glowOpacity: 0.6,
        ribbonAmplitude: 5.0,
        crescentIntensity: 0.72,
        emberCount: 14,
        cyanAccentRatio: 0.65,
      };
    case 'executing':
      return {
        orbScale: 1.02,
        glowOpacity: 0.68,
        ribbonAmplitude: 6.8,
        crescentIntensity: 0.78,
        emberCount: 18,
        cyanAccentRatio: 0.78,
      };
    case 'speaking':
      return {
        orbScale: Number((1.02 + clamped * 0.1).toFixed(4)),
        glowOpacity: Number((0.56 + clamped * 0.4).toFixed(4)),
        ribbonAmplitude: Number((6.5 + clamped * 18.5).toFixed(2)),
        crescentIntensity: Number((0.74 + clamped * 0.26).toFixed(4)),
        emberCount: Math.round(16 + clamped * 12),
        cyanAccentRatio: Number((0.45 + clamped * 0.45).toFixed(4)),
      };
    case 'confirming':
      return {
        orbScale: 1.01,
        glowOpacity: 0.64,
        ribbonAmplitude: 5.2,
        crescentIntensity: 0.74,
        emberCount: 14,
        cyanAccentRatio: 0.2,
      };
    case 'success':
      return {
        orbScale: 1.03,
        glowOpacity: 0.75,
        ribbonAmplitude: 4.5,
        crescentIntensity: 0.85,
        emberCount: 18,
        cyanAccentRatio: 0.92,
      };
    case 'error':
      return {
        orbScale: 0.99,
        glowOpacity: 0.62,
        ribbonAmplitude: 5.8,
        crescentIntensity: 0.7,
        emberCount: 12,
        cyanAccentRatio: 0.1,
      };
    case 'idle':
    default:
      return {
        orbScale: 1.0,
        glowOpacity: 0.34,
        ribbonAmplitude: 2.6,
        crescentIntensity: 0.48,
        emberCount: 9,
        cyanAccentRatio: 0.22,
      };
  }
}

/**
 * Pure harmonic wave displacement for the procedural flowing ribbons around the hollow ring.
 */
export function computeRingHarmonics(
  angleRad: number,
  timeSec: number,
  state: JarvisState,
  audioLevel: number
): number {
  const clamped = Math.max(0, Math.min(1, audioLevel));
  const speed =
    state === 'speaking'
      ? 3.4
      : state === 'listening'
      ? 2.8
      : state === 'executing' || state === 'thinking'
      ? 2.4
      : 0.95;

  const wave1 = Math.sin(angleRad * 3 + timeSec * speed) * 0.45;
  const wave2 = Math.cos(angleRad * 5 - timeSec * (speed * 1.25)) * 0.35;
  const wave3 =
    Math.sin(angleRad * 8 + timeSec * (speed * 1.7)) * (0.2 * (0.3 + clamped * 0.7));

  return Number((wave1 + wave2 + wave3).toFixed(4));
}

export interface DesktopAppCommandDescriptor {
  canonicalApp: string;
  action: 'open' | 'close' | 'focus' | 'execute_task';
  linuxBinaries: string[];
  CloseProcessName: string;
  taskArgs: string;
  summary: string;
}

const KNOWN_SITE_SHORTCUTS: Record<string, string> = {
  youtube: 'https://www.youtube.com',
  google: 'https://www.google.com',
  github: 'https://github.com',
  gmail: 'https://mail.google.com',
  chatgpt: 'https://chatgpt.com',
  wikipedia: 'https://www.wikipedia.org',
  whatsapp: 'https://web.whatsapp.com',
  spotify: 'https://open.spotify.com',
  reddit: 'https://www.reddit.com',
  linkedin: 'https://www.linkedin.com',
  x: 'https://x.com',
  twitter: 'https://x.com',
  amazon: 'https://www.amazon.com',
  netflix: 'https://www.netflix.com',
  stack: 'https://stackoverflow.com',
  stackoverflow: 'https://stackoverflow.com',
};

/**
 * Resolves any natural site name, domain, or search phrase into a clean destination URL.
 */
export function resolveBrowserDestinationUrl(rawInput: string): string {
  const trimmed = (rawInput || '').trim();
  if (!trimmed || trimmed === 'about:blank') return 'about:blank';

  const lower = trimmed.toLowerCase();
  if (KNOWN_SITE_SHORTCUTS[lower]) {
    return KNOWN_SITE_SHORTCUTS[lower];
  }

  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    return trimmed;
  }

  const isDomain =
    /^([\da-z.-]+)\.([a-z.]{2,10})([/\w .-]*)*\/?(\?.*)?(#.*)?$/i.test(trimmed) &&
    !trimmed.includes(' ');
  if (isDomain) {
    return `https://${trimmed}`;
  }

  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(trimmed)}`;
}

/**
 * Builds a structured cross-platform desktop application command descriptor for opening,
 * closing, focusing, or running tasks in local desktop applications.
 */
export function buildDesktopAppCommand(
  appName: string,
  action: string = 'open',
  taskArgs: string = ''
): DesktopAppCommandDescriptor {
  const normalizedApp = (appName || 'terminal').trim().toLowerCase();
  const normalizedAction: DesktopAppCommandDescriptor['action'] =
    action === 'close' || action === 'focus' || action === 'execute_task' ? action : 'open';
  const cleanArgs = (taskArgs || '').trim();

  const catalog: Array<{
    match: RegExp;
    canonical: string;
    bins: string[];
    proc: string;
  }> = [
    {
      match: /code|vscode|visual studio/i,
      canonical: 'VS Code',
      bins: ['code', 'codium'],
      proc: 'code',
    },
    {
      match: /term|bash|shell|konsole|alacritty|kitty/i,
      canonical: 'Terminal',
      bins: ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm'],
      proc: 'gnome-terminal',
    },
    {
      match: /file|folder|nautilus|dolphin|thunar|explorer/i,
      canonical: 'File Manager',
      bins: ['xdg-open', 'nautilus', 'dolphin', 'thunar', 'pcmanfm'],
      proc: 'nautilus',
    },
    {
      match: /chrome|chromium|brave|firefox|browser/i,
      canonical: 'Desktop Browser',
      bins: ['xdg-open', 'google-chrome', 'chromium', 'chromium-browser', 'firefox', 'brave-browser'],
      proc: 'chrome',
    },
    {
      match: /calc/i,
      canonical: 'Calculator',
      bins: ['gnome-calculator', 'kcalc', 'galculator', 'xcalc'],
      proc: 'gnome-calculator',
    },
    {
      match: /spotify|music/i,
      canonical: 'Spotify',
      bins: ['spotify', 'rhythmbox'],
      proc: 'spotify',
    },
    {
      match: /vlc|video|player|mpv/i,
      canonical: 'Media Player',
      bins: ['vlc', 'mpv', 'totem'],
      proc: 'vlc',
    },
    {
      match: /note|gedit|kate|text|editor|nano|mousepad/i,
      canonical: 'Text Editor / Notes',
      bins: ['gedit', 'gnome-text-editor', 'mousepad', 'kate', 'leafpad'],
      proc: 'gedit',
    },
    {
      match: /setting|control/i,
      canonical: 'System Settings',
      bins: ['gnome-control-center', 'systemsettings', 'xfce4-settings-manager'],
      proc: 'gnome-control-center',
    },
    {
      match: /discord/i,
      canonical: 'Discord',
      bins: ['discord'],
      proc: 'discord',
    },
    {
      match: /slack/i,
      canonical: 'Slack',
      bins: ['slack'],
      proc: 'slack',
    },
    {
      match: /office|writer|calc|impress|libre/i,
      canonical: 'LibreOffice',
      bins: ['libreoffice', 'soffice'],
      proc: 'soffice.bin',
    },
  ];

  const found = catalog.find((item) => item.match.test(normalizedApp)) || {
    match: /.*/,
    canonical: appName.trim() || 'Application',
    bins: [normalizedApp.replace(/[^a-z0-9._-]/g, '') || 'xdg-open'],
    proc: normalizedApp.replace(/[^a-z0-9._-]/g, '') || 'app',
  };

  const summary =
    normalizedAction === 'close'
      ? `Closed desktop application ${found.canonical}.`
      : normalizedAction === 'focus'
      ? `Focused desktop window for ${found.canonical}.`
      : normalizedAction === 'execute_task'
      ? `Executed task in ${found.canonical}${cleanArgs ? `: ${cleanArgs}` : ''}.`
      : `Opened desktop application ${found.canonical}${cleanArgs ? ` (${cleanArgs})` : ''}.`;

  return {
    canonicalApp: found.canonical,
    action: normalizedAction,
    linuxBinaries: found.bins,
    CloseProcessName: found.proc,
    taskArgs: cleanArgs,
    summary,
  };
}

/**
 * Detects language script or explicit language preference from any user text/utterance.
 */
export function detectMultilingualLanguageHint(utterance: string): {
  code: string;
  name: string;
} {
  const sample = (utterance || '').trim();
  if (!sample) return { code: 'auto', name: 'Auto-Detect Multilingual' };

  if (/[\u0980-\u09FF]/.test(sample) || /\b(bangla|bengali)\b/i.test(sample)) {
    return { code: 'bn', name: 'Bengali' };
  }
  if (/[\u0900-\u097F]/.test(sample) || /\b(hindi|hinglish)\b/i.test(sample)) {
    return { code: 'hi', name: 'Hindi' };
  }
  if (/[\u0600-\u06FF]/.test(sample) || /\b(arabic)\b/i.test(sample)) {
    return { code: 'ar', name: 'Arabic' };
  }
  if (/[\u3040-\u30FF]/.test(sample) || /\b(japanese)\b/i.test(sample)) {
    return { code: 'ja', name: 'Japanese' };
  }
  if (/[\uAC00-\uD7AF]/.test(sample) || /\b(korean)\b/i.test(sample)) {
    return { code: 'ko', name: 'Korean' };
  }
  if (/[\u4E00-\u9FFF]/.test(sample) || /\b(chinese|mandarin)\b/i.test(sample)) {
    return { code: 'zh', name: 'Chinese' };
  }
  if (/[\u0400-\u04FF]/.test(sample) || /\b(russian)\b/i.test(sample)) {
    return { code: 'ru', name: 'Russian' };
  }
  if (/\b(spanish|español|hola)\b/i.test(sample)) {
    return { code: 'es', name: 'Spanish' };
  }
  if (/\b(french|français|bonjour)\b/i.test(sample)) {
    return { code: 'fr', name: 'French' };
  }
  if (/\b(german|deutsch|guten tag)\b/i.test(sample)) {
    return { code: 'de', name: 'German' };
  }

  return { code: 'en', name: 'English' };
}

/**
 * Downsamples a Float32Array audio buffer from a native hardware sample rate (e.g. 48000 Hz or 44100 Hz)
 * to a target sample rate (16000 Hz) using box-averaging anti-alias filtering.
 */
export function downsampleFloat32Buffer(
  buffer: Float32Array,
  inputSampleRate: number,
  targetSampleRate = 16000
): Float32Array {
  if (!buffer || buffer.length === 0) return new Float32Array(0);
  if (inputSampleRate <= targetSampleRate || inputSampleRate <= 0) {
    return buffer;
  }
  const sampleRateRatio = inputSampleRate / targetSampleRate;
  const newLength = Math.max(1, Math.round(buffer.length / sampleRateRatio));
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.min(
      buffer.length,
      Math.round((offsetResult + 1) * sampleRateRatio)
    );
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer; i++) {
      accum += buffer[i];
      count++;
    }
    result[offsetResult] = count > 0 ? accum / count : buffer[Math.min(offsetBuffer, buffer.length - 1)];
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}


