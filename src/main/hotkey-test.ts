/**
 * Cadence — Hotkey Detection Test (Phase 1, Step 1 of build order)
 *
 * Tests which keys are detectable via node-global-key-listener
 * with proper keydown/keyup events.
 *
 * Run with: npm run test:hotkey
 *
 * Results are written to hotkey-test-results.log in the project root
 * AND displayed in an Electron BrowserWindow for live feedback.
 */

import { GlobalKeyboardListener, IGlobalKeyEvent } from 'node-global-key-listener';
import { BrowserWindow, app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

// Log file path — written to project root
const LOG_FILE = path.join(app.getAppPath(), '..', '..', 'hotkey-test-results.log');

// Track key-down timestamps for hold-duration calculation
const keyDownTimestamps = new Map<string, number>();

// Keys we're specifically interested in testing
const KEYS_OF_INTEREST = new Set([
  'FN',
  'CAPS LOCK',
  'RIGHT CTRL',
  'LEFT CTRL',
  'LEFT SHIFT',
  'RIGHT SHIFT',
  'F13', 'F14', 'F15',
]);

// Accumulated log lines for file output
const logLines: string[] = [];

// Reference to the display window
let displayWindow: BrowserWindow | null = null;

function log(msg: string): void {
  const line = msg;
  logLines.push(line);
  console.log(line);

  // Also write to file immediately
  fs.appendFileSync(LOG_FILE, line + '\n');

  // Send to display window
  if (displayWindow && !displayWindow.isDestroyed()) {
    displayWindow.webContents.executeJavaScript(
      `document.getElementById('log').innerHTML += ${JSON.stringify('<div>' + escapeHtml(line) + '</div>')};
       document.getElementById('log').scrollTop = document.getElementById('log').scrollHeight;`
    ).catch(() => { /* window may be closing */ });
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function createDisplayWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 900,
    height: 600,
    title: 'Cadence — Hotkey Detection Test',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: 'Consolas', 'Courier New', monospace;
          background: #0d1117;
          color: #c9d1d9;
          padding: 20px;
        }
        h1 { color: #58a6ff; font-size: 18px; margin-bottom: 8px; }
        .instructions {
          background: #161b22;
          border: 1px solid #30363d;
          border-radius: 6px;
          padding: 12px 16px;
          margin-bottom: 16px;
          font-size: 13px;
          line-height: 1.6;
        }
        .instructions strong { color: #f0883e; }
        .instructions .key { 
          background: #21262d;
          border: 1px solid #30363d;
          border-radius: 3px;
          padding: 2px 6px;
          font-weight: bold;
          color: #79c0ff;
        }
        #log {
          background: #0d1117;
          border: 1px solid #30363d;
          border-radius: 6px;
          padding: 12px;
          height: calc(100vh - 180px);
          overflow-y: auto;
          font-size: 12px;
          line-height: 1.5;
        }
        #log div { white-space: pre; }
      </style>
    </head>
    <body>
      <h1>🎹 Cadence Hotkey Detection Test</h1>
      <div class="instructions">
        <strong>Hold each key for ~1 second then release:</strong><br/>
        <span class="key">Fn</span>
        <span class="key">CapsLock</span>
        <span class="key">Right Ctrl</span>
        <span class="key">Left/Right Shift</span><br/>
        Press <span class="key">Escape</span> to finish and print summary.
        ★ = key of interest
      </div>
      <div id="log"></div>
    </body>
    </html>
  `;

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return win;
}

// Count events per key for summary
const eventCounts = new Map<string, { down: number; up: number; holds: number[] }>();

function getOrCreateStats(keyName: string) {
  if (!eventCounts.has(keyName)) {
    eventCounts.set(keyName, { down: 0, up: 0, holds: [] });
  }
  return eventCounts.get(keyName)!;
}

export function runHotkeyTest(): void {
  // Clear previous log
  fs.writeFileSync(LOG_FILE, '=== CADENCE HOTKEY DETECTION TEST ===\n');
  fs.appendFileSync(LOG_FILE, `Started: ${new Date().toISOString()}\n\n`);

  // Create display window
  displayWindow = createDisplayWindow();

  // Small delay to let the window load before starting the listener
  setTimeout(() => {
    const keyboard = new GlobalKeyboardListener();

    log('Listening for ALL keyboard events system-wide...');
    log('Hold each key ~1s then release. Press Escape to finish.');
    log('─'.repeat(70));

    keyboard.addListener((e: IGlobalKeyEvent) => {
      const keyName = e.name || `UNKNOWN_${e.vKey}`;
      const isDown = e.state === 'DOWN';
      const isUp = e.state === 'UP';
      const isInteresting = KEYS_OF_INTEREST.has(keyName.toUpperCase());
      const stats = getOrCreateStats(keyName);
      const timestamp = new Date().toISOString().split('T')[1].slice(0, 12);

      if (isDown) {
        if (!keyDownTimestamps.has(keyName)) {
          keyDownTimestamps.set(keyName, Date.now());
          stats.down++;

          const prefix = isInteresting ? '★ ' : '  ';
          log(`${prefix}${timestamp} [DOWN] ${keyName} (vKey: ${e.vKey})`);
        }
      }

      if (isUp) {
        const downTime = keyDownTimestamps.get(keyName);
        keyDownTimestamps.delete(keyName);
        stats.up++;

        let holdInfo = '';
        if (downTime) {
          const holdMs = Date.now() - downTime;
          stats.holds.push(holdMs);
          const tag = holdMs < 150 ? '⚡ < debounce' : '✓ viable';
          holdInfo = ` — hold: ${holdMs}ms (${tag})`;
        }

        const prefix = isInteresting ? '★ ' : '  ';
        log(`${prefix}${timestamp} [UP  ] ${keyName} (vKey: ${e.vKey})${holdInfo}`);
      }

      // Escape stops the test
      if (keyName.toUpperCase() === 'ESCAPE' && isDown) {
        log('\n' + '─'.repeat(70));
        log('\n=== SUMMARY ===\n');

        // Summary of keys of interest
        for (const targetKey of KEYS_OF_INTEREST) {
          const data = eventCounts.get(targetKey) || eventCounts.get(targetKey.toLowerCase());
          if (data && data.down > 0) {
            const avgHold = data.holds.length > 0
              ? Math.round(data.holds.reduce((a, b) => a + b, 0) / data.holds.length)
              : 0;
            const hasUp = data.up > 0;
            const viable = hasUp && data.holds.some(h => h >= 150);
            log(`  ${targetKey}: ${data.down} down, ${data.up} up, avg hold: ${avgHold}ms ${viable ? '✅ VIABLE' : '❌ NOT VIABLE'}`);
          } else {
            log(`  ${targetKey}: ❌ NOT DETECTED`);
          }
        }

        // Check for Fn specifically
        log('');
        const fnData = eventCounts.get('FN') || eventCounts.get('Fn');
        if (!fnData || fnData.down === 0) {
          log('⚠ Fn key was NOT detected — invisible to OS (embedded controller).');
          log('  → Recommend CapsLock (held) or Right Ctrl as activation key.');
        } else {
          log('✓ Fn key WAS detected! Can be used as activation key.');
        }

        log('\nResults saved to: hotkey-test-results.log');
        log('Close this window when done reviewing.');

        keyboard.kill();
      }
    });
  }, 1000);
}
