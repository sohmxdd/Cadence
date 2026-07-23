let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let scriptNode: ScriptProcessorNode | null = null;
let isCapturing = false;

async function startAudioCapture() {
  if (isCapturing) return;

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    audioContext = new AudioContext();
    const targetSampleRate = 16000;
    const actualSampleRate = audioContext.sampleRate;
    const source = audioContext.createMediaStreamSource(mediaStream);

    // 4096 buffer size for stable audio streaming
    scriptNode = audioContext.createScriptProcessor(4096, 1, 1);

    scriptNode.onaudioprocess = (e) => {
      if (!isCapturing) return;
      const inputData = e.inputBuffer.getChannelData(0);

      // Compute RMS volume level (0.0 to 1.0)
      let sum = 0;
      for (let i = 0; i < inputData.length; i++) {
        sum += inputData[i] * inputData[i];
      }
      const rms = Math.sqrt(sum / inputData.length);

      // Resample audio to 16kHz PCM if hardware rate differs
      const resampledFloat = resampleTo16k(inputData, actualSampleRate, targetSampleRate);
      const pcm16 = floatTo16BitPCM(resampledFloat);

      if ((window as any).electronAPI) {
        (window as any).electronAPI.sendAudioChunk(pcm16.buffer, rms);
      }
    };

    source.connect(scriptNode);
    scriptNode.connect(audioContext.destination);
    isCapturing = true;
    console.log(`[AudioCapture] Mic capture active (${actualSampleRate}Hz -> ${targetSampleRate}Hz PCM)`);
  } catch (err) {
    console.error('[AudioCapture] Failed to access microphone:', err);
    if ((window as any).electronAPI && (window as any).electronAPI.sendAudioError) {
      (window as any).electronAPI.sendAudioError((err as Error)?.message || 'Microphone error');
    }
  }
}

function floatTo16BitPCM(float32Array: Float32Array): Int16Array {
  const pcm16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcm16;
}

function resampleTo16k(audioBuffer: Float32Array, fromSampleRate: number, toSampleRate = 16000): Float32Array {
  if (fromSampleRate === toSampleRate) return audioBuffer;
  const ratio = fromSampleRate / toSampleRate;
  const newLength = Math.round(audioBuffer.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const origIndex = i * ratio;
    const index1 = Math.floor(origIndex);
    const index2 = Math.min(index1 + 1, audioBuffer.length - 1);
    const fraction = origIndex - index1;
    result[i] = audioBuffer[index1] * (1 - fraction) + audioBuffer[index2] * fraction;
  }
  return result;
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

(window as any).startAudioCapture = startAudioCapture;
(window as any).stopAudioCapture = stopAudioCapture;
