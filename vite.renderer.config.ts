import { defineConfig } from 'vite';
import path from 'node:path';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main_window: path.resolve(__dirname, 'index.html'),
        overlay_window: path.resolve(__dirname, 'src/renderer/overlay/index.html'),
        audio_window: path.resolve(__dirname, 'src/renderer/audio/index.html'),
      },
    },
  },
});
