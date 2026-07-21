type OverlayState = 'hidden' | 'listening' | 'processing' | 'done' | 'cancelled';
type CadenceMode = 'dictation' | 'command';

console.log('[Overlay Renderer] Script loaded and initialized');

const pill = document.getElementById('pill') as HTMLDivElement;
const canvas = document.getElementById('waveform-canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

let currentState: OverlayState = 'hidden';
let currentMode: CadenceMode = 'dictation';
let audioLevel = 0; // 0.0 to 1.0
let animFrameId: number | null = null;
let phase = 0;

const NUM_BARS = 16;
const barHeights: number[] = new Array(NUM_BARS).fill(3);

if ((window as any).electronAPI) {
  (window as any).electronAPI.onOverlayState(({ state, mode, text }: { state: OverlayState; mode?: CadenceMode; text?: string }) => {
    console.log(`[Overlay Renderer] Received overlay-state: state=${state}, mode=${mode}, text=${text}`);
    setState(state, mode, text);
  });

  (window as any).electronAPI.onAudioLevel((level: number) => {
    audioLevel = Math.min(Math.max(level, 0), 1);
  });
}

function setState(state: OverlayState, mode?: CadenceMode, text?: string) {
  currentState = state;
  if (mode) currentMode = mode;

  pill.className = `pill state-${state}`;
  if (currentMode === 'command') {
    pill.classList.add('is-command-mode');
  } else {
    pill.classList.remove('is-command-mode');
  }

  if (state === 'hidden') {
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
  } else if (!animFrameId && (state === 'listening' || state === 'processing')) {
    animFrameId = requestAnimationFrame(renderLoop);
  }
}

function renderLoop() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  phase += 0.08;

  const dotW = 3;
  const gap = (canvas.width - NUM_BARS * dotW) / (NUM_BARS - 1);
  const centerY = canvas.height / 2;

  // Waveform dot colors per state/mode:
  // Dictation Listening: Red (#FF3B30)
  // Command Listening: Neon Purple (#A855F7)
  // Processing: Neon Blue (#3B82F6)
  if (currentState === 'processing') {
    ctx.fillStyle = '#3B82F6';
  } else if (currentMode === 'command') {
    ctx.fillStyle = '#A855F7';
  } else {
    ctx.fillStyle = '#FF3B30';
  }

  for (let i = 0; i < NUM_BARS; i++) {
    let targetHeight = 3;

    if (currentState === 'listening') {
      const shimmer = 0.12 + 0.06 * Math.abs(Math.sin(phase * 1.5 + i * 0.7));
      const amp = Math.max(shimmer, audioLevel);
      targetHeight = Math.max(3, 3 + amp * 18 * Math.sin(phase + i * 0.35));
    } else if (currentState === 'processing') {
      // Gentle ambient wave pulse while processing audio
      targetHeight = Math.max(3, 3 + 12 * Math.abs(Math.sin(phase * 2 + i * 0.4)));
    }

    // Moving average smoothing
    barHeights[i] += (targetHeight - barHeights[i]) * 0.35;

    const bh = Math.max(3, barHeights[i]);
    const x = i * (dotW + gap);
    const y = centerY - bh / 2;

    ctx.beginPath();
    ctx.roundRect(x, y, dotW, bh, dotW / 2);
    ctx.fill();
  }

  if (currentState === 'listening' || currentState === 'processing') {
    animFrameId = requestAnimationFrame(renderLoop);
  } else {
    animFrameId = null;
  }
}

setState('hidden');
