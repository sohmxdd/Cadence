# Cadence

> **Ultra-Fast, 100% Local Voice Dictation & Generative AI Command Engine for Windows**

Cadence delivers system-wide voice intelligence to **every text field in Windows**. Hold down a hotkey anywhere—whether inside VS Code, Word, Discord, Chrome, or terminal—speak naturally, and watch your voice transform into pristine, publication-grade text or rich generative AI content inserted directly at your cursor.

Zero cloud APIs. Zero monthly subscriptions. Zero network requests. **Pure local inference, speed, and privacy.**

---

## Technical Highlights & Features

- **Push-to-Talk Dictation (`Right Ctrl`)**
  Hold `Right Ctrl` to dictate into any window. Release to instantly filter stutters, remove hesitation artifacts (*"um"*, *"uh"*, *"you know"*), correct grammar in real-time, and inject clean text directly at your caret.

- **Generative AI Command Engine (`Right Ctrl` + `Shift`)**
  Hold `Right Ctrl` + `Shift` to trigger Command Mode (glowing neon purple interface). Issue complex spoken prompts (*"Write an effective system audit prompt"*, *"Refactor this block into TypeScript interfaces"*), and Cadence generates rich, structured content or rewrites highlighted text.

- **System Tray Background Persistence**
  Cadence runs silently in the system tray, taking zero foreground focus until summoned. Access hotkey controls, application logs, or quit the process directly from a clean context menu.

- **Universal Win32 Text Injection**
  Utilizes a custom C# native Win32 helper (`CadenceHelper.exe`) with `WH_KEYBOARD_LL` low-level hooks, hardware scan code virtualization (`MapVirtualKey`), and thread-focus coupling (`AttachThreadInput`) to guarantee accurate text delivery across all Windows applications.

- **Minimalist Dynamic Floating Overlay**
  Features a top-center floating glassmorphic pill UI powered by a 60 FPS Canvas audio visualizer:
  - **Red Waveform**: Dictation Mode (Active Listening)
  - **Neon Purple Waveform**: Command Mode (Active Listening)
  - **Neon Blue Waveform**: Processing (Whisper STT + Ollama LLM Inference)

- **100% Local Privacy Architecture**
  Driven by `whisper.cpp` for instant speech-to-text and `Ollama` for local LLM inference. Audio buffers and text never leave your machine.

---

## Operating Modes

| Mode | Global Shortcut | Visual Cue | Functionality |
|---|---|---|---|
| **Dictation Mode** | Hold **`Right Ctrl`** | Red Glowing Pill | Real-time speech-to-text with automated grammar cleanup, filler stripping, and smart paragraphing. |
| **Command Mode** | Hold **`Right Ctrl` + `Shift`** | Neon Purple Glowing Pill | Spoken instruction execution, generative drafting, text transformations, and code generation. |

### How It Works:
1. **Focus**: Click into any input field in any Windows app.
2. **Hold & Speak**: Press and hold `Right Ctrl` (or `Right Ctrl` + `Shift` for Command Mode) and speak.
3. **Release**: Release the hotkey. Cadence processes your speech locally in milliseconds and injects the output directly into your target field.

---

## Architecture & System Pipeline

Cadence employs a multi-process, low-latency execution pipeline:

```
┌────────────────────────────────────────────────────────┐
│               Low-Level Windows Subsystem              │
└──────────────────────────┬─────────────────────────────┘
                           │ WH_KEYBOARD_LL Global Hook
                           ▼
┌────────────────────────────────────────────────────────┐
│    CadenceHelper.exe (C# Native Win32 Helper)          │
│    - Global low-level keyboard hook (filters synthetic) │
│    - Caret window capture & AttachThreadInput sync      │
│    - Named Pipe Server (`\\.\pipe\cadence-helper`)     │
└──────────────────────────┬─────────────────────────────┘
                           │ Bidirectional IPC
                           ▼
┌────────────────────────────────────────────────────────┐
│           Electron Main Process (Node.js/TS)           │
│    - 16kHz PCM Audio Buffer Processing                 │
│    - Tray Lifecycle Management & Execution Locks       │
│    - Output Sanitizer (Quote & Preamble Stripping)     │
└──────────────┬──────────────────────────┬──────────────┘
               │                          │
               ▼                          ▼
┌───────────────────────────┐  ┌───────────────────────────┐
│ whisper.cpp (Local STT)   │  │ Ollama API (Local LLM)    │
│ High-speed C++ speech     │  │ Local LLM inference via   │
│ transcription engine      │  │ localhost:11434           │
└───────────────────────────┘  └───────────────────────────┘
```

---

## Prerequisites & Installation

### 1. Requirements
- **Windows 10 / 11 (x64)**
- **Ollama**: Installed and running locally (`ollama pull gemma2:2b`).
- **.NET 9.0 SDK / Runtime**: (For building native Win32 binaries).
- **Node.js (v18+) & npm**

### 2. Models Setup
- **Ollama LLM**: Pull your preferred local LLM model (default is `gemma2:2b`):
  ```bash
  ollama pull gemma2:2b
  ```
- **Whisper STT**: Download a GGML model (e.g., `ggml-base.en.bin`) and place it in the `models/` directory alongside `whisper-cli.exe`.

---

## Quick Start & Building

### Development Mode
```bash
# Clone repository
git clone https://github.com/sohmxdd/Cadence.git
cd Cadence

# Install dependencies
npm install

# Build native C# Win32 helper
dotnet publish native-helper/CadenceHelper.csproj -c Release -r win-x64 --self-contained false -o native-helper/bin/publish

# Run Cadence
npm start
```

### Packaging Executable (`.exe`)
To package Cadence into a standalone Windows executable (`Cadence.exe`):

```bash
npm run package
```

The output will be built into `out/Cadence-win32-x64/Cadence.exe`. 

> **Note**: To create a Desktop or Start Menu shortcut, right-click `Cadence.exe` inside `out/Cadence-win32-x64/` and select **Create Shortcut**.

---

## Custom Per-App Profiles

Customize dictation behaviour per application by editing `config/profiles.json`:

```json
{
  "profiles": {
    "code.exe": {
      "name": "VS Code",
      "style": "verbatim",
      "promptOverride": "You are a code editor voice dictation assistant. Clean up typos and obvious mishearings, but do NOT capitalize keywords, change camelCase/snake_case variable names, or alter technical syntax."
    },
    "outlook.exe": {
      "name": "Outlook",
      "style": "formal",
      "promptOverride": "You are a professional email dictation assistant. Format into clear, professional sentences with proper paragraphing and formal grammar."
    }
  }
}
```

---

## Repository Structure

```text
Cadence/
├── native-helper/          # C# Native Win32 Helper (WH_KEYBOARD_LL & SendInput)
├── src/
│   ├── main/               # Main process, system tray, & pipeline orchestration
│   │   ├── ipc/            # Named Pipe IPC Bridge (native-bridge.ts)
│   │   └── pipeline/       # STT Engine (whisper.cpp) & LLM Engine (Ollama)
│   └── renderer/
│       ├── overlay/        # Top-center floating pill UI & waveform canvas
│       └── audio/          # Silent Web Audio capture & 16kHz resampler
├── models/                 # Local whisper-cli.exe & GGML binaries
├── config/                 # Profile rules (profiles.json)
└── forge.config.ts         # Electron Forge packaging configuration
```

---

## License

Licensed under the [MIT License](LICENSE).
