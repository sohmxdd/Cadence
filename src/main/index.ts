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

// Pipeline engines
const sttEngine = new STTEngine();
const llmEngine = new LLMEngine();

// App profiles config
let profilesConfig: any = {};
const profilesPath = path.join(process.cwd(), 'config', 'profiles.json');
try {
  if (fs.existsSync(profilesPath)) {
    profilesConfig = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
  }
} catch (e) {
  console.warn('[Cadence] Could not load profiles.json config:', e);
}

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

function updateOverlayState(state: 'hidden' | 'listening' | 'processing' | 'done' | 'cancelled', mode?: CadenceMode, text?: string) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  logApp(`[Overlay State Change] state=${state}, mode=${mode}, text=${text}`);

  if (state === 'hidden') {
    overlayWindow.webContents.send('overlay-state', { state, mode, text });
    setTimeout(() => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.hide();
      }
    }, 220);
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

  nativeBridge.on('mode-change', ({ mode }: { mode: CadenceMode }) => {
    if (isPaused) return;
    logApp(`✨ [MODE SWITCH] Switched to: ${mode.toUpperCase()}`);
    updateOverlayState('listening', mode);
  });

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
    logApp(`Audio capture stopped, ${totalBytesCaptured} bytes captured`);

    // Transition overlay to processing state
    updateOverlayState('processing', mode);

    // Process audio buffer
    if (audioChunks.length === 0) {
      logApp('[Cadence] Audio buffer empty, skipping transcription.');
      updateOverlayState('hidden');
      isPipelineBusy = false;
      return;
    }

    const tempWavPath = path.join(os.tmpdir(), `cadence_rec_${Date.now()}.wav`);
    sttEngine.saveWavFile(audioChunks, tempWavPath);

    let resultText = '';

    try {
      // 1. Speech to text via whisper.cpp
      const rawTranscript = await sttEngine.transcribe(tempWavPath);

      if (!rawTranscript || !rawTranscript.trim() || rawTranscript.includes('missing')) {
        logApp(`[STT Output Warning] ${rawTranscript}`);
        updateOverlayState('hidden');
        return;
      }

      // 2. Resolve per-app profile prompt override
      const appProcess = (cachedFgApp?.processName || '').toLowerCase();
      const profile = profilesConfig.profiles?.[`${appProcess}.exe`] || profilesConfig.profiles?.[appProcess] || profilesConfig.default;
      const promptOverride = profile?.promptOverride;

      // 3. LLM Cleanup / Command execution via Ollama
      if (mode === 'command') {
        resultText = await llmEngine.processCommand(rawTranscript, '');
      } else {
        resultText = await llmEngine.cleanDictation(rawTranscript, promptOverride);
      }

      // 4. Inject finalized text — C# helper will restore window focus via stored HWND
      if (resultText && resultText.trim()) {
        logApp(`Injecting text (${resultText.length} chars): "${resultText.substring(0, 80)}${resultText.length > 80 ? '...' : ''}"`);
        await nativeBridge?.injectText(resultText);
        updateOverlayState('done', mode);
      } else {
        updateOverlayState('hidden');
      }
    } catch (err) {
      logApp(`[Pipeline Error] ${err}`);
      updateOverlayState('hidden');
    } finally {
      try {
        if (fs.existsSync(tempWavPath)) fs.unlinkSync(tempWavPath);
      } catch (e) {}
      isPipelineBusy = false;
    }

    // Hide overlay window after brief delay
    setTimeout(() => {
      updateOverlayState('hidden');
    }, 600);
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
