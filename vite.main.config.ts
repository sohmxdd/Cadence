import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    outDir: 'build',
    rollupOptions: {
      external: ['node-global-key-listener'],
    },
  },
});
