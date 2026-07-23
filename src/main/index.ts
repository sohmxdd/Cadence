import { app, BrowserWindow, screen, ipcMain, Tray, Menu, nativeImage, shell } from 'electron';
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

declare const OVERLAY_WINDOW_VITE_DEV_SERVER_URL: string;
declare const OVERLAY_WINDOW_VITE_NAME: string;
declare const AUDIO_WINDOW_VITE_DEV_SERVER_URL: string;
declare const AUDIO_WINDOW_VITE_NAME: string;

let nativeBridge: NativeBridge | null = null;
let overlayWindow: BrowserWindow | null = null;
let audioWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isPaused = false;

// Settings & profiles config
let settingsConfig: any = {};
let profilesConfig: any = {};

const isAppPackaged = app ? app.isPackaged : false;
const baseConfigDir = isAppPackaged ? process.resourcesPath : process.cwd();

const settingsPath = path.join(baseConfigDir, 'config', 'settings.json');
const profilesPath = path.join(baseConfigDir, 'config', 'profiles.json');

try {
  if (fs.existsSync(settingsPath)) {
    settingsConfig = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  }
} catch (e) {
  console.warn('[Cadence] Could not load settings.json config:', e);
}

try {
  if (fs.existsSync(profilesPath)) {
    profilesConfig = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
  }
} catch (e) {
  console.warn('[Cadence] Could not load profiles.json config:', e);
}

// Pipeline engines initialized with settings.json configuration
const sttEngine = new STTEngine({
  whisperBinaryPath: settingsConfig?.whisper?.binaryPath || undefined,
  modelPath: settingsConfig?.whisper?.modelPath ? path.resolve(baseConfigDir, settingsConfig.whisper.modelPath) : undefined,
});

const llmEngine = new LLMEngine({
  ollamaUrl: settingsConfig?.ollama?.url,
  dictationModel: settingsConfig?.ollama?.dictationModel,
  commandModel: settingsConfig?.ollama?.commandModel,
  timeoutMs: settingsConfig?.ollama?.timeoutMs,
});

// Audio recording buffer (PCM 16-bit 16kHz)
const audioChunks: Buffer[] = [];
let isRecording = false;

const LOG_FILE = path.join(os.tmpdir(), 'cadence-app.log');
function logApp(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {}
}

process.on('uncaughtException', (err) => {
  logApp(`CRITICAL UNCAUGHT EXCEPTION: ${err.stack || err}`);
});

process.on('unhandledRejection', (reason) => {
  logApp(`UNHANDLED REJECTION: ${reason}`);
});

function createTrayIcon(): ReturnType<typeof nativeImage.createFromBuffer> {
  const isPackaged = app ? app.isPackaged : false;
  const candidates = isPackaged
    ? [
        path.join(process.resourcesPath, 'assets', 'tray.png'),
        path.join(process.resourcesPath, 'tray.png'),
      ]
    : [
        path.join(process.cwd(), 'assets', 'tray.png'),
        path.join(app.getAppPath(), 'assets', 'tray.png'),
      ];

  for (const iconPath of candidates) {
    if (fs.existsSync(iconPath)) {
      logApp(`[Tray] Loaded custom tray icon from: ${iconPath}`);
      return nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    }
  }

  logApp('[Tray] Custom tray icon not found, using empty nativeImage.');
  return nativeImage.createEmpty();
}

/**
 * Overlay Window (Top-Center Floating Pill)
 * Hidden (show: false) when idle. ONLY shown when hotkey is held.
 */
const createOverlayWindow = () => {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width } = primaryDisplay.bounds;

  const overlayWidth = 320;
  const overlayHeight = 60;
  const x = Math.round((width - overlayWidth) / 2);
  const y = 14; // Top center position

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
    show: false, // Strictly hidden when idle
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  overlayWindow.setIgnoreMouseEvents(true);
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');

  logApp(`Overlay window created, bounds: x=${x}, y=${y}, width=${overlayWidth}, height=${overlayHeight}`);

  const overlayUrl = OVERLAY_WINDOW_VITE_DEV_SERVER_URL
    ? `${OVERLAY_WINDOW_VITE_DEV_SERVER_URL}/src/renderer/overlay/index.html`
    : path.join(__dirname, `../renderer/${OVERLAY_WINDOW_VITE_NAME}/src/renderer/overlay/index.html`);

  logApp(`[Overlay Target URL] ${overlayUrl}`);

  overlayWindow.webContents.on('did-fail-load', (_e, code, desc, validatedUrl) => {
    logApp(`[Overlay Window Load Failure] ${code} ${desc} - ${validatedUrl}`);
  });

  overlayWindow.webContents.on('did-finish-load', () => {
    logApp(`[Overlay Window Load Success] Loaded: ${overlayWindow?.webContents.getURL()}`);
  });

  if (OVERLAY_WINDOW_VITE_DEV_SERVER_URL) {
    overlayWindow.loadURL(overlayUrl);
  } else {
    overlayWindow.loadFile(overlayUrl);
  }
};

/**
 * Hidden Audio Capture Window
 */
const createAudioWindow = () => {
  audioWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  const audioUrl = AUDIO_WINDOW_VITE_DEV_SERVER_URL
    ? `${AUDIO_WINDOW_VITE_DEV_SERVER_URL}/src/renderer/audio/index.html`
    : path.join(__dirname, `../renderer/${AUDIO_WINDOW_VITE_NAME}/src/renderer/audio/index.html`);

  logApp(`[Audio Target URL] ${audioUrl}`);

  audioWindow.webContents.on('did-fail-load', (_e, code, desc, validatedUrl) => {
    logApp(`[Audio Window Load Failure] ${code} ${desc} - ${validatedUrl}`);
  });

  audioWindow.webContents.on('did-finish-load', () => {
    logApp(`[Audio Window Load Success] Loaded: ${audioWindow?.webContents.getURL()}`);
  });

  if (AUDIO_WINDOW_VITE_DEV_SERVER_URL) {
    audioWindow.loadURL(audioUrl);
  } else {
    audioWindow.loadFile(audioUrl);
  }
};

/**
 * Create System Tray Icon & Context Menu
 */
const createSystemTray = () => {
  const icon = createTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('Cadence — Local Voice Control (Active)');

  const buildContextMenu = () => {
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Cadence Local Voice Control', enabled: false },
      { type: 'separator' },
      { label: 'Dictation Mode: Hold Right Ctrl', enabled: false },
      { label: 'Command Mode: Hold Right Ctrl + Shift', enabled: false },
      { type: 'separator' },
      {
        label: isPaused ? 'Resume Hotkeys' : 'Pause Hotkeys',
        click: () => {
          isPaused = !isPaused;
          tray?.setToolTip(`Cadence — Local Voice Control (${isPaused ? 'Paused' : 'Active'})`);
          buildContextMenu();
          logApp(`[Tray Menu] Hotkeys ${isPaused ? 'Paused' : 'Resumed'}`);
        },
      },
      { type: 'separator' },
      {
        label: 'View Application Log',
        click: () => {
          if (fs.existsSync(LOG_FILE)) {
            shell.openPath(LOG_FILE);
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Quit Cadence',
        click: () => {
          logApp('Quit requested from System Tray menu.');
          nativeBridge?.stop();
          app.quit();
        },
      },
    ]);
    tray?.setContextMenu(contextMenu);
  };

  buildContextMenu();
};

function updateOverlayState(state: 'hidden' | 'listening' | 'processing' | 'done' | 'cancelled' | 'error', mode?: CadenceMode, text?: string) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  logApp(`[Overlay State Change] state=${state}, mode=${mode}, text=${text}`);

  if (state === 'hidden') {
    overlayWindow.webContents.send('overlay-state', { state, mode, text });
    setTimeout(() => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.hide();
      }
    }, 220);
  } else if (state === 'error') {
    if (!overlayWindow.isVisible()) {
      overlayWindow.showInactive();
    }
    overlayWindow.webContents.send('overlay-state', { state, mode, text });
    setTimeout(() => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        updateOverlayState('hidden');
      }
    }, 1800);
  } else {
    if (!overlayWindow.isVisible()) {
      logApp('Overlay window showInactive() called');
      overlayWindow.showInactive();
    }
    overlayWindow.webContents.send('overlay-state', { state, mode, text });
  }
}

app.on('ready', () => {
  logApp('=== CADENCE BACKGROUND SERVICE STARTED ===');

  createOverlayWindow();
  createAudioWindow();
  createSystemTray();

  // Handle incoming audio error
  ipcMain.on('audio-error', (_event, errorMsg: string) => {
    logApp(`⚠️ [Audio Capture Error] ${errorMsg}`);
    updateOverlayState('error', 'dictation', 'Microphone Error');
  });

  // Handle incoming PCM audio chunks from hidden renderer
  ipcMain.on('audio-chunk', (_event, arrayBuffer: ArrayBuffer, rms: number) => {
    if (isRecording) {
      audioChunks.push(Buffer.from(arrayBuffer));
      if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
        overlayWindow.webContents.send('audio-level', rms);
      }
    }
  });

  // Initialize Native C# Helper Bridge
  nativeBridge = new NativeBridge();
  nativeBridge.start();

  nativeBridge.on('ready', async () => {
    logApp('✓ Native C# Helper Hook connected and listening on named pipe');
  });

  // Pipeline lock to prevent concurrent overlapping executions
  let isPipelineBusy = false;
  let cachedFgApp: { processName: string; windowTitle: string } | null = null;
  let cachedSelectedText = '';

  nativeBridge.on('hotkey-down', async ({ mode }: { mode: CadenceMode }) => {
    if (isPaused) {
      logApp('⏸️ [HOTKEY DOWN] Hotkeys are paused from tray menu, ignoring.');
      return;
    }
    if (isPipelineBusy) {
      logApp('⚠️ [HOTKEY DOWN] Pipeline is busy processing, ignoring press.');
      return;
    }

    logApp(`🎤 [HOTKEY DOWN] Recording started (${mode.toUpperCase()} mode)`);

    // Capture the target application & control HWND immediately at the instant of hotkey-down,
    // BEFORE the overlay window is shown at all.
    cachedFgApp = await nativeBridge?.getForegroundApp() || null;
    logApp(`[Target Window Captured at Hotkey-Down] ${cachedFgApp?.processName} ("${cachedFgApp?.windowTitle}")`);

    if (mode === 'command') {
      cachedSelectedText = await nativeBridge?.getSelectedText() || '';
      logApp(`[Selection Captured at Hotkey-Down] ${cachedSelectedText.length} chars: "${cachedSelectedText.substring(0, 60)}"`);
    } else {
      cachedSelectedText = '';
    }

    isRecording = true;
    audioChunks.length = 0; // Clear previous audio buffer

    // Show overlay pill in listening state
    updateOverlayState('listening', mode);

    // Trigger mic capture in hidden audio renderer
    if (audioWindow && !audioWindow.isDestroyed()) {
      logApp('Audio capture started');
      audioWindow.webContents.executeJavaScript('window.startAudioCapture && window.startAudioCapture()');
    }
  });

  nativeBridge.on('mode-change', async ({ mode }: { mode: CadenceMode }) => {
    if (isPaused) return;
    logApp(`✨ [MODE SWITCH] Switched to: ${mode.toUpperCase()}`);
    if (mode === 'command' && !cachedSelectedText) {
      cachedSelectedText = await nativeBridge?.getSelectedText() || '';
      logApp(`[Selection Captured at Mode-Switch] ${cachedSelectedText.length} chars: "${cachedSelectedText.substring(0, 60)}"`);
    }
    updateOverlayState('listening', mode);
  });

function computeAudioMetrics(pcmChunks: Buffer[]): { durationMs: number; rms: number } {
  const totalBytes = pcmChunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const totalSamples = Math.floor(totalBytes / 2);
  const durationMs = Math.round((totalSamples / 16000) * 1000);

  if (totalSamples === 0) return { durationMs: 0, rms: 0 };

  let sumSquare = 0;
  for (const chunk of pcmChunks) {
    for (let i = 0; i < chunk.length - 1; i += 2) {
      const sample = chunk.readInt16LE(i) / 32768.0;
      sumSquare += sample * sample;
    }
  }

  const rms = Math.sqrt(sumSquare / totalSamples);
  return { durationMs, rms };
}

  nativeBridge.on('hotkey-up', async ({ mode, duration }: { mode: CadenceMode; duration: number }) => {
    if (isPaused) return;
    if (isPipelineBusy) {
      logApp('⚠️ [HOTKEY UP] Pipeline already busy, skipping.');
      return;
    }
    isPipelineBusy = true;

    logApp(`⏹️ [HOTKEY UP] Released (${duration}ms hold). Processing speech...`);
    isRecording = false;

    // Stop mic capture
    if (audioWindow && !audioWindow.isDestroyed()) {
      audioWindow.webContents.executeJavaScript('window.stopAudioCapture && window.stopAudioCapture()');
    }

    const totalBytesCaptured = audioChunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const { durationMs, rms } = computeAudioMetrics(audioChunks);
    logApp(`Audio capture stopped: ${totalBytesCaptured} bytes, ${durationMs}ms duration, RMS ${rms.toFixed(4)}`);

    // Transition overlay to processing state
    updateOverlayState('processing', mode);

    // Process audio buffer threshold check
    if (audioChunks.length === 0 || durationMs < 350 || rms < 0.005) {
      logApp(`[Cadence] Audio discarded (duration ${durationMs}ms < 350ms or RMS ${rms.toFixed(4)} < 0.005). Skipping STT.`);
      updateOverlayState('hidden');
      isPipelineBusy = false;
      return;
    }

    const tempWavPath = path.join(os.tmpdir(), `cadence_rec_${Date.now()}.wav`);
    sttEngine.saveWavFile(audioChunks, tempWavPath);

    let resultText = '';

    try {
      // ── Stage 1: Speech-to-Text ────────────────────────────────────────────
      logApp('[Stage 1/4] STT: Transcribing audio with whisper.cpp...');
      const rawTranscript = await sttEngine.transcribe(tempWavPath);
      logApp(`[Stage 1/4] STT complete. Raw transcript: "${(rawTranscript || '').substring(0, 120)}"`);

      if (rawTranscript && rawTranscript.includes('missing')) {
        logApp(`[Stage 1/4] STT binary/model missing error — showing error overlay.`);
        updateOverlayState('error', mode, 'Whisper Binary Missing');
        return;
      }

      if (!rawTranscript || !rawTranscript.trim()) {
        logApp('[Stage 1/4] STT returned empty transcript — no speech detected, hiding overlay.');
        updateOverlayState('hidden');
        return;
      }

      // ── Stage 2: Per-App Profile Resolution ───────────────────────────────
      const appProcess = (cachedFgApp?.processName || '').toLowerCase();
      const profile = profilesConfig.profiles?.[`${appProcess}.exe`] || profilesConfig.profiles?.[appProcess] || profilesConfig.default;
      const promptOverride = profile?.promptOverride;
      logApp(`[Stage 2/4] Profile resolved for "${appProcess || 'default'}". PromptOverride: ${promptOverride ? 'yes' : 'none'}`);

      // ── Stage 3: LLM Cleanup / Command Execution via Ollama ───────────────
      try {
        if (mode === 'command') {
          logApp(`[Stage 3/4] LLM Command mode — Instruction: "${rawTranscript}" | SelectedText (${cachedSelectedText.length} chars): "${cachedSelectedText.substring(0, 60)}"`);
          resultText = await llmEngine.processCommand(rawTranscript, cachedSelectedText);
        } else {
          logApp(`[Stage 3/4] LLM Dictation mode — sending raw transcript to Ollama for cleanup...`);
          resultText = await llmEngine.cleanDictation(rawTranscript, promptOverride);
        }
        logApp(`[Stage 3/4] LLM complete. resultText (${resultText?.length ?? 0} chars): "${(resultText || '').substring(0, 120)}"`);
      } catch (llmErr: any) {
        logApp(`[Stage 3/4] LLM call threw: ${llmErr?.message || llmErr}`);
        updateOverlayState('error', mode, 'Ollama Offline');
        return;
      }

      // ── Stage 4: Text Injection ───────────────────────────────────────────
      if (resultText && resultText.trim()) {
        logApp(`[Stage 4/4] Injecting ${resultText.length} chars into foreground window...`);
        try {
          await nativeBridge?.injectText(resultText);
          logApp(`[Stage 4/4] Injection complete — showing done overlay.`);
          updateOverlayState('done', mode);
          // Auto-hide after brief done state
          setTimeout(() => { updateOverlayState('hidden'); }, 1200);
        } catch (injErr: any) {
          logApp(`[Stage 4/4] Injection failed: ${injErr?.message || injErr}`);
          updateOverlayState('error', mode, 'Injection Failed');
        }
      } else {
        // LLM returned empty text after sanitization — this is unexpected, show error
        logApp(`[Stage 4/4] LLM returned empty/blank resultText after sanitization. Raw transcript was: "${rawTranscript}". Showing error overlay.`);
        updateOverlayState('error', mode, 'No Output');
      }
    } catch (err) {
      logApp(`[Pipeline Error] Unhandled exception in pipeline: ${err}`);
      updateOverlayState('error', mode, 'Pipeline Error');
    } finally {
      try {
        if (fs.existsSync(tempWavPath)) fs.unlinkSync(tempWavPath);
      } catch (e) {}
      isPipelineBusy = false;
    }
  });

  nativeBridge.on('hotkey-cancel', () => {
    logApp('⚡ Quick tap detected (<150ms debounce), ignoring.');
    isRecording = false;
    updateOverlayState('hidden');
  });
});

app.on('window-all-closed', () => {
  // Pure background service — keep running in system tray
});

app.on('before-quit', () => {
  nativeBridge?.stop();
});
