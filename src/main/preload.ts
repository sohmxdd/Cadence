import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  onOverlayState: (callback: (data: { state: string; mode?: string }) => void) => {
    ipcRenderer.on('overlay-state', (_event, value) => callback(value));
  },
  onAudioLevel: (callback: (level: number) => void) => {
    ipcRenderer.on('audio-level', (_event, value) => callback(value));
  },
  sendAudioChunk: (buffer: ArrayBuffer, rms: number) => {
    ipcRenderer.send('audio-chunk', buffer, rms);
  },
});
