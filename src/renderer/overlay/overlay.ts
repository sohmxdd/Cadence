type OverlayState = 'hidden' | 'listening' | 'processing' | 'done' | 'cancelled';
type CadenceMode = 'dictation' | 'command';

const pill = document.getElementById('pill') as HTMLDivElement;
const canvas = document.getElementById('waveform-canvas') as HTMLCanvasElement;
const statusText = document.getElementById('status-text') as HTMLSpanElement;
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

  if (text) {
    statusText.textContent = text;
  }

  if (state === 'hidden') {
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
  } else if (!animFrameId && state === 'listening') {
    animFrameId = requestAnimationFrame(renderLoop);
  }
}

function renderLoop() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  phase += 0.08;

  const dotW = 3;
  const gap = (canvas.width - NUM_BARS * dotW) / (NUM_BARS - 1);
  const centerY = canvas.height / 2;

  ctx.fillStyle = '#FF3B30'; // Red waveform dots

  for (let i = 0; i < NUM_BARS; i++) {
    let targetHeight = 3;

    if (currentState === 'listening') {
      const shimmer = 0.12 + 0.06 * Math.abs(Math.sin(phase * 1.5 + i * 0.7));
      const amp = Math.max(shimmer, audioLevel);
      targetHeight = Math.max(3, 3 + amp * 18 * Math.sin(phase + i * 0.35));
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

  if (currentState === 'listening') {
    animFrameId = requestAnimationFrame(renderLoop);
  } else {
    animFrameId = null;
  }
}

setState('hidden');
