import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  onOverlayState: (callback: (data: { state: string; mode?: string; text?: string }) => void) => {
    ipcRenderer.on('overlay-state', (_event, value) => callback(value));
  },
  onAudioLevel: (callback: (level: number) => void) => {
    ipcRenderer.on('audio-level', (_event, value) => callback(value));
  },
  onActivityLog: (callback: (data: { type: string; message: string }) => void) => {
    ipcRenderer.on('activity-log', (_event, value) => callback(value));
  },
  sendAudioChunk: (buffer: ArrayBuffer, rms: number) => {
    ipcRenderer.send('audio-chunk', buffer, rms);
  },
  sendAudioError: (errorMsg: string) => {
    ipcRenderer.send('audio-error', errorMsg);
  },
});
