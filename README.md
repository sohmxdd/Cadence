# Cadence

**Fully local voice dictation and AI text-command tool for Windows.**

Cadence lets you hold a hotkey anywhere in Windows to speak, and have your speech transcribed, cleaned up by a local LLM, and typed into whatever text field is currently focused. A modifier switches to command mode, where your speech is treated as an instruction to transform existing text.

Everything runs locally — no cloud, no subscriptions, no data leaving your machine.

## Features

- 🎙️ **Push-to-talk dictation** — hold a key, speak, release → cleaned text appears at your cursor
- 🤖 **AI text commands** — hold key + Shift → speak an instruction → transforms selected text
- 🔒 **Fully local** — whisper.cpp for STT, Ollama for LLM, no cloud calls
- 🖥️ **System-wide** — works in any app: browser, editor, email, terminal
- 🎨 **Minimal overlay** — floating pill with live waveform, zero distraction

## Tech Stack

- **Electron** — UI + orchestration
- **whisper.cpp** — local speech-to-text
- **Ollama** — local LLM for text cleanup/commands
- **C# native helper** — global keyboard hook + SendInput text injection
- **Silero VAD + RNNoise** — voice activity detection + noise suppression

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm start

# Run hotkey detection test (Phase 1)
npm run test:hotkey

# Package for distribution
npm run make
```

## Project Structure

```
cadence/
├── src/
│   ├── main/           # Electron main process
│   │   ├── index.ts    # Entry point, app lifecycle
│   │   ├── ipc/        # IPC handlers
│   │   └── pipeline/   # STT, LLM, VAD modules
│   └── renderer/       # Renderer processes
│       ├── overlay/    # Floating pill UI
│       ├── audio/      # Hidden audio capture
│       └── settings/   # Settings window
├── native-helper/      # C# console app (keyboard hook + SendInput)
├── assets/             # Icons, tray icon
├── models/             # Whisper models (gitignored)
└── config/             # User configuration
```

## License

MIT
