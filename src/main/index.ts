import { app, BrowserWindow, screen, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import started from 'electron-squirrel-startup';
import { NativeBridge, CadenceMode } from './ipc/native-bridge';
import { STTEngine } from './pipeline/stt';
import { LLMEngine } from './pipeline/llm';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;
declare const OVERLAY_WINDOW_VITE_DEV_SERVER_URL: string;
declare const OVERLAY_WINDOW_VITE_NAME: string;
declare const AUDIO_WINDOW_VITE_DEV_SERVER_URL: string;
declare const AUDIO_WINDOW_VITE_NAME: string;

let nativeBridge: NativeBridge | null = null;
let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let audioWindow: BrowserWindow | null = null;

// Pipeline engines
const sttEngine = new STTEngine();
const llmEngine = new LLMEngine();

// App profiles config
let profilesConfig: any = {};
try {
  const profilesPath = path.join(process.cwd(), 'config', 'profiles.json');
  if (fs.existsSync(profilesPath)) {
    profilesConfig = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
  }
} catch (e) {
  console.warn('[Cadence] Could not load profiles.json config:', e);
}

// Audio recording buffer (PCM 16-bit 16kHz)
const audioChunks: Buffer[] = [];
let isRecording = false;

const LOG_FILE = path.join(process.cwd(), 'cadence-app.log');
function logApp(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {}
}

const createMainWindow = () => {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
};

const createOverlayWindow = () => {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width } = primaryDisplay.bounds;

  const overlayWidth = 320;
  const overlayHeight = 60;
  const x = Math.round((width - overlayWidth) / 2);
  const y = 12; // Top center, flush below top edge per user screenshot reference

  overlayWindow = new BrowserWindow({
    width: overlayWidth,
    height: overlayHeight,
    x,
    y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Critical: Never steal focus from whatever app the user is dictating into
  overlayWindow.setIgnoreMouseEvents(true);
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');

  if (OVERLAY_WINDOW_VITE_DEV_SERVER_URL) {
    overlayWindow.loadURL(`${OVERLAY_WINDOW_VITE_DEV_SERVER_URL}/src/renderer/overlay/index.html`);
  } else {
    overlayWindow.loadFile(
      path.join(__dirname, `../renderer/${OVERLAY_WINDOW_VITE_NAME}/src/renderer/overlay/index.html`),
    );
  }
};

const createAudioWindow = () => {
  audioWindow = new BrowserWindow({
    show: false, // Hidden background window
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (AUDIO_WINDOW_VITE_DEV_SERVER_URL) {
    audioWindow.loadURL(`${AUDIO_WINDOW_VITE_DEV_SERVER_URL}/src/renderer/audio/index.html`);
  } else {
    audioWindow.loadFile(
      path.join(__dirname, `../renderer/${AUDIO_WINDOW_VITE_NAME}/src/renderer/audio/index.html`),
    );
  }
};

function updateOverlayState(state: 'hidden' | 'listening' | 'processing' | 'done', mode?: CadenceMode) {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay-state', { state, mode });
  }
}

app.on('ready', () => {
  logApp('=== CADENCE APP STARTING ===');

  createMainWindow();
  createOverlayWindow();
  createAudioWindow();

  // Handle incoming PCM audio chunks from hidden renderer
  ipcMain.on('audio-chunk', (_event, arrayBuffer: ArrayBuffer, rms: number) => {
    if (isRecording) {
      audioChunks.push(Buffer.from(arrayBuffer));
      // Stream live audio level to overlay for reactive waveform animation
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('audio-level', rms);
      }
    }
  });

  // Initialize Native C# Helper Bridge
  nativeBridge = new NativeBridge();
  nativeBridge.start();

  nativeBridge.on('ready', async () => {
    logApp('✓ Native Bridge connected and ready!');
    const fg = await nativeBridge?.getForegroundApp();
    logApp(`[Cadence] Focused app on launch: ${fg?.processName} ("${fg?.windowTitle}")`);
  });

  nativeBridge.on('hotkey-down', ({ mode }: { mode: CadenceMode }) => {
    logApp(`🎤 [HOTKEY DOWN] Starting recording (mode: ${mode.toUpperCase()})`);
    isRecording = true;
    audioChunks.length = 0; // Clear previous audio buffer

    // Show overlay pill in listening state
    updateOverlayState('listening', mode);

    // Trigger mic capture in audio renderer
    if (audioWindow && !audioWindow.isDestroyed()) {
      audioWindow.webContents.executeJavaScript('window.startAudioCapture && window.startAudioCapture()');
    }
  });

  nativeBridge.on('mode-change', ({ mode }: { mode: CadenceMode }) => {
    logApp(`✨ [MODE SWITCH] Switched to: ${mode.toUpperCase()}`);
    updateOverlayState('listening', mode);
  });

  nativeBridge.on('hotkey-up', async ({ mode, duration }: { mode: CadenceMode; duration: number }) => {
    logApp(`⏹️ [HOTKEY UP] Stopped (${duration}ms, mode: ${mode.toUpperCase()})`);
    isRecording = false;

    // Stop mic capture
    if (audioWindow && !audioWindow.isDestroyed()) {
      audioWindow.webContents.executeJavaScript('window.stopAudioCapture && window.stopAudioCapture()');
    }

    // Transition overlay to processing state (blue looping animation)
    updateOverlayState('processing', mode);

    // Get target foreground window info
    const fgApp = await nativeBridge?.getForegroundApp();
    logApp(`[Cadence] Target window: ${fgApp?.processName} ("${fgApp?.windowTitle}")`);

    // Process audio buffer
    if (audioChunks.length === 0) {
      logApp('[Cadence] Audio buffer empty, skipping transcription.');
      updateOverlayState('hidden');
      return;
    }

    const tempWavPath = path.join(os.tmpdir(), `cadence_rec_${Date.now()}.wav`);
    sttEngine.saveWavFile(audioChunks, tempWavPath);

    let resultText = '';

    try {
      // 1. Speech to text via whisper.cpp
      const rawTranscript = await sttEngine.transcribe(tempWavPath);
      logApp(`[Cadence] STT Raw output: "${rawTranscript}"`);

      // 2. Resolve per-app profile prompt override
      const appProcess = (fgApp?.processName || '').toLowerCase();
      const profile = profilesConfig.profiles?.[`${appProcess}.exe`] || profilesConfig.profiles?.[appProcess] || profilesConfig.default;
      const promptOverride = profile?.promptOverride;

      // 3. LLM Cleanup / Command execution via Ollama
      if (mode === 'command') {
        resultText = await llmEngine.processCommand(rawTranscript, '');
      } else {
        resultText = await llmEngine.cleanDictation(rawTranscript, promptOverride);
      }

      logApp(`[Cadence] Final text to inject: "${resultText}"`);

      // 4. Inject finalized text into focused application
      if (resultText && resultText.trim()) {
        await nativeBridge?.injectText(resultText);
      }
    } catch (err) {
      logApp(`[Cadence] Pipeline processing error: ${err}`);
    } finally {
      // Clean up temp audio file
      try {
        if (fs.existsSync(tempWavPath)) fs.unlinkSync(tempWavPath);
      } catch (e) {}
    }

    // Show done state briefly then hide
    updateOverlayState('done', mode);
    setTimeout(() => {
      updateOverlayState('hidden');
    }, 400);
  });

  nativeBridge.on('hotkey-cancel', () => {
    logApp('⚡ [HOTKEY CANCEL] Key press below 150ms debounce threshold');
    isRecording = false;
    updateOverlayState('hidden');
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    nativeBridge?.stop();
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});
