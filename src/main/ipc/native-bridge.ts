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

  // Hotkey tracking state
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
    // Dev path relative to project root
    return path.join(process.cwd(), 'native-helper', 'bin', 'publish', 'CadenceHelper.exe');
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
        logBridge(`Helper process exited with code ${code}, signal ${signal}. Restarting in 2s...`);
        this.helperProcess = null;
        this.socket = null;
        setTimeout(() => this.spawnHelper(), 2000);
      });

      // Connect to named pipe after small delay for pipe server startup
      setTimeout(() => this.connectPipe(), 300);
    } catch (err) {
      logBridge(`Failed to spawn native helper: ${err}`);
    }
  }

  private connectPipe(): void {
    if (this.isConnecting || this.socket) return;
    this.isConnecting = true;

    const pipeName = '\\\\.\\pipe\\cadence-helper';
    logBridge(`Connecting to named pipe ${pipeName}...`);

    const client = net.connect(pipeName, () => {
      logBridge('Connected to named pipe server!');
      this.isConnecting = false;
      this.socket = client;
      this.buffer = '';

      // Test ping
      this.send({ type: 'ping' });
    });

    client.on('data', (data) => {
      this.buffer += data.toString('utf8');
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || ''; // Keep incomplete line chunk

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          this.handleIncomingMessage(parsed);
        } catch (e) {
          console.error('[NativeBridge] Failed to parse JSON message:', trimmed);
        }
      }
    });

    client.on('error', (err) => {
      console.warn(`[NativeBridge] Pipe socket error: ${err.message}`);
      this.isConnecting = false;
    });

    client.on('close', () => {
      console.log('[NativeBridge] Pipe connection closed');
      this.socket = null;
      this.isConnecting = false;
    });
  }

  private send(msg: any): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(JSON.stringify(msg) + '\n');
    } else {
      console.warn('[NativeBridge] Cannot send message, socket not connected');
    }
  }

  private handleIncomingMessage(msg: any): void {
    if (msg.type === 'ready') {
      console.log(`[NativeBridge] Native helper ready (v${msg.version})`);
      this.emit('ready');
      return;
    }

    if (msg.type === 'pong') {
      console.log('[NativeBridge] Received pong from native helper');
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
      console.error('[NativeBridge] Helper reported error:', msg.message);
    }
  }

  private handleKeyEvent(evt: KeyPayload): void {
    // Lock in: RIGHT CTRL as activation key
    // Command mode: RIGHT CTRL + SHIFT (either Shift key)
    const isActivationKey = evt.key === 'RIGHT CTRL';

    if (isActivationKey) {
      if (evt.state === 'down') {
        if (!this.isHoldingActivationKey) {
          this.isHoldingActivationKey = true;
          this.holdStartTimestamp = Date.now();
          this.currentMode = (evt.shift) ? 'command' : 'dictation';

          console.log(`[NativeBridge] Activation key DOWN (mode: ${this.currentMode})`);
          this.emit('hotkey-down', { mode: this.currentMode });
        }
      } else if (evt.state === 'up') {
        if (this.isHoldingActivationKey) {
          const holdDuration = Date.now() - this.holdStartTimestamp;
          this.isHoldingActivationKey = false;

          console.log(`[NativeBridge] Activation key UP (held ${holdDuration}ms)`);
          if (holdDuration >= this.debounceMs) {
            this.emit('hotkey-up', { mode: this.currentMode, duration: holdDuration });
          } else {
            console.log(`[NativeBridge] Hold duration (${holdDuration}ms) below debounce threshold (${this.debounceMs}ms), ignoring tap.`);
            this.emit('hotkey-cancel');
          }
        }
      }
    } else if (this.isHoldingActivationKey && evt.state === 'down') {
      // If user presses Shift while holding Right Ctrl, upgrade to command mode!
      if (evt.key === 'LEFT SHIFT' || evt.key === 'RIGHT SHIFT') {
        if (this.currentMode !== 'command') {
          this.currentMode = 'command';
          console.log('[NativeBridge] Switched to COMMAND mode via Shift key');
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
