# Cadence 🎙️✨

> **Ultra-Fast, 100% Local Voice Dictation & AI Command Engine for Windows**

Cadence brings effortless voice-to-text dictation and AI-powered text transformations to **every single text field on Windows**. Hold down a hotkey anywhere, speak naturally, and watch your voice transform into pristine, publication-grade text directly at your cursor.

No cloud APIs. No monthly subscriptions. No audio leaving your computer. **Pure local speed & privacy.**

---

## 🌟 Key Features

- 🎙️ **Push-to-Talk Dictation (`Right Ctrl`)**
  Hold **`Right Ctrl`** to speak into any app (Notepad, VS Code, Discord, Word, Chrome, Slack). Release the key, and Cadence instantly cleans stutters, filler words ("um", "uh"), fixes grammar, and pastes the text directly at your cursor.

- ⚡ **AI Command Mode (`Right Ctrl` + `Shift`)**
  Hold **`Right Ctrl` + `Shift`** to enter **Command Mode** (glowing neon purple UI). Speak a prompt or instruction (e.g. *"Write an effective system audit prompt"* or *"Rewrite this paragraph to sound more professional"*), and Cadence generates rich, structured content or transforms existing text.

- 🔒 **100% Private & Fully Local**
  Powered by `whisper.cpp` (speech-to-text) and `Ollama` (local LLM). Zero network requests, zero cloud tracking.

- 🖥️ **Universal Windows Compatibility**
  Works in every text field system-wide using high-precision Win32 API text injection (`AttachThreadInput` + thread focus restoration).

- 🎨 **Minimal Floating Overlay**
  A sleek, distraction-free floating pill UI positioned top-center on your screen with a live dynamic audio waveform:
  - 🔴 **Red Waveform**: Dictation Mode (Listening)
  - 🟣 **Neon Purple Waveform**: Command Mode (Listening)
  - 🔵 **Neon Blue Waveform**: Processing (Whisper STT + Ollama AI Inference)

- ⚙️ **Per-App Profile Rules**
  Customize dictation styles for specific applications (e.g., verbatim code preserving camelCase in VS Code vs. formal prose in Outlook).

---

## 🎮 How to Use

| Mode | Shortcut | Visual Cue | What It Does |
|---|---|---|---|
| **Dictation Mode** | Hold **`Right Ctrl`** | Red glowing pill + live waveform | Speech-to-text with automatic filler word removal, grammar correction, and smart formatting into text field. |
| **Command Mode** | Hold **`Right Ctrl` + `Shift`** | Neon Purple glowing pill | Spoken prompt execution & generative content creation (e.g. drafts, outlines, code, rewrites). |

### Simple 3-Step Flow:
1. **Click** into any text field or text box in any Windows app.
2. **Press & Hold** `Right Ctrl` (or `Right Ctrl` + `Shift` for Command Mode) and speak naturally.
3. **Release** the key — the floating pill switches to blue while processing, then injects your finalized text directly into the focused field!

---

## 🛠️ System Requirements & Setup

### 1. Prerequisites
- **Windows 10 / 11 (x64)**
- **.NET 9.0 SDK or Runtime** (for building/running the native C# helper)
- **Node.js (v18+) & npm**
- **Ollama**: Installed and running locally.

### 2. Install Local Models

#### **Ollama Model (LLM)**
Open your terminal and pull your preferred local model (default: `gemma2:2b`):
```bash
ollama pull gemma2:2b
```

#### **Whisper STT Model**
Download the `ggml-base.en.bin` model file (or any GGML Whisper model) and place it inside the `models/` directory:
```text
Cadence/
└── models/
    ├── whisper-cli.exe
    └── ggml-base.en.bin
```

---

## 🚀 Quick Start (Development)

```bash
# 1. Clone the repository
git clone https://github.com/sohmxdd/Cadence.git
cd Cadence

# 2. Install dependencies
npm install

# 3. Build the Native C# Helper
dotnet publish native-helper/CadenceHelper.csproj -c Release -r win-x64 --self-contained false -o native-helper/bin/publish

# 4. Start Cadence
npm start
```

---

## 🏗️ Architecture & Technical Design

Cadence is built with a high-performance multi-process pipeline:

```
┌────────────────────────────────────────────────────────┐
│               Low-Level Windows System                 │
└──────────────────────────┬─────────────────────────────┘
                           │ WH_KEYBOARD_LL Global Hook
                           ▼
┌────────────────────────────────────────────────────────┐
│    CadenceHelper.exe (C# Native Win32 Helper)          │
│    - Global keyboard hook (filters synthetic keys)    │
│    - Focus restoration & Win32 AttachThreadInput      │
│    - Named Pipe Server (`\\.\pipe\cadence-helper`)     │
└──────────────────────────┬─────────────────────────────┘
                           │ Bidirectional IPC
                           ▼
┌────────────────────────────────────────────────────────┐
│           Electron Main Process (Node.js/TS)           │
│    - Audio Buffer Orchestration                        │
│    - Resampling to 16kHz Mono PCM                      │
│    - Execution lock & App Profile Config               │
└──────────────┬──────────────────────────┬──────────────┘
               │                          │
               ▼                          ▼
┌───────────────────────────┐  ┌───────────────────────────┐
│ whisper.cpp (Local STT)   │  │ Ollama API (Local LLM)    │
│ High-speed speech-to-text │  │ Clean dictation & prompt  │
│ transcription             │  │ execution                 │
└────────────────────────n──┘  └───────────────────────────┘
```

---

## ⚙️ Per-App Formatting Profiles

You can customize how dictation behaves for specific applications by modifying `config/profiles.json`:

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

## 📁 Repository Layout

```text
Cadence/
├── native-helper/          # C# Native Windows Helper (WH_KEYBOARD_LL & Win32 injection)
├── src/
│   ├── main/               # Electron Main Process & Pipeline Core
│   │   ├── ipc/            # Named pipe IPC bridge (native-bridge.ts)
│   │   └── pipeline/       # STT (whisper.cpp) & LLM (Ollama) engines
│   └── renderer/
│       ├── overlay/        # Top-center floating pill UI & waveform renderer
│       └── audio/          # Hidden web audio capture & 16kHz resampling
├── models/                 # Local whisper-cli.exe binary & GGML model binaries
├── config/                 # User profiles config (profiles.json)
└── tsconfig.json           # TypeScript configuration
```

---

## 📄 License

Distributed under the **MIT License**. See `LICENSE` for more information.
