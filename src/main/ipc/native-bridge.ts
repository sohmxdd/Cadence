import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';
import { EventEmitter } from 'node:events';
import os from 'node:os';

const LOG_FILE = path.join(os.tmpdir(), 'cadence-app.log');

function logBridge(msg: string) {
  const line = `[${new Date().toISOString()}] [NativeBridge] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {}
}

export type CadenceMode = 'dictation' | 'command';

export interface KeyPayload {
  type: 'key';
  key: string;
  vkCode: number;
  state: 'down' | 'up';
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  timestamp: number;
}

export interface ForegroundPayload {
  processName: string;
  windowTitle: string;
}

export class NativeBridge extends EventEmitter {
  private helperProcess: ChildProcess | null = null;
  private socket: net.Socket | null = null;
  private isConnecting = false;
  private buffer = '';

  // Hotkey tracking state (with key-repeat de-duplication)
  private isHoldingActivationKey = false;
  private holdStartTimestamp = 0;
  private currentMode: CadenceMode = 'dictation';
  private debounceMs = 150;

  // Pending IPC responses (promises)
  private pendingRequests = new Map<string, (data: any) => void>();

  constructor() {
    super();
  }

  public start(): void {
    this.spawnHelper();
  }

  public stop(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    if (this.helperProcess) {
      this.helperProcess.kill();
      this.helperProcess = null;
    }
  }

  private getHelperExecutablePath(): string {
    const isPackaged = app.isPackaged;
    if (isPackaged) {
      return path.join(process.resourcesPath, 'native-helper', 'CadenceHelper.exe');
    }

    const candidates = [
      path.join(app.getAppPath(), 'native-helper', 'bin', 'publish', 'CadenceHelper.exe'),
      path.join(process.cwd(), 'native-helper', 'bin', 'publish', 'CadenceHelper.exe'),
      path.join(__dirname, '../../native-helper/bin/publish/CadenceHelper.exe'),
      'c:\\Users\\SOHAM\\Cadence\\native-helper\\bin\\publish\\CadenceHelper.exe',
    ];

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        logBridge(`Found native helper executable at: ${p}`);
        return p;
      }
    }

    logBridge(`WARNING: Helper executable not found in candidates, defaulting to: ${candidates[0]}`);
    return candidates[0];
  }

  private spawnHelper(): void {
    const exePath = this.getHelperExecutablePath();
    logBridge(`Spawning native helper from: ${exePath}`);

    try {
      this.helperProcess = spawn(exePath, [], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'inherit'], // Forward stderr to main process console for logs
      });

      this.helperProcess.on('exit', (code, signal) => {
        logBridge(`[HELPER PROCESS EXIT] Helper process exited with code ${code}, signal ${signal}. Restarting in 2s...`);
        this.helperProcess = null;
        this.socket = null;
        this.isConnecting = false;
        setTimeout(() => this.spawnHelper(), 2000);
      });

      // Connect to named pipe after small delay for pipe server startup
      setTimeout(() => this.connectPipe(), 300);
    } catch (err) {
      logBridge(`[HELPER SPAWN ERROR] Failed to spawn native helper: ${err}`);
    }
  }

  private connectPipe(): void {
    if (this.isConnecting || this.socket) return;
    this.isConnecting = true;

    const pipeName = '\\\\.\\pipe\\cadence-helper';
    logBridge(`[ELECTRON PIPE CONNECTING] Attempting connection to named pipe ${pipeName}...`);

    const client = net.connect(pipeName, () => {
      logBridge('[ELECTRON PIPE CONNECTED] Successfully connected to named pipe server!');
      this.isConnecting = false;
      this.socket = client;
      this.buffer = '';

      // Test ping
      this.send({ type: 'ping' });
    });

    client.on('data', (data) => {
      const rawStr = data.toString('utf8');
      this.buffer += rawStr;
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || ''; // Keep incomplete line chunk

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        logBridge(`[ELECTRON IPC RX] ${trimmed}`);
        try {
          const parsed = JSON.parse(trimmed);
          this.handleIncomingMessage(parsed);
        } catch (e) {
          logBridge(`[ELECTRON IPC PARSE ERROR] ${trimmed}`);
        }
      }
    });

    client.on('error', (err) => {
      logBridge(`[ELECTRON PIPE ERROR] Socket error: ${err.message}`);
      this.socket = null;
      this.isConnecting = false;
    });

    client.on('close', () => {
      logBridge('[ELECTRON PIPE DISCONNECTED] Pipe connection closed');
      this.socket = null;
      this.isConnecting = false;
    });
  }

  private send(msg: any): void {
    const json = JSON.stringify(msg);
    if (this.socket && !this.socket.destroyed) {
      logBridge(`[ELECTRON IPC TX] ${json}`);
      this.socket.write(json + '\n');
    } else {
      logBridge(`[ELECTRON IPC WARNING] Cannot send message, socket disconnected: ${json}`);
    }
  }

  private handleIncomingMessage(msg: any): void {
    if (msg.type === 'ready') {
      logBridge(`[NativeBridge] Native helper ready (v${msg.version})`);
      this.emit('ready');
      return;
    }

    if (msg.type === 'pong') {
      logBridge('[NativeBridge] Received pong from native helper');
      return;
    }

    if (msg.type === 'key') {
      this.handleKeyEvent(msg as KeyPayload);
      return;
    }

    if (msg.type === 'foreground') {
      const resolver = this.pendingRequests.get('get_foreground');
      if (resolver) {
        this.pendingRequests.delete('get_foreground');
        resolver(msg);
      }
      return;
    }

    if (msg.type === 'inject_done') {
      const resolver = this.pendingRequests.get('inject');
      if (resolver) {
        this.pendingRequests.delete('inject');
        resolver(msg);
      }
      return;
    }

    if (msg.type === 'error') {
      logBridge(`[NativeBridge] Helper reported error: ${msg.message}`);
    }
  }

  private handleKeyEvent(evt: KeyPayload): void {
    const isActivationKey = evt.key === 'RIGHT CTRL';

    if (isActivationKey) {
      if (evt.state === 'down') {
        // De-duplication: Ignore OS key-repeat spam (~30ms) while holding
        if (this.isHoldingActivationKey) {
          logBridge(`[KEY REPEAT DE-DUPLICATED] Ignored auto-repeat down event for ${evt.key}`);
          return;
        }

        this.isHoldingActivationKey = true;
        this.holdStartTimestamp = Date.now();
        this.currentMode = (evt.shift) ? 'command' : 'dictation';

        logBridge(`[HOTKEY DOWN] RIGHT CTRL pressed (mode: ${this.currentMode})`);
        this.emit('hotkey-down', { mode: this.currentMode });
      } else if (evt.state === 'up') {
        if (this.isHoldingActivationKey) {
          const holdDuration = Date.now() - this.holdStartTimestamp;
          this.isHoldingActivationKey = false;

          logBridge(`[HOTKEY UP] RIGHT CTRL released (held ${holdDuration}ms)`);
          if (holdDuration >= this.debounceMs) {
            this.emit('hotkey-up', { mode: this.currentMode, duration: holdDuration });
          } else {
            logBridge(`[HOTKEY CANCEL] Duration (${holdDuration}ms) below debounce threshold (${this.debounceMs}ms)`);
            this.emit('hotkey-cancel');
          }
        }
      }
    } else if (this.isHoldingActivationKey && evt.state === 'down') {
      if (evt.key === 'LEFT SHIFT' || evt.key === 'RIGHT SHIFT') {
        if (this.currentMode !== 'command') {
          this.currentMode = 'command';
          logBridge('[MODE SWITCH] Switched to COMMAND mode via Shift key');
          this.emit('mode-change', { mode: 'command' });
        }
      }
    }
  }

  // Public methods to interact with native helper
  public async injectText(text: string, useClipboard = false): Promise<void> {
    return new Promise((resolve) => {
      this.pendingRequests.set('inject', resolve);
      this.send({ type: 'inject', text, useClipboard });
    });
  }

  public async getForegroundApp(): Promise<ForegroundPayload> {
    return new Promise((resolve) => {
      this.pendingRequests.set('get_foreground', (data) => {
        resolve({
          processName: data.processName || 'unknown',
          windowTitle: data.windowTitle || '',
        });
      });
      this.send({ type: 'get_foreground' });
    });
  }
}
