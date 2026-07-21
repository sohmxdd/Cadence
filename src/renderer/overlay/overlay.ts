type OverlayState = 'hidden' | 'listening' | 'processing' | 'done';
type CadenceMode = 'dictation' | 'command';

const pill = document.getElementById('pill') as HTMLDivElement;
const canvas = document.getElementById('waveform-canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

let currentState: OverlayState = 'hidden';
let currentMode: CadenceMode = 'dictation';
let audioLevel = 0; // 0 to 1
let animFrameId: number | null = null;
let phase = 0;

// Bar animation heights smoothing buffer
const NUM_BARS = 16;
const barHeights: number[] = new Array(NUM_BARS).fill(4);

// Receive IPC messages from main process via preload or IPC
// (In Electron Vite, we can expose window.electronAPI or listen via ipcRenderer if exposed)
if ((window as any).electronAPI) {
  (window as any).electronAPI.onOverlayState(({ state, mode }: { state: OverlayState; mode?: CadenceMode }) => {
    setState(state, mode);
  });

  (window as any).electronAPI.onAudioLevel((level: number) => {
    audioLevel = Math.min(Math.max(level, 0), 1);
  });
}

function setState(state: OverlayState, mode?: CadenceMode) {
  currentState = state;
  if (mode) currentMode = mode;

  pill.className = `pill state-${state}`;
  if (currentMode === 'command') {
    pill.classList.add('is-command-mode');
  }

  if (state === 'hidden') {
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
  } else if (!animFrameId) {
    animFrameId = requestAnimationFrame(renderLoop);
  }
}

function renderLoop() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  phase += 0.08;

  const barWidth = 4;
  const barGap = 6;
  const startX = (canvas.width - (NUM_BARS * (barWidth + barGap) - barGap)) / 2;
  const centerY = canvas.height / 2;

  // Determine bar colors and heights based on state
  let primaryColor = '#FF3B30'; // Red for listening
  if (currentState === 'processing') {
    primaryColor = '#0A84FF'; // Blue for processing
  } else if (currentState === 'done') {
    primaryColor = '#30D158'; // Green for done
  }

  for (let i = 0; i < NUM_BARS; i++) {
    let targetHeight = 4;

    if (currentState === 'listening') {
      // Dynamic bars reacting to live audio input RMS
      const wave = Math.sin(phase + i * 0.4) * 0.3 + 0.7;
      const randomNoise = (Math.random() - 0.5) * 0.15;
      targetHeight = Math.max(4, (audioLevel * 20 + 4) * wave + randomNoise * 10);
    } else if (currentState === 'processing') {
      // Smooth looping pulse wave for processing
      const wave = (Math.sin(phase * 1.5 + i * 0.35) + 1) / 2;
      targetHeight = 4 + wave * 14;
    } else if (currentState === 'done') {
      targetHeight = 6;
    }

    // Smooth moving average for bar height transitions
    barHeights[i] += (targetHeight - barHeights[i]) * 0.3;

    const h = barHeights[i];
    const x = startX + i * (barWidth + barGap);
    const y = centerY - h / 2;

    ctx.fillStyle = primaryColor;
    ctx.beginPath();
    ctx.roundRect(x, y, barWidth, h, 2);
    ctx.fill();
  }

  if (currentState !== 'hidden') {
    animFrameId = requestAnimationFrame(renderLoop);
  }
}

// Initial state
setState('hidden');
