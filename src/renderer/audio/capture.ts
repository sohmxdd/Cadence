let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let scriptNode: ScriptProcessorNode | null = null;
let isCapturing = false;

// IPC listeners from main process
if ((window as any).electronAPI) {
  // Listen for start/stop commands via IPC
}

async function startAudioCapture() {
  if (isCapturing) return;

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(mediaStream);

    // 1024 samples per frame = ~64ms chunks at 16kHz
    scriptNode = audioContext.createScriptProcessor(1024, 1, 1);

    scriptNode.onaudioprocess = (e) => {
      if (!isCapturing) return;
      const inputData = e.inputBuffer.getChannelData(0);

      // Compute RMS volume level (0.0 to 1.0)
      let sum = 0;
      for (let i = 0; i < inputData.length; i++) {
        sum += inputData[i] * inputData[i];
      }
      const rms = Math.sqrt(sum / inputData.length);

      // Convert Float32Array to 16-bit PCM (Int16Array)
      const pcm16 = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }

      // Send raw PCM buffer + RMS level to main process
      if ((window as any).electronAPI) {
        (window as any).electronAPI.sendAudioChunk(pcm16.buffer, rms);
      }
    };

    source.connect(scriptNode);
    scriptNode.connect(audioContext.destination);
    isCapturing = true;
    console.log('[AudioCapture] Mic capture started at 16kHz mono PCM');
  } catch (err) {
    console.error('[AudioCapture] Failed to access microphone:', err);
  }
}

function stopAudioCapture() {
  isCapturing = false;
  if (scriptNode) {
    scriptNode.disconnect();
    scriptNode = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  console.log('[AudioCapture] Mic capture stopped');
}

// Global window hooks for main process trigger
(window as any).startAudioCapture = startAudioCapture;
(window as any).stopAudioCapture = stopAudioCapture;
